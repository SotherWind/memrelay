import type { Env } from "../core/types.js";
import { createChatProvider } from "../core/llm.js";
import { checkpoint, openReadOnly, openWritable } from "./db.js";
import {
  drainSummaryQueue,
  getSessionSummaries,
  getSessionSummary,
  resolveSummaryRuntimeConfig,
  type SummaryDrainResult,
} from "./summaries-store.js";

/**
 * 查询侧摘要通道（设计文档 docs/llm-summary.md §4）：
 * 消费点只读现成摘要；缺了就按预算做定向生成（resume ≤1 会话 / ≤6s，search ≤3 会话 / ≤5s）。
 * 任何失败静默返回空——调用方按现状渲染。hook 路径不会走到这里（绝不做网络请求）。
 */

export interface SummaryDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const RESUME_SUMMARY_BUDGET_MS = 6000;
export const SEARCH_SUMMARY_BUDGET_MS = 5000;
export const SEARCH_SUMMARY_BUDGET_SESSIONS = 3;

/** 只读取现成摘要（批量）；沙箱里也能用。 */
export function readSummaries(env: Env, sessionIds: string[]): Map<string, string> {
  try {
    const db = openReadOnly(env);
    try {
      return getSessionSummaries(db, sessionIds);
    } finally {
      db.close();
    }
  } catch {
    return new Map();
  }
}

export function readSummary(env: Env, sessionId: string): string | undefined {
  return readSummaries(env, [sessionId]).get(sessionId);
}

export interface TargetedSummaryOptions {
  sessionIds?: string[];
  projectRoot?: string;
  maxSessions?: number;
  maxMs?: number;
  deps?: SummaryDeps;
}

/** 查询前定向排空（与向量检索的 targetedDrain 同模式）：沙箱写库失败、接口失败都静默。 */
export async function targetedSummaryDrain(
  env: Env,
  opts: TargetedSummaryOptions = {},
): Promise<SummaryDrainResult | undefined> {
  const deps = opts.deps ?? {};
  const maxMs = opts.maxMs ?? RESUME_SUMMARY_BUDGET_MS;
  try {
    const db = openWritable(env);
    try {
      const config = resolveSummaryRuntimeConfig(db);
      if (!config) return undefined;
      const provider = createChatProvider({
        config,
        // 查询侧不重试：预算内一次调用，失败即静默回退
        timeoutMs: maxMs,
        maxRetries: 0,
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
      });
      const result = await drainSummaryQueue(db, provider, {
        config: { model: config.model, host: config.host },
        batchSessions: opts.maxSessions ?? 1,
        maxSessions: opts.maxSessions ?? 1,
        maxMs,
        sessionIds: opts.sessionIds,
        projectRoot: opts.projectRoot,
        env,
        now: deps.now,
      });
      checkpoint(db); // 随后的只读读要能看见刚写入的行
      return result;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/** resume 用：已有就零成本返回；缺了定向生成；失败返回 undefined（调用方按现状渲染）。 */
export async function resumeSummary(
  env: Env,
  sessionId: string,
  deps: SummaryDeps = {},
): Promise<string | undefined> {
  const existing = readSummary(env, sessionId);
  if (existing) return existing;
  await targetedSummaryDrain(env, {
    sessionIds: [sessionId],
    maxSessions: 1,
    maxMs: RESUME_SUMMARY_BUDGET_MS,
    deps,
  });
  return readSummary(env, sessionId);
}

/** search 用：先对本项目队列做有预算排空，给"最近活跃"的会话补摘要。 */
export async function searchSummaryDrain(env: Env, projectRoot: string, deps: SummaryDeps = {}): Promise<void> {
  await targetedSummaryDrain(env, {
    projectRoot,
    maxSessions: SEARCH_SUMMARY_BUDGET_SESSIONS,
    maxMs: SEARCH_SUMMARY_BUDGET_MS,
    deps,
  });
}

/** ui 后台 / doctor 用：按当前配置跑一轮有预算的 drain（未启用时零成本空转）。 */
export async function drainSummaryWithCurrentConfig(
  env: Env,
  opts: { maxSessions?: number; maxMs?: number; onProgress?: (line: string) => void; deps?: SummaryDeps } = {},
): Promise<SummaryDrainResult | undefined> {
  const deps = opts.deps ?? {};
  try {
    const db = openWritable(env);
    try {
      const config = resolveSummaryRuntimeConfig(db);
      if (!config) return undefined;
      const provider = createChatProvider({ config, fetchImpl: deps.fetchImpl, sleep: deps.sleep });
      const result = await drainSummaryQueue(db, provider, {
        config: { model: config.model, host: config.host },
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
