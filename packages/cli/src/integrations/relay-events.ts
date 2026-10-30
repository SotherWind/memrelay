import fs from "node:fs";
import path from "node:path";

import { memrelayDir } from "../core/env.js";
import type { Env } from "../core/types.js";

export const TRAE_EVENTS_SUBDIR = "relay-events/trae-cn";
export const TRAE_AGENT_HOOKS_SUBDIR = "ModularData/ai-agent/hooks_env/memrelay-events";

/** Trae 的 Electron userData 根目录（跨平台；国际版/CN 两个产品名都看）。 */
export function traeUserDataRoots(env: Env): string[] {
  const appData = env.env["APPDATA"];
  if (appData) {
    return ["Trae CN", "Trae"].map((name) => path.join(appData, name));
  }
  if (env.platform === "darwin") {
    return ["Trae CN", "Trae"].map((name) =>
      path.join(env.home, "Library", "Application Support", name),
    );
  }
  if (env.platform === "linux") {
    const config = env.env["XDG_CONFIG_HOME"] ?? path.join(env.home, ".config");
    return ["Trae CN", "Trae"].map((name) => path.join(config, name));
  }
  return [];
}

/** Trae Agent 沙箱允许写的 hooks_env 目录（Agent 模式的 hook 落盘位置）。 */
export function traeAgentHooksRoots(env: Env): string[] {
  return traeUserDataRoots(env).map((root) =>
    path.join(root, ...TRAE_AGENT_HOOKS_SUBDIR.split("/")),
  );
}

function pickString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function stringify(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 把 Trae 的原始 hook payload 规范化成 relay-events 记录（hook 落盘与适配器读盘共用）。 */
export function traePayloadRecords(
  payload: Record<string, unknown>,
  now = Date.now(),
): Array<Record<string, unknown>> {
  const eventName =
    pickString(payload, ["hook_event_name", "event_name", "eventName", "event"]) ?? "";
  const cwd = pickString(payload, [
    "cwd",
    "workspace",
    "workspace_folder",
    "workspaceFolder",
    "project_path",
    "projectPath",
  ]);
  const prompt = pickString(payload, ["prompt", "user_prompt", "userPrompt"]);
  const toolName = pickString(payload, ["tool_name", "toolName"]);
  const toolCallId = pickString(payload, ["tool_call_id", "toolCallId", "tool_use_id", "toolUseId"]);
  const toolInput = payload["input"] ?? payload["tool_input"] ?? payload["toolInput"];
  const toolResponse =
    payload["response"] ?? payload["tool_response"] ?? payload["toolResponse"] ?? payload["output"];
  const assistantText = pickString(payload, [
    "last_assistant_message",
    "lastAssistantMessage",
    "assistant_message",
  ]);

  const records: Array<Record<string, unknown>> = [];
  if (cwd) records.push({ time: now, type: "session-meta", cwd });

  const event = eventName.toLowerCase();
  if (event.includes("sessionstart") || event.includes("session_start")) {
    records.push({ time: now, type: "session-start" });
  } else if (toolName) {
    records.push({ time: now, type: "function_call", name: toolName, arguments: toolInput, callId: toolCallId });
    const resultText = stringify(toolResponse);
    if (resultText !== undefined) {
      records.push({ time: now, type: "function_call_result", name: toolName, response: resultText, callId: toolCallId });
    }
  } else if (prompt) {
    records.push({ time: now, type: "message", role: "user", text: prompt });
  } else if (assistantText) {
    records.push({ time: now, type: "message", role: "assistant", text: assistantText });
  } else if (eventName) {
    records.push({ time: now, type: "note", event: eventName });
  }
  return records;
}

/**
 * Trae CN IDE / Agent 的事件采集：
 * IDE 会话库加密不可读，hooks 会把每轮 prompt、工具轨迹和最终回复送过来；
 * 这里把它们落成我们自己的格式（relay-events/trae-cn/<sessionId>.jsonl），
 * 由 trae-events 适配器重建会话。
 */
export function recordTraeEvent(env: Env, payload: Record<string, unknown>): void {
  try {
    const sessionId = pickString(payload, ["session_id", "sessionId"]);
    if (!sessionId || !/^[A-Za-z0-9._-]{6,}$/.test(sessionId)) return; // 防路径穿越

    const records = traePayloadRecords(payload);
    if (records.length === 0) return;

    const dir = path.join(memrelayDir(env), ...TRAE_EVENTS_SUBDIR.split("/"));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.appendFileSync(file, records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
  } catch {
    /* hook 永不打扰宿主 */
  }
}
