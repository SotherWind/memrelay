import type { SessionStatus } from "../core/types.js";
import { extractFilePaths } from "../core/tool-names.js";
import { analyzeStatus, type LocalMessage, type StatusInfo } from "../adapters/jsonl-family/records.js";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "done" | "unknown";
}

/** 一条 plan 工具调用。TaskCreate 的真实 id 只出现在工具结果里，所以要把结果一并带上。 */
export interface PlanPart {
  input: Record<string, unknown>;
  resultText?: string;
}

/** 从 plan 工具调用里提炼出最终的待办清单（TodoWrite / update_plan / TaskCreate+Update）。 */
export function extractTodos(messages: LocalMessage[]): TodoItem[] {
  const resultByCall = new Map<string, string>();
  for (const m of messages) {
    for (const r of m.toolResults) {
      if (r.toolCallId) resultByCall.set(r.toolCallId, r.content);
    }
  }
  const planParts: PlanPart[] = [];
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.kind !== "plan") continue;
      const input = p.json;
      if (!input || typeof input !== "object") continue;
      planParts.push({
        input: input as Record<string, unknown>,
        resultText: p.toolCallId ? resultByCall.get(p.toolCallId) : undefined,
      });
    }
  }
  return extractTodosFromPlanParts(planParts);
}

/** 同上，但直接接收 plan 片段（查库快路径复用）。 */
export function extractTodosFromPlanParts(planParts: PlanPart[]): TodoItem[] {
  if (planParts.length === 0) return [];

  const taskMap = new Map<string, TodoItem>();
  const taskSeq: string[] = [];
  let lastFullList: TodoItem[] = [];
  let sawTodoWrite = false;

  for (const { input, resultText } of planParts) {
    const todos = input["todos"];
    if (Array.isArray(todos)) {
      sawTodoWrite = true;
      const list: TodoItem[] = [];
      for (const t of todos) {
        if (!t || typeof t !== "object") continue;
        const rec = t as Record<string, unknown>;
        const content = typeof rec["content"] === "string" ? rec["content"] : undefined;
        if (!content) continue;
        list.push({ content, status: normalizeStatus(rec["status"]) });
      }
      lastFullList = list;
      continue;
    }
    const plan = input["plan"];
    if (Array.isArray(plan)) {
      sawTodoWrite = true;
      const list: TodoItem[] = [];
      for (const t of plan) {
        if (!t || typeof t !== "object") continue;
        const rec = t as Record<string, unknown>;
        const content =
          typeof rec["step"] === "string"
            ? rec["step"]
            : typeof rec["content"] === "string"
              ? rec["content"]
              : undefined;
        if (!content) continue;
        list.push({ content, status: normalizeStatus(rec["status"]) });
      }
      lastFullList = list;
      continue;
    }
    const subject = input["subject"];
    if (typeof subject === "string") {
      // TaskCreate 的入参没有 id；真实 id 在工具结果 "Task #1 created successfully" 里
      const id = idString(input["taskId"]) ?? createdTaskId(resultText);
      if (id) {
        taskMap.set(id, { content: subject, status: normalizeStatus(input["status"]) });
        taskSeq.push(id);
      } else {
        const key = `t${taskSeq.length}`;
        taskMap.set(key, { content: subject, status: "pending" });
        taskSeq.push(key);
      }
      continue;
    }
    const taskId = idString(input["taskId"]);
    if (taskId && taskMap.has(taskId)) {
      const entry = taskMap.get(taskId)!;
      if (typeof input["status"] === "string") entry.status = normalizeStatus(input["status"]);
      if (typeof input["subject"] === "string") entry.content = input["subject"];
    }
  }

  if (sawTodoWrite) return lastFullList;
  return taskSeq.map((id) => taskMap.get(id)!).filter(Boolean);
}

function idString(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw) return raw;
  if (typeof raw === "number") return String(raw);
  return undefined;
}

/** "Task #1 created successfully" / "任务 #1 创建成功" → "1"。 */
function createdTaskId(resultText: string | undefined): string | undefined {
  if (!resultText) return undefined;
  const match = /(?:task|任务)\s*#?\s*(\d+)[^\n]*(?:created|创建成功)/i.exec(resultText);
  return match?.[1];
}

function normalizeStatus(raw: unknown): TodoItem["status"] {
  if (typeof raw !== "string") return "unknown";
  const v = raw.toLowerCase();
  if (v === "completed" || v === "done" || v === "complete") return "done";
  if (v === "in_progress" || v === "in-progress" || v === "active") return "in_progress";
  if (v === "pending" || v === "todo" || v === "open") return "pending";
  return "unknown";
}

/** 最后一段文本：最后一条 assistant 说的完整话。 */
export function lastAssistantText(messages: LocalMessage[], maxChars = 1500): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const text = m.parts
      .filter((p) => p.kind === "text" && p.text)
      .map((p) => p.text!)
      .join("\n")
      .trim();
    if (text) return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }
  return undefined;
}

export function lastErrorText(messages: LocalMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    for (const r of m.toolResults) {
      if (r.isError && r.content.trim()) {
        const text = r.content.trim();
        return text.length > 400 ? `${text.slice(0, 400)}…` : text;
      }
    }
  }
  return undefined;
}

/** 所有实打实的用户指令（按时间顺序，原文）。 */
export function userInstructions(messages: LocalMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user" || !m.isUserPrompt) continue;
    const text = m.parts
      .filter((p) => p.kind === "text" && p.text)
      .map((p) => p.text!.trim())
      .filter(Boolean)
      .join("\n\n");
    if (text) out.push(text);
  }
  return out;
}

/** 会话写入过文件的工具调用（file_edit 与写类工具）。 */
export function filesTouched(messages: LocalMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    for (const call of m.toolCalls) {
      for (const f of call.files) {
        if (f) out.push(f);
      }
      if (call.category === "write" && call.files.length === 0) {
        for (const f of extractFilePaths(call.input)) out.push(f);
      }
    }
  }
  return [...new Set(out)];
}

/** 会话读过（只看未改）的文件，用于换工具时补全上下文。 */
export function filesRead(messages: LocalMessage[]): string[] {
  const written = new Set(filesTouched(messages).map(normalizeFile));
  const out: string[] = [];
  for (const m of messages) {
    for (const call of m.toolCalls) {
      if (call.category !== "read" && call.category !== "search") continue;
      for (const f of extractFilePaths(call.input)) {
        if (!written.has(normalizeFile(f))) out.push(f);
      }
    }
  }
  return [...new Set(out)];
}

function normalizeFile(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/**
 * 判断状态所需的全部摘要信息。
 * resume 的查库快路径直接构造它，文件路径由 summarizeMessages 从消息里算出来——
 * 两条路径共用同一套判定规则。
 */
export interface StatusSummary {
  statusInfo: StatusInfo;
  lastReal: "user" | "assistant" | "system" | undefined;
  unfinishedTodos: boolean;
  /** 最后一条 assistant 消息的文本（5000 上限前），判"完成"用 */
  lastAssistantText?: string;
  /** 最后一条 assistant 消息是收尾正文（无工具调用、有文本） */
  lastAssistantFinal: boolean;
}

export function summarizeMessages(messages: LocalMessage[]): StatusSummary {
  return summarizeMessagesWith(analyzeStatus(messages), messages);
}

export function summarizeMessagesWith(
  statusInfo: StatusInfo,
  messages: LocalMessage[],
): StatusSummary {
  return {
    statusInfo,
    lastReal: lastRealRole(messages),
    unfinishedTodos: extractTodos(messages).some(
      (t) => t.status === "pending" || t.status === "in_progress",
    ),
    lastAssistantText: lastAssistantText(messages, 5000),
    lastAssistantFinal: statusInfo.lastAssistantFinal === true,
  };
}

export function decideStatus(
  statusInfo: StatusInfo,
  messages: LocalMessage[],
  mtimeMs: number,
  now = Date.now(),
): SessionStatus {
  return decideStatusFromSummary(summarizeMessagesWith(statusInfo, messages), mtimeMs, now);
}

export function decideStatusFromSummary(
  summary: StatusSummary,
  mtimeMs: number,
  now = Date.now(),
): SessionStatus {
  return decideStatusCore({
    fresh: now - mtimeMs < FRESH_WINDOW_MS,
    pendingToolCall: summary.statusInfo.pendingToolCallIds.length > 0,
    quotaOrLimit: summary.statusInfo.quotaOrLimitDetected,
    errorSeen: summary.statusInfo.errorDetected,
    lastUserUnanswered: summary.statusInfo.lastUserMessageUnanswered,
    lastReal: summary.lastReal ?? null,
    unfinishedTodos: summary.unfinishedTodos,
    lastAssistantFinal: summary.lastAssistantFinal,
  });
}

/** 文件在这么久内被写过就算"进行中"（实时判定与索引时判定共用同一窗口）。 */
export const FRESH_WINDOW_MS = 3 * 60 * 1000;

export interface StatusCoreInput {
  /** 文件在索引/查询时刻的 3 分钟内被写过 */
  fresh: boolean;
  pendingToolCall: boolean;
  quotaOrLimit: boolean;
  errorSeen: boolean;
  lastUserUnanswered: boolean;
  lastReal: "user" | "assistant" | "system" | null;
  unfinishedTodos: boolean;
  /** 最后一条助手消息是收尾正文（无工具调用、有文本） */
  lastAssistantFinal: boolean;
}

/**
 * 状态判定的最内核形式：只吃"信号 + 新鲜度"，供两条路径复用——
 * 索引时从消息序列算信号（decideStatusFromSummary），
 * 列表查询时从库里存的信号实时重算（信号在索引时落库，读的时候 O(1)）。
 */
export function decideStatusCore(input: StatusCoreInput): SessionStatus {
  if (input.fresh) return "in_progress";
  const interrupted =
    input.pendingToolCall ||
    input.quotaOrLimit ||
    input.errorSeen ||
    input.lastUserUnanswered;
  if (interrupted) return "interrupted";
  if (input.lastReal === "assistant" && !input.unfinishedTodos && input.lastAssistantFinal) {
    return "done";
  }
  return "unknown";
}

function lastRealRole(messages: LocalMessage[]): "user" | "assistant" | "system" | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "system" && m.isCompactBoundary) return "system";
    if (m.role === "user" || m.role === "assistant") return m.role;
  }
  return undefined;
}
