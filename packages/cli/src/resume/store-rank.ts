import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import type { Env, Part, SessionStatus, ToolCategory } from "../core/types.js";
import { isDirExcluded, isSessionDeleted, type Filters } from "../core/filters.js";
import {
  isPathInside,
  normalizePathForCompare,
  partLooksLikeMemrelayCall,
} from "../adapters/jsonl-family/parser.js";
import { analyzeStatus, type LocalMessage, type StatusInfo } from "../adapters/jsonl-family/records.js";
import { openReadOnly } from "../store/db.js";
import { buildMatch, splitQuery } from "../core/fts.js";
import {
  buildRankedSession,
  rankFromSignals,
  type RankedSession,
  type RankOptions,
  type RankSignals,
} from "./select.js";
import {
  decideStatusFromSummary,
  extractTodosFromPlanParts,
  type PlanPart,
  type StatusSummary,
} from "./extract.js";
import { markerFromTexts } from "./session-reader.js";
import type { SessionScan, SerializedJsonlAdapter } from "../adapters/jsonl-family/jsonl-adapter.js";

/**
 * resume 的查库快路径（架构 5.5）：
 * 先按库里的数据排好序，候选文件只做 size+mtime 校验；
 * 只有校验不过（或库里还没有）的文件才现场重读，深读只留给最终选中的那一个会话。
 * 库缺失、打不开或大面积过期时返回 undefined，调用方落回全量扫盘。
 *
 * 注意：库里超长片段（>32KB）只存了头尾，投影出来的文本与文件原读可能
 * 有极小差异——只影响关键词打分，不影响选择逻辑的判定字段。
 */

/** 现场重排的文件超过这个数，说明库已大面积过期：放弃快路径，走全量扫盘。 */
const MAX_FILE_RANKS = 8;

interface StoreSessionRow {
  id: string;
  agent: string;
  sourcePath: string;
  cwd: string | null;
  gitBranch: string | null;
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  srcSize: number;
  srcMtime: number;
  srcVersion: number;
}

function loadStoreRows(db: DatabaseSync, platform: NodeJS.Platform): Map<string, StoreSessionRow> {
  // ORDER BY src.id：万一同一文件因路径大小写差异留了两行，后写入（更新的）那行胜出
  const rows = db
    .prepare(
      `SELECT s.id, s.agent, s.source_path, s.cwd, s.git_branch, s.title, s.started_at, s.ended_at,
              src.size AS src_size, src.mtime_ms AS src_mtime, src.adapter_version AS src_version
       FROM sessions s
       JOIN sources src ON src.path = s.source_path
       WHERE s.deleted_at IS NULL AND s.source_path IS NOT NULL
       ORDER BY src.id`,
    )
    .all() as Array<Record<string, unknown>>;
  const map = new Map<string, StoreSessionRow>();
  for (const r of rows) {
    const path = typeof r["source_path"] === "string" ? r["source_path"] : "";
    if (!path) continue;
    map.set(normalizePathForCompare(path, platform), {
      id: String(r["id"]),
      agent: String(r["agent"]),
      sourcePath: path,
      cwd: typeof r["cwd"] === "string" ? r["cwd"] : null,
      gitBranch: typeof r["git_branch"] === "string" ? r["git_branch"] : null,
      title: typeof r["title"] === "string" ? r["title"] : null,
      startedAt: typeof r["started_at"] === "string" ? r["started_at"] : null,
      endedAt: typeof r["ended_at"] === "string" ? r["ended_at"] : null,
      srcSize: Number(r["src_size"] ?? -1),
      srcMtime: Number(r["src_mtime"] ?? -1),
      srcVersion: Number(r["src_version"] ?? -1),
    });
  }
  return map;
}

/** 会话投影查询（预编译后跨会话复用）。 */
class StoreQueries {
  private cache = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  constructor(private readonly db: DatabaseSync) {}

  private q(sql: string) {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  /** role='user' 的文本片段（判 isUserPrompt 与提取用户指令用）。 */
  userTextParts(sessionId: string): Array<{ ordinal: number; text: string }> {
    return this.q(
      `SELECT m.ordinal AS ordinal, p.text AS text
       FROM messages m JOIN parts p ON p.message_id = m.id
       WHERE m.session_id = ? AND m.role = 'user' AND p.kind = 'text' AND p.text IS NOT NULL
       ORDER BY m.ordinal, p.idx`,
    ).all(sessionId) as Array<{ ordinal: number; text: string }>;
  }

  /** role='user' 且带工具结果的片段序号（这类 user 记录不是"真"用户指令）。 */
  userToolResultOrdinals(sessionId: string): Set<number> {
    const rows = this.q(
      `SELECT DISTINCT m.ordinal AS ordinal
       FROM messages m JOIN parts p ON p.message_id = m.id
       WHERE m.session_id = ? AND m.role = 'user' AND p.kind = 'tool_result'`,
    ).all(sessionId) as Array<{ ordinal: number }>;
    return new Set(rows.map((r) => r.ordinal));
  }

  /** 最后 6 条 assistant 消息的全部片段（keywordText 的"最后几段回复" + 最后进展）。 */
  assistantTailParts(sessionId: string): Array<{
    ordinal: number;
    kind: string;
    text: string | null;
  }> {
    return this.q(
      `SELECT m.ordinal AS ordinal, p.kind AS kind, p.text AS text
       FROM messages m JOIN parts p ON p.message_id = m.id
       WHERE m.session_id = ? AND m.role = 'assistant'
         AND m.ordinal >= COALESCE((
           SELECT MIN(ordinal) FROM (
             SELECT DISTINCT ordinal FROM messages
             WHERE session_id = ? AND role = 'assistant'
             ORDER BY ordinal DESC LIMIT 6
           )
         ), 0)
       ORDER BY m.ordinal, p.idx`,
    ).all(sessionId, sessionId) as Array<{ ordinal: number; kind: string; text: string | null }>;
  }

  /** 末尾最多 8 条消息的片段（与 analyzeStatus 的 slice(-8) 窗口一致）。 */
  windowParts(sessionId: string): Array<{
    ordinal: number;
    role: string;
    compact: number;
    kind: string;
    text: string | null;
    status: string | null;
    toolCallId: string | null;
  }> {
    return this.q(
      `SELECT m.ordinal AS ordinal, m.role AS role, m.is_compact_boundary AS compact,
              p.kind AS kind, p.text AS text, p.status AS status, p.tool_call_id AS tool_call_id
       FROM messages m JOIN parts p ON p.message_id = m.id
       WHERE m.session_id = ?
         AND m.ordinal >= (SELECT MAX(ordinal) FROM messages WHERE session_id = ?) - 7
       ORDER BY m.ordinal, p.idx`,
    ).all(sessionId, sessionId) as Array<{
      ordinal: number;
      role: string;
      compact: number;
      kind: string;
      text: string | null;
      status: string | null;
      toolCallId: string | null;
    }>;
  }

  /** 从末尾往前找最后一条"真"消息（user/assistant，或压缩边界）。 */
  lastReal(sessionId: string): { role: string; ordinal: number; compact: number } | undefined {
    const rows = this.q(
      `SELECT role, ordinal, is_compact_boundary AS compact FROM messages
       WHERE session_id = ? ORDER BY ordinal DESC LIMIT 200`,
    ).all(sessionId) as Array<{ role: string; ordinal: number; compact: number }>;
    for (const r of rows) {
      if (r.role === "user" || r.role === "assistant") return r;
      if (r.role === "system" && r.compact) return r;
    }
    return undefined;
  }

  /** 最后一条 assistant 消息里未配对的工具调用（与 analyzeStatus 同一口径）。 */
  pendingToolCallIds(sessionId: string): string[] {
    const last = this.q(
      "SELECT MAX(ordinal) AS ordinal FROM messages WHERE session_id = ? AND role = 'assistant'",
    ).get(sessionId) as { ordinal?: number | null } | undefined;
    if (last?.ordinal === undefined || last.ordinal === null) return [];
    const rows = this.q(
      `SELECT DISTINCT m.ordinal AS ordinal, p.kind AS kind, p.tool_call_id AS callId
       FROM messages m JOIN parts p ON p.message_id = m.id
       WHERE m.session_id = ? AND p.tool_call_id IS NOT NULL AND p.tool_call_id <> ''`,
    ).all(sessionId) as Array<{ ordinal: number; kind: string; callId: string }>;
    const calls = new Set<string>();
    const results = new Set<string>();
    for (const r of rows) {
      if (r.kind === "tool_result") results.add(r.callId);
      else if (r.ordinal === last.ordinal) calls.add(r.callId);
    }
    return [...calls].filter((id) => !results.has(id));
  }

  /** plan 片段（待办提取用）：带上对应工具结果，TaskCreate 的真实 id 只出现在结果里。 */
  planParts(sessionId: string): PlanPart[] {
    const rows = this.q(
      `SELECT p.json AS json, p.tool_call_id AS call_id
       FROM messages m JOIN parts p ON p.message_id = m.id
       WHERE m.session_id = ? AND p.kind = 'plan' AND p.json IS NOT NULL
       ORDER BY m.ordinal, p.idx`,
    ).all(sessionId) as Array<{ json: string; call_id: string | null }>;

    const callIds = [...new Set(rows.flatMap((r) => (r.call_id ? [r.call_id] : [])))];
    const resultByCall = new Map<string, string>();
    for (let i = 0; i < callIds.length; i += 500) {
      const chunk = callIds.slice(i, i + 500);
      const resultRows = this.q(
        `SELECT p.tool_call_id AS cid, p.text AS text
         FROM messages m JOIN parts p ON p.message_id = m.id
         WHERE m.session_id = ? AND p.kind = 'tool_result'
           AND p.tool_call_id IN (${chunk.map(() => "?").join(",")})`,
      ).all(sessionId, ...chunk) as Array<{ cid: string; text: string | null }>;
      for (const r of resultRows) resultByCall.set(r.cid, r.text ?? "");
    }

    const out: PlanPart[] = [];
    for (const r of rows) {
      try {
        const v = JSON.parse(r.json) as unknown;
        if (v && typeof v === "object" && !Array.isArray(v)) {
          out.push({
            input: v as Record<string, unknown>,
            resultText: r.call_id ? resultByCall.get(r.call_id) : undefined,
          });
        }
      } catch {
        /* 超长内容在库里被截断，解析不了就跳过这一段 */
      }
    }
    return out;
  }

  /** file_edit 片段里的路径（会话改过的文件）。 */
  touchedFiles(sessionId: string): string[] {
    const rows = this.q(
      `SELECT p.text AS text FROM messages m JOIN parts p ON p.message_id = m.id
       WHERE m.session_id = ? AND p.kind = 'file_edit' AND p.text IS NOT NULL
       ORDER BY m.ordinal, p.idx`,
    ).all(sessionId) as Array<{ text: string }>;
    const out: string[] = [];
    for (const r of rows) out.push(...r.text.split("\n"));
    return out;
  }

  /** 是否有助手产出（空壳会话判断）。 */
  hasContent(sessionId: string): boolean {
    const row = this.q(
      `SELECT EXISTS(
         SELECT 1 FROM messages m JOIN parts p ON p.message_id = m.id
         WHERE m.session_id = ? AND m.role = 'assistant'
           AND (p.kind IN ('tool_call', 'file_edit', 'plan')
                OR (p.kind = 'text' AND p.text IS NOT NULL AND TRIM(p.text) <> ''))
       ) AS ok`,
    ).get(sessionId) as { ok: number } | undefined;
    return (row?.ok ?? 0) === 1;
  }

  /** 末尾 4 条消息的片段（memrelay 调用痕迹判断）。 */
  tailParts(sessionId: string): Array<{ text: string | null; json: string | null }> {
    return this.q(
      `SELECT p.text AS text, p.json AS json
       FROM messages m JOIN parts p ON p.message_id = m.id
       WHERE m.session_id = ?
         AND m.ordinal >= (SELECT MAX(ordinal) FROM messages WHERE session_id = ?) - 3
       ORDER BY m.ordinal, p.idx`,
    ).all(sessionId, sessionId) as Array<{ text: string | null; json: string | null }>;
  }

  /** 带续接标记的片段文本（接力链标记）。 */
  markerTexts(sessionId: string): string[] {
    const rows = this.q(
      `SELECT p.text AS text FROM messages m JOIN parts p ON p.message_id = m.id
       WHERE m.session_id = ? AND p.text LIKE '%【MemRelay 续接】%'
       ORDER BY m.ordinal, p.idx`,
    ).all(sessionId) as Array<{ text: string }>;
    return rows.map((r) => r.text);
  }
}

/** 用库里的投影数据算出一个会话的排序信号（与读文件路径共用同一套打分）。 */
function signalsFromStore(
  q: StoreQueries,
  sessionId: string,
  title: string | null,
  mtimeMs: number,
  now: number,
  manualStatus?: (id: string) => SessionStatus | undefined,
): RankSignals {
  // —— 用户指令（isUserPrompt 的 user 消息）——
  const byOrdinal = new Map<number, string[]>();
  for (const r of q.userTextParts(sessionId)) {
    const list = byOrdinal.get(r.ordinal) ?? [];
    list.push(r.text);
    byOrdinal.set(r.ordinal, list);
  }
  const toolResultOrds = q.userToolResultOrdinals(sessionId);
  const isUserPromptOrd = (ordinal: number): boolean =>
    byOrdinal.has(ordinal) && !toolResultOrds.has(ordinal);
  const userInstructions: string[] = [];
  for (const [ordinal, texts] of byOrdinal) {
    if (!isUserPromptOrd(ordinal)) continue; // 混合了工具结果的 user 记录不算指令
    const text = texts
      .map((t) => t.trim())
      .filter(Boolean)
      .join("\n\n");
    if (text) userInstructions.push(text);
  }

  // —— 最后几段助手回复 ——
  const assistantGroups = new Map<number, Array<{ kind: string; text: string | null }>>();
  for (const p of q.assistantTailParts(sessionId)) {
    const list = assistantGroups.get(p.ordinal) ?? [];
    list.push({ kind: p.kind, text: p.text });
    assistantGroups.set(p.ordinal, list);
  }
  const assistantOrds = [...assistantGroups.keys()].sort((a, b) => a - b);
  const lastAssistantParts =
    assistantOrds.length > 0 ? assistantGroups.get(assistantOrds[assistantOrds.length - 1]!)! : [];
  const lastAssistantHasTool = lastAssistantParts.some(
    (p) => p.kind === "tool_call" || p.kind === "file_edit" || p.kind === "plan",
  );
  const lastAssistantOwnText = lastAssistantParts
    .filter((p) => p.kind === "text" && p.text?.trim())
    .map((p) => p.text!.trim())
    .join("\n");
  const last6Joined = assistantOrds.map((ordinal) =>
    assistantGroups
      .get(ordinal)!
      .map((p) => p.text ?? "")
      .join(" "),
  );

  // —— 状态窗口（与 analyzeStatus 的 slice(-8) 一致）——
  const windowMessages: LocalMessage[] = [];
  {
    const groups = new Map<number, ReturnType<StoreQueries["windowParts"]>>();
    for (const r of q.windowParts(sessionId)) {
      const list = groups.get(r.ordinal) ?? [];
      list.push(r);
      groups.set(r.ordinal, list);
    }
    for (const [ordinal, rows] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      const parts: Part[] = rows.map((r) => ({
        kind: r.kind as Part["kind"],
        text: r.text ?? undefined,
        status: r.status === "error" ? "error" : r.status === "ok" ? "ok" : undefined,
        toolCallId: r.toolCallId ?? undefined,
      }));
      windowMessages.push({
        uuid: `db-${ordinal}`,
        role: rows[0]!.role as LocalMessage["role"],
        isSidechain: false,
        isCompactBoundary: rows[0]!.compact === 1,
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
      });
    }
  }
  const windowInfo = analyzeStatus(windowMessages);
  const lastRealRow = q.lastReal(sessionId);
  const lastRealRole =
    lastRealRow === undefined ? undefined : (lastRealRow.role as "user" | "assistant" | "system");
  const statusInfo: StatusInfo = {
    pendingToolCallIds: q.pendingToolCallIds(sessionId),
    lastToolError: windowInfo.lastToolError,
    // 原始口径：只有"真"用户指令（user 且有文本、无工具结果）打在最末才算未回答
    lastUserMessageUnanswered:
      lastRealRow?.role === "user" && isUserPromptOrd(lastRealRow.ordinal),
    quotaOrLimitDetected: windowInfo.quotaOrLimitDetected,
    errorDetected: windowInfo.errorDetected,
    lastAssistantText: windowInfo.lastAssistantText,
  };

  // —— 待办与"完成"判定 ——
  const todos = extractTodosFromPlanParts(q.planParts(sessionId));
  let lastAssistantText5000: string | undefined;
  for (let i = assistantOrds.length - 1; i >= 0; i--) {
    const text = assistantGroups
      .get(assistantOrds[i]!)!
      .filter((p) => p.kind === "text" && p.text)
      .map((p) => p.text!)
      .join("\n")
      .trim();
    if (text) {
      lastAssistantText5000 = text.length > 5000 ? text.slice(0, 5000) : text;
      break;
    }
  }
  const summary: StatusSummary = {
    statusInfo,
    lastReal: lastRealRole,
    unfinishedTodos: todos.some((t) => t.status === "pending" || t.status === "in_progress"),
    lastAssistantText: lastAssistantText5000,
    lastAssistantFinal: Boolean(lastAssistantOwnText) && !lastAssistantHasTool,
  };
  const status = manualStatus?.(sessionId) ?? decideStatusFromSummary(summary, mtimeMs, now);

  // —— 其它信号 ——
  const memrelayCall = q
    .tailParts(sessionId)
    .some((p) => partLooksLikeMemrelayCall(p.text ?? undefined, p.json));

  return {
    statusInfo,
    status,
    keywordText: [
      title ?? "",
      statusInfo.lastAssistantText ?? "",
      ...userInstructions,
      ...last6Joined,
    ].join("\n"),
    touchedFiles: q.touchedFiles(sessionId),
    marker: markerFromTexts(q.markerTexts(sessionId)),
    memrelayCall,
    hasContent: q.hasContent(sessionId),
  };
}

export interface FastRankInput {
  env: Env;
  projectRoot: string;
  filters: Filters;
  adapters: SerializedJsonlAdapter[];
  rank: RankOptions;
  manualStatus?: (id: string) => SessionStatus | undefined;
}

/**
 * 尝试用索引库快速排出候选。返回 undefined 表示应落回全量扫盘：
 * 库缺失 / 打不开 / 一个可读会话都没有 / 现场重排的文件过多。
 */
export async function tryRankFromStore(input: FastRankInput): Promise<RankedSession[] | undefined> {
  const { env, projectRoot, filters, adapters, rank } = input;
  let db: DatabaseSync;
  try {
    db = openReadOnly(env);
  } catch {
    return undefined; // 库缺失或版本太新：交给全量扫盘
  }

  try {
    const queries = new StoreQueries(db);
    const storeRows = loadStoreRows(db, env.platform);
    const ranked: RankedSession[] = [];
    let fileRanked = 0;

    for (const adapter of adapters) {
      const files = await adapter.listProjectFiles({ projectRoot, cwd: projectRoot }, env);
      for (const file of files) {
        const key = normalizePathForCompare(file, env.platform);
        const row = storeRows.get(key);
        if (row) storeRows.delete(key);
        let st: fs.Stats | undefined;
        try {
          st = fs.statSync(file);
        } catch {
          st = undefined; // 伪路径（如 Cursor 的 state.vscdb#<composerId>）没有可 stat 的文件
        }
        if (st && st.size === 0) continue;

        if (row && row.agent === adapter.agent && st) {
          // 项目确认与 scanProject 一致：有 cwd 时必须在项目目录里
          if (row.cwd && !isPathInside(row.cwd, projectRoot, env.platform)) continue;
          const fresh =
            row.srcVersion === adapter.version &&
            row.srcSize === st.size &&
            row.srcMtime === Math.round(st.mtimeMs);
          if (fresh) {
            const signals = signalsFromStore(
              queries,
              row.id,
              row.title,
              st.mtimeMs,
              rank.now,
              input.manualStatus,
            );
            const scan: SessionScan = {
              id: row.id,
              agent: row.agent as SessionScan["agent"],
              sourcePath: file,
              cwd: row.cwd ?? undefined,
              gitBranch: row.gitBranch ?? undefined,
              startedAt: row.startedAt ?? undefined,
              mtimeMs: st.mtimeMs,
              sizeBytes: st.size,
              tail: {
                statusInfo: signals.statusInfo,
                hasActiveLeaf: false,
                lastTitle: row.title ?? undefined,
                lastTimestamp: row.endedAt ?? undefined,
                memrelayCalledRecently: signals.memrelayCall,
              },
            };
            ranked.push(rankFromSignals(scan, signals, rank));
            continue;
          }
        }

        // 库里没有或已过期：只重读这一个文件（只读，不写库；库由 hook / 用户命令更新）
        if (++fileRanked > MAX_FILE_RANKS) return undefined;
        const scan = await adapter.scanFile(file, env);
        if (!scan) continue;
        if (scan.cwd && !isPathInside(scan.cwd, projectRoot, env.platform)) continue;
        ranked.push(
          await buildRankedSession(adapter, scan, {
            keyword: rank.keyword,
            gitChangedFiles: rank.gitChangedFiles,
            now: rank.now,
            manualStatus: input.manualStatus,
            callerAgent: rank.callerAgent,
          }),
        );
      }
    }

    const visible = ranked.filter(
      (r) =>
        !isSessionDeleted(r.scan.id, filters) &&
        !(r.scan.cwd && isDirExcluded(r.scan.cwd, filters, env.platform)),
    );
    return visible.length === 0 ? undefined : visible; // 一个都没有：交给全量扫盘给出准确的空结果说明
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/** 全局兜底最多看多少个命中片段 / 会话（当前目录不是项目时用）。 */
const GLOBAL_HIT_LIMIT = 600;
const GLOBAL_RANK_LIMIT = 40;

export interface GlobalRankInput {
  env: Env;
  filters: Filters;
  rank: RankOptions;
  manualStatus?: (id: string) => SessionStatus | undefined;
  /** 排除当前目录（通常是调用方自己的会话或当前空项目里的残留） */
  excludeProjectRoot?: string;
}

/** 关键词命中的会话 → 命中文本（补进 keywordText，避免只命中旧片段时关键词分为 0）。 */
function globalKeywordHits(db: DatabaseSync, keyword: string): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  const add = (sessionId: string, text: string): void => {
    const list = hits.get(sessionId) ?? [];
    if (list.length < 6) list.push(text);
    hits.set(sessionId, list);
  };
  const queryParts = (table: "parts_fts" | "parts_cjk_fts", match: string | undefined): void => {
    if (!match) return;
    const rows = db
      .prepare(
        `SELECT m.session_id AS session_id, COALESCE(NULLIF(p.text, ''), p.json, '') AS text
         FROM ${table} f
         JOIN parts p ON p.id = f.rowid
         JOIN messages m ON m.id = p.message_id
         WHERE ${table} MATCH ?
         ORDER BY bm25(${table})
         LIMIT ?`,
      )
      .all(match, GLOBAL_HIT_LIMIT) as Array<{ session_id: string; text: string }>;
    for (const r of rows) add(r.session_id, r.text ?? "");
  };
  const { latin, cjk } = splitQuery(keyword);
  queryParts("parts_cjk_fts", buildMatch(cjk, "OR"));
  queryParts("parts_fts", buildMatch(latin, "AND"));

  // 生成的标题/首条指令可能不在 parts 里（或 FTS 分词没覆盖）
  const escaped = keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const like = `%${escaped}%`;
  const rows = db
    .prepare(
      `SELECT id AS session_id, COALESCE(title, '') || '\n' || COALESCE(first_user_message, '') AS text
       FROM sessions
       WHERE deleted_at IS NULL AND (title LIKE ? ESCAPE '\\' OR first_user_message LIKE ? ESCAPE '\\')
       LIMIT ?`,
    )
    .all(like, like, GLOBAL_HIT_LIMIT) as Array<{ session_id: string; text: string }>;
  for (const r of rows) add(r.session_id, r.text ?? "");
  return hits;
}

/**
 * 当前目录没有任何项目内会话时的兜底：按关键词查全库，返回其它项目里的候选。
 * 只在带关键词时使用；返回 undefined 表示库不可用，[] 表示全局也没有命中。
 */
export async function tryRankGloballyFromStore(
  input: GlobalRankInput,
): Promise<RankedSession[] | undefined> {
  const keyword = input.rank.keyword.trim();
  if (!keyword) return undefined;
  let db: DatabaseSync;
  try {
    db = openReadOnly(input.env);
  } catch {
    return undefined;
  }

  try {
    const queries = new StoreQueries(db);
    const hits = globalKeywordHits(db, keyword);
    const rows = [...loadStoreRows(db, input.env.platform).values()]
      .filter((row) => hits.has(row.id))
      .sort((a, b) => b.srcMtime - a.srcMtime)
      .slice(0, GLOBAL_RANK_LIMIT);

    const ranked: RankedSession[] = [];
    for (const row of rows) {
      if (isSessionDeleted(row.id, input.filters)) continue;
      if (row.cwd && isDirExcluded(row.cwd, input.filters, input.env.platform)) continue;
      if (
        row.cwd &&
        input.excludeProjectRoot &&
        isPathInside(row.cwd, input.excludeProjectRoot, input.env.platform)
      ) {
        continue;
      }
      let st: fs.Stats | undefined;
      try {
        st = fs.statSync(row.sourcePath);
      } catch {
        st = undefined; // 伪路径（Cursor 的 state.vscdb#<id> 等）用库里的元数据
      }
      const mtimeMs = st?.mtimeMs ?? row.srcMtime;
      const signals = signalsFromStore(
        queries,
        row.id,
        row.title,
        mtimeMs,
        input.rank.now,
        input.manualStatus,
      );
      const withHits: RankSignals = {
        ...signals,
        keywordText: [signals.keywordText, ...(hits.get(row.id) ?? [])].join("\n"),
      };
      const scan: SessionScan = {
        id: row.id,
        agent: row.agent as SessionScan["agent"],
        sourcePath: row.sourcePath,
        cwd: row.cwd ?? undefined,
        gitBranch: row.gitBranch ?? undefined,
        startedAt: row.startedAt ?? undefined,
        mtimeMs,
        sizeBytes: st?.size ?? row.srcSize,
        tail: {
          statusInfo: signals.statusInfo,
          hasActiveLeaf: false,
          lastTitle: row.title ?? undefined,
          lastTimestamp: row.endedAt ?? undefined,
          memrelayCalledRecently: signals.memrelayCall,
        },
      };
      ranked.push(rankFromSignals(scan, withHits, input.rank));
    }
    return ranked;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}
