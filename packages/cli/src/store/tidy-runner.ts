import type { DatabaseSync } from "node:sqlite";

import { createChatProvider, type ChatProvider } from "../core/llm.js";
import { redactSecrets } from "../core/secrets.js";
import { TIDY_PROMPT_VERSION, buildTidyPrompt, parseTidyResult } from "../core/tidy-plan.js";
import type { Env } from "../core/types.js";
import { applyTidyExports, undoTidyExports, type TidyUndoResult } from "./tidy-export.js";
import {
  clearTidyError,
  importMemorySources,
  readTidyInputs,
  readTidyMaterials,
  readTidyPlan,
  readTidyPromptVersion,
  recordTidyRun,
  resolveTidyConfig,
  writeTidyError,
  writeTidyPlan,
  writeTidyPromptVersion,
} from "./tidy-store.js";

export interface TidyRunResult {
  ran: boolean;
  changed: number;
  entries: number;
  conflicts: number;
  written: number;
  skipped?: "unchanged" | "no-sources";
  error?: string;
}

function planEntries(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter(Boolean);
}

/**
 * 导入来源 → 指纹未变则零成本跳过 → 模型合并 → 写标记块。
 * 关闭/未配置时返回 undefined（不产生任何请求）。
 */
export async function runTidy(
  db: DatabaseSync,
  env: Env,
  opts: { provider?: ChatProvider; now?: () => number } = {},
): Promise<TidyRunResult | undefined> {
  const config = resolveTidyConfig(db);
  if (!config) return undefined;
  const now = opts.now ?? Date.now;
  const imported = importMemorySources(db, env, now());
  const inputs = readTidyInputs(db);
  const previous = readTidyPlan(db);
  const sameInputs =
    previous !== null &&
    previous.model === config.model &&
    previous.host === config.host &&
    readTidyPromptVersion(db) === String(TIDY_PROMPT_VERSION) &&
    JSON.stringify(previous.inputs) === JSON.stringify(inputs);
  if (sameInputs) {
    // 已下发的标记块可能被工具重写掉：不调模型，直接补回（撤销后 status=ready，不会补）。
    if (previous.status === "applied" || previous.status === "conflict") {
      const entries = planEntries(previous.content);
      if (entries.length > 0) applyTidyExports(db, env, entries, now());
    }
    return {
      ran: false,
      changed: imported.changed,
      entries: planEntries(previous.content).length,
      conflicts: previous.conflicts.length,
      written: 0,
      skipped: "unchanged",
    };
  }

  const materials = readTidyMaterials(db).map((material) => ({
    ...material,
    items: material.items.map((item) => ({ ...item, text: redactSecrets(item.text).text })),
  }));
  if (materials.length === 0) {
    return {
      ran: false,
      changed: imported.changed,
      entries: 0,
      conflicts: 0,
      written: 0,
      skipped: "no-sources",
    };
  }

  const provider =
    opts.provider ??
    createChatProvider({ config, label: "整理", timeoutMs: 150_000, maxRetries: 1 });
  const prompt = buildTidyPrompt(materials);
  try {
    const result = parseTidyResult(await provider.complete(prompt.system, prompt.user));
    const content = result.entries.map((entry) => `- ${entry}`).join("\n");
    writeTidyPlan(
      db,
      {
        status: "ready",
        content,
        conflicts: result.conflicts,
        inputs,
        model: config.model,
        host: config.host,
      },
      now(),
    );
    const applied = applyTidyExports(db, env, result.entries, now());
    writeTidyPlan(
      db,
      {
        status: result.conflicts.length > 0 ? "conflict" : "applied",
        content,
        conflicts: result.conflicts,
        inputs,
        model: config.model,
        host: config.host,
      },
      now(),
    );
    clearTidyError(db);
    writeTidyPromptVersion(db, String(TIDY_PROMPT_VERSION));
    recordTidyRun(db, true, now());
    return {
      ran: true,
      changed: imported.changed,
      entries: result.entries.length,
      conflicts: result.conflicts.length,
      written: applied.written.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeTidyError(db, message, now());
    recordTidyRun(db, false, now());
    // 模型成功但写文件失败时，计划原本是 ready；标记 error 让用户能看到并手动重试。
    const plan = readTidyPlan(db);
    if (plan && plan.status === "ready") {
      writeTidyPlan(db, { ...plan, status: "error" }, now());
    }
    return {
      ran: false,
      changed: imported.changed,
      entries: 0,
      conflicts: 0,
      written: 0,
      error: message,
    };
  }
}

/** 把当前计划重新写一遍（撤销后想恢复，或手动应用）。 */
export function applyExistingTidyPlan(
  db: DatabaseSync,
  env: Env,
  now = Date.now(),
): { written: number; error?: string } {
  const plan = readTidyPlan(db);
  if (!plan) return { written: 0, error: "还没有整理结果" };
  const entries = planEntries(plan.content);
  if (entries.length === 0) return { written: 0, error: "整理结果为空" };
  try {
    const applied = applyTidyExports(db, env, entries, now);
    writeTidyPlan(db, { ...plan, status: plan.conflicts.length > 0 ? "conflict" : "applied" }, now);
    return { written: applied.written.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeTidyPlan(db, { ...plan, status: "error" }, now);
    writeTidyError(db, message, now);
    return { written: 0, error: message };
  }
}

/** 撤销下发；计划保留但标记为 ready，源不变时不会立刻被自动重新应用。 */
export function undoTidy(db: DatabaseSync, env: Env, now = Date.now()): TidyUndoResult {
  const result = undoTidyExports(db, env);
  const plan = readTidyPlan(db);
  if (plan) writeTidyPlan(db, { ...plan, status: "ready" }, now);
  return result;
}
