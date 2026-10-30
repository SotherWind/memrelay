import type { Adapter, Part, SessionRef } from "../core/types.js";
import { TOOL_REGISTRY } from "../core/tool-registry.js";
import {
  analyzeStatus,
  type LocalMessage,
  type LocalToolCall,
  type LocalToolResult,
  type StatusInfo,
} from "../adapters/jsonl-family/records.js";
import { tailHasMemrelayCall } from "../adapters/jsonl-family/parser.js";

export interface SessionDetail {
  ref: SessionRef;
  branchMessages: LocalMessage[];
  statusInfo: StatusInfo;
}

function rebuildCallsAndResults(parts: Part[]): {
  toolCalls: LocalToolCall[];
  toolResults: LocalToolResult[];
} {
  const toolCalls: LocalToolCall[] = [];
  const toolResults: LocalToolResult[] = [];
  for (const p of parts) {
    if (p.kind === "tool_call" || p.kind === "file_edit" || p.kind === "plan") {
      toolCalls.push({
        toolCallId: p.toolCallId ?? "",
        toolName: p.toolName,
        category: p.toolCategory ?? "other",
        input: p.json,
        isPlan: p.kind === "plan",
        files: p.kind === "file_edit" && p.text ? p.text.split("\n") : [],
      });
    } else if (p.kind === "tool_result") {
      toolResults.push({
        toolCallId: p.toolCallId,
        content: p.text ?? "",
        isError: p.status === "error",
      });
    }
  }
  return { toolCalls, toolResults };
}

/**
 * 读取一个会话的当前分支与状态信息。resume 与 show 共用。
 * 直接读原始文件，不依赖数据库，保证拿到最新进度。
 */
export async function readSessionDetail(
  adapter: Adapter,
  ref: SessionRef,
): Promise<SessionDetail> {
  const branchMessages: LocalMessage[] = [];
  for await (const event of adapter.readSession(ref)) {
    if (event.kind !== "message") continue;
    const m = event.message;
    const { toolCalls, toolResults } = rebuildCallsAndResults(m.parts);
    branchMessages.push({
      uuid: m.nativeId ?? `ordinal-${m.ordinal}`,
      parentUuid: m.nativeParentId,
      role: m.role,
      timestamp: m.createdAt || undefined,
      isSidechain: m.isSidechain,
      isCompactBoundary: m.isCompactBoundary,
      parts: m.parts,
      toolCalls,
      toolResults,
      isUserPrompt: m.role === "user" && m.parts.some((p) => p.kind === "text"),
    });
  }
  return { ref, branchMessages, statusInfo: analyzeStatus(branchMessages) };
}

export const MEMRELAY_MARKER = "【MemRelay 续接】";

/** 续接输出第二行：`续接自 <工具名>:<id> · 会话数 N · <开始时间>`，工具名可能是带空格的显示名。 */
const CHAIN_LINE_RE =
  /续接自\s+([A-Za-z][A-Za-z0-9 -]*?)\s*:([A-Za-z0-9][A-Za-z0-9_.-]{7,}) · 会话数 (\d+) · (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/;

/** 显示名（"Claude Code"）→ agent id（claude-code）；未知则按小写原样用。 */
function agentIdFromToken(token: string): string {
  const trimmed = token.trim();
  const byName = TOOL_REGISTRY.find(
    (t) => t.name.toLowerCase() === trimmed.toLowerCase(),
  );
  return byName?.id ?? trimmed.toLowerCase();
}

export interface ChainMarker {
  agent: string;
  nativeId: string;
  sessionCount: number;
  startedAt: string;
}

/** 从若干段文本里找出最后一次 memrelay 续接标记（查库快路径与读文件路径共用）。 */
export function markerFromTexts(texts: Iterable<string | undefined>): ChainMarker | undefined {
  let found: ChainMarker | undefined;
  for (const text of texts) {
    if (!text || !text.includes(MEMRELAY_MARKER)) continue;
    const match = CHAIN_LINE_RE.exec(text);
    if (match) {
      found = {
        agent: agentIdFromToken(match[1]!),
        nativeId: match[2]!,
        sessionCount: Number(match[3] ?? "1"),
        startedAt: match[4]!,
      };
    }
  }
  return found;
}

/**
 * 用户首条指令是否像"继续/接着做"。
 * 跨项目接力链必须满足它：否则一个在本项目里测试 memrelay resume 的会话，
 * 只要输出里带了续接标记，就会被误接进别的项目的任务链。
 */
export function looksLikeContinuation(text: string | undefined | null): boolean {
  if (!text) return false;
  return /继续|接着|剩下的|未完成|上次|上一个任务|做到哪|\bcontinue\b|\bresume\b|\bwhere did we leave off\b/i.test(
    text,
  );
}

/** 从会话消息里找出某次 agent 运行 memrelay resume 留下的续接记录。 */
export function findChainMarker(messages: LocalMessage[]): ChainMarker | undefined {
  const texts: string[] = [];
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.text) texts.push(p.text);
    }
  }
  return markerFromTexts(texts);
}

/** 会话里最近的记录是否有调用 memrelay 的痕迹（识别"自己"这个正在运行的会话）。 */
export function containsMemrelayCall(messages: LocalMessage[]): boolean {
  return tailHasMemrelayCall(messages);
}

export function statusLabel(status: string): string {
  switch (status) {
    case "in_progress":
      return "进行中";
    case "interrupted":
      return "中断";
    case "done":
      return "完成";
    case "abandoned":
      return "放弃";
    default:
      return "未知";
  }
}

export function formatLocalTime(iso: string | undefined): string {
  if (!iso) return "未知时间";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function minutesSince(ms: number, now = Date.now()): number {
  return Math.floor((now - ms) / 60000);
}
