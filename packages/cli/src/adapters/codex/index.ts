import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import zlib from "node:zlib";

import type { NormalizedEvent, Part, SessionRef, Env, Session, Detection, ProjectScope } from "../../core/types.js";
import { categorizeTool, extractFilePaths, isPlanTool, partKindForTool } from "../../core/tool-names.js";
import { decodeBuffer } from "../../core/text-encoding.js";
import type { LocalMessage } from "../jsonl-family/records.js";
import { analyzeStatus, compactJson, type StatusInfo } from "../jsonl-family/records.js";
import { isPathInside, normalizePathForCompare, tailHasMemrelayCall } from "../jsonl-family/parser.js";
import { readJsonl } from "../jsonl-family/jsonl.js";
import type { SessionScan, SerializedJsonlAdapter } from "../jsonl-family/jsonl-adapter.js";
import type { TailAnalysis } from "../jsonl-family/parser.js";

export const ADAPTER_VERSION = 2; // v2：支持 0.16x 的 item_completed 格式（AgentMessage/Reasoning/CommandExecution）

const zstdDecompress: ((buf: Buffer) => Buffer) | undefined = (
  zlib as unknown as { zstdDecompressSync?: (buf: Buffer) => Buffer }
).zstdDecompressSync?.bind(zlib);

export function hasZstd(): boolean {
  return zstdDecompress !== undefined;
}

const USER_INJECTION_RE =
  /^\s*(<(environment_context|permissions instructions|user_instructions|environment\b|INSTRUCTIONS>|skills_instructions>)|#\s*AGENTS\.md\b)/i;

/** 新老版本里"跑命令"的失败信号：
 *  旧: "Exit code: 1"  新: "Process exited with code 1" / "write_stdin failed" */
const COMMAND_FAIL_RE =
  /(?:^|\n)\s*(?:exit code|(?:process )?exited with code)\s*:?\s*(?!0\b)\d+|write_stdin failed/im;

/** 一条消息里同一段文本可能来自 response_item 与 item_completed 两处，按内容去重。 */
interface CodexDedupeState {
  userTexts: Set<string>;
  assistantTexts: Set<string>;
  reasoningTexts: Set<string>;
  callIds: Set<string>;
}

function newDedupeState(): CodexDedupeState {
  return {
    userTexts: new Set(),
    assistantTexts: new Set(),
    reasoningTexts: new Set(),
    callIds: new Set(),
  };
}

function resetDedupeState(dedupe: CodexDedupeState): void {
  dedupe.userTexts.clear();
  dedupe.assistantTexts.clear();
  dedupe.reasoningTexts.clear();
  dedupe.callIds.clear();
}

function textBlocks(content: unknown): { texts: string[]; parts: Part[] } {
  const texts: string[] = [];
  const parts: Part[] = [];
  if (!Array.isArray(content)) return { texts, parts };
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const rec = c as Record<string, unknown>;
    const ct = typeof rec["type"] === "string" ? rec["type"].toLowerCase() : "";
    if ((ct === "input_text" || ct === "output_text" || ct === "text") && typeof rec["text"] === "string") {
      texts.push(rec["text"]);
    } else if (ct === "input_image" || ct === "image") {
      parts.push({ kind: "image", text: "[image]" });
    }
  }
  return { texts, parts };
}

function isZst(filePath: string): boolean {
  return /\.jsonl\.zst$/i.test(filePath);
}

/** 逐条产出 rollout 记录；.zst 先整体解压。低版本 Node 没有 zstd 时抛带说明的错误。 */
async function* codexRecords(
  filePath: string,
  opts?: { tail?: boolean },
): AsyncGenerator<Record<string, unknown>> {
  if (isZst(filePath)) {
    if (!zstdDecompress) {
      throw new Error(`Node 版本不支持 zstd 解压，跳过 ${path.basename(filePath)}`);
    }
    const buf = zstdDecompress(fs.readFileSync(filePath));
    for (const line of decodeBuffer(buf).split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      try {
        const v = JSON.parse(text);
        if (v && typeof v === "object" && !Array.isArray(v)) yield v as Record<string, unknown>;
      } catch {
        /* 半行容忍 */
      }
    }
    return;
  }
  if (opts?.tail) {
    const st = fs.statSync(filePath);
    const start = Math.max(0, st.size - 262144);
    const fd = fs.openSync(filePath, "r");
    let text: string;
    try {
      const buf = Buffer.alloc(st.size - start);
      const read = fs.readSync(fd, buf, 0, buf.length, start);
      text = decodeBuffer(buf.subarray(0, read));
    } finally {
      fs.closeSync(fd);
    }
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const v = JSON.parse(t);
        if (v && typeof v === "object" && !Array.isArray(v)) yield v as Record<string, unknown>;
      } catch {
        /* 首行可能被截断 */
      }
    }
    return;
  }
  for await (const { value } of readJsonl(filePath)) yield value;
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const PATCH_PATH_RE = /^\*\*\* (?:Add|Update|Delete|Move to|Move) File: (.+)$/gm;

function filesFromPatch(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(PATCH_PATH_RE)) {
    const p = m[1]?.trim();
    if (p) out.push(p);
  }
  return [...new Set(out)];
}

/**
 * 把 rollout 记录映射成统一消息。
 * 只认 response_item 为内容正本；event_msg 只用来取用户原文与状态信号。
 */
function codexRecordToLocal(
  record: Record<string, unknown>,
  dedupe: CodexDedupeState,
): { message: LocalMessage | null; status: "aborted" | "completed" | null } {
  const type = record["type"];
  const pl = (record["payload"] ?? {}) as Record<string, unknown>;
  const ts = typeof record["timestamp"] === "string" ? record["timestamp"] : undefined;
  const uuid = `codex-${Math.random().toString(36).slice(2, 10)}`;

  if (type === "response_item") {
    const sub = pl["type"];
    if (sub === "message") {
      const role = pl["role"];
      const { texts, parts } = textBlocks(pl["content"]);
      const joined = texts.join("\n").trim();
      if (role === "assistant") {
        const textParts: Part[] = texts
          .filter((t) => t.trim())
          .map((t) => ({ kind: "text", text: t }));
        const allParts = [...textParts, ...parts];
        if (allParts.length === 0) return { message: null, status: null };
        const key = joined || JSON.stringify(allParts.map((p) => p.text));
        if (dedupe.assistantTexts.has(key)) return { message: null, status: null };
        dedupe.assistantTexts.add(key);
        return {
          message: {
            uuid,
            role: "assistant",
            timestamp: ts,
            isSidechain: false,
            isCompactBoundary: false,
            parts: allParts,
            toolCalls: [],
            toolResults: [],
            isUserPrompt: false,
          },
          status: null,
        };
      }
      if (role === "user") {
        if (!joined || USER_INJECTION_RE.test(joined)) return { message: null, status: null };
        if (dedupe.userTexts.has(joined)) return { message: null, status: null };
        dedupe.userTexts.add(joined);
        return {
          message: {
            uuid,
            role: "user",
            timestamp: ts,
            isSidechain: false,
            isCompactBoundary: false,
            parts: [{ kind: "text", text: joined }, ...parts],
            toolCalls: [],
            toolResults: [],
            isUserPrompt: true,
          },
          status: null,
        };
      }
      return { message: null, status: null };
    }
    if (sub === "reasoning") {
      const summary = Array.isArray(pl["summary"]) ? (pl["summary"] as Array<Record<string, unknown>>) : [];
      const text = summary
        .map((s) => (typeof s["text"] === "string" ? s["text"] : ""))
        .filter(Boolean)
        .join("\n\n")
        .trim();
      if (!text || dedupe.reasoningTexts.has(text)) return { message: null, status: null };
      dedupe.reasoningTexts.add(text);
      return {
        message: {
          uuid,
          role: "assistant",
          timestamp: ts,
          isSidechain: false,
          isCompactBoundary: false,
          parts: [{ kind: "reasoning", text }],
          toolCalls: [],
          toolResults: [],
          isUserPrompt: false,
        },
        status: null,
      };
    }
    if (sub === "function_call") {
      const name = typeof pl["name"] === "string" ? pl["name"] : undefined;
      const callId = typeof pl["call_id"] === "string" ? pl["call_id"] : undefined;
      if (callId) dedupe.callIds.add(callId);
      const input = parseArguments(pl["arguments"]);
      const kind = partKindForTool(name);
      const part: Part = { kind, json: input, toolName: name, toolCategory: categorizeTool(name), toolCallId: callId };
      const files = extractFilePaths(input);
      if (kind === "file_edit") part.text = files.join("\n") || compactJson(input);
      return {
        message: {
          uuid,
          role: "assistant",
          timestamp: ts,
          isSidechain: false,
          isCompactBoundary: false,
          parts: [part],
          toolCalls: [
            {
              toolCallId: callId ?? "",
              toolName: name,
              category: categorizeTool(name),
              input,
              isPlan: isPlanTool(name),
              files,
            },
          ],
          toolResults: [],
          isUserPrompt: false,
        },
        status: null,
      };
    }
    if (sub === "custom_tool_call") {
      const name = typeof pl["name"] === "string" ? pl["name"] : "custom_tool";
      const callId = typeof pl["call_id"] === "string" ? pl["call_id"] : undefined;
      if (callId) dedupe.callIds.add(callId);
      const input = typeof pl["input"] === "string" ? pl["input"] : "";
      const files = name === "apply_patch" ? filesFromPatch(input) : [];
      const isEdit = name === "apply_patch";
      return {
        message: {
          uuid,
          role: "assistant",
          timestamp: ts,
          isSidechain: false,
          isCompactBoundary: false,
          parts: [
            {
              kind: isEdit ? "file_edit" : "tool_call",
              text: isEdit ? files.join("\n") : undefined,
              json: input,
              toolName: name,
              toolCategory: isEdit ? "write" : "other",
              toolCallId: callId,
            },
          ],
          toolCalls: [
            {
              toolCallId: callId ?? "",
              toolName: name,
              category: isEdit ? "write" : "other",
              input: { patch: input },
              isPlan: false,
              files,
            },
          ],
          toolResults: [],
          isUserPrompt: false,
        },
        status: null,
      };
    }
    if (sub === "function_call_output" || sub === "custom_tool_call_output") {
      const callId = typeof pl["call_id"] === "string" ? pl["call_id"] : undefined;
      const output = typeof pl["output"] === "string" ? pl["output"] : compactJson(pl["output"]);
      const isError =
        COMMAND_FAIL_RE.test(output) ||
        /^\s*error\b|\bexception\b|Traceback/i.test(output.slice(0, 400));
      return {
        message: {
          uuid,
          role: "tool",
          timestamp: ts,
          isSidechain: false,
          isCompactBoundary: false,
          parts: [{ kind: "tool_result", text: output, toolCallId: callId, status: isError ? "error" : "ok" }],
          toolCalls: [],
          toolResults: [{ toolCallId: callId, content: output, isError }],
          isUserPrompt: false,
        },
        status: null,
      };
    }
    if (sub === "web_search_call") {
      const action = (pl["action"] ?? {}) as Record<string, unknown>;
      const query = typeof action["query"] === "string" ? action["query"] : undefined;
      return {
        message: {
          uuid,
          role: "assistant",
          timestamp: ts,
          isSidechain: false,
          isCompactBoundary: false,
          parts: [{ kind: "tool_call", text: query, toolName: "web_search", toolCategory: "web", json: action }],
          toolCalls: [],
          toolResults: [],
          isUserPrompt: false,
        },
        status: null,
      };
    }
    if (sub === "tool_search_call" || sub === "image_generation_call" || sub === "mcp_tool_call") {
      return {
        message: {
          uuid,
          role: "assistant",
          timestamp: ts,
          isSidechain: false,
          isCompactBoundary: false,
          parts: [{ kind: "tool_call", text: compactJson(pl, 300), toolName: String(sub), toolCategory: "other", json: pl }],
          toolCalls: [],
          toolResults: [],
          isUserPrompt: false,
        },
        status: null,
      };
    }
    // 其它 response_item 保留为 system_event
    return {
      message: {
        uuid,
        role: "system",
        timestamp: ts,
        isSidechain: false,
        isCompactBoundary: false,
        parts: [{ kind: "system_event", text: compactJson(pl, 400) }],
        toolCalls: [],
        toolResults: [],
        isUserPrompt: false,
      },
      status: null,
    };
  }

  if (type === "event_msg") {
    const sub = pl["type"];
    if (sub === "user_message") {
      const text = typeof pl["message"] === "string" ? pl["message"].trim() : "";
      if (!text || dedupe.userTexts.has(text)) return { message: null, status: null };
      dedupe.userTexts.add(text);
      return {
        message: {
          uuid,
          role: "user",
          timestamp: ts,
          isSidechain: false,
          isCompactBoundary: false,
          parts: [{ kind: "text", text }],
          toolCalls: [],
          toolResults: [],
          isUserPrompt: true,
        },
        status: null,
      };
    }
    if (sub === "agent_message") {
      // 与 response_item 常常重复；内容不同（只有这一处有）时也收下
      const text = typeof pl["message"] === "string" ? pl["message"].trim() : "";
      if (!text || dedupe.assistantTexts.has(text)) return { message: null, status: null };
      dedupe.assistantTexts.add(text);
      return {
        message: {
          uuid,
          role: "assistant",
          timestamp: ts,
          isSidechain: false,
          isCompactBoundary: false,
          parts: [{ kind: "text", text }],
          toolCalls: [],
          toolResults: [],
          isUserPrompt: false,
        },
        status: null,
      };
    }
    if (sub === "item_completed") {
      // Codex 0.16x 起：会话项（用户消息、助手消息、思考、命令执行）走 item_completed
      const item = (pl["item"] ?? {}) as Record<string, unknown>;
      const itemType = typeof item["type"] === "string" ? item["type"] : "";
      if (itemType === "UserMessage") {
        const { texts, parts } = textBlocks(item["content"]);
        const joined = texts.join("\n").trim();
        if (!joined || USER_INJECTION_RE.test(joined)) return { message: null, status: null };
        if (dedupe.userTexts.has(joined)) return { message: null, status: null };
        dedupe.userTexts.add(joined);
        return {
          message: {
            uuid,
            role: "user",
            timestamp: ts,
            isSidechain: false,
            isCompactBoundary: false,
            parts: [{ kind: "text", text: joined }, ...parts],
            toolCalls: [],
            toolResults: [],
            isUserPrompt: true,
          },
          status: null,
        };
      }
      if (itemType === "AgentMessage") {
        const { texts, parts } = textBlocks(item["content"]);
        const joined = texts.join("\n").trim();
        const allParts = [
          ...texts.filter((t) => t.trim()).map((t) => ({ kind: "text" as const, text: t })),
          ...parts,
        ];
        if (allParts.length === 0 || dedupe.assistantTexts.has(joined)) {
          return { message: null, status: null };
        }
        dedupe.assistantTexts.add(joined);
        return {
          message: {
            uuid,
            role: "assistant",
            timestamp: ts,
            isSidechain: false,
            isCompactBoundary: false,
            parts: allParts,
            toolCalls: [],
            toolResults: [],
            isUserPrompt: false,
          },
          status: null,
        };
      }
      if (itemType === "Reasoning") {
        const raw = item["summary_text"];
        const text = Array.isArray(raw)
          ? raw.filter((t): t is string => typeof t === "string").join("\n\n").trim()
          : "";
        if (!text || dedupe.reasoningTexts.has(text)) return { message: null, status: null };
        dedupe.reasoningTexts.add(text);
        return {
          message: {
            uuid,
            role: "assistant",
            timestamp: ts,
            isSidechain: false,
            isCompactBoundary: false,
            parts: [{ kind: "reasoning", text }],
            toolCalls: [],
            toolResults: [],
            isUserPrompt: false,
          },
          status: null,
        };
      }
      if (itemType === "CommandExecution") {
        const callId = typeof item["id"] === "string" ? item["id"] : undefined;
        // function_call / function_call_output 通常已经覆盖过同一 call_id
        if (callId && dedupe.callIds.has(callId)) return { message: null, status: null };
        if (callId) dedupe.callIds.add(callId);
        const command = Array.isArray(item["command"]) ? (item["command"] as unknown[]).join(" ") : String(item["command"] ?? "");
        const status = typeof item["status"] === "string" ? item["status"] : "";
        const output = typeof item["aggregated_output"] === "string" ? item["aggregated_output"] : "";
        const isError = status === "failed" || (output ? COMMAND_FAIL_RE.test(output) : false);
        return {
          message: {
            uuid,
            role: "assistant",
            timestamp: ts,
            isSidechain: false,
            isCompactBoundary: false,
            parts: [
              { kind: "tool_call", text: command, toolName: "exec_command", toolCategory: "shell", json: { command } },
              ...(output
                ? [{ kind: "tool_result" as const, text: output, status: isError ? ("error" as const) : ("ok" as const) }]
                : []),
            ],
            toolCalls: [
              {
                toolCallId: callId ?? "",
                toolName: "exec_command",
                category: "shell",
                input: { command },
                isPlan: false,
                files: [],
              },
            ],
            toolResults: output
              ? [{ toolCallId: callId, content: output, isError }]
              : [],
            isUserPrompt: false,
          },
          status: null,
        };
      }
      return { message: null, status: null };
    }
    if (sub === "task_complete") {
      const last = typeof pl["last_agent_message"] === "string" ? pl["last_agent_message"] : "";
      return {
        message: {
          uuid,
          role: "system",
          timestamp: ts,
          isSidechain: false,
          isCompactBoundary: false,
          // 新版本 last_agent_message 常是 null，进展取自最后一条助手消息
          parts: [{ kind: "system_event", text: last ? `[任务完成] ${last}` : "[回合完成]" }],
          toolCalls: [],
          toolResults: [],
          isUserPrompt: false,
        },
        status: "completed",
      };
    }
    if (sub === "turn_aborted") {
      const reason = typeof pl["reason"] === "string" ? pl["reason"] : "aborted";
      return {
        message: {
          uuid,
          role: "system",
          timestamp: ts,
          isSidechain: false,
          isCompactBoundary: false,
          parts: [{ kind: "system_event", text: `[回合中断] ${reason}` }],
          toolCalls: [],
          toolResults: [],
          isUserPrompt: false,
        },
        status: "aborted",
      };
    }
    if (sub === "thread_rolled_back") return {
      message: {
        uuid,
        role: "system",
        timestamp: ts,
        isSidechain: false,
        isCompactBoundary: false,
        parts: [{ kind: "system_event", text: `[回退 ${pl["num_turns"] ?? "?"} 个回合]` }],
        toolCalls: [],
        toolResults: [],
        isUserPrompt: false,
      },
      status: null,
    };
    if (sub === "patch_apply_end") {
      const changes = pl["changes"];
      const files = changes && typeof changes === "object" ? Object.keys(changes) : [];
      return {
        message: {
          uuid,
          role: "system",
          timestamp: ts,
          isSidechain: false,
          isCompactBoundary: false,
          parts: [{ kind: "system_event", text: `[补丁应用] ${files.join(", ") || compactJson(pl, 200)}` }],
          toolCalls: [],
          toolResults: [],
          isUserPrompt: false,
        },
        status: null,
      };
    }
    return { message: null, status: null };
  }
  return { message: null, status: null };
}

export interface CodexParseState {
  aborted: boolean;
  completed: boolean;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  firstUserMessage?: string;
}

export function parseCodexRecords(records: Record<string, unknown>[]): {
  messages: LocalMessage[];
  state: CodexParseState;
} {
  const messages: LocalMessage[] = [];
  const dedupe = newDedupeState();
  const state: CodexParseState = { aborted: false, completed: false };
  for (const record of records) {
    const type = record["type"];
    const pl = (record["payload"] ?? {}) as Record<string, unknown>;
    if (type === "session_meta") {
      if (typeof pl["id"] === "string") state.sessionId = pl["id"];
      if (typeof pl["cwd"] === "string") state.cwd = stripLongPathPrefix(pl["cwd"]);
      if (typeof pl["git"] === "object" && pl["git"]) {
        const g = pl["git"] as Record<string, unknown>;
        if (typeof g["branch"] === "string") state.gitBranch = g["branch"];
      }
    } else if (type === "turn_context") {
      if (typeof pl["cwd"] === "string") state.cwd = stripLongPathPrefix(pl["cwd"]);
      // 新回合开始：镜像事件去重只应作用于同一回合，否则第二回合相同的"继续"会被吞掉。
      resetDedupeState(dedupe);
    } else if (type === "task_started") {
      resetDedupeState(dedupe);
    }
    const { message, status } = codexRecordToLocal(record, dedupe);
    if (status === "aborted") state.aborted = true;
    if (status === "completed") state.completed = true;
    if (message) {
      messages.push(message);
      if (!state.firstUserMessage && message.isUserPrompt) {
        state.firstUserMessage = message.parts
          .filter((p) => p.kind === "text" && p.text)
          .map((p) => p.text!)
          .join("\n");
      }
    }
  }
  return { messages, state };
}

function stripLongPathPrefix(p: string): string {
  return p.replace(/^\\\\\?\\/, "");
}

/** 从 threads 表（state_*.sqlite，只读）拿标题/分支；失败返回空表。 */
interface ThreadInfo {
  id: string;
  rolloutPath?: string;
  cwd?: string;
  title?: string;
  gitBranch?: string;
  updatedAtMs?: number;
}

export function readThreadsTable(env: Env): Map<string, ThreadInfo> {
  const out = new Map<string, ThreadInfo>();
  let stateFile: string | undefined;
  try {
    const files = fs
      .readdirSync(path.join(env.home, ".codex"))
      .filter((f) => /^state_\d+\.sqlite$/.test(f));
    files.sort((a, b) => Number(b.match(/\d+/)?.[0] ?? 0) - Number(a.match(/\d+/)?.[0] ?? 0));
    if (files[0]) stateFile = path.join(env.home, ".codex", files[0]);
  } catch {
    return out;
  }
  if (!stateFile) return out;
  try {
    const db = new DatabaseSync(stateFile, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT id, rollout_path, cwd, title, git_branch, updated_at_ms FROM threads")
        .all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const id = typeof row["id"] === "string" ? row["id"] : undefined;
        if (!id) continue;
        out.set(id, {
          id,
          rolloutPath: typeof row["rollout_path"] === "string" ? row["rollout_path"] : undefined,
          cwd: typeof row["cwd"] === "string" ? stripLongPathPrefix(row["cwd"]) : undefined,
          title: typeof row["title"] === "string" ? row["title"] : undefined,
          gitBranch: typeof row["git_branch"] === "string" ? row["git_branch"] : undefined,
          updatedAtMs: typeof row["updated_at_ms"] === "number" ? row["updated_at_ms"] : undefined,
        });
      }
    } finally {
      db.close();
    }
  } catch {
    return out;
  }
  return out;
}

function sessionIdFromFile(filePath: string): string {
  const base = path.basename(filePath).replace(/\.jsonl(\.zst)?$/i, "");
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(base);
  return m ? m[1]! : base;
}

function listRolloutFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1);
      else if (/rollout-.*\.jsonl(\.zst)?$/i.test(entry.name) || /^rollout-.*\.jsonl\.zst$/i.test(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root, 0);
  return out;
}

/** 读一个 rollout 文件的开头（session_meta 通常在第一行）。 */
function peekCodexHead(filePath: string): { cwd?: string; sessionId?: string; startedAt?: string } {
  try {
    if (isZst(filePath)) {
      if (!zstdDecompress) return {};
      const buf = zstdDecompress(fs.readFileSync(filePath));
      const first = buf.toString("utf8", 0, Math.min(buf.length, 65536)).split(/\r?\n/);
      for (const line of first) {
        const t = line.trim();
        if (!t) continue;
        try {
          const v = JSON.parse(t) as Record<string, unknown>;
          if (v["type"] === "session_meta") {
            const pl = (v["payload"] ?? {}) as Record<string, unknown>;
            return {
              cwd: typeof pl["cwd"] === "string" ? stripLongPathPrefix(pl["cwd"]) : undefined,
              sessionId: typeof pl["id"] === "string" ? pl["id"] : undefined,
              startedAt: typeof v["timestamp"] === "string" ? v["timestamp"] : undefined,
            };
          }
        } catch {
          continue;
        }
      }
      return {};
    }
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(Math.min(fs.statSync(filePath).size, 65536));
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = decodeBuffer(buf.subarray(0, read));
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try {
          const v = JSON.parse(t) as Record<string, unknown>;
          if (v["type"] === "session_meta") {
            const pl = (v["payload"] ?? {}) as Record<string, unknown>;
            return {
              cwd: typeof pl["cwd"] === "string" ? stripLongPathPrefix(pl["cwd"]) : undefined,
              sessionId: typeof pl["id"] === "string" ? pl["id"] : undefined,
              startedAt: typeof v["timestamp"] === "string" ? v["timestamp"] : undefined,
            };
          }
        } catch {
          continue;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* ignore */
  }
  return {};
}

async function analyzeCodexTail(filePath: string): Promise<TailAnalysis> {
  const records: Record<string, unknown>[] = [];
  try {
    for await (const record of codexRecords(filePath, { tail: true })) records.push(record);
  } catch {
    /* 留给 scan 整体跳过 */
  }
  const { messages, state } = parseCodexRecords(records);
  const statusInfo = analyzeStatus(messages);
  const lastMsg = [...messages].reverse().find((m) => m.role === "user" || m.role === "assistant");
  const tail: TailAnalysis = {
    statusInfo,
    hasActiveLeaf: false,
    lastMessageUuid: lastMsg?.uuid,
    lastTimestamp: lastMsg?.timestamp,
    memrelayCalledRecently: tailHasMemrelayCall(messages),
  };
  if (state.aborted) {
    tail.statusInfo.errorDetected = true;
  }
  return tail;
}

export interface CodexAdapterOptions {
  agent?: string;
  /** 会话根目录（相对 home）；Trae CLI 是 Codex 兼容格式，复用本适配器时指向 .trae/cli */
  sessionsRootRel?: string;
  /** 标题等外部元数据来源；缺省读 Codex 自己的本地库 */
  threads?: (env: Env) => Map<string, ThreadInfo>;
}

export function codexAdapter(options: CodexAdapterOptions = {}): SerializedJsonlAdapter {
  const agent = options.agent ?? "codex";
  const rel = options.sessionsRootRel ?? ".codex/sessions";
  const rootOf = (env: Env): string => path.join(env.home, ...rel.split("/"));
  const threadsFor = options.threads ?? readThreadsTable;

  async function detect(env: Env): Promise<Detection> {
    const root = rootOf(env);
    try {
      return { installed: fs.statSync(root).isDirectory(), sessionsRoot: root };
    } catch {
      return { installed: false, sessionsRoot: root };
    }
  }

  async function scanFiles(files: string[], env: Env, threads: Map<string, ThreadInfo>): Promise<SessionScan[]> {
    const out: SessionScan[] = [];
    const byPath = new Map<string, ThreadInfo>();
    for (const t of threads.values()) {
      if (t.rolloutPath) byPath.set(normalizePathForCompare(t.rolloutPath, env.platform), t);
    }
    for (const file of files) {
      const norm = normalizePathForCompare(file, env.platform);
      const thread = byPath.get(norm) ?? threads.get(sessionIdFromFile(file));
      const head = peekCodexHead(file);
      const cwd = head.cwd ?? thread?.cwd;
      if (!cwd) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const tail = await analyzeCodexTail(file);
      if (thread?.title) tail.lastTitle = thread.title;
      out.push({
        id: `${agent}:${head.sessionId ?? sessionIdFromFile(file)}`,
        agent,
        sourcePath: file,
        cwd,
        gitBranch: thread?.gitBranch,
        startedAt: head.startedAt,
        mtimeMs: st.mtimeMs,
        sizeBytes: st.size,
        tail,
      });
    }
    return out;
  }

  async function scanProject(scope: ProjectScope, env: Env): Promise<SessionScan[]> {
    const root = rootOf(env);
    const all = await scanFiles(listRolloutFiles(root), env, threadsFor(env));
    const out = all.filter((s) => isPathInside(s.cwd ?? "", scope.projectRoot, env.platform));
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  }

  async function scanAll(env: Env): Promise<SessionScan[]> {
    const root = rootOf(env);
    const all = await scanFiles(listRolloutFiles(root), env, threadsFor(env));
    all.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return all;
  }

  async function* readSession(
    ref: SessionRef,
    readOpts?: { fromOffset?: number },
  ): AsyncIterable<NormalizedEvent> {
    const records: Record<string, unknown>[] = [];
    for await (const record of codexRecords(ref.sourcePath)) records.push(record);
    const { messages, state } = parseCodexRecords(records);

    const session: Session = {
      id: ref.id,
      agent,
      sourcePath: ref.sourcePath,
      cwd: state.cwd ?? ref.cwd ?? "",
      projectRoot: state.cwd ?? ref.cwd ?? "",
      gitBranch: state.gitBranch ?? ref.gitBranch,
      title: undefined,
      firstUserMessage: state.firstUserMessage,
      startedAt: ref.startedAt ?? "",
      endedAt: messages[messages.length - 1]?.timestamp ?? "",
      status: "unknown",
      rawRecords: records.length,
    };
    yield { kind: "session", session };

    const start = readOpts?.fromOffset ?? 0;
    for (let i = 0; i < messages.length; i++) {
      const ordinal = i + 1;
      if (ordinal < start) continue;
      const m = messages[i]!;
      yield {
        kind: "message",
        message: {
          sessionId: ref.id,
          ordinal,
          nativeId: m.uuid,
          nativeParentId: undefined,
          role: m.role,
          createdAt: m.timestamp ?? "",
          isSidechain: m.isSidechain,
          isCompactBoundary: m.isCompactBoundary,
          parts: m.parts,
        },
      };
    }
  }

  return {
    agent,
    version: ADAPTER_VERSION,
    detect,
    listSessions: async (scope, env) => (await scanProject(scope, env)).map(toRef),
    readSession,
    basePath: rootOf,
    scanProject,
    scanAll,
    // rollout 文件不带项目信息，只能全量列出；项目判定交给快路径（库里的 cwd）
    listProjectFiles: async (_scope, env) => listRolloutFiles(rootOf(env)),
    scanFile: async (filePath, env) => (await scanFiles([filePath], env, threadsFor(env)))[0],
  };
}

/** Trae CLI 2.0：Codex 兼容的 rollout JSONL（sessions 与 archived_sessions 都在 .trae/cli 下）。 */
export function traeCliAdapter(): SerializedJsonlAdapter {
  return codexAdapter({
    agent: "trae",
    sessionsRootRel: ".trae/cli",
    threads: () => new Map(),
  });
}

function toRef(scan: SessionScan): SessionRef {
  const { tail: _tail, ...ref } = scan;
  return ref;
}

export type { StatusInfo };
