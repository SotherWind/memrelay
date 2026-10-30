import type { DatabaseSync } from "node:sqlite";

import type { Env } from "../core/types.js";
import {
  createRemoteEmbeddingProvider,
  embedQueryText,
  QUERY_TIMEOUT_MS,
  type EmbeddingConfig,
  type EmbeddingProvider,
} from "../core/embeddings.js";
import { checkpoint, openReadOnly, openWritable } from "./db.js";
import {
  drainEmbedQueue,
  resolveEmbeddingConfig,
  scoreSessionsByVector,
  type DrainResult,
} from "./embeddings-store.js";

/**
 * 查询侧语义通道（设计文档 §3）：查询词脱敏后嵌入一次（3s 超时 + 进程内 LRU），
 * 项目域预过滤后流式扫描余弦。任何环节失败都静默返回空结果——调用方原样走关键词 / FTS。
 * hook 路径不会走到这里（绝不做网络请求）。
 */

export interface SemanticDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface SemanticRuntime {
  config: EmbeddingConfig;
  provider: EmbeddingProvider;
}

/** 从库里读配置；未启用 / 配置不全时 undefined。只读连接也适用。 */
export function createSemanticRuntime(
  db: DatabaseSync,
  opts: SemanticDeps & { timeoutMs?: number } = {},
): SemanticRuntime | undefined {
  const config = resolveEmbeddingConfig(db);
  if (!config) return undefined;
  return {
    config,
    provider: createRemoteEmbeddingProvider({
      config,
      timeoutMs: opts.timeoutMs ?? QUERY_TIMEOUT_MS,
      // 查询侧不重试：3s 预算内一次调用，失败即静默回退（重试留给回填侧）
      maxRetries: 0,
      fetchImpl: opts.fetchImpl,
    }),
  };
}

export interface TargetedDrainOptions {
  sessionIds?: string[];
  projectRoot?: string;
  /** 预算：≤3 会话 / 总计 ≤5s（设计文档 §6）。 */
  maxSessions?: number;
  maxMs?: number;
  deps?: SemanticDeps;
}

/**
 * 查询前定向排空：补"刚被打断就接力 / 搜索、最新会话还没嵌入"的热场景。
 * 沙箱里写库失败、接口失败都静默跳过（返回 undefined）。
 */
export async function targetedDrain(
  env: Env,
  opts: TargetedDrainOptions = {},
): Promise<DrainResult | undefined> {
  const deps = opts.deps ?? {};
  try {
    const db = openWritable(env);
    try {
      const runtime = createSemanticRuntime(db, deps);
      if (!runtime) return undefined;
      const provider = createRemoteEmbeddingProvider({ config: runtime.config, fetchImpl: deps.fetchImpl });
      const result = await drainEmbedQueue(db, provider, {
        fingerprint: { model: runtime.config.model, host: runtime.config.host },
        batchSessions: opts.maxSessions ?? 3,
        maxSessions: opts.maxSessions ?? 3,
        maxMs: opts.maxMs ?? 5000,
        sessionIds: opts.sessionIds,
        projectRoot: opts.projectRoot,
        env,
        now: deps.now,
      });
      checkpoint(db); // 随后的只读打开要能看见刚写入的行
      return result;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/** 接力用：候选会话 → 会话内"新近加权聚合"的余弦（无结果 / 失败为空 Map）。 */
export async function semanticScoresForResume(
  env: Env,
  keyword: string,
  sessionIds: string[],
  deps: SemanticDeps = {},
): Promise<Map<string, number>> {
  if (!keyword.trim() || sessionIds.length === 0) return new Map();
  try {
    await targetedDrain(env, { sessionIds, deps });
    const db = openReadOnly(env);
    try {
      const runtime = createSemanticRuntime(db, deps);
      if (!runtime) return new Map();
      const queryVec = await embedQueryText(runtime.provider, runtime.config, keyword);
      if (!queryVec) return new Map();
      const scored = scoreSessionsByVector(
        db,
        { model: runtime.config.model, host: runtime.config.host, dims: queryVec.length },
        { queryVec, sessionIds, env },
      );
      return new Map(scored.map((s) => [s.sessionId, s.weightedCos]));
    } finally {
      db.close();
    }
  } catch {
    return new Map();
  }
}

export interface VectorSessionHit {
  sessionId: string;
  /** 会话内最强块的余弦 */
  cos: number;
  ordinal: number;
  chunkIx: number;
}

export interface SearchSemanticOptions extends SemanticDeps {
  projectRoot: string;
  limit?: number;
  /** 服务端（长驻进程 + ui 后台循环在跑）跳过定向排空 */
  drain?: boolean;
}

/** 搜索用：向量榜（会话级、按最强块余弦降序；无结果 / 失败为空数组）。 */
export async function semanticHitsForSearch(
  env: Env,
  keyword: string,
  opts: SearchSemanticOptions,
): Promise<VectorSessionHit[]> {
  if (!keyword.trim()) return [];
  try {
    if (opts.drain !== false) {
      await targetedDrain(env, { projectRoot: opts.projectRoot, deps: opts });
    }
    const db = openReadOnly(env);
    try {
      const runtime = createSemanticRuntime(db, opts);
      if (!runtime) return [];
      const queryVec = await embedQueryText(runtime.provider, runtime.config, keyword);
      if (!queryVec) return [];
      const scored = scoreSessionsByVector(
        db,
        { model: runtime.config.model, host: runtime.config.host, dims: queryVec.length },
        { queryVec, projectRoot: opts.projectRoot, env, limit: opts.limit },
      );
      return scored.map((s) => ({
        sessionId: s.sessionId,
        cos: s.maxCos,
        ordinal: s.bestOrdinal,
        chunkIx: s.bestChunkIx,
      }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** 供 doctor / ui 后台等长驻场景用：按当前配置跑一轮有预算的 drain。 */
export async function drainWithCurrentConfig(
  env: Env,
  opts: { maxSessions?: number; maxMs?: number; onProgress?: (line: string) => void; deps?: SemanticDeps } = {},
): Promise<DrainResult | undefined> {
  const deps = opts.deps ?? {};
  try {
    const db = openWritable(env);
    try {
      const runtime = createSemanticRuntime(db, deps);
      if (!runtime) return undefined;
      const provider = createRemoteEmbeddingProvider({ config: runtime.config, fetchImpl: deps.fetchImpl });
      const result = await drainEmbedQueue(db, provider, {
        fingerprint: { model: runtime.config.model, host: runtime.config.host },
        batchSessions: 4,
        maxSessions: opts.maxSessions,
        maxMs: opts.maxMs,
        env,
        now: deps.now,
        onProgress: opts.onProgress,
      });
      checkpoint(db);
      return result;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}
