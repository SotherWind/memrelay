import type { DatabaseSync } from "node:sqlite";

import type { Env } from "../core/types.js";
import { isDirExcluded, isSessionDeleted, loadFilters, mutateFilters } from "../core/filters.js";

export interface SecretFindingDto {
  sessionId: string;
  ordinal: number | null;
  ruleId: string;
  preview: string;
  sessionTitle: string | null;
}

/** 检测到的密钥（只含遮盖后的预览；已删除 / 被排除目录的会话不再展示）。 */
export function listSecrets(db: DatabaseSync, env: Env, limit = 200): SecretFindingDto[] {
  const filters = loadFilters(env);
  const rows = db
    .prepare(
      `SELECT sf.session_id AS session_id, m.ordinal AS ordinal, sf.rule_id AS rule_id,
              sf.preview AS preview, s.title AS title, s.first_user_message AS first_user, s.cwd AS cwd
       FROM secret_findings sf
       LEFT JOIN messages m ON m.id = sf.message_id
       LEFT JOIN sessions s ON s.id = sf.session_id
       ORDER BY sf.id DESC`,
    )
    .iterate() as IterableIterator<Record<string, unknown>>;
  const out: SecretFindingDto[] = [];
  for (const row of rows) {
    const sessionId = String(row["session_id"]);
    if (isSessionDeleted(sessionId, filters)) continue;
    const cwd = typeof row["cwd"] === "string" ? row["cwd"] : "";
    if (cwd && isDirExcluded(cwd, filters, env.platform)) continue;
    const title =
      (typeof row["title"] === "string" ? row["title"].trim() : "") ||
      (typeof row["first_user"] === "string" ? row["first_user"].replace(/\s+/g, " ").trim().slice(0, 80) : "");
    out.push({
      sessionId,
      ordinal: typeof row["ordinal"] === "number" ? row["ordinal"] : null,
      ruleId: String(row["rule_id"]),
      preview: String(row["preview"]),
      sessionTitle: title || null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function getExclusions(env: Env): string[] {
  return loadFilters(env).excludedDirs;
}

/** 设置排除目录（保留删除记录与手动状态）。 */
export function setExclusions(env: Env, dirs: string[]): string[] {
  const cleaned = [...new Set(dirs.map((d) => d.trim()).filter(Boolean))];
  mutateFilters(env, (filters) => ({ ...filters, excludedDirs: cleaned }));
  return cleaned;
}
