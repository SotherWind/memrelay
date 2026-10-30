import { redactSecrets } from "./secrets.js";

/** 每块约 1200 字符、200 重叠（设计文档 §4）。 */
export const EMBED_CHUNK_SIZE = 1200;
export const EMBED_CHUNK_OVERLAP = 200;
/** 单次 /embeddings 请求最多几条文本。 */
export const EMBED_BATCH_SIZE = 16;
/** 查询向量调用超时（设计文档 §2.2 / §7）：失败静默回退关键词 / FTS。 */
export const QUERY_TIMEOUT_MS = 3000;
/** 把余弦折算到关键词 0..1 标度的两个锚点（§2.1，实现后按真实分布校准）。 */
export const SEMANTIC_LO = 0.35;
export const SEMANTIC_HI = 0.75;
/** 接力聚合的"新近加权"下界：最早的块权重 0.6，最新的 1.0，中间线性。 */
export const RECENCY_MIN_WEIGHT = 0.6;

/** 解析后的嵌入配置（baseUrl / apiKey 已按继承规则补全）。 */
export interface EmbeddingConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
  /** baseUrl 主机（含端口）。指纹组成之一：同名模型不同源不保证同一向量空间。 */
  host: string;
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
}

/** 指纹的展示形式；匹配一律走 SQL 列（model + dims + host），不解析这个字符串。 */
export function fingerprintString(model: string, dims: number, host: string): string {
  return `${model}@${host} (${dims}d)`;
}

/** 固定窗口切块；纯函数（同样的文本永远得到同样的块序列，chunk_ix 才可作幂等键）。 */
export function chunkText(
  text: string,
  size = EMBED_CHUNK_SIZE,
  overlap = EMBED_CHUNK_OVERLAP,
): string[] {
  const chunks: string[] = [];
  if (!text.trim()) return chunks;
  if (text.length <= size) return [text];
  let start = 0;
  while (start < text.length) {
    const chunk = text.slice(start, start + size);
    if (chunk.trim()) chunks.push(chunk);
    if (start + size >= text.length) break;
    start += size - overlap;
  }
  return chunks;
}

export function l2norm(vec: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!;
  return Math.sqrt(sum);
}

export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
  return sum;
}

/** 余弦相似度；norm 传预存的 L2 范数（查询侧用 l2norm 现算一次）。 */
export function cosine(a: Float32Array, b: Float32Array, normA: number, normB: number): number {
  if (normA === 0 || normB === 0) return 0;
  return dot(a, b) / (normA * normB);
}

/** 余弦 → 关键词标度：≤0.35 记 0 分（视为无关），≥0.75 记 1 分（明确命中），中间线性。 */
export function semanticToKeyword(cos: number): number {
  const t = (cos - SEMANTIC_LO) / (SEMANTIC_HI - SEMANTIC_LO);
  return Math.min(1, Math.max(0, t));
}

export interface EmbeddingProvider {
  readonly model: string;
  /** 返回与 texts 一一对应的向量；失败抛 EmbeddingRequestError。 */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export class EmbeddingRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 429 / 5xx / 网络错误 → 指数退避重试；其它（400 等）直接抛出。 */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EmbeddingRequestError";
  }
}

function embeddingsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  // 用户可能直接粘贴到 /embeddings 的完整地址
  return trimmed.endsWith("/embeddings") ? trimmed : `${trimmed}/embeddings`;
}

export interface RemoteProviderOptions {
  config: EmbeddingConfig;
  /** 单次请求超时；查询用 3s，回填用默认 30s。 */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

interface EmbeddingsResponseItem {
  index?: number;
  embedding?: unknown;
}

function parseEmbeddingsBody(body: string, expected: number): Float32Array[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new EmbeddingRequestError("嵌入接口返回的不是 JSON——请检查接口地址是否为 OpenAI 兼容的 /embeddings。", 0, false);
  }
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    const message = (parsed as { error?: { message?: string } }).error?.message;
    throw new EmbeddingRequestError(
      `嵌入接口响应缺少 data 数组${message ? `：${message}` : ""}——请检查配置的模型是否为嵌入模型。`,
      0,
      false,
    );
  }
  const items = (data as EmbeddingsResponseItem[])
    .map((item, fallbackIndex) => ({ index: item.index ?? fallbackIndex, embedding: item.embedding }))
    .sort((a, b) => a.index - b.index);
  if (items.length !== expected) {
    throw new EmbeddingRequestError(
      `嵌入接口返回 ${items.length} 条向量，请求了 ${expected} 条——该接口可能不支持批量输入，请检查配置。`,
      0,
      false,
    );
  }
  const out: Float32Array[] = [];
  for (const item of items) {
    if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
      throw new EmbeddingRequestError("嵌入接口返回的向量不是数字数组——请检查接口兼容性。", 0, false);
    }
    out.push(Float32Array.from(item.embedding as number[]));
  }
  const dims = out[0]!.length;
  if (out.some((v) => v.length !== dims)) {
    throw new EmbeddingRequestError("嵌入接口返回的向量维度不一致。", 0, false);
  }
  return out;
}

/** OpenAI 兼容 /embeddings 客户端：批量 + 429/网络 指数退避。 */
export function createRemoteEmbeddingProvider(opts: RemoteProviderOptions): EmbeddingProvider {
  const { config } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxRetries = opts.maxRetries ?? 3;
  const url = embeddingsUrl(config.baseUrl);

  async function callOnce(texts: string[]): Promise<Float32Array[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model: config.model, input: texts, encoding_format: "float" }),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new EmbeddingRequestError(`嵌入接口请求失败（${message}）`, 0, true);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const snippet = body.replace(/\s+/g, " ").slice(0, 200);
      throw new EmbeddingRequestError(
        `嵌入接口返回 HTTP ${res.status}${snippet ? `：${snippet}` : ""}`,
        res.status,
        res.status === 429 || res.status >= 500,
      );
    }
    return parseEmbeddingsBody(await res.text(), texts.length);
  }

  async function callWithRetry(texts: string[]): Promise<Float32Array[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await callOnce(texts);
      } catch (err) {
        if (!(err instanceof EmbeddingRequestError) || !err.retryable || attempt >= maxRetries) throw err;
        await sleep(1000 * 2 ** attempt);
      }
    }
  }

  return {
    model: config.model,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
        out.push(...(await callWithRetry(texts.slice(i, i + EMBED_BATCH_SIZE))));
      }
      return out;
    },
  };
}

/**
 * 查询向量进程内小 LRU：agent 重试、菜单重查同一关键词、UI 连续搜索时不重复调 API。
 * 键含指纹（model+host），换配置后旧结果不会被误用。
 */
const QUERY_CACHE_MAX = 16;
const queryCache = new Map<string, Float32Array>();

export function queryCacheKey(config: EmbeddingConfig, redactedQuery: string): string {
  return `${config.model}@${config.host}\n${redactedQuery}`;
}

export function clearQueryVectorCache(): void {
  queryCache.clear();
}

/**
 * 查询词 → 向量（§3 查询侧）：先做密钥脱敏；命中 LRU 直接返回；任何失败返回 undefined
 * （调用方静默回退关键词 / FTS，结果与未开启时一致）。
 */
export async function embedQueryText(
  provider: EmbeddingProvider,
  config: EmbeddingConfig,
  text: string,
): Promise<Float32Array | undefined> {
  const redacted = redactSecrets(text).text;
  const key = queryCacheKey(config, redacted);
  const cached = queryCache.get(key);
  if (cached) {
    queryCache.delete(key); // 刷新为最近使用
    queryCache.set(key, cached);
    return cached;
  }
  try {
    const [vec] = await provider.embed([redacted]);
    if (!vec) return undefined;
    queryCache.set(key, vec);
    if (queryCache.size > QUERY_CACHE_MAX) {
      const oldest = queryCache.keys().next().value;
      if (oldest !== undefined) queryCache.delete(oldest);
    }
    return vec;
  } catch {
    return undefined;
  }
}
