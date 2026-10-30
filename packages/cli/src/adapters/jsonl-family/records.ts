import type { Message, MessageRole, Part, ToolCategory } from "../../core/types.js";

export interface LocalToolCall {
  toolCallId: string;
  toolName?: string;
  category: ToolCategory;
  input: unknown;
  isPlan: boolean;
  /** file_edit 对应的文件路径 */
  files: string[];
}

export interface LocalToolResult {
  toolCallId?: string;
  content: string;
  isError: boolean;
}

export interface LocalMessage {
  uuid: string;
  parentUuid?: string;
  role: MessageRole;
  timestamp?: string;
  isSidechain: boolean;
  isCompactBoundary: boolean;
  parts: Part[];
  toolCalls: LocalToolCall[];
  toolResults: LocalToolResult[];
  /** 该条 user 记录是否是实打实的用户指令 */
  isUserPrompt: boolean;
}

/** 归一化 Message → 状态分析用的 LocalMessage（供事件型/DB 型适配器复用）。 */
export function toLocalMessages(messages: Message[]): LocalMessage[] {
  return messages.map((message, index) => ({
    uuid: message.nativeId ?? `${index + 1}`,
    parentUuid: message.nativeParentId,
    role: message.role,
    timestamp: message.createdAt,
    isSidechain: message.isSidechain,
    isCompactBoundary: message.isCompactBoundary,
    parts: message.parts,
    toolCalls: message.parts.flatMap((part) =>
      part.kind === "tool_call" && part.toolCallId
        ? [
            {
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              category: part.toolCategory ?? "other",
              input: part.json,
              isPlan: false,
              files: [],
            },
          ]
        : [],
    ),
    toolResults: message.parts.flatMap((part) =>
      part.kind === "tool_result" && part.toolCallId
        ? [
            {
              toolCallId: part.toolCallId,
              content: part.text ?? "",
              isError: part.status === "error",
            },
          ]
        : [],
    ),
    isUserPrompt:
      message.role === "user" && message.parts.some((part) => part.kind === "text" && part.text),
  }));
}

export interface ParsedSession {
  nativeId: string;
  sourcePath: string;
  cwd: string;
  gitBranch?: string;
  title?: string;
  firstUserMessage?: string;
  version?: string;
  explicitLeaf?: string;
  messages: LocalMessage[];
}

const TOOL_RESULT_KEYS = ["content", "text", "output", "stdout", "stderr"];

export function compactJson(value: unknown, maxLen = 400): string {
  if (value === null || value === undefined) return "";
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

export function textFromToolResultBlock(block: Record<string, unknown>): string {
  for (const key of TOOL_RESULT_KEYS) {
    const v = block[key];
    if (typeof v === "string" && v) return v;
    if (Array.isArray(v)) {
      const chunks: string[] = [];
      for (const item of v) {
        if (typeof item === "string") chunks.push(item);
        else if (item && typeof item === "object") {
          const rec = item as Record<string, unknown>;
          if (rec["type"] === "text" && typeof rec["text"] === "string") chunks.push(rec["text"]);
        }
      }
      if (chunks.length) return chunks.join("\n");
    }
  }
  return compactJson(block);
}

export function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/g, "").trim();
}

export function extractUserText(content: unknown): string {
  if (typeof content === "string") return stripSystemReminders(content);
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const rec = b as Record<string, unknown>;
    if (rec["type"] === "text" && typeof rec["text"] === "string") {
      const t = stripSystemReminders(rec["text"]);
      if (t) chunks.push(t);
    }
  }
  return chunks.join("\n\n").trim();
}

export function flattenText(text: string, maxLen: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxLen ? `${flat.slice(0, maxLen)}…` : flat;
}

export interface StatusInfo {
  pendingToolCallIds: string[];
  lastToolError?: string;
  lastUserMessageUnanswered: boolean;
  quotaOrLimitDetected: boolean;
  errorDetected: boolean;
  lastAssistantText?: string;
  /** 最后一条助手消息是收尾正文（无工具调用、有文本） */
  lastAssistantFinal?: boolean;
}

const QUOTA_RE =
  /(额度|quota|rate.?limit|usage limit|too many requests|429|token limit|context (window )?(exceeded|limit)|out of (credits|tokens)|insufficient|欠费|余额)/i;
const ERROR_RE = /(\berror\b|failed|exception|报错|失败|中断|interrupted)/i;
const ERROR_TAIL_RE = /(^|\n)\s*(error|failed|exception|报错|失败|中断|interrupted)[:：\s]/i;

/**
 * 从消息序列推断会话的收尾状态，供状态判断复用。
 * pending ToolCall 只认"最后一条助手消息里还没结果的调用"：
 * 历史中段被跳过/裁剪的孤儿调用不应让已经继续或收尾的会话永久显示中断。
 */
export function analyzeStatus(messages: LocalMessage[]): StatusInfo {
  const resolved = new Set<string>();
  for (const m of messages) {
    for (const result of m.toolResults) {
      if (result.toolCallId) resolved.add(result.toolCallId);
    }
  }

  let lastAssistant: LocalMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      lastAssistant = messages[i];
      break;
    }
  }
  const pendingToolCallIds = lastAssistant
    ? lastAssistant.toolCalls
        .map((call) => call.toolCallId)
        .filter((id): id is string => Boolean(id) && !resolved.has(id))
    : [];

  let lastToolError: string | undefined;

  let lastReal: LocalMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" || m.role === "assistant") {
      lastReal = m;
      break;
    }
    if (m.role === "system" && m.isCompactBoundary) {
      lastReal = m;
      break;
    }
  }

  const lastUserMessageUnanswered =
    lastReal !== undefined &&
    (lastReal.role === "user"
      ? true
      : lastReal.role === "system" && lastReal.isCompactBoundary);
  const wasUserPrompt = lastReal?.role === "user" && lastReal.isUserPrompt;

  let lastAssistantText: string | undefined;
  let quotaOrLimitDetected = false;
  let errorDetected = false;
  const recent = messages.slice(-8);
  let lastToolResultIndex = -1;
  let lastToolErrorIndex = -1;
  recent.forEach((m, index) => {
    for (const p of m.parts) {
      if (p.kind === "text" && p.text && QUOTA_RE.test(p.text)) quotaOrLimitDetected = true;
      if (p.kind === "tool_result" && p.status === "error" && p.text && QUOTA_RE.test(p.text)) {
        quotaOrLimitDetected = true;
      }
    }
    // 只有"最后一次工具结果仍是错误"才算中断；报错后又成功干活的会话不算。
    for (const result of m.toolResults) {
      lastToolResultIndex = index;
      if (result.isError) {
        lastToolError = result.content.slice(0, 300);
        lastToolErrorIndex = index;
      }
    }
    if (m.role === "assistant") {
      const text = m.parts
        .filter((p) => p.kind === "text" && p.text)
        .map((p) => p.text!)
        .join("\n");
      if (text) {
        lastAssistantText = text;
      }
    }
  });

  if (lastAssistantText && lastAssistantText.length < 600 && ERROR_TAIL_RE.test(lastAssistantText)) {
    errorDetected = true;
  }
  if (lastToolError && QUOTA_RE.test(lastToolError)) quotaOrLimitDetected = true;
  if (lastToolError && lastToolErrorIndex >= lastToolResultIndex) errorDetected = true;

  // 收尾判定：最后一条助手消息必须没有工具调用，且本身有正文。
  // 只看最后一条：中途说过一句话、随后又发起工具调用的不算收尾。
  const lastAssistantOwnText = lastAssistant
    ? lastAssistant.parts
        .filter((p) => p.kind === "text" && p.text?.trim())
        .map((p) => p.text!.trim())
        .join("\n")
    : "";
  const lastAssistantHasTool =
    lastAssistant !== undefined &&
    (lastAssistant.toolCalls.length > 0 ||
      lastAssistant.parts.some(
        (p) => p.kind === "tool_call" || p.kind === "file_edit" || p.kind === "plan",
      ));
  const lastAssistantFinal = Boolean(lastAssistantOwnText) && !lastAssistantHasTool;

  return {
    pendingToolCallIds,
    lastToolError,
    lastUserMessageUnanswered: lastUserMessageUnanswered && wasUserPrompt,
    quotaOrLimitDetected,
    errorDetected,
    lastAssistantFinal,
    lastAssistantText,
  };
}

export function hasToolResultContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((b) => {
    if (!b || typeof b !== "object") return false;
    const t = (b as Record<string, unknown>)["type"];
    return t === "tool_result" || t === "tool-result";
  });
}

export function isMetaRecord(record: Record<string, unknown>): boolean {
  return record["isMeta"] === true;
}
