import type { DatabaseSync } from "node:sqlite";

import { hostOf } from "../core/embeddings.js";
import { isSessionHidden, loadFilters } from "../core/filters.js";
import { sha256 } from "../core/hash.js";
import { redactSecrets } from "../core/secrets.js";
import {
  ChatRequestError,
  SUMMARY_MAX_CHARS,
  type ChatConfig,
  type ChatProvider,
} from "../core/llm.js";
import { inTransaction } from "./db.js";
import { readKey } from "./embeddings-store.js";
import { claim, dequeue, enqueueAll, pendingCount, release, runBounded } from "./queue.js";
import type { Env } from "../core/types.js";

// ————————————————————————————————————————————————————————————————
// 配置（settings 表）
// ————————————————————————————————————————————————————————————————

export const SUMMARY_KEYS = {
  enabled: "summary.enabled",
  baseUrl: "summary.baseUrl",
  model: "summary.model",
  apiKey: "summary.apiKey",
  lastError: "summary.lastError",
  lastErrorAt: "summary.lastErrorAt",
  lastSuccessAt: "summary.lastSuccessAt",
} as const;

function writeKey(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

function deleteKey(db: DatabaseSync, key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

export function summaryEnabled(db: DatabaseSync): boolean {
  return readKey(db, SUMMARY_KEYS.enabled) === "1";
}

/** 会话摘要自己的接口三字段；任一为空则视为未配置（回退规则提炼）。 */
export function resolveChatConfig(db: DatabaseSync): ChatConfig | undefined {
  const model = readKey(db, SUMMARY_KEYS.model).trim();
  const baseUrl = readKey(db, SUMMARY_KEYS.baseUrl).trim();
  const apiKey = readKey(db, SUMMARY_KEYS.apiKey).trim();
  if (!model || !baseUrl || !apiKey) return undefined;
  return { model, baseUrl, apiKey, host: hostOf(baseUrl) };
}

/** 开启且配置完整才可用。 */
export function resolveSummaryRuntimeConfig(db: DatabaseSync): ChatConfig | undefined {
  if (!summaryEnabled(db)) return undefined;
  return resolveChatConfig(db);
}

// ————————————————————————————————————————————————————————————————
// 生成素材（从库里取，不碰源文件；发送前脱敏）
// ————————————————————————————————————————————————————————————————

/** prompt / 素材模板的版本号：进 content_hash，迭代后自动重生成。 */
export const SUMMARY_PROMPT_VERSION = 1;
export const SUMMARY_WINDOW_MESSAGES = 20;
export const SUMMARY_EXCERPT_CHARS = 8000;

export interface SummaryMaterial {
  title: string;
  /** 人话状态行（未答复 / pending 工具 / 报错 / 待办…），可空 */
  signals: string;
  /** 最后 N 条 user/assistant 正文，尾部截断到上限 */
  excerpt: string;
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(",");
}

export function loadSummaryMaterial(db: DatabaseSync, sessionId: string): SummaryMaterial | undefined {
  const meta = db
    .prepare(
      `SELECT title, first_user_message, sig_pending, sig_quota, sig_error, sig_unanswered, sig_todos_open
       FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as
    | {
        title: string | null;
        first_user_message: string | null;
        sig_pending: number;
        sig_quota: number;
        sig_error: number;
        sig_unanswered: number;
        sig_todos_open: number;
      }
    | undefined;
  if (!meta) return undefined;

  const rawTitle = meta.title?.trim() || meta.first_user_message?.replace(/\s+/g, " ").trim() || "";
  const title = redactSecrets(rawTitle).text.slice(0, 120);
  const signals: string[] = [];
  if (meta.sig_unanswered === 1) signals.push("用户最后一条消息还没有回复");
  if (meta.sig_pending === 1) signals.push("有工具调用没有返回结果，会话在等待");
  if (meta.sig_error === 1) signals.push("最近出现过报错");
  if (meta.sig_quota === 1) signals.push("疑似撞到用量限制");
  if (meta.sig_todos_open === 1) signals.push("有未完成的待办");

  const ordinals = (
    db
      .prepare(
        `SELECT DISTINCT ordinal FROM messages
         WHERE session_id = ? AND (role = 'user' OR role = 'assistant')
         ORDER BY ordinal DESC LIMIT ?`,
      )
      .all(sessionId, SUMMARY_WINDOW_MESSAGES) as Array<{ ordinal: number }>
  )
    .map((row) => row.ordinal)
    .sort((a, b) => a - b);
  if (ordinals.length === 0) return undefined;

  const rows = db
    .prepare(
      `SELECT m.ordinal AS ordinal, m.role AS role, p.text AS text
       FROM messages m JOIN parts p ON p.message_id = m.id
       WHERE m.session_id = ? AND m.ordinal IN (${placeholders(ordinals.length)})
         AND p.kind = 'text' AND p.text IS NOT NULL
       ORDER BY m.ordinal, p.idx`,
    )
    .all(sessionId, ...ordinals) as Array<{ ordinal: number; role: string; text: string }>;

  const byOrdinal = new Map<number, { role: string; texts: string[] }>();
  for (const row of rows) {
    if (!row.text.trim()) continue;
    const entry = byOrdinal.get(row.ordinal) ?? { role: row.role, texts: [] };
    entry.texts.push(row.text);
    byOrdinal.set(row.ordinal, entry);
  }
  const lines: string[] = [];
  for (const [, entry] of byOrdinal) {
    const who = entry.role === "user" ? "用户" : "助手";
    lines.push(`${who}：${entry.texts.join("\n")}`);
  }
  // 发送前脱敏（设计文档 §3）：素材在源头就只保留遮盖后的形态，下游（hash / prompt / 日志）都安全
  let excerpt = redactSecrets(lines.join("\n\n")).text;
  if (!excerpt.trim()) return undefined;
  if (excerpt.length > SUMMARY_EXCERPT_CHARS) {
    excerpt = excerpt.slice(excerpt.length - SUMMARY_EXCERPT_CHARS); // 保留最新尾部
  }
  return { title, signals: signals.join("；"), excerpt };
}

export function buildSummaryPrompt(material: SummaryMaterial): { system: string; user: string } {
  const system = [
    "你是任务接力助手。根据用户提供的会话尾部内容，输出任务进展摘要。",
    "要求：",
    "- 2~4 句；跟随内容的主要语言（中文内容用中文，英文内容用英文）",
    "- 覆盖：在做什么、进行到哪、有无阻塞 / 待办、下一步建议",
    "- 只输出摘要正文；不要标题、markdown、引号或任何解释",
    "- 长度不超过 200 个汉字（或 500 个字符）",
  ].join("\n");
  const user = [
    `任务名：${material.title || "（无）"}`,
    material.signals ? `状态：${material.signals}` : "",
    "会话尾部：",
    material.excerpt,
  ]
    .filter(Boolean)
    .join("\n");
  return { system, user };
}

/** sha256(素材 + prompt 版本 + model + host)：同一素材零成本跳过，换模型/主机自动重生成。 */
export function summaryContentHash(material: SummaryMaterial, fp: { model: string; host: string }): string {
  const { system, user } = buildSummaryPrompt(material);
  return sha256(`${SUMMARY_PROMPT_VERSION}\n${fp.model}\n${fp.host}\n${system}\n${user}`);
}

// ————————————————————————————————————————————————————————————————
// 读取（消费点用；只认当前 model+host 的行）
// ————————————————————————————————————————————————————————————————

/** 按会话批量取摘要（未启用 / 配置不全 → 空 Map）。 */
export function getSessionSummaries(db: DatabaseSync, sessionIds: string[]): Map<string, string> {
  const config = resolveSummaryRuntimeConfig(db);
  if (!config || sessionIds.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT session_id, text FROM summaries
       WHERE model = ? AND host = ? AND session_id IN (${placeholders(sessionIds.length)})`,
    )
    .all(config.model, config.host, ...sessionIds) as Array<{ session_id: string; text: string }>;
  return new Map(rows.map((row) => [row.session_id, row.text]));
}

export function getSessionSummary(db: DatabaseSync, sessionId: string): string | undefined {
  return getSessionSummaries(db, [sessionId]).get(sessionId);
}

// ————————————————————————————————————————————————————————————————
// 生成 / drain（批处理 + 事务，模式与 embeddings 同构）
// ————————————————————————————————————————————————————————————————

export const SUMMARY_MAX_CONSECUTIVE_FAILURES = 3;

async function generateSessionSummary(
  db: DatabaseSync,
  provider: ChatProvider,
  fp: { model: string; host: string },
  sessionId: string,
  now: number,
): Promise<{ generated: boolean }> {
  const material = loadSummaryMaterial(db, sessionId);
  if (!material) {
    // 没有可摘要的正文（空壳 / 纯工具会话）：清掉旧行即可
    inTransaction(db, () => {
      db.prepare("DELETE FROM summaries WHERE session_id = ?").run(sessionId);
    });
    return { generated: false };
  }
  const hash = summaryContentHash(material, fp);
  const existing = db.prepare("SELECT content_hash FROM summaries WHERE session_id = ?").get(sessionId) as
    | { content_hash: string }
    | undefined;
  if (existing?.content_hash === hash) return { generated: false }; // 零 API 跳过

  const { system, user } = buildSummaryPrompt(material);
  const raw = await provider.complete(system, user);
  const text = redactSecrets(raw).text.trim().slice(0, SUMMARY_MAX_CHARS);
  if (!text) throw new ChatRequestError("摘要生成结果为空", 0, false);
  db.prepare(
    `INSERT INTO summaries (session_id, content_hash, model, host, text, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       content_hash = excluded.content_hash, model = excluded.model, host = excluded.host,
       text = excluded.text, updated_at = excluded.updated_at`,
  ).run(sessionId, hash, fp.model, fp.host, text, new Date(now).toISOString());
  return { generated: true };
}

export interface SummaryDrainOptions {
  /** 当前指纹（model + host；摘要行按这两列过滤） */
  config: { model: string; host: string };
  batchSessions?: number;
  /** 同时在飞的请求数（默认 3）；配额低的上游可调小 */
  concurrency?: number;
  maxSessions?: number;
  maxMs?: number;
  sessionIds?: string[];
  projectRoot?: string;
  /** 提供后会在每次外发前检查删除/排除目录（真实调用方都必须传） */
  env?: Env;
  now?: () => number;
  onProgress?: (line: string) => void;
}

export interface SummaryDrainResult {
  processed: number;
  skipped: number;
  failed: number;
  remaining: number;
  paused: boolean;
  lastError?: string;
}

/** 回填循环：claim 一批 → 有界并发生成 → 出队；失败归还 claim，连续多轮全败才暂停。 */
export async function drainSummaryQueue(
  db: DatabaseSync,
  provider: ChatProvider,
  opts: SummaryDrainOptions,
): Promise<SummaryDrainResult> {
  const nowFn = opts.now ?? Date.now;
  const started = nowFn();
  const batchSessions = opts.batchSessions ?? 4;
  const filters = opts.env ? loadFilters(opts.env) : undefined;
  const concurrency = Math.max(1, opts.concurrency ?? 3);
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
    const batch = claim(db, "summary_queue", {
      limit: batchSessions,
      sessionIds: opts.sessionIds,
      projectRoot: opts.projectRoot,
      now: claimedAt,
    });
    if (batch.length === 0) break;
    const lease = new Date(claimedAt).toISOString();

    const workers = Math.min(concurrency, batch.length);
    // 并发下"连续失败"按轮计：任一成功即清零，全轮皆败累计到 3 轮才暂停
    const failureLimit = SUMMARY_MAX_CONSECUTIVE_FAILURES * workers;
    await runBounded(
      batch,
      workers,
      async (sessionId) => {
        try {
          if (opts.env && filters && isSessionHidden(db, opts.env, sessionId, filters)) {
            db.prepare("DELETE FROM summaries WHERE session_id = ?").run(sessionId);
            dequeue(db, "summary_queue", sessionId);
            skipped++;
            consecutive = 0;
            return;
          }
          const result = await generateSessionSummary(db, provider, opts.config, sessionId, nowFn());
          dequeue(db, "summary_queue", sessionId, lease);
          if (result.generated) {
            processed++;
            opts.onProgress?.(`已生成摘要 ${sessionId}`);
          } else {
            skipped++;
          }
          consecutive = 0;
        } catch (err) {
          failed++;
          consecutive++;
          lastError = err instanceof Error ? err.message : String(err);
          // 立刻写状态：长回填过程中"最近错误"就要在配置页 / doctor 可见
          writeKey(db, SUMMARY_KEYS.lastError, lastError);
          writeKey(db, SUMMARY_KEYS.lastErrorAt, new Date(nowFn()).toISOString());
          release(db, "summary_queue", sessionId);
          opts.onProgress?.(`摘要失败 ${sessionId}：${lastError}`);
          if (consecutive >= failureLimit) paused = true;
        }
      },
      () => paused || budgetOut(),
      (sessionId) => release(db, "summary_queue", sessionId),
    );
    if (paused) break;
  }

  const remaining = pendingCount(db, "summary_queue");
  if (lastError === undefined && processed + skipped > 0) {
    deleteKey(db, SUMMARY_KEYS.lastError);
    deleteKey(db, SUMMARY_KEYS.lastErrorAt);
    writeKey(db, SUMMARY_KEYS.lastSuccessAt, new Date(nowFn()).toISOString());
  }
  return { processed, skipped, failed, remaining, paused, lastError };
}

// ————————————————————————————————————————————————————————————————
// 状态 / 清除 / 重建
// ————————————————————————————————————————————————————————————————

export interface SummaryStatus {
  enabled: boolean;
  configured: boolean;
  model: string;
  host: string | null;
  summarizedSessions: number;
  pendingSessions: number;
  /** 其它模型/主机的遗留行（换配置后未重建时 > 0） */
  staleSessions: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

export function summaryStatus(db: DatabaseSync): SummaryStatus {
  const enabled = summaryEnabled(db);
  const config = resolveChatConfig(db);
  const total = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM summaries").get() as { n: number }).n,
  );
  let summarized = 0;
  if (config) {
    summarized = Number(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM summaries WHERE model = ? AND host = ?")
          .get(config.model, config.host) as { n: number }
      ).n,
    );
  }
  return {
    enabled,
    configured: config !== undefined,
    model: config?.model ?? readKey(db, SUMMARY_KEYS.model).trim(),
    host: config?.host ?? null,
    summarizedSessions: summarized,
    pendingSessions: pendingCount(db, "summary_queue"),
    staleSessions: total - summarized,
    lastError: readKey(db, SUMMARY_KEYS.lastError) || null,
    lastErrorAt: readKey(db, SUMMARY_KEYS.lastErrorAt) || null,
  };
}

/** 显式"删除全部摘要"：唯一清除路径（停用只保留不删——本地留存不构成新隐私面）。 */
export function deleteAllSummaries(db: DatabaseSync): void {
  inTransaction(db, () => {
    db.exec("DELETE FROM summaries");
    db.exec("DELETE FROM summary_queue");
    deleteKey(db, SUMMARY_KEYS.lastError);
    deleteKey(db, SUMMARY_KEYS.lastErrorAt);
  });
}

/** 换指纹：先删旧（不等当前模型/主机的行）、再全量入队（drain 用 hash 对账，变过才烧 API）。 */
export function rebuildSummaries(db: DatabaseSync, config: { model: string; host: string }): {
  deleted: number;
  queued: number;
} {
  return inTransaction(db, () => {
    const info = db
      .prepare("DELETE FROM summaries WHERE NOT (model = ? AND host = ?)")
      .run(config.model, config.host);
    const queued = enqueueAll(db, "summary_queue");
    return { deleted: Number(info.changes), queued };
  });
}
