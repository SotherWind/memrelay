import { parseArgs } from "node:util";

import { createRemoteEmbeddingProvider } from "../../core/embeddings.js";
import { currentEnv } from "../../core/env.js";
import { checkpoint, openReadOnly, openWritable, StoreMissingError, StoreTooNewError } from "../../store/db.js";
import {
  drainEmbedQueue,
  embeddingStatus,
  resolveEmbeddingConfig,
} from "../../store/embeddings-store.js";
import { enqueueAll } from "../../store/queue.js";
import { helpText } from "../help.js";

/**
 * memrelay embed —— 向量回填与状态。
 * 回填全量入队 + drain（content_hash 对账：未变的块零 API 成本跳过）；
 * 输出完整进度，可中断续跑（claim 租约）。
 */
export async function runEmbed(rest: string[], stdout: (text: string) => void): Promise<number> {
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
  if (values.status) return embedStatus(env, stdout);
  return embedBackfill(env, stdout);
}

function embedStatus(env: ReturnType<typeof currentEnv>, stdout: (text: string) => void): number {
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
      status = embeddingStatus(db);
    } catch {
      // v3 及更早的库还没有向量表：只读路径不迁移，给出去哪升级的指引
      stdout("索引库版本过旧（还没有向量表）。先运行 memrelay doctor 或 memrelay ui 升级索引库。");
      return 2;
    }
    stdout("向量检索状态：");
    stdout(`  开关：${status.enabled ? "已开启" : "未启用（默认关，在配置页开启）"}`);
    if (!status.enabled) return 0;
    stdout(`  配置：${status.configured ? `模型 ${status.model} · 主机 ${status.host}` : "不完整（需要接口地址、模型名与 Key）"}`);
    stdout(`  已嵌：${status.embeddedSessions} 个会话 / ${status.embeddedChunks} 块`);
    stdout(`  待嵌：${status.pendingSessions} 个会话`);
    if (status.staleChunks > 0) {
      stdout(`  遗留：${status.staleChunks} 块旧指纹向量（换过模型/主机，需重建）`);
      const est = status.estimate;
      if (est) stdout(`  重建预估：约 ${est.tokens.toLocaleString()} tokens ≈ $${est.usd.toFixed(3)}（按 text-embedding-3-small 价）`);
    }
    if (status.rulesOutdated) {
      stdout("  提示：密钥脱敏规则已更新，相关块会在下次回填（memrelay embed）时自动重嵌。");
    }
    if (status.lastError) stdout(`  最近错误：${status.lastError}（${status.lastErrorAt ?? ""}）`);
    return 0;
  } finally {
    db.close();
  }
}

async function embedBackfill(env: ReturnType<typeof currentEnv>, stdout: (text: string) => void): Promise<number> {
  const db = openWritable(env);
  try {
    const config = resolveEmbeddingConfig(db);
    if (!config) {
      stdout(
        "向量检索未启用或配置不全。先在 memrelay ui 的配置页开启语义检索，并把接口地址、模型名与 Key 填完整。",
      );
      return 2;
    }
    const queued = enqueueAll(db, "embed_queue");
    stdout(`已入队 ${queued} 个会话；开始回填（模型 ${config.model} · 主机 ${config.host}）…`);
    const provider = createRemoteEmbeddingProvider({ config });
    const result = await drainEmbedQueue(db, provider, {
      fingerprint: { model: config.model, host: config.host },
      env,
      onProgress: (line) => stdout(`  …${line}`),
    });
    checkpoint(db);
    stdout(
      `回填完成：嵌入 ${result.processed} 个会话、未变化跳过 ${result.skipped} 个、失败 ${result.failed} 个、剩余 ${result.remaining} 个。`,
    );
    if (result.lastError) {
      stdout(`最近错误：${result.lastError}`);
    }
    if (result.paused) {
      stdout("连续失败已暂停，修好配置后再跑一次即可续上（未变化的块不会重复花钱）。");
      return 1;
    }
    return 0;
  } finally {
    db.close();
  }
}
