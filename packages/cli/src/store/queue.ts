import type { DatabaseSync } from "node:sqlite";

import { inTransaction } from "./db.js";

/**
 * 队列公共原语（设计文档 docs/llm-summary.md §5）：
 * embed_queue 与 summary_queue 共用同一套 claim 租约模式——
 * 入队 / 到期租约互斥 / 归还 / 出队 / 计数。
 * 只收表名白名单；表结构统一为 (session_id PK, enqueued_at, claimed_at)。
 */

export const QUEUE_TABLES = ["embed_queue", "summary_queue", "name_queue"] as const;
export type QueueTable = (typeof QUEUE_TABLES)[number];

function checkTable(table: string): QueueTable {
  if (!(QUEUE_TABLES as readonly string[]).includes(table)) {
    throw new Error(`未知队列表：${table}`);
  }
  return table as QueueTable;
}

/** drain 的 claim 租约：进程中断后过期即可被再次 claim（可中断续跑）。 */
export const CLAIM_LEASE_MS = 5 * 60 * 1000;

export function enqueue(db: DatabaseSync, table: QueueTable, sessionId: string, now = Date.now()): void {
  db.prepare(
    `INSERT INTO ${checkTable(table)} (session_id, enqueued_at, claimed_at) VALUES (?, ?, NULL)
     ON CONFLICT(session_id) DO UPDATE SET enqueued_at = excluded.enqueued_at, claimed_at = NULL`,
  ).run(sessionId, new Date(now).toISOString());
}

/** 入队但不动已在队列里的行：周期扫描/按需补名字时用，避免把在途 claim 重置。 */
export function enqueueOnce(
  db: DatabaseSync,
  table: QueueTable,
  sessionId: string,
  now = Date.now(),
): void {
  db.prepare(
    `INSERT OR IGNORE INTO ${checkTable(table)} (session_id, enqueued_at, claimed_at) VALUES (?, ?, NULL)`,
  ).run(sessionId, new Date(now).toISOString());
}

/** 全量入队（重新开启 / 换指纹重建）；内容哈希对账在各队列的 drain 里做。 */
export function enqueueAll(db: DatabaseSync, table: QueueTable, now = Date.now()): number {
  const info = db
    .prepare(
      `INSERT OR REPLACE INTO ${checkTable(table)} (session_id, enqueued_at, claimed_at)
       SELECT id, ?, NULL FROM sessions WHERE deleted_at IS NULL`,
    )
    .run(new Date(now).toISOString());
  return Number(info.changes);
}

export interface ClaimOptions {
  limit: number;
  sessionIds?: string[];
  projectRoot?: string;
  now?: number;
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(",");
}

function normalizeProject(project: string): string {
  return project.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** claim 事务互斥：ui 后台与 CLI 并发时各拿各的，不重复烧 API。 */
export function claim(db: DatabaseSync, table: QueueTable, opts: ClaimOptions): string[] {
  const t = checkTable(table);
  if (opts.sessionIds !== undefined && opts.sessionIds.length === 0) return [];
  const now = opts.now ?? Date.now();
  const leaseCutoff = new Date(now - CLAIM_LEASE_MS).toISOString();
  return inTransaction(db, () => {
    let sql = `SELECT q.session_id AS id, s.project_root AS project_root FROM ${t} q LEFT JOIN sessions s ON s.id = q.session_id`;
    const where = ["(q.claimed_at IS NULL OR q.claimed_at < ?)"];
    const args: Array<string | number> = [leaseCutoff];
    if (opts.sessionIds !== undefined) {
      where.push(`q.session_id IN (${placeholders(opts.sessionIds.length)})`);
      args.push(...opts.sessionIds);
    }
    sql += ` WHERE ${where.join(" AND ")} ORDER BY q.enqueued_at`;
    if (opts.projectRoot === undefined) {
      sql += " LIMIT ?";
      args.push(opts.limit);
    }
    const rows = db.prepare(sql).all(...args) as Array<{ id: string; project_root: string | null }>;

    const normalizedProject = normalizeProject(opts.projectRoot ?? "");
    const picked: string[] = [];
    for (const row of rows) {
      if (opts.projectRoot !== undefined && normalizeProject(row.project_root ?? "") !== normalizedProject) {
        continue;
      }
      picked.push(row.id);
      if (picked.length >= opts.limit) break;
    }
    if (picked.length > 0) {
      db.prepare(
        `UPDATE ${t} SET claimed_at = ? WHERE session_id IN (${placeholders(picked.length)})`,
      ).run(new Date(now).toISOString(), ...picked);
    }
    return picked;
  });
}

/** 处理失败 / 预算中止：归还 claim（清租约，下次可再拿）。 */
export function release(db: DatabaseSync, table: QueueTable, sessionId: string): void {
  db.prepare(`UPDATE ${checkTable(table)} SET claimed_at = NULL WHERE session_id = ?`).run(sessionId);
}

/**
 * 出队。带 claimedAt 时会校验租约仍是本次 claim 写入的值：
 * 处理期间若被重新入队（claimed_at 被清空），保留新队列行，避免丢掉最新内容。
 */
export function dequeue(db: DatabaseSync, table: QueueTable, sessionId: string, claimedAt?: string): void {
  const t = checkTable(table);
  if (claimedAt === undefined) {
    db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(sessionId);
    return;
  }
  db.prepare(`DELETE FROM ${t} WHERE session_id = ? AND claimed_at = ?`).run(sessionId, claimedAt);
}

export function pendingCount(db: DatabaseSync, table: QueueTable): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${checkTable(table)}`).get() as { n: number };
  return Number(row.n);
}

/**
 * 有界并发跑一批已 claim 的会话：worker 各自拉下一个，完成后不互相等待。
 * run 自行捕获异常并计数；stop() 为真时把尚未开始的项归还租约。
 */
export async function runBounded<T>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
  stop: () => boolean,
  releaseItem: (item: T) => void,
): Promise<void> {
  let cursor = 0;
  const workers = Math.max(1, Math.min(concurrency, items.length));
  await Promise.allSettled(
    Array.from({ length: workers }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        if (stop()) {
          releaseItem(items[index]!);
          continue;
        }
        await run(items[index]!);
      }
    }),
  );
}
