import type { DatabaseSync } from "node:sqlite";

import type { Env, SessionStatus } from "../core/types.js";
import {
  isDirExcluded,
  isSessionDeleted,
  loadFilters,
  manualStatusFor,
  type Filters,
} from "../core/filters.js";
import { searchSessions, type SearchSemanticHit } from "../store/search.js";
import { getSessionSummaries } from "../store/summaries-store.js";
import { getSessionNames } from "../store/names-store.js";
import { displayTitle } from "../store/titles.js";
import {
  computeSessionStats,
  MtimeResolver,
  statusFromSignals,
  type StoredSignals,
} from "../store/session-stats.js";

export interface SessionSummaryDto {
  id: string;
  tool: string;
  title: string | null;
  project: string;
  status: string;
  startedAt: string | null;
  lastActiveAt: number;
  messageCount: number;
  snippets: Array<{ ordinal: number; snippet: string }>;
  /** 会话摘要（AI，未开启/未生成时 null） */
  summary: string | null;
}

export interface MessagePartDto {
  kind: string;
  text: string | null;
  json: string | null;
  toolName: string | null;
  toolCategory: string | null;
  toolCallId: string | null;
  status: string | null;
  truncated: boolean;
}

export interface MessageDto {
  ordinal: number;
  role: string;
  createdAt: string | null;
  isCompactBoundary: boolean;
  parts: MessagePartDto[];
}

export interface SessionMessagesDto {
  session: SessionSummaryDto;
  messages: MessageDto[];
  total: number;
  from: number;
  hasMore: boolean;
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(",");
}

function titleOf(
  agent: string,
  title: string | null,
  firstUser: string | null,
  generated?: string | null,
): string | null {
  return displayTitle({ agent, title, firstUser, generated });
}

/**
 * 状态实时化所需列：信号（sig_*）+ 源文件路径与库里的 mtime。
 * message_count 的取值：回填过的直接用列值；没回填的按需现算（只影响展示的那几十行）。
 */
const STATUS_COLUMNS = `s.status AS stored_status, s.source_path AS source_path,
  s.message_count AS raw_count, COALESCE(src.mtime_ms, 0) AS mtime_ms,
  s.sig_pending, s.sig_quota, s.sig_error, s.sig_unanswered, s.sig_todos_open,
  s.sig_last_real, s.sig_reply_len,
  CASE WHEN s.message_count >= 0 THEN s.message_count
       ELSE (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) END AS message_count`;

interface StatusCarrier {
  id: string;
  storedStatus: string;
  sourcePath: string | null;
  mtimeMs: number;
  /** 库里的原始 message_count（-1 = 信号还没回填） */
  rawCount: number;
  signals: StoredSignals;
}

function signalsOf(row: Record<string, unknown>): StoredSignals {
  const lastReal = row["sig_last_real"];
  return {
    pending: Number(row["sig_pending"] ?? 0) === 1,
    quota: Number(row["sig_quota"] ?? 0) === 1,
    error: Number(row["sig_error"] ?? 0) === 1,
    unanswered: Number(row["sig_unanswered"] ?? 0) === 1,
    todosOpen: Number(row["sig_todos_open"] ?? 0) === 1,
    lastReal:
      lastReal === "user" || lastReal === "assistant" || lastReal === "system" ? lastReal : null,
    replyLen: Number(row["sig_reply_len"] ?? 0),
  };
}

function carrierOf(row: Record<string, unknown>): StatusCarrier {
  return {
    id: String(row["id"]),
    storedStatus: String(row["stored_status"]),
    sourcePath: typeof row["source_path"] === "string" ? row["source_path"] : null,
    mtimeMs: Number(row["mtime_ms"] ?? 0),
    rawCount: Number(row["raw_count"] ?? -1),
    signals: signalsOf(row),
  };
}

interface ResolvedSession {
  status: SessionStatus;
  mtimeMs: number;
}

/**
 * 实时状态：手动标记优先；其余用"库里的信号 + 最新 mtime（stat 校验）"在查询时刻重算，
 * 所以"进行中"会随着文件不再被写而自然降级成中断 / 完成 / 未判定。
 * 同时返回最新 mtime，让"最近活动"的显示/排序和状态用同一个口径。
 */
function resolveStatuses(
  db: DatabaseSync,
  filters: Filters,
  rows: StatusCarrier[],
  now: number,
): Map<string, ResolvedSession> {
  const missing = rows.filter((r) => r.rawCount < 0).map((r) => r.id);
  const computed = missing.length > 0 ? computeSessionStats(db, missing) : undefined;
  const resolver = new MtimeResolver(now);
  const out = new Map<string, ResolvedSession>();
  for (const row of rows) {
    const mtimeMs = resolver.resolve(row.sourcePath, row.mtimeMs, true);
    const manual = manualStatusFor(row.id, filters);
    if (manual) {
      out.set(row.id, { status: manual, mtimeMs });
      continue;
    }
    const signals = computed?.get(row.id) ?? row.signals;
    out.set(row.id, { status: statusFromSignals(signals, mtimeMs, now), mtimeMs });
  }
  return out;
}

/** 最近会话列表（消息数为 0 的空壳、已删除、被排除目录的都不展示）。 */
export function listRecentSessions(db: DatabaseSync, env: Env, limit = 100): SessionSummaryDto[] {
  const filters = loadFilters(env);
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT s.id, s.agent, s.title, s.first_user_message, s.project_root, s.started_at, s.cwd,
              ${STATUS_COLUMNS}
       FROM sessions s
       LEFT JOIN sources src ON src.path = s.source_path
       WHERE s.deleted_at IS NULL AND s.project_root IS NOT NULL AND s.project_root <> ''
       ORDER BY mtime_ms DESC`,
    )
    .iterate() as IterableIterator<Record<string, unknown>>;

  const visible: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (Number(row["message_count"] ?? 0) <= 0) continue;
    if (isSessionDeleted(String(row["id"]), filters)) continue;
    const cwd = typeof row["cwd"] === "string" ? row["cwd"] : "";
    if (cwd && isDirExcluded(cwd, filters, env.platform)) continue;
    visible.push(row);
    if (visible.length >= limit) break;
  }
  const resolved = resolveStatuses(db, filters, visible.map(carrierOf), now);
  const names = getSessionNames(db, visible.map((row) => String(row["id"])));
  const summaries = getSessionSummaries(db, visible.map((row) => String(row["id"])));

  return visible
    .map((row) => {
      const id = String(row["id"]);
      const live = resolved.get(id);
      return {
        id,
        tool: String(row["agent"]),
        title: titleOf(
          String(row["agent"]),
          typeof row["title"] === "string" ? row["title"] : null,
          typeof row["first_user_message"] === "string" ? row["first_user_message"] : null,
          names.get(id)?.name,
        ),
        project: String(row["project_root"]),
        status: live?.status ?? "unknown",
        startedAt: typeof row["started_at"] === "string" ? row["started_at"] : null,
        lastActiveAt: live?.mtimeMs ?? Number(row["mtime_ms"] ?? 0),
        messageCount: Number(row["message_count"] ?? 0),
        snippets: [],
        summary: summaries.get(id) ?? null,
      };
    })
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

/** 全局搜索（与 memrelay search 共用同一套 FTS / 融合 / 过滤）。 */
export function searchAllSessions(
  db: DatabaseSync,
  env: Env,
  query: string,
  limitSessions = 30,
  semantic?: SearchSemanticHit[],
): SessionSummaryDto[] {
  const results = searchSessions(db, {
    projectRoot: "",
    query,
    limitSessions,
    perSession: 3,
    env,
    semantic,
  });
  if (results.length === 0) return [];
  const filters = loadFilters(env);
  const ids = results.map((result) => result.session.id);
  const rows = db
    .prepare(
      `SELECT s.id, s.agent AS agent, s.first_user_message AS first_user_message, ${STATUS_COLUMNS}
       FROM sessions s
       LEFT JOIN sources src ON src.path = s.source_path
       WHERE s.id IN (${placeholders(ids.length)})`,
    )
    .all(...ids) as unknown as Array<Record<string, unknown>>;
  const byId = new Map(rows.map((row) => [String(row["id"]), row]));
  const statuses = resolveStatuses(
    db,
    filters,
    [...byId.values()].map(carrierOf),
    Date.now(),
  );

  const names = getSessionNames(db, results.map((result) => result.session.id));
  const summaries = getSessionSummaries(db, results.map((result) => result.session.id));
  return results.map((result) => {
    const row = byId.get(result.session.id);
    const firstUser = row?.["first_user_message"];
    const live = statuses.get(result.session.id);
    return {
      id: result.session.id,
      tool: result.session.agent,
      title: titleOf(
        result.session.agent,
        result.session.title,
        typeof firstUser === "string" ? firstUser : null,
        names.get(result.session.id)?.name,
      ),
      project: result.session.projectRoot ?? "",
      status: live?.status ?? result.session.status,
      startedAt: result.session.startedAt,
      lastActiveAt: live?.mtimeMs ?? Number(row?.["mtime_ms"] ?? 0),
      messageCount: Number(row?.["message_count"] ?? 0),
      snippets: result.matches.map((match) => ({ ordinal: match.ordinal, snippet: match.snippet })),
      summary: summaries.get(result.session.id) ?? null,
    };
  });
}

/** 一个会话的消息分页（只读库里的投影；超长片段在库里是"头尾 + 省略"形态）。 */
export function getSessionMessages(
  db: DatabaseSync,
  env: Env,
  sessionId: string,
  opts: { from?: number; limit?: number } = {},
): SessionMessagesDto | undefined {
  const filters = loadFilters(env);
  if (isSessionDeleted(sessionId, filters)) return undefined;
  const meta = db
    .prepare(
      `SELECT s.id, s.agent, s.title, s.first_user_message, s.project_root, s.started_at, s.cwd,
              ${STATUS_COLUMNS}
       FROM sessions s
       LEFT JOIN sources src ON src.path = s.source_path
       WHERE s.id = ? AND s.deleted_at IS NULL AND s.project_root IS NOT NULL AND s.project_root <> ''`,
    )
    .get(sessionId) as unknown as Record<string, unknown> | undefined;
  if (!meta) return undefined;
  const cwd = typeof meta["cwd"] === "string" ? meta["cwd"] : "";
  if (cwd && isDirExcluded(cwd, filters, env.platform)) return undefined;

  const total = Number(meta["message_count"] ?? 0);
  const from = Math.max(0, opts.from ?? 0);
  const limit = Math.min(Math.max(1, opts.limit ?? 40), 200);

  const live = resolveStatuses(db, filters, [carrierOf(meta)], Date.now()).get(String(meta["id"]));
  const name = getSessionNames(db, [String(meta["id"])]).get(String(meta["id"]))?.name;

  const session: SessionSummaryDto = {
    id: String(meta["id"]),
    tool: String(meta["agent"]),
    title: titleOf(
      String(meta["agent"]),
      typeof meta["title"] === "string" ? meta["title"] : null,
      typeof meta["first_user_message"] === "string" ? meta["first_user_message"] : null,
      name,
    ),
    project: String(meta["project_root"]),
    status: live?.status ?? "unknown",
    startedAt: typeof meta["started_at"] === "string" ? meta["started_at"] : null,
    lastActiveAt: live?.mtimeMs ?? Number(meta["mtime_ms"] ?? 0),
    messageCount: total,
    snippets: [],
    summary: getSessionSummaries(db, [String(meta["id"])]).get(String(meta["id"])) ?? null,
  };

  const ordinals = db
    .prepare("SELECT ordinal FROM messages WHERE session_id = ? ORDER BY ordinal LIMIT ? OFFSET ?")
    .all(sessionId, limit, from) as unknown as Array<{ ordinal: number }>;
  if (ordinals.length === 0) {
    return { session, messages: [], total, from, hasMore: false };
  }

  const rows = db
    .prepare(
      `SELECT m.ordinal AS ordinal, m.role AS role, m.created_at AS created_at,
              m.is_compact_boundary AS compact, p.kind AS kind, p.text AS text, p.json AS json,
              p.tool_name AS tool_name, p.tool_category AS tool_category,
              p.tool_call_id AS tool_call_id, p.status AS status, p.truncated AS truncated
       FROM messages m JOIN parts p ON p.message_id = m.id
       WHERE m.session_id = ? AND m.ordinal IN (${placeholders(ordinals.length)})
       ORDER BY m.ordinal, p.idx`,
    )
    .all(sessionId, ...ordinals.map((o) => o.ordinal)) as unknown as Array<Record<string, unknown>>;

  const byOrdinal = new Map<number, MessageDto>();
  for (const row of rows) {
    const ordinal = Number(row["ordinal"]);
    let message = byOrdinal.get(ordinal);
    if (!message) {
      message = {
        ordinal,
        role: String(row["role"]),
        createdAt: typeof row["created_at"] === "string" ? row["created_at"] : null,
        isCompactBoundary: Number(row["compact"] ?? 0) === 1,
        parts: [],
      };
      byOrdinal.set(ordinal, message);
    }
    message.parts.push({
      kind: String(row["kind"]),
      text: typeof row["text"] === "string" ? row["text"] : null,
      json: typeof row["json"] === "string" ? row["json"] : null,
      toolName: typeof row["tool_name"] === "string" ? row["tool_name"] : null,
      toolCategory: typeof row["tool_category"] === "string" ? row["tool_category"] : null,
      toolCallId: typeof row["tool_call_id"] === "string" ? row["tool_call_id"] : null,
      status: typeof row["status"] === "string" ? row["status"] : null,
      truncated: Number(row["truncated"] ?? 0) === 1,
    });
  }

  const messages = [...byOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal);
  return { session, messages, total, from, hasMore: from + ordinals.length < total };
}
