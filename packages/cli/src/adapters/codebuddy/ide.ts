import fs from "node:fs";
import path from "node:path";

import {
  codebuddyIdeHistoryRoots,
  codebuddyIdeWorkspaceMap,
  decodeIdeWorkspaceDir,
} from "../../core/codebuddy-paths.js";
import { categorizeTool, extractFilePaths, isPlanTool } from "../../core/tool-names.js";
import { decodeBuffer } from "../../core/text-encoding.js";
import type {
  Detection,
  Env,
  MessageRole,
  NormalizedEvent,
  Part,
  ProjectScope,
  Session,
  SessionRef,
} from "../../core/types.js";
import {
  analyzeStatus,
  type LocalMessage,
  type LocalToolCall,
  type LocalToolResult,
} from "../jsonl-family/records.js";
import { isPathInside, toNormalizedMessages } from "../jsonl-family/parser.js";
import type { SessionScan, SerializedJsonlAdapter } from "../jsonl-family/jsonl-adapter.js";

/**
 * CodeBuddy IDE 适配器。真实布局（2026-10-29 实测）：
 *   <localData>/CodeBuddyExtension/Data/<uid>/CodeBuddyIDE/<uid>/history/<md5(工作区)>/
 *     index.json                    { conversations: [{ id, name, createdAt, lastMessageAt }] }
 *     <会话 id>/index.json           { messages: [{ id, role, type, isComplete }], requests }
 *     <会话 id>/messages/<消息 id>.json
 * 旧的 genie-history 布局（<base64(工作区)>/conversations/<会话 id>/）也兼容。
 * 消息文件：{ id, role, createdAt/createTime, message: JSON 字符串 { role, content }, extra }；
 * content 片段：text / reasoning / tool-call / tool-result。
 * hook 的 transcript_path 指向会话的 index.json，可按单会话精准索引。
 */

export const CODECBUDDY_AGENT = "codebuddy";
const IDE_SESSION_PREFIX = "ide-";
/** 扫描时只读末尾几条消息推断状态：最后一条助手消息 + 它的工具结果足够判断是否中断。 */
const TAIL_MESSAGE_LIMIT = 4;

interface WorkspaceConversation {
  id: string;
  name?: string;
  createdAtMs?: number;
  lastMessageAtMs?: number;
  hidden?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function msOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function isoOf(ms: number | undefined): string | undefined {
  return ms && ms > 0 ? new Date(ms).toISOString() : undefined;
}

function normalizeWorkspacePath(value: string, platform: NodeJS.Platform): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  if (!trimmed) return trimmed;
  return platform === "win32" && /^[A-Za-z]:[\\/]/.test(trimmed)
    ? path.win32.normalize(trimmed)
    : trimmed;
}

function readJsonFile(file: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(decodeBuffer(fs.readFileSync(file))));
  } catch {
    return undefined;
  }
}

function workspaceDirs(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
}

function isConversationDir(dir: string): boolean {
  try {
    return (
      fs.statSync(path.join(dir, "index.json")).isFile() &&
      fs.statSync(path.join(dir, "messages")).isDirectory()
    );
  } catch {
    return false;
  }
}

/** 旧版会话在 conversations/<id>；当前版本直接是 <工作区 hash>/<id>。 */
function conversationDirOf(wsDir: string, id: string): string {
  const legacy = path.join(wsDir, "conversations", id);
  if (isConversationDir(legacy)) return legacy;
  return path.join(wsDir, id);
}

function conversationContainers(wsDir: string): string[] {
  const legacy = path.join(wsDir, "conversations");
  try {
    if (fs.statSync(legacy).isDirectory()) return [legacy];
  } catch {
    /* 当前版本没有这一层 */
  }
  return [wsDir];
}

function readWorkspaceConversations(wsDir: string): Map<string, WorkspaceConversation> {
  const out = new Map<string, WorkspaceConversation>();
  const index = readJsonFile(path.join(wsDir, "index.json"));
  const list = index?.["conversations"];
  if (Array.isArray(list)) {
    for (const item of list) {
      const rec = asRecord(item);
      const id = typeof rec?.["id"] === "string" ? rec["id"] : undefined;
      if (!id) continue;
      out.set(id, {
        id,
        name: typeof rec?.["name"] === "string" ? rec["name"] : undefined,
        createdAtMs: msOf(rec?.["createdAt"]),
        lastMessageAtMs: msOf(rec?.["lastMessageAt"]),
        hidden: rec?.["hidden"] === true,
      });
    }
  }
  // 索引缺条目（崩溃/旧版本）时按目录兜底
  for (const container of conversationContainers(wsDir)) {
    for (const dir of workspaceDirs(container)) {
      const id = path.basename(dir);
      if (out.has(id) || !isConversationDir(dir)) continue;
      out.set(id, { id });
    }
  }
  return out;
}

interface IdeMessage {
  id: string;
  role: MessageRole;
  createdAtMs?: number;
  content: unknown;
  extra: Record<string, unknown>;
}

function readIdeMessage(file: string, fallbackId: string): IdeMessage | undefined {
  const raw = readJsonFile(file);
  if (!raw) return undefined;
  const payload = asRecord(parseJson(raw["message"])) ?? {};
  const rawRole = typeof raw["role"] === "string" ? raw["role"] : payload["role"];
  const role: MessageRole =
    rawRole === "user"
      ? "user"
      : rawRole === "assistant"
        ? "assistant"
        : rawRole === "tool"
          ? "tool"
          : "system";
  return {
    id: typeof raw["id"] === "string" ? raw["id"] : fallbackId,
    role,
    // 当前版本写 createdAt（ISO），迁移/旧版可能写 createTime（毫秒）
    createdAtMs: msOf(raw["createTime"]) ?? msOf(raw["createdAt"]),
    content: payload["content"],
    extra: asRecord(parseJson(raw["extra"])) ?? {},
  };
}

/** 用户消息常被 <user_info>/<additional_data>/<user_query> 包裹：标题和首条只取真正的提问。 */
function userQueryText(text: string): string {
  const query = /<user_query[^>]*>([\s\S]*?)<\/user_query>/i.exec(text);
  if (query?.[1]?.trim()) return query[1].trim();
  return text
    .replace(/<user_info[\s\S]*?<\/user_info>/gi, "")
    .replace(/<additional_data[\s\S]*?<\/additional_data>/gi, "")
    .replace(/<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/gi, "")
    .trim();
}

function textBlocks(content: unknown): { text?: string; reasoning?: string; parts: Part[] } {
  if (typeof content === "string") {
    const text = content.trim();
    return { text: text || undefined, parts: text ? [{ kind: "text", text }] : [] };
  }
  if (!Array.isArray(content)) return { parts: [] };
  const parts: Part[] = [];
  const texts: string[] = [];
  const reasonings: string[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (!block) continue;
    if (block["type"] === "text" && typeof block["text"] === "string" && block["text"].trim()) {
      const text = block["text"];
      parts.push({ kind: "text", text });
      texts.push(text);
    } else if (
      block["type"] === "reasoning" &&
      typeof block["text"] === "string" &&
      block["text"].trim()
    ) {
      const text = block["text"];
      parts.push({ kind: "reasoning", text });
      reasonings.push(text);
    }
  }
  return {
    text: texts.join("\n").trim() || undefined,
    reasoning: reasonings.join("\n").trim() || undefined,
    parts,
  };
}

function toolInputOf(value: unknown): unknown {
  const parsed = parseJson(value);
  return parsed === undefined ? value : parsed;
}

function resultText(result: unknown): string | undefined {
  const rec = asRecord(result);
  if (!rec) return typeof result === "string" ? result : undefined;
  const inner = rec["result"];
  if (typeof inner === "string") return inner;
  if (inner !== undefined) {
    try {
      return JSON.stringify(inner);
    } catch {
      return String(inner);
    }
  }
  if (typeof rec["errorMessage"] === "string") return rec["errorMessage"];
  return undefined;
}

function resultIsError(result: unknown): boolean {
  const rec = asRecord(result);
  if (!rec) return false;
  if (typeof rec["success"] === "boolean") return rec["success"] === false;
  const status = rec["status"];
  return typeof status === "string" && status !== "success" && status !== "executed";
}

function toolStatusOf(extra: Record<string, unknown>, callId: string): Record<string, unknown> | undefined {
  const map = asRecord(extra["toolStatus"]);
  return map ? asRecord(map[callId]) : undefined;
}

function messageToLocal(message: IdeMessage): {
  local: LocalMessage;
  statusFallbacks: Array<{ callId: string; status?: string; error: boolean; text: string }>;
} | undefined {
  if (message.role === "system") return undefined;
  const { text, parts } = textBlocks(message.content);
  const calls: LocalToolCall[] = [];
  const results: LocalToolResult[] = [];
  const statusFallbacks: Array<{ callId: string; status?: string; error: boolean; text: string }> = [];

  if (Array.isArray(message.content)) {
    for (const item of message.content) {
      const block = asRecord(item);
      if (!block) continue;
      if (block["type"] === "tool-call" || block["type"] === "tool_call") {
        const callId = typeof block["toolCallId"] === "string" ? block["toolCallId"] : undefined;
        const toolName = typeof block["toolName"] === "string" ? block["toolName"] : undefined;
        const input = toolInputOf(block["args"]);
        parts.push({ kind: "tool_call", toolName, toolCallId: callId, json: input });
        calls.push({
          toolCallId: callId ?? "",
          toolName,
          category: categorizeTool(toolName),
          input,
          isPlan: isPlanTool(toolName),
          files: extractFilePaths(input),
        });
        if (callId) {
          const status = toolStatusOf(message.extra, callId);
          if (status) {
            const result = status["result"];
            statusFallbacks.push({
              callId,
              status: typeof status["status"] === "string" ? status["status"] : undefined,
              error: resultIsError(result),
              text: resultText(result) ?? "",
            });
          }
        }
      } else if (block["type"] === "tool-result" || block["type"] === "tool_result") {
        const callId = typeof block["toolCallId"] === "string" ? block["toolCallId"] : undefined;
        const result = block["result"];
        const error = resultIsError(result);
        const text2 = resultText(result) ?? "";
        parts.push({ kind: "tool_result", toolCallId: callId, text: text2, status: error ? "error" : "ok" });
        results.push({ toolCallId: callId, content: text2, isError: error });
      }
    }
  }

  if (parts.length === 0) return undefined;
  // 用户消息的 <user_info>/<additional_data> 是注入的背景，真正的内容在 <user_query>：
  // 只保留提问本身，避免续接预览/搜索/摘要里出现一大段元信息。
  const clean = message.role === "user" && text ? userQueryText(text) : undefined;
  const finalParts =
    message.role === "user"
      ? [
          ...(clean ? [{ kind: "text", text: clean } as Part] : []),
          ...parts.filter((part) => part.kind !== "text"),
        ]
      : parts;
  if (finalParts.length === 0) return undefined;
  return {
    local: {
      uuid: message.id,
      role: message.role,
      timestamp: isoOf(message.createdAtMs),
      isSidechain: false,
      isCompactBoundary: false,
      parts: finalParts,
      toolCalls: calls,
      toolResults: results,
      isUserPrompt: Boolean(clean),
    },
    statusFallbacks,
  };
}

/** 按索引顺序读消息；limit 只取末尾若干条（扫描状态用），不传则全量。 */
/** 会话新鲜度：index.json + 所有消息文件的最大 mtime 与总大小（消息文件更新也要重索引）。 */
function conversationFreshness(
  convDir: string,
  indexStat: fs.Stats,
  messageIds: string[],
): { mtimeMs: number; sizeBytes: number } {
  let mtimeMs = indexStat.mtimeMs;
  let sizeBytes = indexStat.size;
  for (const id of messageIds) {
    try {
      const stat = fs.statSync(path.join(convDir, "messages", `${id}.json`));
      if (stat.mtimeMs > mtimeMs) mtimeMs = stat.mtimeMs;
      sizeBytes += stat.size;
    } catch {
      /* 消息文件可能尚未落盘 */
    }
  }
  return { mtimeMs, sizeBytes };
}

function readLocalMessages(convDir: string, messageIds: string[], limit?: number): LocalMessage[] {  const ids = limit && messageIds.length > limit ? messageIds.slice(-limit) : messageIds;
  const messages: LocalMessage[] = [];
  const fallbackResults: LocalToolResult[] = [];
  for (const id of ids) {
    const raw = readIdeMessage(path.join(convDir, "messages", `${id}.json`), id);
    if (!raw) continue;
    if (raw.extra["isHelperMessage"] === true) continue;
    const converted = messageToLocal(raw);
    if (!converted) continue;
    messages.push(converted.local);
    // 结果只存在 extra.toolStatus（没有独立 tool 消息）时补一条合成结果，供状态判断
    for (const fallback of converted.statusFallbacks) {
      if (!fallback.status || fallback.status === "pending") continue;
      fallbackResults.push({
        toolCallId: fallback.callId,
        content: fallback.text,
        isError: fallback.error,
      });
    }
  }
  if (fallbackResults.length > 0) {
    const resolved = new Set<string>();
    for (const message of messages) {
      for (const result of message.toolResults) if (result.toolCallId) resolved.add(result.toolCallId);
    }
    const missing = fallbackResults.filter(
      (result) => result.toolCallId && !resolved.has(result.toolCallId),
    );
    if (missing.length > 0) {
      const last = messages[messages.length - 1];
      messages.push({
        uuid: `${last?.uuid ?? "session"}-tool-results`,
        role: "tool",
        timestamp: last?.timestamp,
        isSidechain: false,
        isCompactBoundary: false,
        parts: missing.map((result) => ({
          kind: "tool_result",
          toolCallId: result.toolCallId,
          text: result.content,
          status: result.isError ? "error" : "ok",
        })),
        toolCalls: [],
        toolResults: missing,
        isUserPrompt: false,
      });
    }
  }
  return messages;
}

function messageIdsOf(convIndex: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const list = convIndex?.["messages"];
  if (Array.isArray(list)) {
    for (const item of list) {
      const rec = asRecord(item);
      const id = typeof rec?.["id"] === "string" ? rec["id"] : undefined;
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  // 旧格式/半写索引可能只有 requests 分组：按请求顺序把消息 id 摊平
  if (out.length === 0 && Array.isArray(convIndex?.["requests"])) {
    for (const item of convIndex["requests"] as unknown[]) {
      const rec = asRecord(item);
      const ids = rec?.["messages"];
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        if (typeof id === "string" && id && !seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
    }
  }
  return out;
}

function firstUserText(messages: LocalMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = message.parts
      .filter((part) => part.kind === "text" && part.text)
      .map((part) => part.text!)
      .join("\n");
    const cleaned = userQueryText(text);
    if (cleaned) return cleaned.replace(/\s+/g, " ").slice(0, 500);
  }
  return undefined;
}

function lastTimestamp(messages: LocalMessage[]): number | undefined {
  let max = 0;
  for (const message of messages) {
    const ms = message.timestamp ? Date.parse(message.timestamp) : 0;
    if (ms > max) max = ms;
  }
  return max || undefined;
}

/** 会话 index.json 的上一层：旧版是 <ws>/conversations/<id>，当前版本是 <ws>/<id>。 */
function workspaceOfConversation(convIndexPath: string): string {
  const convDir = path.dirname(convIndexPath);
  const parent = path.dirname(convDir);
  return path.basename(parent) === "conversations" ? path.dirname(parent) : parent;
}

function workspaceFromHash(hash: string, env: Env): string | undefined {
  const mapped = codebuddyIdeWorkspaceMap(env).get(hash.toLowerCase());
  if (mapped) return normalizeWorkspacePath(mapped, env.platform);
  const decoded = decodeIdeWorkspaceDir(hash);
  return decoded ? normalizeWorkspacePath(decoded, env.platform) : undefined;
}

/** 工作区映射丢了（workspaceStorage 被清）时，从首条用户消息的 <user_info> 里兜底。 */
function workspaceFromMessages(convDir: string, messageIds: string[]): string | undefined {
  for (const id of messageIds.slice(0, 3)) {
    const raw = readIdeMessage(path.join(convDir, "messages", `${id}.json`), id);
    if (!raw) continue;
    const text = textBlocks(raw.content).text;
    if (!text) continue;
    const match = /Workspace Folder:\s*(.+)/i.exec(text);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

export function codebuddyIdeAdapter(): SerializedJsonlAdapter {
  // v2：用户消息只保留 <user_query>（旧版索引里是 <user_info> 整段，需要重解析）
  const version = 2;

  function rootsOf(env: Env): string[] {
    return codebuddyIdeHistoryRoots(env);
  }

  function resolveWorkspace(
    wsDir: string,
    convDir: string,
    messageIds: string[],
    env: Env,
  ): string | undefined {
    const fromHash = workspaceFromHash(path.basename(wsDir), env);
    if (fromHash) return fromHash;
    const fromMessages = workspaceFromMessages(convDir, messageIds);
    return fromMessages ? normalizeWorkspacePath(fromMessages, env.platform) : undefined;
  }

  function scanConversation(
    wsDir: string,
    conv: WorkspaceConversation,
    env: Env,
  ): SessionScan | undefined {
    const convDir = conversationDirOf(wsDir, conv.id);
    const indexPath = path.join(convDir, "index.json");
    let st: fs.Stats;
    try {
      st = fs.statSync(indexPath);
    } catch {
      return undefined;
    }
    const convIndex = readJsonFile(indexPath);
    const messageIds = messageIdsOf(convIndex);
    if (messageIds.length === 0) return undefined;
    const cwd = resolveWorkspace(wsDir, convDir, messageIds, env);
    const tailMessages = readLocalMessages(convDir, messageIds, TAIL_MESSAGE_LIMIT);
    const tailText = tailMessages
      .flatMap((message) => message.parts)
      .filter((part) => part.kind === "text" && part.text)
      .map((part) => part.text!)
      .join("\n");
    const tailLast = lastTimestamp(tailMessages);
    const freshness = conversationFreshness(convDir, st, messageIds);
    return {
      id: `${CODECBUDDY_AGENT}:${IDE_SESSION_PREFIX}${conv.id}`,
      agent: CODECBUDDY_AGENT,
      sourcePath: indexPath,
      cwd,
      gitBranch: undefined,
      startedAt: isoOf(conv.createdAtMs ?? conv.lastMessageAtMs),
      mtimeMs: freshness.mtimeMs,
      sizeBytes: freshness.sizeBytes,
      tail: {
        statusInfo: analyzeStatus(tailMessages),
        hasActiveLeaf: false,
        lastTitle: conv.name,
        lastTimestamp: isoOf(tailLast ?? conv.lastMessageAtMs),
        memrelayCalledRecently: tailText.includes("【MemRelay 续接】"),
      },
    };
  }

  function scanAllOf(env: Env): SessionScan[] {
    const scans: SessionScan[] = [];
    for (const root of rootsOf(env)) {
      for (const wsDir of workspaceDirs(root)) {
        for (const conv of readWorkspaceConversations(wsDir).values()) {
          if (conv.hidden) continue;
          const scan = scanConversation(wsDir, conv, env);
          if (scan) scans.push(scan);
        }
      }
    }
    return scans;
  }

  return {
    agent: CODECBUDDY_AGENT,
    version,

    async detect(env: Env): Promise<Detection> {
      const roots = rootsOf(env);
      return roots.length > 0
        ? { installed: true, sessionsRoot: roots[0] }
        : { installed: false };
    },

    basePath(env: Env): string {
      return rootsOf(env)[0] ?? path.join(env.home, "AppData", "Local", "CodeBuddyExtension", "Data");
    },

    /** hook 可能带任一历史根下的会话 index.json：不按单一 basePath 判断归属。 */
    acceptsPath(filePath: string, env: Env): boolean {
      if (!rootsOf(env).some((root) => isPathInside(filePath, root, env.platform))) return false;
      if (path.basename(filePath) === "index.json") return true;
      return filePath.endsWith(".json") && filePath.includes(`${path.sep}messages${path.sep}`);
    },

    async listSessions(scope: ProjectScope, env: Env): Promise<SessionRef[]> {
      const scans = scanAllOf(env).filter(
        (scan) => scan.cwd !== undefined && isPathInside(scan.cwd, scope.projectRoot, env.platform),
      );
      return scans.map(({ tail: _tail, ...ref }) => ref);
    },

    async scanAll(env: Env): Promise<SessionScan[]> {
      return scanAllOf(env);
    },

    async scanProject(scope: ProjectScope, env: Env): Promise<SessionScan[]> {
      return scanAllOf(env).filter(
        (scan) => scan.cwd !== undefined && isPathInside(scan.cwd, scope.projectRoot, env.platform),
      );
    },

    async listProjectFiles(scope: ProjectScope, env: Env): Promise<string[]> {
      const scans = scanAllOf(env).filter(
        (scan) => scan.cwd !== undefined && isPathInside(scan.cwd, scope.projectRoot, env.platform),
      );
      return scans.map((scan) => scan.sourcePath);
    },

    async scanFile(filePath: string, env: Env): Promise<SessionScan | undefined> {
      let indexPath = filePath;
      if (path.basename(filePath) !== "index.json") {
        const marker = `${path.sep}messages${path.sep}`;
        const at = filePath.lastIndexOf(marker);
        if (at < 0) return undefined;
        indexPath = path.join(filePath.slice(0, at), "index.json");
      }
      if (!fs.existsSync(indexPath)) return undefined;
      const convDir = path.dirname(indexPath);
      if (!isConversationDir(convDir)) return undefined;
      const wsDir = workspaceOfConversation(indexPath);
      if (!rootsOf(env).some((root) => isPathInside(wsDir, root, env.platform))) return undefined;
      const convId = path.basename(convDir);
      const conversations = readWorkspaceConversations(wsDir);
      const conv = conversations.get(convId) ?? { id: convId };
      return scanConversation(wsDir, conv, env);
    },

    async *readSession(ref: SessionRef): AsyncIterable<NormalizedEvent> {
      const indexPath = ref.sourcePath;
      const convDir = path.dirname(indexPath);
      const wsDir = workspaceOfConversation(indexPath);
      const convId = path.basename(convDir);
      const conversations = readWorkspaceConversations(wsDir);
      const conv = conversations.get(convId) ?? { id: convId };
      const messageIds = messageIdsOf(readJsonFile(indexPath));
      const messages = readLocalMessages(convDir, messageIds);
      // scan 时已经把 hash 映射成了工作区路径；这里优先用它，缺失时再从首条消息兜底
      const cwd = ref.cwd || workspaceFromMessages(convDir, messageIds) || "";
      const startedAtMs =
        conv.createdAtMs ?? (messages[0]?.timestamp ? Date.parse(messages[0].timestamp) : undefined);
      const endedAtMs = lastTimestamp(messages) ?? conv.lastMessageAtMs;
      const title = conv.name;
      const session: Session = {
        id: ref.id,
        agent: CODECBUDDY_AGENT,
        sourcePath: indexPath,
        cwd,
        projectRoot: "",
        title,
        firstUserMessage: firstUserText(messages),
        startedAt: isoOf(startedAtMs) ?? ref.startedAt ?? "",
        endedAt: isoOf(endedAtMs) ?? "",
        status: "unknown",
        rawRecords: messageIds.length,
      };
      yield { kind: "session", session };
      for (const event of toNormalizedMessages({ sessionId: ref.id }, messages)) {
        yield event;
      }
    },
  };
}
