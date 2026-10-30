import path from "node:path";

import type { NormalizedEvent, Part } from "../../core/types.js";
import { partKindForTool, categorizeTool, extractFilePaths, isPlanTool } from "../../core/tool-names.js";
import { readFileHead, readFileTail } from "./jsonl.js";
import {
  analyzeStatus,
  compactJson,
  hasToolResultContent,
  isMetaRecord,
  stripSystemReminders,
  textFromToolResultBlock,
  type LocalMessage,
  type LocalToolCall,
  type LocalToolResult,
  type ParsedSession,
  type StatusInfo,
} from "./records.js";

const MESSAGE_TYPES = new Set(["user", "assistant"]);

const SKIPPED_TYPES = new Set([
  "queue-operation",
  "file-history-snapshot",
  "ai-title",
  "mode",
  "permission-mode",
  "last-prompt",
  "task_reminder",
  "hook_output",
  "critical_system_reminder",
  "agent_listing_delta",
  "runtime-config",
  "worktree-state",
  "workspace-directories",
  "active-leaf",
  "summary",
  // Qoder transcript（IDE 侧）的元数据与 hook 进度，不属于对话内容
  "session_meta",
  "progress",
]);

export interface ParseOptions {
  agent: string;
  sessionId: string;
  sourcePath: string;
}

interface BlockParseResult {
  parts: Part[];
  toolCalls: LocalToolCall[];
  toolResults: LocalToolResult[];
}

function parseBlocks(blocks: unknown[], role: "user" | "assistant"): BlockParseResult {
  const parts: Part[] = [];
  const toolCalls: LocalToolCall[] = [];
  const toolResults: LocalToolResult[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    const rec = b as Record<string, unknown>;
    const type = rec["type"];
    if (type === "text" && typeof rec["text"] === "string") {
      const text = role === "user" ? stripSystemReminders(rec["text"]) : rec["text"];
      if (text.trim()) parts.push({ kind: "text", text });
    } else if (type === "thinking" && typeof rec["thinking"] === "string") {
      parts.push({ kind: "reasoning", text: rec["thinking"] });
    } else if (type === "redacted_thinking" || type === "reasoning") {
      const text = typeof rec["text"] === "string" ? rec["text"] : "[redacted reasoning]";
      parts.push({ kind: "reasoning", text });
    } else if (type === "tool_use" || type === "tool-call") {
      const toolName =
        typeof rec["name"] === "string"
          ? rec["name"]
          : typeof rec["toolName"] === "string"
            ? rec["toolName"]
            : undefined;
      const toolCallId =
        typeof rec["id"] === "string"
          ? rec["id"]
          : typeof rec["toolCallId"] === "string"
            ? rec["toolCallId"]
            : `call-${toolCalls.length}-${Math.random().toString(36).slice(2, 8)}`;
      const input = rec["input"] ?? rec["args"];
      const kind = partKindForTool(toolName);
      const part: Part = {
        kind,
        json: input,
        toolName,
        toolCategory: categorizeTool(toolName),
        toolCallId,
      };
      const files = extractFilePaths(input);
      if (kind === "file_edit") {
        part.text = files.join("\n") || compactJson(input);
      }
      parts.push(part);
      toolCalls.push({
        toolCallId,
        toolName,
        category: categorizeTool(toolName),
        input,
        isPlan: isPlanTool(toolName),
        files,
      });
    } else if (type === "tool_result" || type === "tool-result") {
      const toolCallId =
        typeof rec["tool_use_id"] === "string"
          ? rec["tool_use_id"]
          : typeof rec["toolCallId"] === "string"
            ? rec["toolCallId"]
            : undefined;
      const text = textFromToolResultBlock(rec);
      const isError = rec["is_error"] === true || rec["isError"] === true;
      parts.push({
        kind: "tool_result",
        text,
        toolCallId,
        status: isError ? "error" : "ok",
      });
      toolResults.push({ toolCallId, content: text, isError });
    } else if (type === "image") {
      parts.push({ kind: "image", text: "[image]" });
    }
  }
  return { parts, toolCalls, toolResults };
}

export function recordToLocalMessage(record: Record<string, unknown>): LocalMessage | null {
  const type = record["type"];
  if (typeof type !== "string") return null;

  if (MESSAGE_TYPES.has(type)) {
    const messageObj = (record["message"] ?? {}) as Record<string, unknown>;
    const rawContent = messageObj["content"] ?? record["content"];
    const isSidechain = record["isSidechain"] === true;
    const blocks: unknown[] = Array.isArray(rawContent)
      ? rawContent
      : typeof rawContent === "string"
        ? [{ type: "text", text: rawContent }]
        : [];

    if (type === "user") {
      if (isMetaRecord(record)) return null;
      const hasToolResult =
        hasToolResultContent(rawContent) || record["toolUseResult"] !== undefined;
      const { parts, toolResults } = parseBlocks(blocks, "user");
      if (!hasToolResult && parts.length === 0) return null;
      const uuid = typeof record["uuid"] === "string" ? record["uuid"] : undefined;
      if (!uuid) return null;
      // 记录级的失败信号（Qoder 把退出码放在 toolUseResult 里）
      const tur = record["toolUseResult"];
      const exitCode =
        tur && typeof tur === "object"
          ? (tur as Record<string, unknown>)["exitCode"]
          : undefined;
      const failed =
        (tur && typeof tur === "object" && (tur as Record<string, unknown>)["success"] === false) ||
        (typeof exitCode === "number" && exitCode !== 0);
      if (failed) {
        for (const p of parts) {
          if (p.kind === "tool_result") p.status = "error";
        }
        for (const r of toolResults) r.isError = true;
      }
      const userText = parts
        .filter((p) => p.kind === "text" && p.text)
        .map((p) => p.text!)
        .join("\n")
        .trim();
      return {
        uuid,
        parentUuid: typeof record["parentUuid"] === "string" ? record["parentUuid"] : undefined,
        role: hasToolResult && !userText ? "tool" : "user",
        timestamp: typeof record["timestamp"] === "string" ? record["timestamp"] : undefined,
        isSidechain,
        isCompactBoundary: false,
        parts,
        toolCalls: [],
        toolResults,
        isUserPrompt: !hasToolResult && userText.length > 0,
      };
    }

    const { parts, toolCalls, toolResults } = parseBlocks(blocks, "assistant");
    const uuid = typeof record["uuid"] === "string" ? record["uuid"] : undefined;
    if (!uuid || parts.length === 0) return null;
    return {
      uuid,
      parentUuid: typeof record["parentUuid"] === "string" ? record["parentUuid"] : undefined,
      role: "assistant",
      timestamp: typeof record["timestamp"] === "string" ? record["timestamp"] : undefined,
      isSidechain,
      isCompactBoundary: false,
      parts,
      toolCalls,
      toolResults,
      isUserPrompt: false,
    };
  }

  if (type === "system") {
    const uuid = typeof record["uuid"] === "string" ? record["uuid"] : undefined;
    const subtype = typeof record["subtype"] === "string" ? record["subtype"] : "";
    const content = record["content"];
    const isCompact = subtype.includes("compact");
    const keep = isCompact || typeof content === "string";
    if (!keep || !uuid) return null;
    return {
      uuid,
      parentUuid: typeof record["parentUuid"] === "string" ? record["parentUuid"] : undefined,
      role: "system",
      timestamp: typeof record["timestamp"] === "string" ? record["timestamp"] : undefined,
      isSidechain: record["isSidechain"] === true,
      isCompactBoundary: isCompact,
      parts: [
        {
          kind: isCompact ? "compaction_summary" : "system_event",
          text: typeof content === "string" ? content : compactJson(record),
        },
      ],
      toolCalls: [],
      toolResults: [],
      isUserPrompt: false,
    };
  }

  if (type === "attachment") {
    const uuid = typeof record["uuid"] === "string" ? record["uuid"] : undefined;
    if (!uuid) return null;
    return {
      uuid,
      parentUuid: typeof record["parentUuid"] === "string" ? record["parentUuid"] : undefined,
      role: "system",
      timestamp: typeof record["timestamp"] === "string" ? record["timestamp"] : undefined,
      isSidechain: record["isSidechain"] === true,
      isCompactBoundary: false,
      parts: [{ kind: "system_event", text: compactJson(record["attachment"]) }],
      toolCalls: [],
      toolResults: [],
      isUserPrompt: false,
    };
  }

  if (!SKIPPED_TYPES.has(type)) {
    return {
      uuid: `unknown-${Math.random().toString(36).slice(2)}`,
      role: "system",
      isSidechain: false,
      isCompactBoundary: false,
      parts: [{ kind: "system_event", text: compactJson(record, 800) }],
      toolCalls: [],
      toolResults: [],
      isUserPrompt: false,
    };
  }
  return null;
}

/** 读文件开头，拿 cwd / gitBranch / 起始时间，以及最后一条消息的 uuid（判断分支用）。 */
export function peekHead(
  filePath: string,
  bytes = 131072,
): {
  cwd?: string;
  gitBranch?: string;
  startedAt?: string;
  lastUuid?: string;
  /** 内容里的原生会话 id（比文件名更可靠，接力链标记引用的是它） */
  sessionId?: string;
} {
  const head = readFileHead(filePath, bytes);
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let startedAt: string | undefined;
  let lastUuid: string | undefined;
  let sessionId: string | undefined;
  for (const line of head.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!cwd) {
      const v = record["cwd"];
      if (typeof v === "string" && v) cwd = v;
    }
    if (!cwd) {
      const dirs = record["directories"];
      if (Array.isArray(dirs) && typeof dirs[0] === "string" && dirs[0]) cwd = dirs[0];
    }
    if (!sessionId) {
      const sid = record["sessionId"];
      if (typeof sid === "string" && sid) sessionId = sid;
    }
    const branch = record["gitBranch"];
    if (!gitBranch && typeof branch === "string" && branch) gitBranch = branch;
    const ts = record["timestamp"];
    if (!startedAt && typeof ts === "string") startedAt = ts;
    const uuid = record["uuid"];
    if (typeof uuid === "string" && uuid) lastUuid = uuid;
  }
  return { cwd, gitBranch, startedAt, lastUuid, sessionId };
}

/** 读文件末尾若干条记录，用于快速判断状态与取标题。 */
export function readTailRecords(
  filePath: string,
  bytes = 262144,
): Record<string, unknown>[] {
  const tail = readFileTail(filePath, bytes);
  const out: Record<string, unknown>[] = [];
  for (const line of tail.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    try {
      const v = JSON.parse(text);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out.push(v as Record<string, unknown>);
      }
    } catch {
      /* 首行可能被截断，跳过 */
    }
  }
  return out;
}

export interface TailAnalysis {
  statusInfo: StatusInfo;
  hasActiveLeaf: boolean;
  explicitLeaf?: string;
  lastMessageUuid?: string;
  lastTitle?: string;
  lastTimestamp?: string;
  /** 文件末尾的记录里有 memrelay 的调用痕迹（识别"当前正在运行的会话"） */
  memrelayCalledRecently: boolean;
}

export function analyzeTailRecords(records: Record<string, unknown>[]): TailAnalysis {
  const messages: LocalMessage[] = [];
  let explicitLeaf: string | undefined;
  let lastMessageUuid: string | undefined;
  let lastTitle: string | undefined;
  let lastTimestamp: string | undefined;
  for (const record of records) {
    const type = record["type"];
    if (type === "active-leaf" && typeof record["leafUuid"] === "string") {
      explicitLeaf = record["leafUuid"];
    }
    if (type === "ai-title" && typeof record["title"] === "string") {
      lastTitle = record["title"];
    }
    if (type === "last-prompt" && typeof record["lastPrompt"] === "string") {
      lastTitle = lastTitle ?? record["lastPrompt"];
    }
    if (type === "user" || type === "assistant" || type === "system" || type === "attachment") {
      const msg = recordToLocalMessage(record);
      if (msg) {
        messages.push(msg);
        if (msg.role === "user" || msg.role === "assistant") {
          lastMessageUuid = msg.uuid;
          if (msg.timestamp) lastTimestamp = msg.timestamp;
        }
      }
    }
  }
  return {
    statusInfo: analyzeStatus(messages),
    hasActiveLeaf: explicitLeaf !== undefined,
    explicitLeaf,
    lastMessageUuid,
    lastTitle,
    lastTimestamp,
    memrelayCalledRecently: tailHasMemrelayCall(messages),
  };
}

/** 一个片段是否像 memrelay 的调用痕迹（识别"当前正在运行的会话"，查库快路径共用）。 */
export function partLooksLikeMemrelayCall(text: string | undefined, json: unknown): boolean {
  const haystack = [
    text,
    typeof json === "string" ? json : JSON.stringify(json ?? ""),
  ].join(" ");
  if (/\bmemrelay(\.cmd)?["'\s]+(resume|show)\b/.test(haystack)) return true;
  return haystack.includes("【MemRelay 续接】");
}

/** 只看末尾几条：有 memrelay 的调用或续接标记，说明这个会话刚刚/正在调用 memrelay。 */
export function tailHasMemrelayCall(messages: LocalMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0 && i >= messages.length - 4; i--) {
    const m = messages[i]!;
    for (const p of m.parts) {
      if (partLooksLikeMemrelayCall(p.text, p.json)) return true;
    }
  }
  return false;
}

export function sessionIdFromPath(filePath: string): string {
  return path.basename(filePath).replace(/\.jsonl(\.zst)?$/i, "");
}

/**
 * 沿 parentUuid 回溯出当前分支（从根到叶的顺序返回）。
 * links 是"所有带 uuid 的记录"的 uuid→parentUuid 链接表：链上可能夹着
 * 被跳过的记录（空 thinking、isMeta 等），只按已解析消息走会在空档处断链。
 */
export function walkBranch(
  messages: LocalMessage[],
  leafUuid: string | undefined,
  links?: Map<string, string | undefined>,
): { branch: LocalMessage[]; onBranch: Set<string> } {
  const byId = new Map<string, LocalMessage>();
  const indexByUuid = new Map<string, number>();
  messages.forEach((m, index) => {
    byId.set(m.uuid, m);
    indexByUuid.set(m.uuid, index);
  });
  const knowLeaf = leafUuid !== undefined && (byId.has(leafUuid) || links?.has(leafUuid));
  if (!leafUuid || !knowLeaf) {
    const ordered = messages.filter((m) => !m.isSidechain);
    return { branch: ordered, onBranch: new Set(ordered.map((m) => m.uuid)) };
  }
  const chain: LocalMessage[] = [];
  let current: string | undefined = leafUuid;
  const guard = new Set<string>();
  while (current && !guard.has(current)) {
    guard.add(current);
    const msg = byId.get(current);
    if (msg) chain.push(msg);
    current = links?.has(current) ? links.get(current) : byId.get(current)?.parentUuid;
  }
  // 空档一律换"合并显示"不合适：保证至少给出可读内容
  if (chain.length === 0) {
    const ordered = messages.filter((m) => !m.isSidechain);
    return { branch: ordered, onBranch: new Set(ordered.map((m) => m.uuid)) };
  }
  chain.reverse();
  const included = new Set(chain.map((m) => m.uuid));
  // 并行工具调用的结果在 Qoder 里是兄弟记录，只有一条在叶链上；
  // 把"父消息是链上 assistant"的工具结果补回来，否则调用会被误判为永远没结果。
  // 只补叶子之前的：explicit leaf 之后的内容不属于当前分支（典型是停在工具调用上）。
  const leafIndex = indexByUuid.get(leafUuid) ?? -1;
  const lastChainIndex = chain.reduce(
    (max, m) => Math.max(max, indexByUuid.get(m.uuid) ?? -1),
    -1,
  );
  const cutoff = leafIndex >= 0 ? leafIndex : lastChainIndex;
  for (let i = 0; i < messages.length; i++) {
    if (cutoff >= 0 && i > cutoff) break;
    const m = messages[i]!;
    if (included.has(m.uuid) || m.isSidechain) continue;
    if (m.role !== "tool" && m.toolResults.length === 0) continue;
    const parent = links?.get(m.uuid) ?? m.parentUuid;
    if (!parent || !included.has(parent)) continue;
    if (byId.get(parent)?.role !== "assistant") continue;
    included.add(m.uuid);
  }
  const branch = messages.filter((m) => included.has(m.uuid) && !m.isSidechain);
  return { branch, onBranch: included };
}

export function toNormalizedMessages(
  parseCtx: { sessionId: string },
  branch: LocalMessage[],
): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  branch.forEach((m, index) => {
    events.push({
      kind: "message",
      message: {
        sessionId: parseCtx.sessionId,
        ordinal: index + 1,
        nativeId: m.uuid,
        nativeParentId: m.parentUuid,
        role: m.role,
        createdAt: m.timestamp ?? "",
        isSidechain: m.isSidechain,
        isCompactBoundary: m.isCompactBoundary,
        parts: m.parts,
      },
    });
  });
  return events;
}

export function finalizeSession(
  ctx: ParseOptions,
  messages: LocalMessage[],
  extra: { cwd?: string; gitBranch?: string; title?: string; explicitLeaf?: string },
): ParsedSession {
  const firstUser = messages.find(
    (m) => m.role === "user" && m.parts.some((p) => p.kind === "text" && p.text?.trim()),
  );
  const firstUserMessage = firstUser
    ? firstUser.parts
        .filter((p) => p.kind === "text" && p.text)
        .map((p) => p.text!)
        .join("\n\n")
    : undefined;
  return {
    nativeId: ctx.sessionId,
    sourcePath: ctx.sourcePath,
    cwd: extra.cwd ?? "",
    gitBranch: extra.gitBranch,
    title: extra.title,
    firstUserMessage,
    explicitLeaf: extra.explicitLeaf,
    messages,
  };
}

/**
 * 目录名编码：路径里每个非字母数字字符各换成 '-'（连续分隔符保留为连续 '-'）。
 * 实测：D:\webProject\MemRelay → D--webProject-MemRelay；/home/dev/app → -home-dev-app。
 */
function encodePathChars(p: string): string {
  return p
    .replace(/[\\/]+$/, "")
    .replace(/[^A-Za-z0-9]/g, "-")
    .replace(/^-+/, "");
}

export function projectSlug(projectPath: string): string {
  const cleaned = projectPath.trim().replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:[\\/]/.test(cleaned) || cleaned.startsWith("\\\\")) {
    return encodePathChars(path.normalize(cleaned));
  }
  // POSIX 绝对路径（或测试里的模拟路径）不做平台解析，避免 Windows 上凭空多出盘符
  return encodePathChars(cleaned);
}

export const projectSlugVariants = (projectPath: string): string[] => {
  const slug = projectSlug(projectPath);
  const upper = slug.charAt(0).toUpperCase() + slug.slice(1);
  // 有的产品（Qoder IDE）把连续分隔符合并成一个、盘符小写：d-Desktop-test-thunder-fighter
  const collapsed = slug.replace(/-+/g, "-");
  return [...new Set([upper, slug.toLowerCase(), collapsed.toLowerCase()])];
};

export function normalizePathForCompare(p: string, platform: NodeJS.Platform): string {
  let out = path.resolve(p).replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  if (platform === "win32") out = out.toLowerCase();
  return out;
}

export function isPathInside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const c = normalizePathForCompare(child, platform);
  const p = normalizePathForCompare(parent, platform);
  return c === p || c.startsWith(`${p}/`);
}
