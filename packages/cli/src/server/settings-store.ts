import type { DatabaseSync } from "node:sqlite";

import { inTransaction } from "../store/db.js";
import { enqueueAll } from "../store/queue.js";

export interface UiSettingsDto {
  /** 语义检索（向量）：独立接口；未填全时该功能不生效，搜索回退关键词 */
  embedding: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    apiKeySet: boolean;
  };
  autoIntegrate: boolean;
  /** 会话摘要（LLM 增强，opt-in）：独立接口；未填全时回退规则提炼 */
  summary: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    apiKeySet: boolean;
  };
  /** 跨工具偏好整理（自动）：独立接口；未填全时不运行 */
  tidy: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    apiKeySet: boolean;
  };
}

const KEYS = {
  autoIntegrate: "autoIntegrate",
  embedEnabled: "embed.enabled",
  embedBaseUrl: "embed.baseUrl",
  embedModel: "embed.model",
  embedApiKey: "embed.apiKey",
  summaryEnabled: "summary.enabled",
  summaryBaseUrl: "summary.baseUrl",
  summaryModel: "summary.model",
  summaryApiKey: "summary.apiKey",
  tidyEnabled: "tidy.enabled",
  tidyBaseUrl: "tidy.baseUrl",
  tidyModel: "tidy.model",
  tidyApiKey: "tidy.apiKey",
} as const;

function readKey(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value?: string | null }
    | undefined;
  return typeof row?.value === "string" ? row.value : undefined;
}

function writeKey(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

export function readUiSettings(db: DatabaseSync): UiSettingsDto {
  return {
    embedding: {
      enabled: readKey(db, KEYS.embedEnabled) === "1",
      baseUrl: readKey(db, KEYS.embedBaseUrl) ?? "",
      model: readKey(db, KEYS.embedModel) ?? "",
      apiKeySet: (readKey(db, KEYS.embedApiKey) ?? "").length > 0,
    },
    autoIntegrate: readKey(db, KEYS.autoIntegrate) === "1",
    summary: {
      enabled: readKey(db, KEYS.summaryEnabled) === "1",
      baseUrl: readKey(db, KEYS.summaryBaseUrl) ?? "",
      model: readKey(db, KEYS.summaryModel) ?? "",
      apiKeySet: (readKey(db, KEYS.summaryApiKey) ?? "").length > 0,
    },
    tidy: {
      enabled: readKey(db, KEYS.tidyEnabled) === "1",
      baseUrl: readKey(db, KEYS.tidyBaseUrl) ?? "",
      model: readKey(db, KEYS.tidyModel) ?? "",
      apiKeySet: (readKey(db, KEYS.tidyApiKey) ?? "").length > 0,
    },
  };
}

export interface UiSettingsPatch {
  embedding?: { enabled?: boolean; baseUrl?: string; model?: string; apiKey?: string };
  autoIntegrate?: boolean;
  summary?: { enabled?: boolean; baseUrl?: string; model?: string; apiKey?: string };
  tidy?: { enabled?: boolean; baseUrl?: string; model?: string; apiKey?: string };
}

export function writeUiSettings(db: DatabaseSync, patch: UiSettingsPatch): UiSettingsDto {
  let enabledBefore: boolean | undefined;
  let summaryEnabledBefore: boolean | undefined;
  inTransaction(db, () => {
    if (patch.autoIntegrate !== undefined) writeKey(db, KEYS.autoIntegrate, patch.autoIntegrate ? "1" : "0");
    if (patch.summary !== undefined) {
      summaryEnabledBefore = readKey(db, KEYS.summaryEnabled) === "1";
      if (patch.summary.enabled !== undefined) {
        writeKey(db, KEYS.summaryEnabled, patch.summary.enabled ? "1" : "0");
      }
      if (patch.summary.baseUrl !== undefined) writeKey(db, KEYS.summaryBaseUrl, patch.summary.baseUrl.trim());
      if (patch.summary.model !== undefined) writeKey(db, KEYS.summaryModel, patch.summary.model.trim());
      // 空字符串表示清除；未提供表示保持原值
      if (patch.summary.apiKey !== undefined) writeKey(db, KEYS.summaryApiKey, patch.summary.apiKey.trim());
    }
    if (patch.embedding !== undefined) {
      enabledBefore = readKey(db, KEYS.embedEnabled) === "1";
      if (patch.embedding.enabled !== undefined) {
        writeKey(db, KEYS.embedEnabled, patch.embedding.enabled ? "1" : "0");
      }
      if (patch.embedding.baseUrl !== undefined) writeKey(db, KEYS.embedBaseUrl, patch.embedding.baseUrl.trim());
      if (patch.embedding.model !== undefined) writeKey(db, KEYS.embedModel, patch.embedding.model.trim());
      if (patch.embedding.apiKey !== undefined) writeKey(db, KEYS.embedApiKey, patch.embedding.apiKey.trim());
    }
    if (patch.tidy !== undefined) {
      if (patch.tidy.enabled !== undefined) writeKey(db, KEYS.tidyEnabled, patch.tidy.enabled ? "1" : "0");
      if (patch.tidy.baseUrl !== undefined) writeKey(db, KEYS.tidyBaseUrl, patch.tidy.baseUrl.trim());
      if (patch.tidy.model !== undefined) writeKey(db, KEYS.tidyModel, patch.tidy.model.trim());
      if (patch.tidy.apiKey !== undefined) writeKey(db, KEYS.tidyApiKey, patch.tidy.apiKey.trim());
    }
  });
  // 重新开启（关→开）：全量入队 + content_hash 对账——未变块零 API 成本跳过（设计文档 §8）。
  // 不能反向：关闭只停查询通道，向量保留。
  if (patch.embedding?.enabled === true && enabledBefore === false) {
    try {
      enqueueAll(db, "embed_queue");
    } catch {
      /* 入队失败不阻断设置保存；下次回填 / doctor 会补上 */
    }
  }
  // 会话摘要重新开启同理：全量入队 + hash 对账（未变零成本）
  if (patch.summary?.enabled === true && summaryEnabledBefore === false) {
    try {
      enqueueAll(db, "summary_queue");
    } catch {
      /* 同上 */
    }
  }
  return readUiSettings(db);
}
