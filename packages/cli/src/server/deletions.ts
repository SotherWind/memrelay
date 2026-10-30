import type { DatabaseSync } from "node:sqlite";

import type { Env } from "../core/types.js";
import { loadFilters, mutateFilters } from "../core/filters.js";

export interface TrashItemDto {
  id: string;
  inIndex: boolean;
  title: string | null;
  project: string | null;
  tool: string | null;
  lastActiveAt: number;
  messageCount: number;
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === "string" && id.trim().length > 0))];
}

/** 已删除列表：filters.json 里的 id + 索引里还能查到的元数据。 */
export function listTrash(db: DatabaseSync, env: Env): TrashItemDto[] {
  const filters = loadFilters(env);
  const ids = filters.deletedSessions;
  const rows = new Map<
    string,
    {
      title: string | null;
      first_user_message: string | null;
      project_root: string | null;
      agent: string;
      mtime_ms: number;
      message_count: number;
    }
  >();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const found = db
      .prepare(
        `SELECT s.id AS id, s.title, s.first_user_message, s.project_root, s.agent,
                COALESCE(src.mtime_ms, 0) AS mtime_ms,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
         FROM sessions s LEFT JOIN sources src ON src.path = s.source_path
         WHERE s.id IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(...chunk) as Array<{
      id: string;
      title: string | null;
      first_user_message: string | null;
      project_root: string | null;
      agent: string;
      mtime_ms: number;
      message_count: number;
    }>;
    for (const row of found) rows.set(String(row.id), row);
  }
  return ids.map((id) => {
    const row = rows.get(id);
    if (!row) {
      return { id, inIndex: false, title: null, project: null, tool: null, lastActiveAt: 0, messageCount: 0 };
    }
    const title = row.title?.trim() || row.first_user_message?.replace(/\s+/g, " ").trim().slice(0, 80) || null;
    return {
      id,
      inIndex: true,
      title,
      project: row.project_root,
      tool: row.agent,
      lastActiveAt: row.mtime_ms,
      messageCount: row.message_count,
    };
  });
}

/** 删除 = 记进 filters.json，并在库里落软删除标记；原工具的会话文件不动。 */
export function deleteSessions(env: Env, ids: string[], db?: DatabaseSync): number {
  const wanted = dedupe(ids);
  if (wanted.length === 0) return 0;
  let added = 0;
  mutateFilters(env, (filters) => {
    const set = new Set(filters.deletedSessions);
    for (const id of wanted) {
      if (!set.has(id)) {
        set.add(id);
        added++;
      }
    }
    return { ...filters, deletedSessions: [...set] };
  });
  if (db) {
    const now = new Date().toISOString();
    const mark = db.prepare("UPDATE sessions SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL");
    for (const id of wanted) mark.run(now, id);
  }
  return added;
}

/** 恢复 = 从 filters.json 移除，并清掉库里的软删除标记。 */
export function restoreSessions(env: Env, ids: string[], db?: DatabaseSync): number {
  const wanted = new Set(dedupe(ids));
  if (wanted.size === 0) return 0;
  let removed = 0;
  mutateFilters(env, (filters) => {
    const kept = filters.deletedSessions.filter((id) => {
      if (wanted.has(id)) {
        removed++;
        return false;
      }
      return true;
    });
    return { ...filters, deletedSessions: kept };
  });
  if (db) {
    const clear = db.prepare("UPDATE sessions SET deleted_at = NULL WHERE id = ?");
    for (const id of wanted) clear.run(id);
  }
  return removed;
}
