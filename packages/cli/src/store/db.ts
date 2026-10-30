import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { currentEnv, memrelayDir } from "../core/env.js";
import type { Env } from "../core/types.js";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";

export class StoreTooNewError extends Error {
  constructor(found: number) {
    super(
      `索引库由更新版本的 MemRelay 写入（库版本 ${found}，本程序支持 ${SCHEMA_VERSION}）。请升级 memrelay 后再试。`,
    );
  }
}

export class StoreMissingError extends Error {
  constructor(file: string) {
    super(`索引库还不存在（${file}）。索引由用户命令（memrelay doctor 或 memrelay ui）建立。`);
  }
}

export function dbPath(env: Env = currentEnv()): string {
  return path.join(memrelayDir(env), "memrelay.db");
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

/** 按顺序执行迁移；每一步单独事务。未发版的 v1 增表用幂等建库语句补齐。 */
export function migrate(db: DatabaseSync): void {
  const current = readUserVersion(db);
  if (current > SCHEMA_VERSION) throw new StoreTooNewError(current);
  if (current === SCHEMA_VERSION) {
    inTransaction(db, () => db.exec(MIGRATIONS[0]!));
    return;
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    const sql = MIGRATIONS[v]!;
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

/** 写方式打开（建库、迁移、索引）。agent 命令不要用这个。 */
export function openWritable(env: Env = currentEnv()): DatabaseSync {
  const file = dbPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    // hook 与用户命令可能同时写：第二个写入方最多等 5 秒，而不是立刻报 SQLITE_BUSY
    db.exec("PRAGMA busy_timeout = 5000");
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/**
 * 只读打开（沙箱里的 agent 命令用）。
 * 只读模式下不能 migrate；库比程序新时拒绝，缺库时报 StoreMissingError。
 */
export function openReadOnly(env: Env = currentEnv()): DatabaseSync {
  const file = dbPath(env);
  if (!fs.existsSync(file)) throw new StoreMissingError(file);
  const db = new DatabaseSync(file, { readOnly: true });
  const current = readUserVersion(db);
  if (current > SCHEMA_VERSION) {
    db.close();
    throw new StoreTooNewError(current);
  }
  return db;
}

/** 索引写入结束后调用：把 WAL 合并回主库，方便沙箱里只读打开。 */
export function checkpoint(db: DatabaseSync): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    /* 尽力而为 */
  }
}

export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
