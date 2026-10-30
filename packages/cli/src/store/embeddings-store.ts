import type { DatabaseSync } from "node:sqlite";

import type { Env } from "../core/types.js";
import {
  chunkText,
  cosine,
  l2norm,
  hostOf,
  EMBED_BATCH_SIZE,
  EMBED_CHUNK_SIZE,
  EMBED_CHUNK_OVERLAP,
  RECENCY_MIN_WEIGHT,
  EmbeddingRequestError,
  type EmbeddingConfig,
  type EmbeddingProvider,
} from "../core/embeddings.js";
import { sha256 } from "../core/hash.js";
import { redactSecrets, SECRET_RULES_VERSION } from "../core/secrets.js";
import { isDirExcluded, isSessionHidden, loadFilters } from "../core/filters.js";
import { inTransaction } from "./db.js";
import { claim, dequeue, enqueue, enqueueAll, pendingCount, release, runBounded } from "./queue.js";

// ————————————————————————————————————————————————————————————————
// 配置（settings 表）与指纹
// ————————————————————————————————————————————————————————————————

export const EMBED_KEYS = {
  enabled: "embed.enabled",
  baseUrl: "embed.baseUrl",
  model: "embed.model",
  apiKey: "embed.apiKey",
  lastError: "embed.lastError",
  lastErrorAt: "embed.lastErrorAt",
  rulesVersion: "embed.rulesVersion",
  lastSuccessAt: "embed.lastSuccessAt",
} as const;

export function readKey(db: DatabaseSync, key: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value?: string | null }
    | undefined;
  return typeof row?.value === "string" ? row.value : "";
}

function writeKey(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

function deleteKey(db: DatabaseSync, key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

export interface EmbeddingSettingsRaw {
  enabled: boolean;
  /** 语义检索自己的接口三字段；任一为空即未配置 */
  baseUrl: string;
  model: string;
  apiKey: string;
}

export function readEmbeddingSettings(db: DatabaseSync): EmbeddingSettingsRaw {
  return {
    enabled: readKey(db, EMBED_KEYS.enabled) === "1",
    baseUrl: readKey(db, EMBED_KEYS.baseUrl),
    model: readKey(db, EMBED_KEYS.model),
    apiKey: readKey(db, EMBED_KEYS.apiKey),
  };
}

/**
 * 解析出可用配置；关闭或字段不全时返回 undefined。
 * 三字段一律用语义检索自己的值——不跨功能继承，换上游互不影响。
 */
export function resolveEmbeddingConfig(db: DatabaseSync): EmbeddingConfig | undefined {
  const raw = readEmbeddingSettings(db);
  if (!raw.enabled) return undefined;
  const model = raw.model.trim();
  const baseUrl = raw.baseUrl.trim();
  const apiKey = raw.apiKey.trim();
  if (!model || !baseUrl || !apiKey) return undefined;
  return { model, baseUrl, apiKey, host: hostOf(baseUrl) };
}

// ————————————————————————————————————————————————————————————————
// 块装载（从库里读消息，不碰源文件）
// ————————————————————————————————————————————————————————————————

export interface SessionChunk {
  ordinal: number;
  chunkIx: number;
  /** 原文块（摘要生成用；发送前会脱敏） */
  text: string;
  /** 脱敏后文本：既作嵌入输入，也作 content_hash 与幂等判断 */
  redacted: string;
  hash: string;
}

/** user / assistant 的 text 正文 → 拼段 → 固定窗切块 → 逐块脱敏 + 哈希。 */
export function loadSessionChunks(
  db: DatabaseSync,
  sessionId: string,
  chunkSize = EMBED_CHUNK_SIZE,
  overlap = EMBED_CHUNK_OVERLAP,
): SessionChunk[] {
  const rows = db
    .prepare(
      `SELECT m.ordinal AS ordinal, p.text AS text
       FROM messages m JOIN parts p ON p.message_id = m.id
       WHERE m.session_id = ? AND (m.role = 'user' OR m.role = 'assistant')
         AND p.kind = 'text' AND p.text IS NOT NULL
       ORDER BY m.ordinal, p.idx`,
    )
    .all(sessionId) as Array<{ ordinal: number; text: string }>;
  const byOrdinal = new Map<number, string[]>();
  for (const row of rows) {
    if (!row.text.trim()) continue;
    const list = byOrdinal.get(row.ordinal) ?? [];
    list.push(row.text);
    byOrdinal.set(row.ordinal, list);
  }
  const out: SessionChunk[] = [];
  for (const [ordinal, texts] of byOrdinal) {
    // 先对完整文本脱敏再切块：跨块的长私钥/长 token 才能被规则完整匹配。
    const redactedFull = redactSecrets(texts.join("\n\n")).text;
    const chunks = chunkText(redactedFull, chunkSize, overlap);
    chunks.forEach((redacted, chunkIx) => {
      out.push({ ordinal, chunkIx, text: redacted, redacted, hash: sha256(redacted) });
    });
  }
  return out;
}

/** 按 (ordinal, chunk_ix) 还原原文块（向量独有命中的摘要从命中块文本生成）。 */
export function chunkTextAt(
  db: DatabaseSync,
  sessionId: string,
  ordinal: number,
  chunkIx: number,
  chunkSize = EMBED_CHUNK_SIZE,
  overlap = EMBED_CHUNK_OVERLAP,
): string | undefined {
  const rows = db
    .prepare(
      `SELECT p.text AS text
       FROM messages m JOIN parts p ON p.message_id = m.id
       WHERE m.session_id = ? AND m.ordinal = ? AND p.kind = 'text' AND p.text IS NOT NULL
       ORDER BY p.idx`,
    )
    .all(sessionId, ordinal) as Array<{ text: string }>;
  const joined = rows
    .map((r) => r.text)
    .filter((t) => t.trim())
    .join("\n\n");
  if (!joined) return undefined;
  const chunk = chunkText(joined, chunkSize, overlap)[chunkIx];
  return chunk === undefined ? undefined : redactSecrets(chunk).text;
}

// ————————————————————————————————————————————————————————————————
// 向量编解码（float32 LE BLOB + 预存 L2 范数）
// ————————————————————————————————————————————————————————————————

export function encodeVec(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(",");
}

function normalizeProject(project: string): string {
  return project.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function decodeVec(blob: Uint8Array): Float32Array {
  if (blob.byteOffset % 4 === 0 && blob.byteLength % 4 === 0) {
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  }
  const copy = blob.slice();
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

// ————————————————————————————————————————————————————————————————
// drain（回填）
// ————————————————————————————————————————————————————————————————

export const MAX_CONSECUTIVE_FAILURES = 3;

export interface DrainOptions {
  /** 当前指纹的已知部分（dims 由响应确定） */
  fingerprint: { model: string; host: string };
  /** 每批 claim 几个会话 */
  batchSessions?: number;
  /** 同时在飞的请求数（默认 3）；配额低的上游可调小 */
  concurrency?: number;
  /** 本次运行最多处理（含跳过）多少会话 */
  maxSessions?: number;
  /** 本次运行的时间预算 */
  maxMs?: number;
  /** 只 drain 这些会话（查询前定向排空） */
  sessionIds?: string[];
  projectRoot?: string;
  /** 提供后会在每次外发前检查删除/排除目录（真实调用方都必须传） */
  env?: Env;
  now?: () => number;
  onProgress?: (line: string) => void;
}

export interface DrainResult {
  processed: number;
  skipped: number;
  failed: number;
  remaining: number;
  calls: number;
  paused: boolean;
  lastError?: string;
}

interface SessionEmbedResult {
  embedded: boolean;
  calls: number;
}

function chunkKey(ordinal: number, chunkIx: number): string {
  return `${ordinal}:${chunkIx}`;
}

/** 单会话：对账 → 批量嵌入 → 事务写入；幂等（未变块零 API 成本）。 */
async function embedSession(
  db: DatabaseSync,
  provider: EmbeddingProvider,
  sessionId: string,
  fingerprint: { model: string; host: string },
  now: number,
): Promise<SessionEmbedResult> {
  const chunks = loadSessionChunks(db, sessionId);
  const existingRows = db
    .prepare(
      `SELECT ordinal, chunk_ix, content_hash FROM embeddings
       WHERE session_id = ? AND model = ? AND host = ?`,
    )
    .all(sessionId, fingerprint.model, fingerprint.host) as Array<{
    ordinal: number;
    chunk_ix: number;
    content_hash: string;
  }>;
  const existing = new Map(existingRows.map((r) => [chunkKey(r.ordinal, r.chunk_ix), r.content_hash]));
  const currentKeys = new Set(chunks.map((c) => chunkKey(c.ordinal, c.chunkIx)));
  const staleRows = existingRows.filter((r) => !currentKeys.has(chunkKey(r.ordinal, r.chunk_ix)));

  const removeStale = () => {
    const del = db.prepare(
      "DELETE FROM embeddings WHERE session_id = ? AND ordinal = ? AND chunk_ix = ? AND model = ? AND host = ?",
    );
    for (const row of staleRows) del.run(sessionId, row.ordinal, row.chunk_ix, fingerprint.model, fingerprint.host);
  };

  const toEmbed = chunks.filter((c) => existing.get(chunkKey(c.ordinal, c.chunkIx)) !== c.hash);
  if (chunks.length === 0 || toEmbed.length === 0) {
    if (staleRows.length > 0) {
      inTransaction(db, removeStale);
    }
    return { embedded: false, calls: 0 };
  }

  const vectors = await provider.embed(toEmbed.map((c) => c.redacted));
  if (vectors.length !== toEmbed.length) {
    throw new EmbeddingRequestError("嵌入返回数量与请求不符", 0, false);
  }
  const nowIso = new Date(now).toISOString();
  inTransaction(db, () => {
    const upsert = db.prepare(
      `INSERT INTO embeddings (session_id, ordinal, chunk_ix, content_hash, model, dims, host, vec, norm, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, ordinal, chunk_ix) DO UPDATE SET
         content_hash = excluded.content_hash, model = excluded.model, dims = excluded.dims,
         host = excluded.host, vec = excluded.vec, norm = excluded.norm, updated_at = excluded.updated_at`,
    );
    toEmbed.forEach((chunk, i) => {
      const vec = vectors[i]!;
      upsert.run(
        sessionId,
        chunk.ordinal,
        chunk.chunkIx,
        chunk.hash,
        fingerprint.model,
        vec.length,
        fingerprint.host,
        encodeVec(vec),
        l2norm(vec),
        nowIso,
      );
    });
    removeStale();
  });
  return { embedded: true, calls: Math.ceil(toEmbed.length / EMBED_BATCH_SIZE) };
}

/**
 * 回填循环：claim 一批 → 有界并发嵌入 → 出队；失败归还 claim，连续多轮全败才暂停。
 * 可中断续跑（租约）、幂等（hash 对账）；进程内只跑一份调用方自己保证（ui 用防重入标志）。
 */
export async function drainEmbedQueue(
  db: DatabaseSync,
  provider: EmbeddingProvider,
  opts: DrainOptions,
): Promise<DrainResult> {
  const nowFn = opts.now ?? Date.now;
  const started = nowFn();
  const batchSessions = opts.batchSessions ?? 4;
  const filters = opts.env ? loadFilters(opts.env) : undefined;
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let calls = 0;
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
    const batch = claim(db, "embed_queue", {
      limit: batchSessions,
      sessionIds: opts.sessionIds,
      projectRoot: opts.projectRoot,
      now: claimedAt,
    });
    if (batch.length === 0) break;
    const lease = new Date(claimedAt).toISOString();

    const workers = Math.min(concurrency, batch.length);
    // 并发下"连续失败"按轮计：任一成功即清零，全轮皆败累计到 3 轮才暂停
    const failureLimit = MAX_CONSECUTIVE_FAILURES * workers;
    await runBounded(
      batch,
      workers,
      async (sessionId) => {
        try {
          if (opts.env && filters && isSessionHidden(db, opts.env, sessionId, filters)) {
            db.prepare("DELETE FROM embeddings WHERE session_id = ?").run(sessionId);
            dequeue(db, "embed_queue", sessionId);
            skipped++;
            consecutive = 0;
            return;
          }
          const result = await embedSession(db, provider, sessionId, opts.fingerprint, nowFn());
          dequeue(db, "embed_queue", sessionId, lease);
          if (result.embedded) {
            processed++;
            calls += result.calls;
            opts.onProgress?.(`已嵌入 ${sessionId}（${result.calls} 次请求）`);
          } else {
            skipped++;
          }
          consecutive = 0;
        } catch (err) {
          failed++;
          consecutive++;
          lastError = err instanceof Error ? err.message : String(err);
          // 立刻写状态：长回填过程中"最近错误"就要在配置页 / doctor 可见
          writeKey(db, EMBED_KEYS.lastError, lastError);
          writeKey(db, EMBED_KEYS.lastErrorAt, new Date(nowFn()).toISOString());
          release(db, "embed_queue", sessionId);
          opts.onProgress?.(`嵌入失败 ${sessionId}：${lastError}`);
          if (consecutive >= failureLimit) paused = true;
        }
      },
      () => paused || budgetOut(),
      (sessionId) => release(db, "embed_queue", sessionId),
    );
    if (paused) break;
  }

  const remaining = pendingCount(db, "embed_queue");
  if (lastError === undefined && processed + skipped > 0) {
    // 这一轮全部成功：清掉上一次的遗留错误，记录成功与规则版本
    deleteKey(db, EMBED_KEYS.lastError);
    deleteKey(db, EMBED_KEYS.lastErrorAt);
    writeKey(db, EMBED_KEYS.lastSuccessAt, new Date(nowFn()).toISOString());
    writeKey(db, EMBED_KEYS.rulesVersion, String(SECRET_RULES_VERSION));
  }
  return { processed, skipped, failed, remaining, calls, paused, lastError };
}

// ————————————————————————————————————————————————————————————————
// 状态 / 清除 / 重建
// ————————————————————————————————————————————————————————————————

export interface EmbeddingEstimate {
  chars: number;
  chunks: number;
  tokens: number;
  usd: number;
}

export interface EmbeddingStatus {
  enabled: boolean;
  configured: boolean;
  model: string;
  host: string | null;
  /** 当前指纹的行（模型+主机；dims 由行内确定，正常只有一种） */
  embeddedSessions: number;
  embeddedChunks: number;
  /** 其它指纹的遗留行（换配置后未重建时 > 0） */
  staleChunks: number;
  pendingSessions: number;
  lastError: string | null;
  lastErrorAt: string | null;
  /** 入库时的密钥脱敏规则版本与当前代码不一致：建议重嵌（下次回填自动处理） */
  rulesOutdated: boolean;
  /** 全量重嵌预估（仅在有遗留旧指纹行时给出，用于重建确认提示） */
  estimate: EmbeddingEstimate | null;
}

/**
 * 全量重嵌预估：正文字符数 → 近似块数 / token 数 / 费用。
 * token 保守按 1 字符 ≈ 1 token（中文口径；英文会高估），单价按 text-embedding-3-small $0.02/M。
 */
export function estimateFullReembed(db: DatabaseSync): EmbeddingEstimate {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(LENGTH(p.text)), 0) AS chars
       FROM parts p JOIN messages m ON p.message_id = m.id JOIN sessions s ON m.session_id = s.id
       WHERE s.deleted_at IS NULL AND (m.role = 'user' OR m.role = 'assistant')
         AND p.kind = 'text' AND p.text IS NOT NULL`,
    )
    .get() as { chars: number };
  const chars = Number(row.chars);
  const perChunk = Math.max(1, EMBED_CHUNK_SIZE - EMBED_CHUNK_OVERLAP);
  const chunks = Math.ceil(chars / perChunk);
  const tokens = chars;
  return { chars, chunks, tokens, usd: (tokens / 1_000_000) * 0.02 };
}

export function embeddingStatus(db: DatabaseSync): EmbeddingStatus {
  const raw = readEmbeddingSettings(db);
  const config = resolveEmbeddingConfig(db);
  const counts = (where: string, args: string[]): { sessions: number; chunks: number } => {
    const row = db
      .prepare(
        `SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS chunks
         FROM embeddings WHERE ${where}`,
      )
      .get(...args) as { sessions: number; chunks: number };
    return { sessions: Number(row.sessions), chunks: Number(row.chunks) };
  };

  let embedded = { sessions: 0, chunks: 0 };
  let staleChunks = 0;
  if (config) {
    embedded = counts("model = ? AND host = ?", [config.model, config.host]);
    const total = counts("1=1", []);
    staleChunks = total.chunks - embedded.chunks;
  } else {
    const total = counts("1=1", []);
    staleChunks = total.chunks;
  }

  const storedRules = readKey(db, EMBED_KEYS.rulesVersion);
  const lastError = readKey(db, EMBED_KEYS.lastError);
  const lastErrorAt = readKey(db, EMBED_KEYS.lastErrorAt);
  return {
    enabled: raw.enabled,
    configured: config !== undefined,
    model: config?.model ?? raw.model.trim(),
    host: config?.host ?? null,
    embeddedSessions: embedded.sessions,
    embeddedChunks: embedded.chunks,
    staleChunks,
    pendingSessions: pendingCount(db, "embed_queue"),
    lastError: lastError || null,
    lastErrorAt: lastErrorAt || null,
    rulesOutdated: storedRules !== "" && storedRules !== String(SECRET_RULES_VERSION),
    estimate: staleChunks > 0 ? estimateFullReembed(db) : null,
  };
}

/** 显式"删除全部向量"：唯一清除路径（停用只保留不删——本地留存不构成新隐私面）。 */
export function deleteAllEmbeddings(db: DatabaseSync): void {
  inTransaction(db, () => {
    db.exec("DELETE FROM embeddings");
    db.exec("DELETE FROM embed_queue");
    deleteKey(db, EMBED_KEYS.lastError);
    deleteKey(db, EMBED_KEYS.lastErrorAt);
    deleteKey(db, EMBED_KEYS.rulesVersion);
  });
}

/** 换指纹：先删旧（不等当前模型/主机的行）、再全量入队（drain 用 hash 对账，变过才烧 API）。 */
export function rebuildEmbeddings(db: DatabaseSync, config: { model: string; host: string }): {
  deleted: number;
  queued: number;
} {
  return inTransaction(db, () => {
    const info = db
      .prepare("DELETE FROM embeddings WHERE NOT (model = ? AND host = ?)")
      .run(config.model, config.host);
    const queued = enqueueAll(db, "embed_queue");
    return { deleted: Number(info.changes), queued };
  });
}

// ————————————————————————————————————————————————————————————————
// 查询侧：项目域预过滤 + 流式扫描 + 会话聚合
// ————————————————————————————————————————————————————————————————

export interface SessionVectorScore {
  sessionId: string;
  /** 会话内最强单块（搜索排序用） */
  maxCos: number;
  bestOrdinal: number;
  bestChunkIx: number;
  /** 新近加权聚合（接力分用）：块序越新权重越高（RECENCY_MIN_WEIGHT..1） */
  weightedCos: number;
}

export interface VectorQueryOptions {
  queryVec: Float32Array;
  /** 只在这些会话里找（resume 候选定向） */
  sessionIds?: string[];
  /** 项目域预过滤（空 = 全部项目） */
  projectRoot?: string;
  env?: Env;
  /** 返回会话数上限（搜索用；缺省全部） */
  limit?: number;
}

/**
 * 按当前指纹扫块算余弦并聚合到会话级。
 * 只读当前指纹的行（SQL 过滤）——重嵌期间未完成的会话自动只剩关键词通道，
 * 任何时刻不会出现两个空间的向量混合计算。
 */
export function scoreSessionsByVector(
  db: DatabaseSync,
  fingerprint: { model: string; host: string; dims: number },
  opts: VectorQueryOptions,
): SessionVectorScore[] {
  if (opts.sessionIds !== undefined && opts.sessionIds.length === 0) return [];
  let sql = `SELECT e.session_id AS session_id, e.ordinal AS ordinal, e.chunk_ix AS chunk_ix,
                    e.vec AS vec, e.norm AS norm, s.project_root AS project_root, s.cwd AS cwd
             FROM embeddings e JOIN sessions s ON s.id = e.session_id
             WHERE e.model = ? AND e.host = ? AND e.dims = ? AND s.deleted_at IS NULL`;
  const args: Array<string | number> = [fingerprint.model, fingerprint.host, fingerprint.dims];
  if (opts.sessionIds !== undefined) {
    sql += ` AND e.session_id IN (${placeholders(opts.sessionIds.length)})`;
    args.push(...opts.sessionIds);
  }
  const rows = db.prepare(sql).iterate(...args) as IterableIterator<{
    session_id: string;
    ordinal: number;
    chunk_ix: number;
    vec: Uint8Array;
    norm: number;
    project_root: string | null;
    cwd: string | null;
  }>;

  const filters = opts.env ? loadFilters(opts.env) : undefined;
  const platform = opts.env?.platform ?? process.platform;
  const normalizedProject = normalizeProject(opts.projectRoot ?? "");
  const deleted = new Set(filters?.deletedSessions ?? []);
  const qNorm = l2norm(opts.queryVec);

  const bySession = new Map<
    string,
    { hits: Array<{ ordinal: number; chunkIx: number; cos: number }>; maxOrdinal: number }
  >();
  for (const row of rows) {
    if (normalizedProject && normalizeProject(row.project_root ?? "") !== normalizedProject) continue;
    if (row.cwd && filters && isDirExcluded(row.cwd, filters, platform)) continue;
    if (deleted.has(row.session_id)) continue;
    const vec = decodeVec(row.vec);
    if (vec.length !== opts.queryVec.length) continue;
    const cos = cosine(opts.queryVec, vec, qNorm, Number(row.norm));
    const entry = bySession.get(row.session_id) ?? { hits: [], maxOrdinal: 0 };
    entry.hits.push({ ordinal: row.ordinal, chunkIx: row.chunk_ix, cos });
    entry.maxOrdinal = Math.max(entry.maxOrdinal, row.ordinal);
    bySession.set(row.session_id, entry);
  }

  const out: SessionVectorScore[] = [];
  for (const [sessionId, entry] of bySession) {
    let best = entry.hits[0]!;
    let weighted = -Infinity;
    for (const hit of entry.hits) {
      if (hit.cos > best.cos) best = hit;
      const ratio = entry.maxOrdinal > 0 ? hit.ordinal / entry.maxOrdinal : 1;
      weighted = Math.max(weighted, hit.cos * (RECENCY_MIN_WEIGHT + (1 - RECENCY_MIN_WEIGHT) * ratio));
    }
    out.push({
      sessionId,
      maxCos: best.cos,
      bestOrdinal: best.ordinal,
      bestChunkIx: best.chunkIx,
      weightedCos: weighted,
    });
  }
  out.sort((a, b) => b.maxCos - a.maxCos);
  return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
}
