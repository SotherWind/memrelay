import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { SessionStatus } from "./types.js";
import { memrelayDir, type currentEnv } from "./env.js";

export interface Filters {
  /** 排除的目录（前缀匹配，规范化后比较） */
  excludedDirs: string[];
  /** 已删除的会话 id */
  deletedSessions: string[];
  /** 用户手动设置的任务状态 */
  manualStatus: Record<string, SessionStatus>;
  /** 用户手动改的任务名（键 = 界面用的任务 id） */
  manualNames: Record<string, string>;
  /** 用户手动整理的接力链（每个数组是一条链，按顺序排列的会话 id）；链里的会话不再参与自动接力链 */
  manualChains: string[][];
}

export const EMPTY_FILTERS: Filters = {
  excludedDirs: [],
  deletedSessions: [],
  manualStatus: {},
  manualNames: {},
  manualChains: [],
};

export function filtersPath(env: ReturnType<typeof currentEnv>): string {
  return path.join(memrelayDir(env), "filters.json");
}

export function loadFilters(env: ReturnType<typeof currentEnv>): Filters {
  const file = filtersPath(env);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_FILTERS;
    return loadFiltersBackup(env);
  }
  try {
    return normalizeFilters(JSON.parse(raw) as Partial<Filters>);
  } catch {
    // 主文件损坏时退回最近一次成功写入的副本，避免删除/排除记录静默失效。
    return loadFiltersBackup(env);
  }
}

function loadFiltersBackup(env: ReturnType<typeof currentEnv>): Filters {
  try {
    const raw = fs.readFileSync(`${filtersPath(env)}.bak`, "utf8");
    return normalizeFilters(JSON.parse(raw) as Partial<Filters>);
  } catch {
    return EMPTY_FILTERS;
  }
}

function normalizeFilters(raw: Partial<Filters>): Filters {
  return {
    excludedDirs: Array.isArray(raw.excludedDirs) ? raw.excludedDirs.filter(isString) : [],
    deletedSessions: Array.isArray(raw.deletedSessions)
      ? raw.deletedSessions.filter(isString)
      : [],
    manualStatus:
      raw.manualStatus && typeof raw.manualStatus === "object" ? raw.manualStatus : {},
    manualNames:
      raw.manualNames && typeof raw.manualNames === "object"
        ? Object.fromEntries(
            Object.entries(raw.manualNames).filter(
              (entry): entry is [string, string] => isString(entry[1]),
            ),
          )
        : {},
    manualChains: Array.isArray(raw.manualChains)
      ? raw.manualChains
          .filter((chain): chain is string[] => Array.isArray(chain))
          .map((chain) => chain.filter(isString))
          .filter((chain) => chain.length > 0)
      : [],
  };
}

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function isDirExcluded(dir: string, filters: Filters, platform: NodeJS.Platform): boolean {
  if (!dir) return false;
  const target = normalize(dir, platform);
  return filters.excludedDirs.some((e) => {
    const excluded = normalize(e, platform);
    return target === excluded || target.startsWith(`${excluded}/`);
  });
}

export function isSessionDeleted(sessionId: string, filters: Filters): boolean {
  return filters.deletedSessions.includes(sessionId);
}

/**
 * 会话是否应被视为“不可见”：已删除、所在目录被排除，或库里已落软删除标记。
 * 展示、检索和任何会外发内容的 AI 链路都必须先过这一关。
 */
export function isSessionHidden(
  db: DatabaseSync,
  env: ReturnType<typeof currentEnv>,
  sessionId: string,
  filters: Filters = loadFilters(env),
): boolean {
  if (isSessionDeleted(sessionId, filters)) return true;
  const row = db
    .prepare("SELECT cwd, deleted_at FROM sessions WHERE id = ?")
    .get(sessionId) as { cwd?: string | null; deleted_at?: string | null } | undefined;
  if (row?.deleted_at) return true;
  if (!row?.cwd) return false;
  return isDirExcluded(row.cwd, filters, env.platform);
}

export function saveFilters(env: ReturnType<typeof currentEnv>, filters: Filters): void {
  const file = filtersPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = `${JSON.stringify(filters, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, file);
  // 保留最近一次成功写入的副本，主文件损坏时 loadFilters 能恢复。
  fs.writeFileSync(`${file}.bak`, payload, "utf8");
}

/** 读-改-写：保留其它字段（排除目录 / 手动状态），只动调用方要动的东西。 */
export function mutateFilters(
  env: ReturnType<typeof currentEnv>,
  mutate: (filters: Filters) => Filters,
): Filters {
  const next = mutate(loadFilters(env));
  saveFilters(env, next);
  return next;
}

export function manualStatusFor(
  sessionId: string,
  filters: Filters,
): SessionStatus | undefined {
  return filters.manualStatus[sessionId];
}

function normalize(p: string, platform: NodeJS.Platform): string {
  let out = path.resolve(p).replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  if (platform === "win32") out = out.toLowerCase();
  return out;
}
