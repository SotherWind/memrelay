import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import type { Env, Part, SessionRef } from "../core/types.js";
import type { SessionScan, SerializedJsonlAdapter } from "../adapters/jsonl-family/jsonl-adapter.js";
import { analyzeStatus, type LocalMessage } from "../adapters/jsonl-family/records.js";
import { normalizePathForCompare } from "../adapters/jsonl-family/parser.js";
import { findChainMarker, looksLikeContinuation } from "../resume/session-reader.js";
import { decideStatusFromSummary, summarizeMessagesWith } from "../resume/extract.js";
import { resolveProject } from "../core/project.js";
import { toCjkIndexText } from "../core/fts.js";
import { redactSecrets, SECRET_RULES_VERSION, containsSecrets } from "../core/secrets.js";
import { isDirExcluded, isSessionDeleted, loadFilters, type Filters } from "../core/filters.js";
import { sha256File } from "../core/hash.js";
import { checkpoint, dbPath, inTransaction, openWritable } from "./db.js";
import { enqueue } from "./queue.js";
import { prepareText, storeBlob } from "./ingest.js";
import { backfillSessionStats } from "./session-stats.js";
import { displayTitle } from "./titles.js";

export interface AgentStats {
  sessions: number;
  messages: number;
  parts: number;
  updated: number;
  skipped: number;
  failed: number;
}

export interface BuildStats {
  byAgent: Record<string, AgentStats>;
  updated: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

interface SourceRow {
  size: number;
  mtime_ms: number;
  last_offset: number;
  adapter_version: number;
}

function getSource(db: DatabaseSync, filePath: string): SourceRow | undefined {
  return db
    .prepare("SELECT size, mtime_ms, last_offset, adapter_version FROM sources WHERE path = ?")
    .get(filePath) as SourceRow | undefined;
}

/**
 * 增量规则：没变过就不重读；变小（截断）或适配器版本变了就整文件重读。
 * 变更的会话按"整文件重读 + 覆盖该会话的行"处理——分支回退等情况下，
 * 会话内容会整体重排，按偏移量硬拼会读到错误的进度，整读更稳。
 */
function shouldIndex(
  row: SourceRow | undefined,
  size: number,
  mtimeMs: number,
  adapterVersion: number,
): boolean {
  if (!row) return true;
  if (row.adapter_version !== adapterVersion) return true;
  if (size < row.last_offset) return true;
  if (size !== row.size) return true;
  // mtime 在库里有取整，比较时也要取整，否则每次都会误判"已变更"
  if (Math.round(mtimeMs) !== row.mtime_ms) return true;
  return false;
}

function upsertSource(
  db: DatabaseSync,
  agent: string,
  filePath: string,
  size: number,
  mtimeMs: number,
  adapterVersion: number,
): void {
  let hash: string | null = null;
  try {
    hash = sha256File(filePath);
  } catch {
    hash = null;
  }
  db.prepare(
    `INSERT INTO sources (agent, path, size, mtime_ms, hash, last_offset, adapter_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       agent=excluded.agent, size=excluded.size, mtime_ms=excluded.mtime_ms,
       hash=excluded.hash, last_offset=excluded.last_offset, adapter_version=excluded.adapter_version`,
  ).run(agent, filePath, size, Math.round(mtimeMs), hash, size, adapterVersion);
}

function deleteSessionRows(db: DatabaseSync, sessionId: string): void {
  const partIds = db
    .prepare(
      "SELECT p.id AS id FROM parts p JOIN messages m ON p.message_id = m.id WHERE m.session_id = ?",
    )
    .all(sessionId) as Array<{ id: number }>;
  const delFts = db.prepare("DELETE FROM parts_fts WHERE rowid = ?");
  const delCjk = db.prepare("DELETE FROM parts_cjk_fts WHERE rowid = ?");
  for (const { id } of partIds) {
    delFts.run(id);
    delCjk.run(id);
  }
  db.prepare("DELETE FROM secret_findings WHERE session_id = ?").run(sessionId);
  db.prepare("DELETE FROM task_sessions WHERE session_id = ?").run(sessionId);
  db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

function insertPart(
  db: DatabaseSync,
  messageId: number,
  idx: number,
  part: Part,
  sessionId: string,
): void {
  const prepared = prepareText(part.text);
  let blobSha: string | null = null;
  if (prepared.blobContent !== undefined) {
    blobSha = storeBlob(db, prepared.blobContent);
  }
  const jsonText =
    part.json === undefined ? null : typeof part.json === "string" ? part.json : safeJson(part.json);
  const jsonPrepared = prepareText(jsonText ?? undefined);
  if (jsonPrepared.blobContent !== undefined && blobSha === null) {
    blobSha = storeBlob(db, jsonPrepared.blobContent);
  }
  const info = db
    .prepare(
      `INSERT INTO parts (message_id, idx, kind, text, json, tool_name, tool_category, tool_call_id, status, blob_sha256, truncated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      messageId,
      idx,
      part.kind,
      prepared.text,
      jsonPrepared.text,
      part.toolName ?? null,
      part.toolCategory ?? null,
      part.toolCallId ?? null,
      part.status ?? null,
      blobSha,
      prepared.truncated || jsonPrepared.truncated ? 1 : 0,
    );
  const partId = Number(info.lastInsertRowid);

  // 全文索引只收"人话"：正文、工具结果、文件改动、计划、工具调用参数；
  // 思考与系统事件（技能清单、提示词包裹）不进索引，避免搜索命中一堆 JSON 噪声。
  let ftsText = "";
  if (
    part.kind === "text" ||
    part.kind === "tool_result" ||
    part.kind === "file_edit" ||
    part.kind === "plan" ||
    part.kind === "compaction_summary"
  ) {
    ftsText = prepared.text;
  } else if (part.kind === "tool_call") {
    ftsText = [part.toolName ?? "", jsonPrepared.text].filter(Boolean).join(" ");
  }
  if (ftsText) {
    db.prepare("INSERT INTO parts_fts (rowid, text) VALUES (?, ?)").run(partId, ftsText);
    db.prepare("INSERT INTO parts_cjk_fts (rowid, text) VALUES (?, ?)").run(
      partId,
      toCjkIndexText(ftsText),
    );
  }

  if (prepared.text && containsSecrets(prepared.text)) {
    const { findings } = redactSecrets(prepared.text);
    const insertFinding = db.prepare(
      `INSERT INTO secret_findings (session_id, message_id, part_id, rule_id, rules_version, preview)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const f of findings) {
      insertFinding.run(sessionId, messageId, partId, f.ruleId, SECRET_RULES_VERSION, f.preview);
    }
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function indexScan(
  db: DatabaseSync,
  adapter: SerializedJsonlAdapter,
  scan: SessionScan,
  env: Env,
  projectCache: Map<string, string>,
  now: number,
  filters: Filters,
): Promise<{ updated: boolean; messages: number; parts: number }> {
  const ref = toRef(scan);
  const row = getSource(db, scan.sourcePath);
  if (!shouldIndex(row, scan.sizeBytes, scan.mtimeMs, adapter.version)) {
    return { updated: false, messages: 0, parts: 0 };
  }

  const messages: LocalMessage[] = [];
  let rawRecords = 0;
  let sawSession = false;
  let sessionMeta: { cwd: string; gitBranch?: string; title?: string; startedAt: string; endedAt: string } = {
    cwd: scan.cwd ?? "",
    gitBranch: scan.gitBranch,
    startedAt: scan.startedAt ?? "",
    endedAt: "",
  };
  let firstUserMessage: string | undefined;

  for await (const event of adapter.readSession(ref)) {
    if (event.kind === "session") {
      sawSession = true;
      rawRecords = event.session.rawRecords ?? 0;
      sessionMeta = {
        cwd: event.session.cwd || scan.cwd || "",
        gitBranch: event.session.gitBranch,
        title: event.session.title ?? scan.tail.lastTitle,
        startedAt: event.session.startedAt || scan.startedAt || "",
        endedAt: event.session.endedAt,
      };
      firstUserMessage = event.session.firstUserMessage;
    } else if (event.kind === "message") {
      const m = event.message;
      const { toolCalls, toolResults } = rebuildCallsAndResults(m.parts);
      messages.push({
        uuid: m.nativeId ?? `ordinal-${m.ordinal}`,
        parentUuid: m.nativeParentId,
        role: m.role,
        timestamp: m.createdAt || undefined,
        isSidechain: m.isSidechain,
        isCompactBoundary: m.isCompactBoundary,
        parts: m.parts,
        toolCalls,
        toolResults,
        isUserPrompt: m.role === "user" && m.parts.some((p) => p.kind === "text" && p.text),
      });
    }
  }

  // 适配器读不动（库锁、坏 JSON、文件被删）时会静默结束：没有 session 事件就当这次没读到，
  // 保留旧索引、不更新 sources，下一次扫描还能重试。
  if (!sawSession) throw new Error("适配器没有产出会话元数据");
  if (rawRecords > 0 && messages.length === 0) {
    throw new Error(`会话有 ${rawRecords} 条原始记录但未解析出消息`);
  }

  const summary = summarizeMessagesWith(analyzeStatus(messages), messages);
  const status = decideStatusFromSummary(summary, scan.mtimeMs, now);
  const fileSet = new Set<string>();
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.kind !== "file_edit" || !p.text) continue;
      for (const line of p.text.split("\n")) {
        const file = line.trim();
        if (file) fileSet.add(file);
      }
    }
  }
  const projectRoot = resolveProjectCached(sessionMeta.cwd || scan.cwd || "", projectCache);
  const existingDeletedAt = (
    db.prepare("SELECT deleted_at FROM sessions WHERE id = ?").get(ref.id) as
      | { deleted_at?: string | null }
      | undefined
  )?.deleted_at;
  const hidden =
    isSessionDeleted(ref.id, filters) ||
    Boolean(existingDeletedAt) ||
    Boolean(sessionMeta.cwd && isDirExcluded(sessionMeta.cwd, filters, env.platform));
  const deletedAt = hidden ? (existingDeletedAt ?? new Date(now).toISOString()) : null;
  const parentSessionId = parentIdFor(
    db,
    findChainMarker(messages),
    projectRoot,
    firstUserMessage,
    sessionMeta.title,
    env.platform,
  );

  let partCount = 0;
  inTransaction(db, () => {
    deleteSessionRows(db, ref.id);
    db.prepare(
      `INSERT INTO sessions (id, agent, source_path, project_root, cwd, git_branch, title, first_user_message,
         started_at, ended_at, status, status_source, parent_session_id, deleted_at, raw_records,
         message_count, file_count, sig_pending, sig_quota, sig_error, sig_unanswered, sig_todos_open,
         sig_last_real, sig_reply_len)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ref.id,
      adapter.agent,
      scan.sourcePath,
      projectRoot,
      sessionMeta.cwd || null,
      sessionMeta.gitBranch ?? null,
      sessionMeta.title ?? null,
      firstUserMessage ?? null,
      sessionMeta.startedAt || null,
      sessionMeta.endedAt || null,
      status,
      parentSessionId,
      deletedAt,
      rawRecords,
      messages.length,
      fileSet.size,
      summary.statusInfo.pendingToolCallIds.length > 0 ? 1 : 0,
      summary.statusInfo.quotaOrLimitDetected ? 1 : 0,
      summary.statusInfo.errorDetected ? 1 : 0,
      summary.statusInfo.lastUserMessageUnanswered ? 1 : 0,
      summary.unfinishedTodos ? 1 : 0,
      summary.lastReal ?? null,
      // 0 = 最后一条助手消息不是收尾正文（带工具调用或无文本）
      summary.lastAssistantFinal
        ? Math.min(Math.max(summary.lastAssistantText?.length ?? 0, 1), 5000)
        : 0,
    );

    for (let mi = 0; mi < messages.length; mi++) {
      const m = messages[mi]!;
      const info = db
        .prepare(
          `INSERT INTO messages (session_id, ordinal, native_id, native_parent_id, role, created_at, is_sidechain, is_compact_boundary, on_current_branch)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          ref.id,
          mi + 1,
          m.uuid,
          m.parentUuid ?? null,
          m.role,
          m.timestamp ?? null,
          m.isSidechain ? 1 : 0,
          m.isCompactBoundary ? 1 : 0,
        );
      const messageId = Number(info.lastInsertRowid);
      m.parts.forEach((p, idx) => {
        insertPart(db, messageId, idx, p, ref.id);
        partCount++;
      });
    }
    if (hidden) {
      // 已删除/被排除的会话不再保留可外发的派生内容。
      db.prepare("DELETE FROM summaries WHERE session_id = ?").run(ref.id);
      db.prepare("DELETE FROM embeddings WHERE session_id = ?").run(ref.id);
    }
  });

  upsertSource(db, adapter.agent, scan.sourcePath, scan.sizeBytes, scan.mtimeMs, adapter.version);
  // 后台任务入队：向量回填 + 会话摘要（都是仅写库零网络，hook 路径也走这，静默契约不受影响）；
  // 启用于否都入队——drain 只在对应功能开启时运行，且按内容哈希对账跳过未变内容。
  // 已删除/被排除的会话不入队，避免内容被送到远端接口。
  if (!hidden) {
    enqueue(db, "embed_queue", ref.id, now);
    enqueue(db, "summary_queue", ref.id, now);
  }
  return { updated: true, messages: messages.length, parts: partCount };
}

function rebuildCallsAndResults(parts: Part[]): {
  toolCalls: LocalMessage["toolCalls"];
  toolResults: LocalMessage["toolResults"];
} {
  const toolCalls: LocalMessage["toolCalls"] = [];
  const toolResults: LocalMessage["toolResults"] = [];
  for (const p of parts) {
    if (p.kind === "tool_call" || p.kind === "file_edit" || p.kind === "plan") {
      toolCalls.push({
        toolCallId: p.toolCallId ?? "",
        toolName: p.toolName,
        category: p.toolCategory ?? "other",
        input: p.json,
        isPlan: p.kind === "plan",
        files: p.kind === "file_edit" && p.text ? p.text.split("\n") : [],
      });
    } else if (p.kind === "tool_result") {
      toolResults.push({
        toolCallId: p.toolCallId,
        content: p.text ?? "",
        isError: p.status === "error",
      });
    }
  }
  return { toolCalls, toolResults };
}

function resolveProjectCached(cwd: string, cache: Map<string, string>): string {
  if (!cwd) return "";
  const key = cwd.toLowerCase();
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let root = cwd;
  try {
    root = resolveProject(cwd).projectRoot;
  } catch {
    root = cwd;
  }
  cache.set(key, root);
  return root;
}

function toRef(scan: SessionScan): SessionRef {
  const { tail: _tail, ...ref } = scan;
  return ref;
}

function sameProject(
  a: string | null | undefined,
  b: string | null | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (!a || !b) return false;
  return normalizePathForCompare(a, platform) === normalizePathForCompare(b, platform);
}

/** 解析 parent_session_id：同项目直接接；跨项目要求首条指令确实是"继续/接着做"。 */
function parentIdFor(
  db: DatabaseSync,
  marker: ReturnType<typeof findChainMarker>,
  childProject: string,
  firstUserMessage: string | undefined,
  title: string | null | undefined,
  platform: NodeJS.Platform,
): string | null {
  if (!marker) return null;
  const parentId = `${marker.agent}:${marker.nativeId}`;
  const parent = db
    .prepare("SELECT project_root FROM sessions WHERE id = ?")
    .get(parentId) as { project_root?: string | null } | undefined;
  if (sameProject(parent?.project_root, childProject, platform)) return parentId;
  return looksLikeContinuation(firstUserMessage ?? title) ? parentId : null;
}

/** 接力链入库：把有 parent_session_id 的会话串成任务。 */
export function linkTasks(db: DatabaseSync): void {
  // 全量重建链接时放进一个事务，避免 UI 读到“链接表刚被清空”的中间态。
  inTransaction(db, () => linkTasksInTransaction(db));
}

function linkTasksInTransaction(db: DatabaseSync): void {
  const rows = db
    .prepare(
      "SELECT id, agent, parent_session_id, project_root, title, first_user_message, started_at FROM sessions",
    )
    .all() as Array<{
    id: string;
    agent: string;
    parent_session_id: string | null;
    project_root: string | null;
    title: string | null;
    first_user_message: string | null;
    started_at: string | null;
  }>;
  const byId = new Map(rows.map((r) => [r.id, r]));

  // 旧库清理：跨项目且首条指令不是"继续/接着做"的 parent 链接是误判
  // （典型：在项目 A 的会话里测试 memrelay resume，输出带了项目 B 的续接标记）。
  const clearParent = db.prepare("UPDATE sessions SET parent_session_id = NULL WHERE id = ?");
  for (const row of rows) {
    if (!row.parent_session_id) continue;
    const parent = byId.get(row.parent_session_id);
    if (!parent) continue;
    if (sameProject(row.project_root, parent.project_root, process.platform)) continue;
    if (looksLikeContinuation(row.first_user_message ?? row.title)) continue;
    clearParent.run(row.id);
    row.parent_session_id = null;
  }

  const rootMemo = new Map<string, string>();

  const rootOf = (id: string): string => {
    const cached = rootMemo.get(id);
    if (cached) return cached;
    const seen = new Set<string>();
    let current = id;
    while (true) {
      if (seen.has(current)) break;
      seen.add(current);
      const parent = byId.get(current)?.parent_session_id;
      if (!parent || !byId.has(parent)) break;
      current = parent;
    }
    rootMemo.set(id, current);
    return current;
  };

  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const root = rootOf(row.id);
    const list = groups.get(root) ?? [];
    list.push(row.id);
    groups.set(root, list);
  }

  // 接力链自动链接每次全量重建：链路缩短/父会话消失后，旧的 task_sessions 行不能残留。
  db.exec("DELETE FROM task_sessions");
  const findTaskOf = db.prepare(
    "SELECT task_id FROM task_sessions WHERE session_id = ? ORDER BY task_id LIMIT 1",
  );
  const delLinks = db.prepare("DELETE FROM task_sessions WHERE session_id = ?");
  const insLink = db.prepare(
    "INSERT OR REPLACE INTO task_sessions (task_id, session_id, position, link_source) VALUES (?, ?, ?, 'auto')",
  );
  const nowIso = new Date().toISOString();

  for (const [root, members] of groups) {
    if (members.length < 2) continue;
    const rootRow = byId.get(root)!;
    let taskId: number | undefined = (
      findTaskOf.get(root) as { task_id?: number } | undefined
    )?.task_id;
    if (taskId === undefined) {
      const info = db
        .prepare(
          "INSERT INTO tasks (name, project_root, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
        )
        .run(taskNameOf(rootRow), rootRow.project_root, nowIso, nowIso);
      taskId = Number(info.lastInsertRowid);
    } else {
      db.prepare("UPDATE tasks SET name = ?, project_root = ?, updated_at = ? WHERE id = ?").run(
        taskNameOf(rootRow),
        rootRow.project_root,
        nowIso,
        taskId,
      );
    }
    const ordered = members
      .map((id) => byId.get(id)!)
      .sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));
    ordered.forEach((row, position) => {
      delLinks.run(row.id);
      insLink.run(taskId, row.id, position);
    });
  }
  // 已被拆散/断链的任务行不再被任何会话引用，清掉避免无限累积。
  db.exec("DELETE FROM tasks WHERE id NOT IN (SELECT DISTINCT task_id FROM task_sessions)");
}

function taskNameOf(row: {
  agent: string;
  title: string | null;
  first_user_message: string | null;
  id: string;
}): string {
  const title = displayTitle({
    agent: row.agent,
    title: row.title,
    firstUser: row.first_user_message,
  });
  return (title ?? row.id).slice(0, 60);
}

export interface BuildIndexOptions {
  adapters: SerializedJsonlAdapter[];
  onProgress?: (message: string) => void;
  now?: number;
}

/** 派生数据（FTS 内容、表结构用法）变化时 +1：下次建索引会整库重建。 */
export const INDEXER_VERSION = 2;

function indexerVersionCurrent(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'indexer_version'")
    .get() as { value?: string } | undefined;
  return row?.value === String(INDEXER_VERSION);
}

function writeIndexerVersion(db: DatabaseSync): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('indexer_version', ?)").run(
    String(INDEXER_VERSION),
  );
}

/**
 * 全量建索引专用：版本不一致时整库重建。
 * hook 的单会话路径绝不能走这里——它只能索引一个文件，清空后其余会话会变成空壳。
 */
function ensureIndexerVersion(db: DatabaseSync): void {
  if (indexerVersionCurrent(db)) return;
  inTransaction(db, () => {
    db.exec("DELETE FROM messages"); // 级联删 parts
    db.exec("DELETE FROM parts_fts");
    db.exec("DELETE FROM parts_cjk_fts");
    db.exec("DELETE FROM secret_findings");
    db.exec("DELETE FROM task_sessions");
    db.exec("DELETE FROM tasks");
    db.exec("DELETE FROM summaries"); // 派生内容随消息一起重建
    db.exec("DELETE FROM embeddings");
    db.exec("UPDATE sources SET adapter_version = 0"); // 强制全部重解析
    writeIndexerVersion(db);
  });
}

/**
 * hook 的单会话路径：新版索引器需要重建时只跳过本次增量，等用户运行
 * doctor/ui/setup 做全量重建；空库则直接记录版本后正常索引。
 */
function canIndexOneScan(db: DatabaseSync): boolean {
  if (indexerVersionCurrent(db)) return true;
  const row = db
    .prepare("SELECT (SELECT COUNT(*) FROM sessions) + (SELECT COUNT(*) FROM sources) AS n")
    .get() as { n?: number } | undefined;
  if (Number(row?.n ?? 0) > 0) return false;
  writeIndexerVersion(db);
  return true;
}

/**
 * 建立/更新索引。只在用户命令（setup / doctor / ui）里调用；
 * agent 调用的 resume / show / search 只以只读方式打开数据库。
 */
export async function buildIndex(env: Env, opts: BuildIndexOptions): Promise<BuildStats> {
  const started = Date.now();
  const now = opts.now ?? started;
  const db = openWritable(env);
  const stats: BuildStats = { byAgent: {}, updated: 0, skipped: 0, failed: 0, durationMs: 0 };
  const projectCache = new Map<string, string>();
  const filters = loadFilters(env);

  try {
    ensureIndexerVersion(db);
    backfillSessionStats(db, { onProgress: opts.onProgress });
    for (const adapter of opts.adapters) {
      const detection = await adapter.detect(env);
      const agentStats: AgentStats = { sessions: 0, messages: 0, parts: 0, updated: 0, skipped: 0, failed: 0 };
      stats.byAgent[adapter.agent] = agentStats;
      if (!detection.installed) continue;

      let scans: SessionScan[] = [];
      try {
        scans = await adapter.scanAll(env);
      } catch (err) {
        agentStats.failed++;
        opts.onProgress?.(`${adapter.agent}: 扫描失败 ${err instanceof Error ? err.message : err}`);
        continue;
      }
      agentStats.sessions = scans.length;

      for (const scan of scans) {
        try {
          const result = await indexScan(db, adapter, scan, env, projectCache, now, filters);
          agentStats.messages += result.messages;
          agentStats.parts += result.parts;
          if (result.updated) {
            agentStats.updated++;
            stats.updated++;
          } else {
            agentStats.skipped++;
            stats.skipped++;
          }
        } catch (err) {
          agentStats.failed++;
          stats.failed++;
          if (stats.failed <= 5) {
            opts.onProgress?.(
              `${adapter.agent} 会话解析失败：${scan.sourcePath}（${err instanceof Error ? err.message : err}）`,
            );
          }
        }
      }
    }

    linkTasks(db);
    checkpoint(db);

    // 补充各 agent 的库内总量（跳过的不再重读，总量从库里取）
    for (const [agent, agentStats] of Object.entries(stats.byAgent)) {
      const totals = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM sessions WHERE agent = ?) AS sessions,
             (SELECT COUNT(*) FROM messages m JOIN sessions s ON m.session_id = s.id WHERE s.agent = ?) AS messages,
             (SELECT COUNT(*) FROM parts p JOIN messages m ON p.message_id = m.id JOIN sessions s ON m.session_id = s.id WHERE s.agent = ?) AS parts`,
        )
        .get(agent, agent, agent) as { sessions: number; messages: number; parts: number };
      agentStats.sessions = totals.sessions;
      agentStats.messages = totals.messages;
      agentStats.parts = totals.parts;
    }
  } finally {
    db.close();
  }
  stats.durationMs = Date.now() - started;
  return stats;
}

/** 供 doctor 使用：库文件是否存在。 */
export function storeExists(env: Env): boolean {
  try {
    fs.statSync(dbPath(env));
    return true;
  } catch {
    return false;
  }
}

export interface IndexOneResult {
  updated: boolean;
  messages: number;
  parts: number;
}

/**
 * hook（Stop / SessionEnd）用：只增量索引一个会话文件。
 * 幂等：文件没变（size + mtime 一致）时什么都不做。出错由调用方决定是否静默。
 */
export async function indexOneScan(
  env: Env,
  adapter: SerializedJsonlAdapter,
  scan: SessionScan,
  now = Date.now(),
): Promise<IndexOneResult> {
  const db = openWritable(env);
  try {
    if (!canIndexOneScan(db)) return { updated: false, messages: 0, parts: 0 };
    const projectCache = new Map<string, string>();
    const filters = loadFilters(env);
    const result = await indexScan(db, adapter, scan, env, projectCache, now, filters);
    linkTasks(db);
    checkpoint(db);
    return result;
  } finally {
    db.close();
  }
}

export interface ParseDrift {
  sessionId: string;
  agent: string;
  rawRecords: number;
  messages: number;
}

/**
 * 解析完整性哨兵（doctor 用）。
 * 工具升级改了记录格式、适配器读不懂时，会出现"原始记录很多、解析出的消息极少"的会话。
 * 检查各 agent 最近 20 个会话；命中即提醒，避免"解析不报错但内容悄悄丢了"。
 * 只检查源文件还在的会话——原工具清理过的归档无法重解析，报了也没法修。
 */
export function findParseDrifts(db: DatabaseSync): ParseDrift[] {
  const rows = db
    .prepare(
      `WITH ranked AS (
         SELECT s.id AS id, s.agent AS agent, s.raw_records AS raw_records,
                s.source_path AS source_path,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS msgs,
                ROW_NUMBER() OVER (PARTITION BY s.agent ORDER BY s.started_at DESC) AS rn
         FROM sessions s
         WHERE s.deleted_at IS NULL
       )
       SELECT id, agent, raw_records, msgs, source_path FROM ranked
       WHERE rn <= 20 AND raw_records >= 30 AND msgs <= raw_records * 0.05`,
    )
    .all() as Array<{
    id: string;
    agent: string;
    raw_records: number;
    msgs: number;
    source_path: string | null;
  }>;
  const drifts: ParseDrift[] = [];
  for (const r of rows) {
    if (!r.source_path) continue;
    try {
      if (!fs.existsSync(r.source_path)) continue; // 只剩归档，无法重解析
    } catch {
      continue;
    }
    drifts.push({
      sessionId: r.id,
      agent: r.agent,
      rawRecords: r.raw_records,
      messages: r.msgs,
    });
  }
  return drifts;
}
