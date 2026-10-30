import type { DatabaseSync } from "node:sqlite";

import { type ChatProvider } from "../core/llm.js";
import { redactSecrets } from "../core/secrets.js";
import { isSessionHidden, loadFilters } from "../core/filters.js";
import type { Env } from "../core/types.js";
import { claim, dequeue, pendingCount, release } from "./queue.js";
import { resolveChatConfig, resolveSummaryRuntimeConfig, summaryEnabled } from "./summaries-store.js";
import {
  cleanTitleText as cleanText,
  isContinuationMeta,
  isLowSignalTitle as isLowSignal,
  stripContinuationPrefix,
} from "./titles.js";

/**
 * AI 任务名：每个会话生成一次并持久化，任务投影取根会话的名字。
 * 与会话标题（Qoder 的 last-prompt 会逐轮漂移）分开；重索引不会覆盖已生成的名字。
 */

export const NAME_MAX_CHARS = 40;
export const NAME_OBJECTIVE_MAX_CHARS = 160;
export const NAME_MATERIAL_CHARS = 2500;
export const NAME_ASSISTANT_CHARS = 800;
export const NAME_MAX_CONSECUTIVE_FAILURES = 3;
const NAME_PARENT_HOPS = 5;
const NAME_USER_MESSAGES = 12;
const QUERY_CHUNK = 400;

export const NAME_KEYS = {
  lastError: "names.lastError",
  lastErrorAt: "names.lastErrorAt",
  lastSuccessAt: "names.lastSuccessAt",
} as const;

export interface SessionName {
  name: string;
  objective: string | null;
}

export interface NameMaterial {
  prompt: string;
  assistant: string | null;
  sourceSessionId: string;
}

export interface NameDrainOptions {
  config: { model: string; host: string };
  batchSessions?: number;
  maxSessions?: number;
  maxMs?: number;
  sessionIds?: string[];
  projectRoot?: string;
  /** 提供后会在每次外发前检查删除/排除目录（真实调用方都必须传） */
  env?: Env;
  now?: () => number;
  onProgress?: (line: string) => void;
}

export interface NameDrainResult {
  processed: number;
  skipped: number;
  failed: number;
  remaining: number;
  paused: boolean;
  lastError?: string;
}

export interface NameStatus {
  enabled: boolean;
  configured: boolean;
  model: string;
  host: string | null;
  generated: number;
  pending: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

export class NameParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NameParseError";
  }
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(",");
}

function writeKey(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

function deleteKey(db: DatabaseSync, key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

/** 任务名复用摘要开关与摘要接口配置：摘要关闭时不额外烧 API。 */
export function resolveNameRuntimeConfig(db: DatabaseSync) {
  return resolveSummaryRuntimeConfig(db);
}

/** 按会话批量取任务名（只读；任务列表取根会话的名字）。 */
export function getSessionNames(db: DatabaseSync, sessionIds: string[]): Map<string, SessionName> {
  const out = new Map<string, SessionName>();
  const ids = [...new Set(sessionIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_names'")
    .get();
  if (!hasTable) return out; // 只读路径遇到 v5 老库：照常回退标题，不报错
  for (let i = 0; i < ids.length; i += QUERY_CHUNK) {
    const chunk = ids.slice(i, i + QUERY_CHUNK);
    const rows = db
      .prepare(
        `SELECT session_id AS sid, name, objective FROM session_names
         WHERE session_id IN (${placeholders(chunk.length)})`,
      )
      .all(...chunk) as Array<{ sid: string; name: string; objective: string | null }>;
    for (const row of rows) out.set(row.sid, { name: row.name, objective: row.objective });
  }
  return out;
}

function userTexts(db: DatabaseSync, sessionId: string): string[] {
  const rows = db
    .prepare(
      `SELECT m.ordinal AS ordinal, p.text AS text
       FROM messages m JOIN parts p ON p.message_id = m.id
       WHERE m.session_id = ? AND m.role = 'user' AND p.kind = 'text'
         AND p.text IS NOT NULL AND p.text <> ''
       ORDER BY m.ordinal, p.idx
       LIMIT ?`,
    )
    .all(sessionId, NAME_USER_MESSAGES * 3) as Array<{ ordinal: number; text: string }>;
  const byOrdinal = new Map<number, string[]>();
  for (const row of rows) {
    const list = byOrdinal.get(row.ordinal) ?? [];
    list.push(row.text);
    byOrdinal.set(row.ordinal, list);
  }
  return [...byOrdinal.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, texts]) => texts.join("\n").trim())
    .filter(Boolean);
}

function firstAssistantText(db: DatabaseSync, sessionId: string): string | null {
  const rows = db
    .prepare(
      `SELECT p.text AS text
       FROM messages m JOIN parts p ON p.message_id = m.id
       WHERE m.session_id = ? AND m.role = 'assistant' AND p.kind = 'text'
         AND p.text IS NOT NULL AND p.text <> ''
       ORDER BY m.ordinal, p.idx
       LIMIT 8`,
    )
    .all(sessionId) as Array<{ text: string }>;
  const joined = rows.map((row) => row.text).join("\n").trim();
  return joined || null;
}

/** 从「继续 <uuid> 会话」里找回原会话（跨项目也可能找到）。 */
function referencedSessionId(db: DatabaseSync, text: string, selfId: string): string | null {
  const match =
    text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? null;
  if (!match) return null;
  const row = db
    .prepare(
      `SELECT id FROM sessions
       WHERE id LIKE ? AND id <> ? AND deleted_at IS NULL
       ORDER BY CASE WHEN id LIKE 'qoder:%' THEN 0 ELSE 1 END
       LIMIT 1`,
    )
    .get(`%${match}%`, selfId) as { id: string } | undefined;
  return row?.id ?? null;
}

function pickPrompts(texts: string[]): string[] | undefined {
  const picked = texts
    .map(stripContinuationPrefix)
    .filter((text) => text && !isLowSignal(text))
    .slice(0, 2);
  return picked.length > 0 ? picked : undefined;
}

function materialFor(db: DatabaseSync, sourceSessionId: string, prompts: string[]): NameMaterial {
  const assistant = firstAssistantText(db, sourceSessionId);
  const prompt = clipMiddle(redactSecrets(prompts.join("\n\n")).text, NAME_MATERIAL_CHARS);
  const reply = assistant
    ? clipMiddle(redactSecrets(assistant).text, NAME_ASSISTANT_CHARS)
    : null;
  return { prompt, assistant: reply, sourceSessionId };
}

/**
 * 命名素材：优先会话自己的首条实质指令；「继续 xxx 会话」先回溯原会话/父会话。
 * 只取开头，不看尾部——任务名不应该跟着最后一轮对话漂移。
 */
export function loadNameMaterial(db: DatabaseSync, sessionId: string): NameMaterial | undefined {
  const startTexts = userTexts(db, sessionId).map(cleanText);
  const startPrompts = pickPrompts(startTexts);
  const fallback = startPrompts ? materialFor(db, sessionId, startPrompts) : undefined;

  const visited = new Set<string>();
  let current: string | null = sessionId;
  for (let hop = 0; current && hop <= NAME_PARENT_HOPS; hop++) {
    if (visited.has(current)) break;
    visited.add(current);
    const row = db
      .prepare("SELECT id, parent_session_id FROM sessions WHERE id = ?")
      .get(current) as { id: string; parent_session_id: string | null } | undefined;
    if (!row) break;

    const texts = userTexts(db, current).map(cleanText);
    const first = texts[0] ?? "";
    const continuation = first ? isContinuationMeta(first) : false;
    if (continuation) {
      const referenced = referencedSessionId(db, first, current);
      if (referenced && !visited.has(referenced)) {
        current = referenced;
        continue;
      }
      if (row.parent_session_id && !visited.has(row.parent_session_id)) {
        current = row.parent_session_id;
        continue;
      }
    }

    const prompts = pickPrompts(texts);
    if (prompts) return materialFor(db, current, prompts);

    if (row.parent_session_id && !visited.has(row.parent_session_id)) {
      current = row.parent_session_id;
      continue;
    }
    break;
  }
  return fallback;
}

function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n…\n${text.slice(-tail)}`;
}

export function buildNamePrompt(material: NameMaterial): { system: string; user: string } {
  const system = [
    "你是任务命名助手。根据会话开头，给这个任务起一个稳定的短名字，并写一句目标。",
    "要求：",
    "- name：4~18 个汉字（英文任务可用 2~8 个单词），描述“要做什么”，不要复述原句，不要用“继续/任务/用户要求/帮我”这类空话",
    "- objective：一句话，不超过 60 个汉字，说明任务目标",
    "- 如果开头是角色设定或提示词模板，提取其中真正的开发/研究任务",
    '- 只输出一行 JSON：{"name":"...","objective":"..."}；不要 markdown、代码块或解释',
  ].join("\n");
  const user = [
    `会话开头：\n${material.prompt}`,
    material.assistant ? `首轮助手回复（节选）：\n${material.assistant}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system, user };
}

function stripNamePrefix(value: string): string {
  return value
    .replace(/^(?:任务名|名称|name|任务)[:：]\s*/i, "")
    .replace(/^(?:目标|objective|goal)[:：]\s*/i, "")
    .replace(/^[-*\d.\s]+/, "")
    .replace(/^["'“‘`]+|["'”’`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseJsonish(raw: string): { name: string; objective: string | null } | undefined {
  const text = raw.replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  const name = rec["name"] ?? rec["title"];
  const objective = rec["objective"] ?? rec["goal"] ?? rec["description"];
  if (typeof name !== "string" || !name.trim()) return undefined;
  return {
    name: stripNamePrefix(name),
    objective: typeof objective === "string" ? stripNamePrefix(objective) : null,
  };
}

export function parseNameReply(raw: string): { name: string; objective: string | null } {
  const parsed = parseJsonish(raw);
  let name = "";
  let objective: string | null = null;
  if (parsed) {
    name = parsed.name;
    objective = parsed.objective;
  } else {
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("```"));
    name = stripNamePrefix(lines[0] ?? "");
    objective = lines[1] ? stripNamePrefix(lines[1]) : null;
  }
  name = name.slice(0, NAME_MAX_CHARS);
  objective = objective ? objective.slice(0, NAME_OBJECTIVE_MAX_CHARS) : null;
  if (!name || isLowSignal(name)) throw new NameParseError("任务名模型没有返回可用名字");
  return { name, objective };
}

function insertName(
  db: DatabaseSync,
  sessionId: string,
  parsed: { name: string; objective: string | null },
  config: { model: string; host: string },
  now: number,
): boolean {
  const info = db
    .prepare(
      `INSERT INTO session_names (session_id, name, objective, model, host, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO NOTHING`,
    )
    .run(sessionId, parsed.name, parsed.objective, config.model, config.host, new Date(now).toISOString());
  return Number(info.changes) > 0;
}

async function generateSessionName(
  db: DatabaseSync,
  provider: ChatProvider,
  config: { model: string; host: string },
  sessionId: string,
  now: number,
): Promise<{ generated: boolean }> {
  if (db.prepare("SELECT 1 FROM session_names WHERE session_id = ?").get(sessionId)) {
    return { generated: false };
  }
  const material = loadNameMaterial(db, sessionId);
  if (!material) return { generated: false };
  const { system, user } = buildNamePrompt(material);
  const raw = await provider.complete(system, user);
  const parsed = parseNameReply(raw);
  return { generated: insertName(db, sessionId, parsed, config, now) };
}

/** 会话名 drain：与摘要同构的 claim 租约 + 失败暂停；只处理队列里有的会话。 */
export async function drainNameQueue(
  db: DatabaseSync,
  provider: ChatProvider,
  opts: NameDrainOptions,
): Promise<NameDrainResult> {
  const nowFn = opts.now ?? Date.now;
  const started = nowFn();
  const batchSessions = opts.batchSessions ?? 4;
  const filters = opts.env ? loadFilters(opts.env) : undefined;
  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let consecutive = 0;
  let paused = false;
  let lastError: string | undefined;

  const budgetOut = (): boolean => {
    if (opts.maxSessions !== undefined && processed + skipped >= opts.maxSessions) return true;
    if (opts.maxMs !== undefined && nowFn() - started >= opts.maxMs) return true;
    return false;
  };

  while (!budgetOut()) {
    const claimedAt = nowFn();
    const batch = claim(db, "name_queue", {
      limit: batchSessions,
      sessionIds: opts.sessionIds,
      projectRoot: opts.projectRoot,
      now: claimedAt,
    });
    if (batch.length === 0) break;
    const lease = new Date(claimedAt).toISOString();

    for (const sessionId of batch) {
      if (budgetOut()) {
        release(db, "name_queue", sessionId);
        continue;
      }
      try {
        if (opts.env && filters && isSessionHidden(db, opts.env, sessionId, filters)) {
          db.prepare("DELETE FROM session_names WHERE session_id = ?").run(sessionId);
          dequeue(db, "name_queue", sessionId);
          skipped++;
          consecutive = 0;
          continue;
        }
        const result = await generateSessionName(db, provider, opts.config, sessionId, nowFn());
        dequeue(db, "name_queue", sessionId, lease);
        if (result.generated) {
          processed++;
          opts.onProgress?.(`已生成任务名 ${sessionId}`);
        } else {
          skipped++;
        }
        consecutive = 0;
      } catch (err) {
        failed++;
        consecutive++;
        lastError = err instanceof Error ? err.message : String(err);
        writeKey(db, NAME_KEYS.lastError, lastError);
        writeKey(db, NAME_KEYS.lastErrorAt, new Date(nowFn()).toISOString());
        release(db, "name_queue", sessionId);
        opts.onProgress?.(`任务名失败 ${sessionId}：${lastError}`);
        if (consecutive >= NAME_MAX_CONSECUTIVE_FAILURES) {
          paused = true;
          break;
        }
      }
    }
    if (paused) break;
  }

  if (lastError === undefined && processed + skipped > 0) {
    deleteKey(db, NAME_KEYS.lastError);
    deleteKey(db, NAME_KEYS.lastErrorAt);
    writeKey(db, NAME_KEYS.lastSuccessAt, new Date(nowFn()).toISOString());
  }
  return { processed, skipped, failed, remaining: pendingCount(db, "name_queue"), paused, lastError };
}

/** 只给“真正要展示”的会话按需入队，避免把全库历史一次性烧一遍。 */
export function enqueueNamesForSessions(
  db: DatabaseSync,
  sessionIds: string[],
  now = Date.now(),
): number {
  if (!resolveNameRuntimeConfig(db)) return 0;
  const ids = [...new Set(sessionIds.filter(Boolean))];
  let added = 0;
  const enqueuedAt = new Date(now).toISOString();
  for (let i = 0; i < ids.length; i += QUERY_CHUNK) {
    const chunk = ids.slice(i, i + QUERY_CHUNK);
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO name_queue (session_id, enqueued_at, claimed_at)
         SELECT s.id, ?, NULL FROM sessions s
         WHERE s.id IN (${placeholders(chunk.length)})
           AND s.deleted_at IS NULL
           AND s.project_root IS NOT NULL AND s.project_root <> ''
           AND NOT EXISTS (SELECT 1 FROM session_names n WHERE n.session_id = s.id)`,
      )
      .run(enqueuedAt, ...chunk);
    added += Number(info.changes);
  }
  return added;
}

export function nameStatus(db: DatabaseSync): NameStatus {
  const config = resolveChatConfig(db);
  const generated = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM session_names").get() as { n: number }).n,
  );
  const lastError = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(NAME_KEYS.lastError) as { value: string } | undefined;
  const lastErrorAt = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(NAME_KEYS.lastErrorAt) as { value: string } | undefined;
  return {
    enabled: summaryEnabled(db),
    configured: config !== undefined,
    model: config?.model ?? "",
    host: config?.host ?? null,
    generated,
    pending: pendingCount(db, "name_queue"),
    lastError: lastError?.value ?? null,
    lastErrorAt: lastErrorAt?.value ?? null,
  };
}
