import { parseArgs } from "node:util";

import { createChatProvider } from "../../core/llm.js";
import { currentEnv } from "../../core/env.js";
import { checkpoint, openReadOnly, openWritable, StoreMissingError, StoreTooNewError } from "../../store/db.js";
import { enqueueAll } from "../../store/queue.js";
import {
  drainSummaryQueue,
  resolveSummaryRuntimeConfig,
  summaryStatus,
} from "../../store/summaries-store.js";
import { helpText } from "../help.js";

/**
 * memrelay summarize —— 会话摘要生成与状态。
 * 回填全量入队 + drain（content_hash 对账：素材未变零 API 成本跳过）；
 * 输出完整进度，可中断续跑（claim 租约）。配置用配置页的摘要接口。
 */
export async function runSummarize(rest: string[], stdout: (text: string) => void): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: {
      status: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    stdout(helpText());
    return 0;
  }
  const env = currentEnv();
  if (values.status) return summaryStatusCommand(env, stdout);
  return summarizeBackfill(env, stdout);
}

function summaryStatusCommand(env: ReturnType<typeof currentEnv>, stdout: (text: string) => void): number {
  let db;
  try {
    db = openReadOnly(env);
  } catch (err) {
    if (err instanceof StoreMissingError || err instanceof StoreTooNewError) {
      stdout(err.message);
      return 2;
    }
    throw err;
  }
  try {
    let status;
    try {
      status = summaryStatus(db);
    } catch {
      // 旧库还没有摘要表：只读路径不迁移，给出去哪升级的指引
      stdout("索引库版本过旧（还没有摘要表）。先运行 memrelay doctor 或 memrelay ui 升级索引库。");
      return 2;
    }
    stdout("会话摘要状态：");
    stdout(`  开关：${status.enabled ? "已开启" : "未启用（默认关，在配置页开启）"}`);
    if (!status.enabled) return 0;
    stdout(
      `  配置：${status.configured ? `模型 ${status.model} · 主机 ${status.host}` : "不完整（在配置页填接口地址、模型名与 Key）"}`,
    );
    stdout(`  已摘要：${status.summarizedSessions} 个会话`);
    stdout(`  待摘要：${status.pendingSessions} 个会话`);
    if (status.staleSessions > 0) {
      stdout(`  遗留：${status.staleSessions} 条旧模型/主机的摘要（换过配置，需重建）`);
    }
    if (status.lastError) stdout(`  最近错误：${status.lastError}（${status.lastErrorAt ?? ""}）`);
    return 0;
  } finally {
    db.close();
  }
}

async function summarizeBackfill(
  env: ReturnType<typeof currentEnv>,
  stdout: (text: string) => void,
): Promise<number> {
  const db = openWritable(env);
  try {
    const config = resolveSummaryRuntimeConfig(db);
    if (!config) {
      stdout(
        "会话摘要未启用或摘要接口配置不全。先在 memrelay ui 的配置页开启会话摘要，并把接口地址、模型名与 Key 填完整。",
      );
      return 2;
    }
    const queued = enqueueAll(db, "summary_queue");
    stdout(`已入队 ${queued} 个会话；开始生成摘要（模型 ${config.model} · 主机 ${config.host}）…`);
    const provider = createChatProvider({ config });
    const result = await drainSummaryQueue(db, provider, {
      config: { model: config.model, host: config.host },
      env,
      onProgress: (line) => stdout(`  …${line}`),
    });
    checkpoint(db);
    stdout(
      `生成完成：摘要 ${result.processed} 个会话、未变化跳过 ${result.skipped} 个、失败 ${result.failed} 个、剩余 ${result.remaining} 个。`,
    );
    if (result.lastError) {
      stdout(`最近错误：${result.lastError}`);
    }
    if (result.paused) {
      stdout("连续失败已暂停，修好配置后再跑一次即可续上（未变化的会话不会重复花钱）。");
      return 1;
    }
    return 0;
  } finally {
    db.close();
  }
}
