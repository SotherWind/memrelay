import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import type { Part, SessionStatus, ToolCategory } from "../core/types.js";
import { analyzeStatus, type LocalMessage } from "../adapters/jsonl-family/records.js";
import { decideStatusCore, FRESH_WINDOW_MS, extractTodosFromPlanParts, type PlanPart } from "../resume/extract.js";

/** 状态信号：索引时算好落库，列表查询时按"查询时刻"实时重算出状态。 */
export interface StoredSignals {
  pending: boolean;
  quota: boolean;
  error: boolean;
  unanswered: boolean;
  todosOpen: boolean;
  lastReal: "user" | "assistant" | "system" | null;
  /**
   * 收尾正文长度：最后一条助手消息没有工具调用且有文本时为其长度（至少 1），
   * 否则为 0。状态判定只用"是否 > 0"。
   */
  replyLen: number;
}

/** 实时状态：新鲜度窗口内的会话是"进行中"，否则由信号决定中断 / 完成 / 未判定。 */
export function statusFromSignals(signals: StoredSignals, mtimeMs: number, now: number): SessionStatus {
  return decideStatusCore({
    fresh: now - mtimeMs < FRESH_WINDOW_MS,
    pendingToolCall: signals.pending,
    quotaOrLimit: signals.quota,
    errorSeen: signals.error,
    lastUserUnanswered: signals.unanswered,
    lastReal: signals.lastReal,
    unfinishedTodos: signals.todosOpen,
    lastAssistantFinal: signals.replyLen > 0,
  });
}

/**
 * 源文件 mtime 解析：库里存的是上次索引时的 mtime，对"还在被写"的会话会滞后；
 * 展示页（量小）直接 stat 取最新值。扫全量的汇总只对最近活跃的行 stat（老会话没有这个必要）。
 */
export const STAT_WINDOW_MS = 30 * 60 * 1000;

export class MtimeResolver {
  private cache = new Map<string, number | undefined>();

  constructor(private readonly now: number) {}

  resolve(sourcePath: string | null, storedMtimeMs: number, always = false): number {
    if (!sourcePath) return storedMtimeMs;
    if (!always && this.now - storedMtimeMs >= STAT_WINDOW_MS) return storedMtimeMs;
    if (!this.cache.has(sourcePath)) {
      try {
        this.cache.set(sourcePath, fs.statSync(sourcePath).mtimeMs);
      } catch {
        this.cache.set(sourcePath, undefined);
      }
    }
    const stat = this.cache.get(sourcePath);
    return stat === undefined ? storedMtimeMs : Math.max(stat, storedMtimeMs);
  }
}

/**
 * 单会话的聚合统计与状态信号（v3 表结构起落库）。
 * 语义与索引时从消息序列直接算的那一套保持一致（见 indexScan / summarizeMessagesWith），
 * 这里只是把它们做成"从库里批量重算"，供老库回填用。
 */
export interface SessionStats extends StoredSignals {
  messageCount: number;
  fileCount: number;
}

/** 状态口径变化时 +1：下次 buildIndex 全量刷新一次信号（不删消息，归档会话安全）。 */
export const STATS_VERSION = 4;

export const EMPTY_SESSION_STATS: SessionStats = {
  messageCount: 0,
  fileCount: 0,
  pending: false,
  quota: false,
  error: false,
  unanswered: false,
  todosOpen: false,
  lastReal: null,
  replyLen: 0,
};

/** 每批处理的会话数：批量查询要控制在 SQLite 变量上限内，内存也保持可控。 */
const BATCH_SIZE = 400;

function placeholders(count: number): string {
  return new Array(count).fill("?").join(",");
}

function inClause(ids: string[]): string {
  return placeholders(ids.length);
}

interface WindowMessageRow {
  sid: string;
  mid: number;
  ordinal: number;
  role: string;
  compact: number;
}

interface WindowPartRow {
  message_id: number;
  kind: string;
  text: string | null;
  status: string | null;
  tool_call_id: string | null;
}

/** 与 store-rank 的 windowParts 映射同构：够 analyzeStatus 用即可。 */
function windowMessages(msgRows: WindowMessageRow[], partRows: WindowPartRow[]): LocalMessage[] {
  const partsByMessage = new Map<number, Part[]>();
  for (const p of partRows) {
    const list = partsByMessage.get(p.message_id) ?? [];
    list.push({
      kind: p.kind as Part["kind"],
      text: p.text ?? undefined,
      status: p.status === "error" ? "error" : p.status === "ok" ? "ok" : undefined,
      toolCallId: p.tool_call_id ?? undefined,
    });
    partsByMessage.set(p.message_id, list);
  }
  return msgRows.map((m) => {
    const parts = partsByMessage.get(m.mid) ?? [];
    return {
      uuid: `db-${m.mid}`,
      role: m.role as LocalMessage["role"],
      isSidechain: false,
      isCompactBoundary: m.compact === 1,
      parts,
      toolCalls: parts
        .filter((p) => p.kind === "tool_call" || p.kind === "file_edit" || p.kind === "plan")
        .map((p) => ({
          toolCallId: p.toolCallId ?? "",
          category: "other" as ToolCategory,
          input: undefined,
          isPlan: p.kind === "plan",
          files: [],
        })),
      toolResults: parts
        .filter((p) => p.kind === "tool_result")
        .map((p) => ({
          toolCallId: p.toolCallId,
          content: p.text ?? "",
          isError: p.status === "error",
        })),
      isUserPrompt: false,
    };
  });
}

/** 批量重算一批会话的统计与信号（读路径，只读）。 */
export function computeSessionStats(db: DatabaseSync, sessionIds: string[]): Map<string, SessionStats> {
  const out = new Map<string, SessionStats>();
  if (sessionIds.length === 0) return out;
  for (const id of sessionIds) out.set(id, { ...EMPTY_SESSION_STATS });
  const inIds = inClause(sessionIds);

  // —— 消息数 / 文件数 ——
  {
    const rows = db
      .prepare(
        `SELECT session_id AS sid, COUNT(*) AS c FROM messages
         WHERE session_id IN (${inIds}) GROUP BY session_id`,
      )
      .all(...sessionIds) as Array<{ sid: string; c: number }>;
    for (const r of rows) out.get(r.sid)!.messageCount = Number(r.c);
  }
  {
    const rows = db
      .prepare(
        `SELECT m.session_id AS sid, p.text AS text
         FROM parts p JOIN messages m ON p.message_id = m.id
         WHERE m.session_id IN (${inIds}) AND p.kind = 'file_edit' AND p.text IS NOT NULL`,
      )
      .all(...sessionIds) as Array<{ sid: string; text: string }>;
    const sets = new Map<string, Set<string>>();
    for (const r of rows) {
      let set = sets.get(r.sid);
      if (!set) {
        set = new Set<string>();
        sets.set(r.sid, set);
      }
      for (const line of r.text.split("\n")) {
        const file = line.trim();
        if (file) set.add(file);
      }
    }
    for (const [sid, set] of sets) out.get(sid)!.fileCount = set.size;
  }

  // —— 未配对的工具调用（只看最后一条助手消息：历史孤儿不算等待） ——
  {
    const rows = db
      .prepare(
        `WITH last_asst AS (
           SELECT session_id AS sid, MAX(ordinal) AS ordinal
           FROM messages
           WHERE session_id IN (${inIds}) AND role = 'assistant'
           GROUP BY session_id
         ), calls AS (
           SELECT m.session_id AS sid, la.ordinal AS ordinal, p.tool_call_id AS cid
           FROM messages m
           JOIN last_asst la ON la.sid = m.session_id AND la.ordinal = m.ordinal
           JOIN parts p ON p.message_id = m.id
           WHERE p.kind IN ('tool_call', 'file_edit', 'plan')
             AND p.tool_call_id IS NOT NULL AND p.tool_call_id <> ''
         )
         SELECT c.sid AS sid, COUNT(*) AS n
         FROM calls c
         WHERE NOT EXISTS (
           SELECT 1 FROM parts r
           JOIN messages rm ON r.message_id = rm.id
           WHERE rm.session_id = c.sid AND rm.ordinal >= c.ordinal
             AND r.kind = 'tool_result' AND r.tool_call_id = c.cid
         )
         GROUP BY c.sid`,
      )
      .all(...sessionIds) as Array<{ sid: string; n: number }>;
    for (const r of rows) {
      if (Number(r.n) > 0) out.get(r.sid)!.pending = true;
    }
  }

  // —— 末尾 8 条消息窗口（analyzeStatus 的 slice(-8) 口径）：额度 / 报错信号 ——
  {
    const msgRows = db
      .prepare(
        `SELECT m.session_id AS sid, m.id AS mid, m.ordinal AS ordinal, m.role AS role,
                m.is_compact_boundary AS compact
         FROM messages m
         JOIN (
           SELECT session_id, MAX(ordinal) AS maxo FROM messages
           WHERE session_id IN (${inIds}) GROUP BY session_id
         ) t ON t.session_id = m.session_id
         WHERE m.ordinal >= t.maxo - 7
         ORDER BY m.session_id, m.ordinal`,
      )
      .all(...sessionIds) as unknown as WindowMessageRow[];
    const midToSid = new Map<number, string>();
    for (const r of msgRows) midToSid.set(r.mid, r.sid);
    const partRows =
      msgRows.length === 0
        ? []
        : (db
            .prepare(
              `SELECT p.message_id AS message_id, p.kind AS kind, p.text AS text,
                      p.status AS status, p.tool_call_id AS tool_call_id
               FROM parts p WHERE p.message_id IN (${placeholders(msgRows.length)})
               ORDER BY p.message_id, p.idx`,
            )
            .all(...msgRows.map((r) => r.mid)) as unknown as WindowPartRow[]);
    const bySid = new Map<string, { msgs: WindowMessageRow[]; parts: WindowPartRow[] }>();
    for (const m of msgRows) {
      const entry = bySid.get(m.sid) ?? { msgs: [], parts: [] };
      entry.msgs.push(m);
      bySid.set(m.sid, entry);
    }
    for (const p of partRows) {
      const sid = midToSid.get(p.message_id);
      if (sid) bySid.get(sid)!.parts.push(p);
    }
    for (const [sid, entry] of bySid) {
      const info = analyzeStatus(windowMessages(entry.msgs, entry.parts));
      const stats = out.get(sid)!;
      stats.quota = info.quotaOrLimitDetected;
      stats.error = info.errorDetected;
    }
  }

  // —— 最后一条"真"消息（user / assistant，或压缩边界） ——
  const lastRealBySid = new Map<string, { role: string; ordinal: number }>();
  {
    const rows = db
      .prepare(
        `SELECT sid, role, ordinal FROM (
           SELECT m.session_id AS sid, m.role AS role, m.ordinal AS ordinal,
                  ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.ordinal DESC) AS rn
           FROM messages m
           WHERE m.session_id IN (${inIds})
             AND (m.role IN ('user', 'assistant') OR m.is_compact_boundary = 1)
         ) WHERE rn = 1`,
      )
      .all(...sessionIds) as Array<{ sid: string; role: string; ordinal: number }>;
    for (const r of rows) {
      out.get(r.sid)!.lastReal = r.role as SessionStats["lastReal"];
      lastRealBySid.set(r.sid, { role: r.role, ordinal: Number(r.ordinal) });
    }
  }

  // —— "最后一条是没被回复的用户指令"：以该消息有没有文本片段为准 ——
  {
    const pairs = [...lastRealBySid.entries()].filter(([, v]) => v.role === "user");
    if (pairs.length > 0) {
      const values = pairs.map(() => "(?, ?)").join(",");
      const args = pairs.flatMap(([sid, v]) => [sid, v.ordinal]);
      const rows = db
        .prepare(
          `SELECT m.session_id AS sid,
                  MAX(p.kind = 'text' AND p.text IS NOT NULL AND p.text <> '') AS has_text
           FROM messages m JOIN parts p ON p.message_id = m.id
           WHERE (m.session_id, m.ordinal) IN (VALUES ${values})
           GROUP BY m.session_id`,
        )
        .all(...args) as Array<{ sid: string; has_text: number }>;
      for (const r of rows) {
        if (Number(r.has_text) === 1) out.get(r.sid)!.unanswered = true;
      }
    }
  }

  // —— 收尾正文（"完成"判定）：最后一条助手消息没有工具调用、且有文本 ——
  {
    const rows = db
      .prepare(
        `WITH last_asst AS (
           SELECT m.session_id AS sid, MAX(m.ordinal) AS ordinal
           FROM messages m
           WHERE m.session_id IN (${inIds}) AND m.role = 'assistant'
           GROUP BY m.session_id
         )
         SELECT la.sid AS sid, p.kind AS kind, p.text AS text
         FROM last_asst la
         JOIN messages m ON m.session_id = la.sid AND m.ordinal = la.ordinal
         JOIN parts p ON p.message_id = m.id
         ORDER BY la.sid, p.idx`,
      )
      .all(...sessionIds) as Array<{ sid: string; kind: string; text: string | null }>;
    const bySid = new Map<string, Array<{ kind: string; text: string | null }>>();
    for (const r of rows) {
      const list = bySid.get(r.sid) ?? [];
      list.push({ kind: r.kind, text: r.text });
      bySid.set(r.sid, list);
    }
    for (const [sid, parts] of bySid) {
      const hasTool = parts.some(
        (p) => p.kind === "tool_call" || p.kind === "file_edit" || p.kind === "plan",
      );
      const text = parts
        .filter((p) => p.kind === "text" && p.text)
        .map((p) => p.text!)
        .join("\n")
        .trim();
      // 长度存实际值（至少 1）；没有收尾正文时存 0，statusFromSignals 据此判 final
      out.get(sid)!.replyLen = !hasTool && text ? Math.min(Math.max(text.length, 1), 5000) : 0;
    }
  }

  // —— 待办（最后一个 plan 片段的最终状态） ——
  {
    const planRows = db
      .prepare(
        `SELECT m.session_id AS sid, p.json AS json, p.tool_call_id AS call_id
         FROM messages m JOIN parts p ON p.message_id = m.id
         WHERE m.session_id IN (${inIds}) AND p.kind = 'plan' AND p.json IS NOT NULL
         ORDER BY m.session_id, m.ordinal, p.idx`,
      )
      .all(...sessionIds) as Array<{ sid: string; json: string; call_id: string | null }>;

    // TaskCreate 的真实 id 只在工具结果里（"Task #1 created successfully"），更新要靠它对齐
    const callIds = [...new Set(planRows.flatMap((r) => (r.call_id ? [r.call_id] : [])))];
    const resultByCall = new Map<string, string>();
    for (let i = 0; i < callIds.length; i += 500) {
      const chunk = callIds.slice(i, i + 500);
      const rows = db
        .prepare(
          `SELECT p.tool_call_id AS cid, p.text AS text
           FROM messages m JOIN parts p ON p.message_id = m.id
           WHERE m.session_id IN (${inIds}) AND p.kind = 'tool_result'
             AND p.tool_call_id IN (${placeholders(chunk.length)})`,
        )
        .all(...sessionIds, ...chunk) as Array<{ cid: string; text: string | null }>;
      for (const r of rows) resultByCall.set(r.cid, r.text ?? "");
    }

    const partsBySid = new Map<string, PlanPart[]>();
    for (const r of planRows) {
      let value: unknown;
      try {
        value = JSON.parse(r.json) as unknown;
      } catch {
        continue; // 超长内容在库里被截断，解析不了就跳过这一段
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const list = partsBySid.get(r.sid) ?? [];
      list.push({
        input: value as Record<string, unknown>,
        resultText: r.call_id ? resultByCall.get(r.call_id) : undefined,
      });
      partsBySid.set(r.sid, list);
    }
    for (const [sid, parts] of partsBySid) {
      out.get(sid)!.todosOpen = extractTodosFromPlanParts(parts).some(
        (t) => t.status === "pending" || t.status === "in_progress",
      );
    }
  }

  return out;
}

/**
 * 老库回填：把还没算过（message_count < 0）的会话的统计与信号补上。
 * 幂等、可中断续跑；在 buildIndex 里调用（用户命令路径），hook 路径不触发。
 */
export function backfillSessionStats(
  db: DatabaseSync,
  opts: { onProgress?: (message: string) => void } = {},
): number {
  const versionRow = db
    .prepare("SELECT value FROM settings WHERE key = 'stats_version'")
    .get() as { value?: string } | undefined;
  const refreshAll = versionRow?.value !== String(STATS_VERSION);
  const rows = (
    refreshAll
      ? db.prepare("SELECT id FROM sessions").all()
      : db.prepare("SELECT id FROM sessions WHERE message_count < 0").all()
  ) as Array<{ id: string }>;
  if (rows.length === 0) {
    if (refreshAll) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('stats_version', ?)").run(
        String(STATS_VERSION),
      );
    }
    return 0;
  }

  const update = db.prepare(
    `UPDATE sessions SET message_count = ?, file_count = ?,
       sig_pending = ?, sig_quota = ?, sig_error = ?, sig_unanswered = ?,
       sig_todos_open = ?, sig_last_real = ?, sig_reply_len = ?
     WHERE id = ?`,
  );
  opts.onProgress?.(
    `${refreshAll ? "刷新" : "补齐"} ${rows.length} 个会话的统计与状态信号…`,
  );

  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const ids = rows.slice(i, i + BATCH_SIZE).map((r) => r.id);
    const stats = computeSessionStats(db, ids);
    db.exec("BEGIN");
    try {
      for (const id of ids) {
        const s = stats.get(id) ?? EMPTY_SESSION_STATS;
        update.run(
          s.messageCount,
          s.fileCount,
          s.pending ? 1 : 0,
          s.quota ? 1 : 0,
          s.error ? 1 : 0,
          s.unanswered ? 1 : 0,
          s.todosOpen ? 1 : 0,
          s.lastReal,
          s.replyLen,
          id,
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    done += ids.length;
  }
  if (refreshAll) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('stats_version', ?)").run(
      String(STATS_VERSION),
    );
  }
  opts.onProgress?.(`已${refreshAll ? "刷新" : "补齐"} ${done} 个会话。`);
  return done;
}
