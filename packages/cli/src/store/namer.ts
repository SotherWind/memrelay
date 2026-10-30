import { createChatProvider } from "../core/llm.js";
import type { Env } from "../core/types.js";
import { checkpoint, openWritable } from "./db.js";
import { drainNameQueue, resolveNameRuntimeConfig, type NameDrainResult } from "./names-store.js";

export interface NameDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** ui 后台用：按当前配置跑一轮有预算的任务名 drain（未启用时零成本空转）。 */
export async function drainNamesWithCurrentConfig(
  env: Env,
  opts: {
    maxSessions?: number;
    maxMs?: number;
    onProgress?: (line: string) => void;
    deps?: NameDeps;
  } = {},
): Promise<NameDrainResult | undefined> {
  const deps = opts.deps ?? {};
  try {
    const db = openWritable(env);
    try {
      const config = resolveNameRuntimeConfig(db);
      if (!config) return undefined;
      const provider = createChatProvider({
        config,
        label: "任务名",
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
      });
      const result = await drainNameQueue(db, provider, {
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
