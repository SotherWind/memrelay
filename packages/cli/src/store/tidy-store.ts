import type { DatabaseSync } from "node:sqlite";

import { hostOf } from "../core/embeddings.js";
import { sha256 } from "../core/hash.js";
import type { ChatConfig } from "../core/llm.js";
import { contentFingerprint, parseMemoryItems, scanMemorySources } from "../core/memory-sources.js";
import type { TidyConflict, TidyMaterial } from "../core/tidy-plan.js";
import type { Env } from "../core/types.js";
import { inTransaction } from "./db.js";

export type { TidyConflict } from "../core/tidy-plan.js";

export const TIDY_KEYS = {
  enabled: "tidy.enabled",
  baseUrl: "tidy.baseUrl",
  model: "tidy.model",
  apiKey: "tidy.apiKey",
  promptVersion: "tidy.promptVersion",
  lastError: "tidy.lastError",
  lastErrorAt: "tidy.lastErrorAt",
  lastRunAt: "tidy.lastRunAt",
  lastSuccessAt: "tidy.lastSuccessAt",
} as const;

function readKey(db: DatabaseSync, key: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value?: string | null }
    | undefined;
  return typeof row?.value === "string" ? row.value : "";
}

function writeKey(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

export function tidyEnabled(db: DatabaseSync): boolean {
  return readKey(db, TIDY_KEYS.enabled) === "1";
}

/** 开关 + 自己的接口三字段完整才可用。 */
export function resolveTidyConfig(db: DatabaseSync): ChatConfig | undefined {
  if (!tidyEnabled(db)) return undefined;
  const baseUrl = readKey(db, TIDY_KEYS.baseUrl).trim();
  const model = readKey(db, TIDY_KEYS.model).trim();
  const apiKey = readKey(db, TIDY_KEYS.apiKey).trim();
  if (!baseUrl || !model || !apiKey) return undefined;
  return { baseUrl, model, apiKey, host: hostOf(baseUrl) };
}

export function writeTidyError(db: DatabaseSync, message: string, now = Date.now()): void {
  writeKey(db, TIDY_KEYS.lastError, message);
  writeKey(db, TIDY_KEYS.lastErrorAt, new Date(now).toISOString());
}

export function clearTidyError(db: DatabaseSync): void {
  writeKey(db, TIDY_KEYS.lastError, "");
  writeKey(db, TIDY_KEYS.lastErrorAt, "");
}

export function readTidyPromptVersion(db: DatabaseSync): string {
  return readKey(db, TIDY_KEYS.promptVersion);
}

export function writeTidyPromptVersion(db: DatabaseSync, version: string): void {
  writeKey(db, TIDY_KEYS.promptVersion, version);
}

export function recordTidyRun(db: DatabaseSync, success: boolean, now = Date.now()): void {
  const iso = new Date(now).toISOString();
  writeKey(db, TIDY_KEYS.lastRunAt, iso);
  if (success) writeKey(db, TIDY_KEYS.lastSuccessAt, iso);
}

// ————————————————————————————————————————————————————————————————
// 来源导入
// ————————————————————————————————————————————————————————————————

export interface TidyImportResult {
  changed: number;
  files: number;
  items: number;
}

/** 只读扫描 → 变化文件重建条目；消失的来源删除。 */
export function importMemorySources(db: DatabaseSync, env: Env, now = Date.now()): TidyImportResult {
  const files = scanMemorySources(env);
  let changed = 0;
  inTransaction(db, () => {
    const seen = new Set<string>();
    const upsertSource = db.prepare(
      `INSERT INTO memory_sources (path, tool, scope, fingerprint, mtime_ms, imported_at, error)
       VALUES (?, ?, 'global', ?, ?, ?, NULL)
       ON CONFLICT(path) DO UPDATE SET
         tool = excluded.tool, fingerprint = excluded.fingerprint,
         mtime_ms = excluded.mtime_ms, imported_at = excluded.imported_at, error = NULL`,
    );
    const deleteItems = db.prepare("DELETE FROM memory_items WHERE path = ?");
    const insertItem = db.prepare(
      "INSERT OR IGNORE INTO memory_items (path, heading, text, content_hash) VALUES (?, ?, ?, ?)",
    );
    for (const file of files) {
      seen.add(file.path);
      const fingerprint = contentFingerprint(file.content);
      const existing = db.prepare("SELECT fingerprint FROM memory_sources WHERE path = ?").get(file.path) as
        | { fingerprint: string }
        | undefined;
      if (existing?.fingerprint === fingerprint) continue;
      // 只有标题/只剩本功能标记块的文件不算来源（避免自己创建的下发文件形成回环）
      const items = parseMemoryItems(file.content);
      if (items.length === 0) {
        db.prepare("DELETE FROM memory_sources WHERE path = ?").run(file.path);
        continue;
      }
      deleteItems.run(file.path);
      // 先建来源行，再插条目（memory_items.path 外键指向 memory_sources）。
      upsertSource.run(
        file.path,
        file.tool,
        fingerprint,
        Math.round(file.mtimeMs),
        new Date(now).toISOString(),
      );
      for (const item of items) {
        insertItem.run(file.path, item.heading, item.text, sha256(item.text.toLowerCase()));
      }
      changed++;
    }
    const rows = db.prepare("SELECT path FROM memory_sources").all() as Array<{ path: string }>;
    for (const row of rows) {
      if (!seen.has(row.path)) db.prepare("DELETE FROM memory_sources WHERE path = ?").run(row.path);
    }
  });
  return { changed, files: files.length, items: countItems(db) };
}

export function countItems(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM memory_items").get() as { n: number };
  return Number(row.n);
}

/** 当前输入指纹：来源路径 → 内容指纹。用于"源没变就不重复花钱"。 */
export function readTidyInputs(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare("SELECT path, fingerprint FROM memory_sources ORDER BY path").all() as Array<{
    path: string;
    fingerprint: string;
  }>;
  return Object.fromEntries(rows.map((row) => [row.path, row.fingerprint]));
}

export function readTidyMaterials(db: DatabaseSync): TidyMaterial[] {
  const sources = db
    .prepare("SELECT path, tool FROM memory_sources ORDER BY tool, path")
    .all() as Array<{ path: string; tool: string }>;
  const byPath = new Map<string, TidyMaterial>();
  for (const source of sources) {
    byPath.set(source.path, { tool: source.tool, path: source.path, items: [] });
  }
  const rows = db
    .prepare("SELECT path, heading, text FROM memory_items ORDER BY path, id")
    .all() as Array<{ path: string; heading: string | null; text: string }>;
  for (const row of rows) {
    byPath.get(row.path)?.items.push({ heading: row.heading, text: row.text });
  }
  return [...byPath.values()].filter((source) => source.items.length > 0);
}

// ————————————————————————————————————————————————————————————————
// 计划
// ————————————————————————————————————————————————————————————————

export interface TidyPlan {
  status: "ready" | "conflict" | "applied" | "error";
  content: string;
  conflicts: TidyConflict[];
  inputs: Record<string, string>;
  model: string | null;
  host: string | null;
  updatedAt: string;
}

function parseConflicts(raw: string): TidyConflict[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: TidyConflict[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const topic = String((item as TidyConflict).topic ?? "").slice(0, 200);
      const question = String((item as TidyConflict).question ?? "").slice(0, 400);
      if (!topic && !question) continue;
      const rawOptions = Array.isArray((item as TidyConflict).options)
        ? (item as TidyConflict).options.map((option) => String(option).slice(0, 300).trim())
        : [];
      // 去重后不足两个不同选项，不构成“互斥选择”，不是冲突
      const options = [...new Set(rawOptions.filter(Boolean))].slice(0, 6);
      if (options.length < 2) continue;
      out.push({ topic, options, question });
      if (out.length >= 20) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function readTidyPlan(db: DatabaseSync): TidyPlan | null {
  const row = db.prepare("SELECT * FROM memory_plan WHERE id = 1").get() as
    | {
        status: TidyPlan["status"];
        content: string;
        conflicts: string;
        inputs: string;
        model: string | null;
        host: string | null;
        updated_at: string;
      }
    | undefined;
  if (!row) return null;
  let inputs: Record<string, string> = {};
  try {
    const parsed = JSON.parse(row.inputs) as unknown;
    if (parsed && typeof parsed === "object") inputs = parsed as Record<string, string>;
  } catch {
    /* 旧数据损坏时当作无输入 */
  }
  const conflicts = parseConflicts(row.conflicts);
  return {
    status: row.status === "conflict" && conflicts.length === 0 ? "applied" : row.status,
    content: row.content,
    conflicts,
    inputs,
    model: row.model,
    host: row.host,
    updatedAt: row.updated_at,
  };
}

export function writeTidyPlan(
  db: DatabaseSync,
  plan: Omit<TidyPlan, "updatedAt">,
  now = Date.now(),
): TidyPlan {
  const updatedAt = new Date(now).toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO memory_plan (id, status, content, conflicts, inputs, model, host, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    plan.status,
    plan.content,
    JSON.stringify(plan.conflicts),
    JSON.stringify(plan.inputs),
    plan.model,
    plan.host,
    updatedAt,
  );
  return { ...plan, updatedAt };
}

// ————————————————————————————————————————————————————————————————
// 下发记录
// ————————————————————————————————————————————————————————————————

export type TidyExportKind = "block" | "own-file" | "index";

export interface TidyExport {
  path: string;
  tool: string;
  kind: TidyExportKind;
  blockHash: string;
  writtenAt: string;
  backupPath: string | null;
  created: boolean;
}

export function listTidyExports(db: DatabaseSync): TidyExport[] {
  const rows = db
    .prepare("SELECT * FROM memory_exports ORDER BY tool, path")
    .all() as Array<{
    path: string;
    tool: string;
    kind: TidyExportKind;
    block_hash: string;
    written_at: string;
    backup_path: string | null;
    created: number;
  }>;
  return rows.map((row) => ({
    path: row.path,
    tool: row.tool,
    kind: row.kind,
    blockHash: row.block_hash,
    writtenAt: row.written_at,
    backupPath: row.backup_path,
    created: row.created === 1,
  }));
}

export function recordTidyExport(
  db: DatabaseSync,
  entry: Omit<TidyExport, "writtenAt">,
  now = Date.now(),
): void {
  db.prepare(
    `INSERT OR REPLACE INTO memory_exports (path, tool, kind, block_hash, written_at, backup_path, created)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.path,
    entry.tool,
    entry.kind,
    entry.blockHash,
    new Date(now).toISOString(),
    entry.backupPath,
    entry.created ? 1 : 0,
  );
}

export function clearTidyExports(db: DatabaseSync): void {
  db.exec("DELETE FROM memory_exports");
}

// ————————————————————————————————————————————————————————————————
// 状态
// ————————————————————————————————————————————————————————————————

export interface TidySourceStatus {
  path: string;
  tool: string;
  items: number;
  fingerprint: string;
  importedAt: string;
}

export interface TidyStatus {
  enabled: boolean;
  configured: boolean;
  model: string;
  host: string | null;
  items: number;
  sources: TidySourceStatus[];
  plan: TidyPlan | null;
  exports: TidyExport[];
  lastRunAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export function tidyStatus(db: DatabaseSync): TidyStatus {
  const config = resolveTidyConfig(db);
  const rows = db
    .prepare(
      `SELECT s.path, s.tool, s.fingerprint, s.imported_at, COUNT(i.id) AS n
       FROM memory_sources s LEFT JOIN memory_items i ON i.path = s.path
       GROUP BY s.path ORDER BY s.tool, s.path`,
    )
    .all() as Array<{
    path: string;
    tool: string;
    fingerprint: string;
    imported_at: string;
    n: number;
  }>;
  return {
    enabled: tidyEnabled(db),
    configured: config !== undefined,
    model: config?.model ?? readKey(db, TIDY_KEYS.model).trim(),
    host: config?.host ?? null,
    items: countItems(db),
    sources: rows.map((row) => ({
      path: row.path,
      tool: row.tool,
      items: Number(row.n),
      fingerprint: row.fingerprint,
      importedAt: row.imported_at,
    })),
    plan: readTidyPlan(db),
    exports: listTidyExports(db),
    lastRunAt: readKey(db, TIDY_KEYS.lastRunAt) || null,
    lastError: readKey(db, TIDY_KEYS.lastError) || null,
    lastErrorAt: readKey(db, TIDY_KEYS.lastErrorAt) || null,
  };
}
