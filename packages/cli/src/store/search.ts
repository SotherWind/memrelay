import type { DatabaseSync } from "node:sqlite";

import { currentEnv } from "../core/env.js";
import { splitQuery, buildMatch } from "../core/fts.js";
import { loadFilters, isDirExcluded, isSessionDeleted, type Filters } from "../core/filters.js";
import type { Env } from "../core/types.js";
import { chunkTextAt } from "./embeddings-store.js";

export interface SearchMatch {
  ordinal: number;
  snippet: string;
}

export interface SessionSearchResult {
  session: {
    id: string;
    agent: string;
    title: string | null;
    status: string;
    statusSource: string;
    startedAt: string | null;
    projectRoot: string | null;
  };
  matches: SearchMatch[];
}

/** 向量路的会话级命中（由查询侧语义通道给出，按余弦降序）。 */
export interface SearchSemanticHit {
  sessionId: string;
  cos: number;
  ordinal: number;
  chunkIx: number;
}

export interface SearchOptions {
  projectRoot: string;
  query: string;
  /** 最多返回多少个会话 */
  limitSessions?: number;
  /** 每个会话最多展示几段命中 */
  perSession?: number;
  env?: Env;
  /** 向量路（opt-in）；缺省 / 空 = 纯 FTS，结果与未开启语义时逐字一致 */
  semantic?: SearchSemanticHit[];
}

/** 会话级 RRF 融合常数（设计文档 §2.2）。 */
export const RRF_K = 60;

const SNIPPET_RADIUS = 48;

/** 在原文里取命中词附近的窗口做摘要（比 FTS snippet 好看，中文不会被切碎）。 */
function makeSnippet(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, " ");
  let best = -1;
  let bestTerm = "";
  const lower = flat.toLowerCase();
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx >= 0 && (best === -1 || idx < best)) {
      best = idx;
      bestTerm = term;
    }
  }
  if (best === -1) return flat.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, best - SNIPPET_RADIUS);
  const end = Math.min(flat.length, best + bestTerm.length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

interface RawHit {
  partId: number;
  text: string;
  sessionId: string;
  ordinal: number;
  /** bm25：越小越相关 */
  rank: number;
}

function queryIndex(
  db: DatabaseSync,
  table: "parts_fts" | "parts_cjk_fts",
  matchExpr: string,
  limit: number,
  normalizedProject: string,
): RawHit[] {
  const rows = db
    .prepare(
      `SELECT f.rowid AS part_id,
              COALESCE(NULLIF(p.text, ''), p.json, '') AS text,
              m.session_id AS session_id, m.ordinal AS ordinal,
              bm25(${table}) AS rank
       FROM ${table} f
       JOIN parts p ON p.id = f.rowid
       JOIN messages m ON m.id = p.message_id
       JOIN sessions s ON s.id = m.session_id
       WHERE ${table} MATCH ?
         AND (? = '' OR lower(replace(s.project_root, '\\', '/')) = ?)
       ORDER BY rank
       LIMIT ?`,
    )
    .all(matchExpr, normalizedProject, normalizedProject, limit) as Array<{
    part_id: number;
    text: string;
    session_id: string;
    ordinal: number;
    rank: number;
  }>;
  return rows.map((r) => ({
    partId: r.part_id,
    text: r.text ?? "",
    sessionId: r.session_id,
    ordinal: r.ordinal,
    rank: Number(r.rank),
  }));
}

/** 在当前项目的会话里搜索。只读数据库，可在沙箱里运行。 */
export function searchSessions(db: DatabaseSync, opts: SearchOptions): SessionSearchResult[] {
  const limitSessions = opts.limitSessions ?? 10;
  const perSession = opts.perSession ?? 2;
  const { latin, cjk } = splitQuery(opts.query);
  if (latin.length === 0 && cjk.length === 0) return [];

  const hits = new Map<number, RawHit>();
  const normalizedProject = (opts.projectRoot ?? "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  const cjkMatch = buildMatch(cjk, "OR");
  if (cjkMatch) {
    for (const h of queryIndex(db, "parts_cjk_fts", cjkMatch, 500, normalizedProject)) hits.set(h.partId, h);
  }
  const latinMatch = buildMatch(latin, "AND");
  if (latinMatch) {
    for (const h of queryIndex(db, "parts_fts", latinMatch, 500, normalizedProject)) hits.set(h.partId, h);
  }
  // FTS 一个都没命中时仍可能被向量路接住（问法与原文对不上正是语义召回的场景）
  if (hits.size === 0 && (!opts.semantic || opts.semantic.length === 0)) return [];

  // 取会话元数据并做过滤（项目、删除、目录排除）
  const sessionStmt = db.prepare(
    `SELECT id, agent, title, status, status_source, started_at, project_root, cwd, deleted_at
     FROM sessions WHERE id = ?`,
  );
  const env = opts.env ?? currentEnv();
  const filters = loadFilters(env);

  const bySession = new Map<
    string,
    { meta: SessionSearchResult["session"]; parts: RawHit[]; bestRank: number }
  >();
  for (const hit of hits.values()) {
    const row = sessionStmt.get(hit.sessionId) as
      | {
          id: string;
          agent: string;
          title: string | null;
          status: string;
          status_source: string;
          started_at: string | null;
          project_root: string | null;
          cwd: string | null;
          deleted_at: string | null;
        }
      | undefined;
    if (!row || row.deleted_at) continue;
    if (isSessionDeleted(row.id, filters)) continue;
    const proj = (row.project_root ?? "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
    if (normalizedProject && proj !== normalizedProject) continue;
    if (row.cwd && isDirExcluded(row.cwd, filters, env.platform)) continue;
    const entry = bySession.get(row.id) ?? {
      meta: {
        id: row.id,
        agent: row.agent,
        title: row.title,
        status: row.status,
        statusSource: row.status_source,
        startedAt: row.started_at,
        projectRoot: row.project_root,
      },
      parts: [],
      bestRank: Number.POSITIVE_INFINITY,
    };
    entry.parts.push(hit);
    entry.bestRank = Math.min(entry.bestRank, hit.rank);
    bySession.set(row.id, entry);
  }

  const terms = [...cjk, ...latin];
  const results = [...bySession.values()].map((entry) => {
    const seenSnippets = new Set<string>();
    const matches: SearchMatch[] = [];
    for (const p of entry.parts.sort((a, b) => a.rank - b.rank || a.ordinal - b.ordinal)) {
      const snippet = makeSnippet(p.text, terms);
      if (seenSnippets.has(snippet)) continue; // 同一段话被多个记录重复时只留一条
      seenSnippets.add(snippet);
      matches.push({ ordinal: p.ordinal, snippet });
      if (matches.length >= perSession) break;
    }
    return { session: entry.meta, matches };
  });

  // 先按相关度（bm25 聚合）排，再按时间做同分决胜。
  const bestRank = new Map<string, number>();
  for (const [sessionId, entry] of bySession) bestRank.set(sessionId, entry.bestRank);
  results.sort(
    (a, b) =>
      (bestRank.get(a.session.id) ?? Number.POSITIVE_INFINITY) -
        (bestRank.get(b.session.id) ?? Number.POSITIVE_INFINITY) ||
      (b.session.startedAt ?? "").localeCompare(a.session.startedAt ?? ""),
  );
  if (!opts.semantic || opts.semantic.length === 0) return results.slice(0, limitSessions);
  return fuseWithVector(db, results, opts.semantic, {
    limitSessions,
    filters,
    env,
    normalizedProject,
  });
}

/** 向量独有命中的摘要：从命中块文本截一段（无关键词可高亮，给开头窗口）。 */
function vectorSnippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 120 ? flat : `${flat.slice(0, 120)}…`;
}

/**
 * 会话级 RRF（k=60）融合 FTS 榜与向量榜（设计文档 §2.2）。
 * 两榜都有名的会话保留 FTS 命中；向量独有的会话补元数据 + 从命中块文本生成摘要。
 * 响应结构与纯 FTS 完全一致。
 */
function fuseWithVector(
  db: DatabaseSync,
  fts: SessionSearchResult[],
  semantic: SearchSemanticHit[],
  opts: { limitSessions: number; filters: Filters; env: Env; normalizedProject: string },
): SessionSearchResult[] {
  const ftsRank = new Map<string, number>();
  fts.forEach((r, i) => ftsRank.set(r.session.id, i + 1));

  const ordered = [...semantic].sort((a, b) => b.cos - a.cos);
  const vecRank = new Map<string, number>();
  const bestHit = new Map<string, SearchSemanticHit>();
  for (const hit of ordered) {
    if (vecRank.has(hit.sessionId)) continue;
    vecRank.set(hit.sessionId, vecRank.size + 1);
    bestHit.set(hit.sessionId, hit);
  }

  const merged = new Map<string, SessionSearchResult>(fts.map((r) => [r.session.id, r]));
  const sessionStmt = db.prepare(
    `SELECT id, agent, title, status, status_source, started_at, project_root, cwd, deleted_at
     FROM sessions WHERE id = ?`,
  );
  for (const [sessionId, hit] of bestHit) {
    if (merged.has(sessionId)) continue;
    const row = sessionStmt.get(sessionId) as
      | {
          id: string;
          agent: string;
          title: string | null;
          status: string;
          status_source: string;
          started_at: string | null;
          project_root: string | null;
          cwd: string | null;
          deleted_at: string | null;
        }
      | undefined;
    if (!row || row.deleted_at) continue;
    if (isSessionDeleted(row.id, opts.filters)) continue;
    const proj = (row.project_root ?? "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
    if (opts.normalizedProject && proj !== opts.normalizedProject) continue;
    if (row.cwd && isDirExcluded(row.cwd, opts.filters, opts.env.platform)) continue;
    const chunk = chunkTextAt(db, sessionId, hit.ordinal, hit.chunkIx);
    merged.set(sessionId, {
      session: {
        id: row.id,
        agent: row.agent,
        title: row.title,
        status: row.status,
        statusSource: row.status_source,
        startedAt: row.started_at,
        projectRoot: row.project_root,
      },
      matches: chunk ? [{ ordinal: hit.ordinal, snippet: vectorSnippet(chunk) }] : [],
    });
  }

  const rrf = (id: string): number => {
    const ftsR = ftsRank.get(id);
    const vecR = vecRank.get(id);
    return (ftsR !== undefined ? 1 / (RRF_K + ftsR) : 0) + (vecR !== undefined ? 1 / (RRF_K + vecR) : 0);
  };
  return [...merged.values()]
    .sort(
      (a, b) =>
        rrf(b.session.id) - rrf(a.session.id) ||
        (b.session.startedAt ?? "").localeCompare(a.session.startedAt ?? ""),
    )
    .slice(0, opts.limitSessions);
}
