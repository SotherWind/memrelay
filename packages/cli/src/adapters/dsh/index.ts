import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import type {
  Detection,
  Env,
  NormalizedEvent,
  Part,
  ProjectScope,
  Session,
  SessionRef,
} from "../../core/types.js";
import { categorizeTool, extractFilePaths, isPlanTool, partKindForTool } from "../../core/tool-names.js";
import { decodeBuffer } from "../../core/text-encoding.js";
import { analyzeStatus, compactJson, type LocalMessage } from "../jsonl-family/records.js";
import { isPathInside, tailHasMemrelayCall, type TailAnalysis } from "../jsonl-family/parser.js";
import type { SessionScan, SerializedJsonlAdapter } from "../jsonl-family/jsonl-adapter.js";

export const ADAPTER_VERSION = 1;

const zstdDecompress: ((buf: Buffer) => Buffer) | undefined = (
  zlib as unknown as { zstdDecompressSync?: (buf: Buffer) => Buffer }
).zstdDecompressSync?.bind(zlib);

export function hasZstd(): boolean {
  return zstdDecompress !== undefined;
}

/**
 * dsh 的会话文件是多帧 zstd 追加写入（每批事件一个独立帧），
 * zstdDecompressSync 只解第一帧，所以要逐帧扫魔数解压再拼接。
 */
function decodeZstdFrames(buf: Buffer): string {
  if (!zstdDecompress) {
    throw new Error("Node 版本不支持 zstd 解压（需要 22.15+ 或 24+）");
  }
  const chunks: string[] = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    // 压缩数据里偶发的假魔数解压会失败，跳过即可
    if (buf[i] !== 0x28 || buf[i + 1] !== 0xb5 || buf[i + 2] !== 0x2f || buf[i + 3] !== 0xfd) continue;
    try {
      chunks.push(decodeBuffer(zstdDecompress(buf.subarray(i))));
    } catch {
      /* 假魔数或撕裂的末帧 */
    }
  }
  return chunks.join("");
}

function decodeDshEvents(filePath: string): Record<string, unknown>[] {
  const buf = fs.readFileSync(filePath);
  const text = /\.zstd?$/i.test(filePath) ? decodeZstdFrames(buf) : decodeBuffer(buf);
  const out: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v as Record<string, unknown>);
    } catch {
      /* 半行容忍 */
    }
  }
  return out;
}

/**
 * 移植自 dsh-session-persistence-jsonl 的 projectKey：
 * 分隔符（/ \ :）折叠成单个 -，其余特殊字符 ~XXXX（UTF-16 码元）转义，两端用 -- 包裹。
 */
export function projectKeyForCwd(cwd: string): string {
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = cwd[i]!;
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  const core = readable.replace(/^-+/, "") || "root";
  return `--${core.slice(0, 251)}--`;
}

/** 会话主文件：优先最高版本的 session.vN.jsonl(.zstd)，当前是 v4。 */
function pickSessionFile(sessionDir: string): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  let best: { version: number; file: string } | undefined;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const m = /^session(?:\.v(\d+))?\.jsonl(\.zstd|\.zst)?$/i.exec(entry.name);
    if (!m) continue;
    const version = m[1] ? Number(m[1]) : 0;
    if (!best || version > best.version) {
      best = { version, file: path.join(sessionDir, entry.name) };
    }
  }
  return best?.file;
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function isoFromMs(ms: unknown): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function toolCallPart(callId: string | undefined, name: string | undefined, input: unknown): Part {
  const kind = partKindForTool(name);
  const part: Part = {
    kind,
    json: input,
    toolName: name,
    toolCategory: categorizeTool(name),
    toolCallId: callId,
  };
  if (kind === "file_edit") {
    const files = extractFilePaths(input);
    part.text = files.join("\n") || compactJson(input);
  }
  return part;
}

function blocksToParts(content: unknown): Part[] {
  const parts: Part[] = [];
  if (typeof content === "string") {
    if (content) parts.push({ kind: "text", text: content });
    return parts;
  }
  if (!Array.isArray(content)) return parts;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const rec = b as Record<string, unknown>;
    const t = typeof rec["type"] === "string" ? rec["type"] : "";
    if (t === "text" && typeof rec["text"] === "string") {
      parts.push({ kind: "text", text: rec["text"] });
    } else if (t === "reasoning" && typeof rec["text"] === "string") {
      parts.push({ kind: "reasoning", text: rec["text"] });
    } else if (t === "image") {
      parts.push({ kind: "image", text: "[图片]" });
    } else if (t === "tool-call" || t === "tool_call") {
      // dsh 里工具调用通常是独立的 tool/call 事件；消息里出现也兜住
      parts.push(toolCallPart(strOrUndef(rec["id"]), strOrUndef(rec["name"]), rec["arguments"]));
    }
  }
  return parts;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      const rec = b as Record<string, unknown>;
      const t = rec["type"];
      if ((t === "text" || t === "output_text") && typeof rec["text"] === "string") {
        chunks.push(rec["text"]);
      }
    }
    if (chunks.length) return chunks.join("\n");
  }
  return compactJson(content);
}

interface DshParseState {
  nativeId?: string;
  cwd?: string;
  title?: string;
  startedAt?: string;
  firstUserMessage?: string;
  lastTimestamp?: string;
  /** 最后一次 turn/end 的结果（completed / interrupted / aborted / error / max-tokens…） */
  lastTurnEnd?: string;
}

function dshEventToLocal(record: Record<string, unknown>, state: DshParseState): LocalMessage | null {
  const type = typeof record["type"] === "string" ? record["type"] : "";
  const data = (
    record["data"] && typeof record["data"] === "object" ? record["data"] : {}
  ) as Record<string, unknown>;
  const seq = typeof record["seq"] === "number" ? record["seq"] : undefined;
  const uuid = seq !== undefined ? `dsh-${seq}` : `dsh-${Math.random().toString(36).slice(2, 10)}`;
  const timestamp = isoFromMs(record["time"]);

  if (type === "session") {
    state.nativeId = strOrUndef(record["id"]);
    state.cwd = strOrUndef(record["cwd"]);
    state.startedAt = isoFromMs(record["createdAt"]);
    return null;
  }
  if (type === "session/title") {
    state.title = strOrUndef(data["title"]);
    return null;
  }
  if (type === "turn/end") {
    const reason = (
      data["reason"] && typeof data["reason"] === "object" ? data["reason"] : {}
    ) as Record<string, unknown>;
    const kind = strOrUndef(reason["kind"]) ?? strOrUndef(data["reason"]);
    if (kind) state.lastTurnEnd = kind;
    return null;
  }
  if (type === "user/message") {
    const parts = blocksToParts(data["content"]);
    if (parts.length === 0) return null;
    const source = (
      data["source"] && typeof data["source"] === "object" ? data["source"] : {}
    ) as Record<string, unknown>;
    const msgId = strOrUndef(data["id"]);
    const sourceKind = strOrUndef(source["kind"]);
    return {
      uuid: msgId ? `dsh-${msgId}` : uuid,
      role: "user",
      timestamp,
      isSidechain: false,
      isCompactBoundary: false,
      parts,
      toolCalls: [],
      toolResults: [],
      isUserPrompt: sourceKind === undefined || sourceKind === "user",
    };
  }
  if (type === "assistant/message") {
    const message = (
      data["message"] && typeof data["message"] === "object" ? data["message"] : {}
    ) as Record<string, unknown>;
    const parts = blocksToParts(message["content"]);
    if (parts.length === 0) return null;
    return {
      uuid,
      role: "assistant",
      timestamp,
      isSidechain: false,
      isCompactBoundary: false,
      parts,
      toolCalls: [],
      toolResults: [],
      isUserPrompt: false,
    };
  }
  if (type === "tool/call") {
    const callId = strOrUndef(data["callId"]);
    const name = strOrUndef(data["name"]);
    const input = data["arguments"];
    const files = extractFilePaths(input);
    return {
      uuid,
      role: "assistant",
      timestamp,
      isSidechain: false,
      isCompactBoundary: false,
      parts: [toolCallPart(callId, name, input)],
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
    };
  }
  if (type === "tool/result") {
    const message = (
      data["message"] && typeof data["message"] === "object" ? data["message"] : {}
    ) as Record<string, unknown>;
    const source = (
      message["source"] && typeof message["source"] === "object" ? message["source"] : {}
    ) as Record<string, unknown>;
    const callId = strOrUndef(message["toolCallId"]) ?? strOrUndef(source["callId"]);
    const text = toolResultText(message["content"]);
    const isError = message["isError"] === true || data["error"] !== undefined;
    return {
      uuid,
      role: "tool",
      timestamp,
      isSidechain: false,
      isCompactBoundary: false,
      parts: [{ kind: "tool_result", text, toolCallId: callId, status: isError ? "error" : "ok" }],
      toolCalls: [],
      toolResults: [{ toolCallId: callId, content: text, isError }],
      isUserPrompt: false,
    };
  }
  if (type === "compaction/summary") {
    const raw = data["summary"] ?? data["text"] ?? data["content"];
    const text = typeof raw === "string" ? raw : compactJson(raw, 2000);
    if (!text) return null;
    return {
      uuid,
      role: "system",
      timestamp,
      isSidechain: false,
      isCompactBoundary: false,
      parts: [{ kind: "compaction_summary", text }],
      toolCalls: [],
      toolResults: [],
      isUserPrompt: false,
    };
  }
  // turn/start、step/*、request/header、agent/inbox/spliced、approval/*、system/message（系统提示）等均为噪声
  return null;
}

export function parseDshSession(records: Record<string, unknown>[]): {
  messages: LocalMessage[];
  state: DshParseState;
} {
  const messages: LocalMessage[] = [];
  const state: DshParseState = {};
  for (const record of records) {
    const msg = dshEventToLocal(record, state);
    if (!msg) continue;
    messages.push(msg);
    if (msg.timestamp) state.lastTimestamp = msg.timestamp;
    if (!state.firstUserMessage && msg.isUserPrompt) {
      const text = msg.parts
        .filter((p) => p.kind === "text" && p.text)
        .map((p) => p.text!)
        .join("\n");
      if (text) state.firstUserMessage = text;
    }
  }
  return { messages, state };
}

function tailFromParse(messages: LocalMessage[], state: DshParseState): TailAnalysis {
  const statusInfo = analyzeStatus(messages);
  // 与 Codex 适配器口径一致：最后一回合被中断/出错也是"未接完"的信号
  if (state.lastTurnEnd !== undefined && state.lastTurnEnd !== "completed") {
    statusInfo.errorDetected = true;
  }
  const lastMsg = [...messages].reverse().find((m) => m.role === "user" || m.role === "assistant");
  return {
    statusInfo,
    hasActiveLeaf: false,
    lastMessageUuid: lastMsg?.uuid,
    lastTitle: state.title,
    lastTimestamp: lastMsg?.timestamp ?? state.lastTimestamp,
    memrelayCalledRecently: tailHasMemrelayCall(messages),
  };
}

export function dshAdapter(): SerializedJsonlAdapter {
  const agent = "dsh";
  const rootOf = (env: Env): string => path.join(env.home, ".dsh", "sessions");

  async function detect(env: Env): Promise<Detection> {
    const root = rootOf(env);
    try {
      return { installed: fs.statSync(root).isDirectory(), sessionsRoot: root };
    } catch {
      return { installed: false, sessionsRoot: root };
    }
  }

  /** 项目目录名由 cwd 精确算出（大小写不敏感兜底）；`_no-cwd` 不归属任何项目。 */
  function projectDirs(env: Env, projectRoot: string): string[] {
    const key = projectKeyForCwd(projectRoot).toLowerCase();
    const root = rootOf(env);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.toLowerCase() === key) out.push(path.join(root, entry.name));
    }
    return out;
  }

  function sessionFilesIn(projectDir: string): string[] {
    const out: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = pickSessionFile(path.join(projectDir, entry.name));
      if (file) out.push(file);
    }
    return out;
  }

  function scanOne(filePath: string): SessionScan | undefined {
    let st: fs.Stats;
    try {
      st = fs.statSync(filePath);
    } catch {
      return undefined;
    }
    if (st.size === 0) return undefined;
    let records: Record<string, unknown>[];
    try {
      records = decodeDshEvents(filePath);
    } catch {
      return undefined; /* 无 zstd 支持或文件损坏 */
    }
    const { messages, state } = parseDshSession(records);
    if (!state.nativeId || !state.cwd) return undefined; /* 没有 cwd 的会话不归任何项目 */
    return {
      id: `${agent}:${state.nativeId}`,
      agent,
      sourcePath: filePath,
      cwd: state.cwd,
      startedAt: state.startedAt,
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      tail: tailFromParse(messages, state),
    };
  }

  async function scanProject(scope: ProjectScope, env: Env): Promise<SessionScan[]> {
    const out: SessionScan[] = [];
    for (const dir of projectDirs(env, scope.projectRoot)) {
      for (const file of sessionFilesIn(dir)) {
        const scan = scanOne(file);
        if (!scan) continue;
        if (scan.cwd && !isPathInside(scan.cwd, scope.projectRoot, env.platform)) continue;
        out.push(scan);
      }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  }

  async function scanAll(env: Env): Promise<SessionScan[]> {
    const root = rootOf(env);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: SessionScan[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      for (const file of sessionFilesIn(path.join(root, entry.name))) {
        const scan = scanOne(file);
        if (scan) out.push(scan);
      }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  }

  async function* readSession(
    ref: SessionRef,
    readOpts?: { fromOffset?: number },
  ): AsyncIterable<NormalizedEvent> {
    const records = decodeDshEvents(ref.sourcePath);
    const { messages, state } = parseDshSession(records);

    const session: Session = {
      id: ref.id,
      agent,
      sourcePath: ref.sourcePath,
      cwd: state.cwd ?? ref.cwd ?? "",
      projectRoot: state.cwd ?? ref.cwd ?? "",
      title: state.title,
      firstUserMessage: state.firstUserMessage,
      startedAt: state.startedAt ?? ref.startedAt ?? "",
      endedAt: state.lastTimestamp ?? "",
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
    listProjectFiles: async (scope, env) => {
      const out: string[] = [];
      for (const dir of projectDirs(env, scope.projectRoot)) out.push(...sessionFilesIn(dir));
      return out;
    },
    scanFile: async (filePath) => scanOne(filePath),
  };
}

function toRef(scan: SessionScan): SessionRef {
  const { tail: _tail, ...ref } = scan;
  return ref;
}

/**
 * hook 用：按 session_id（+ 可选 cwd）定位会话文件。
 * dsh 的 hook payload 里 transcript_path 恒为空，只能靠 session_id 回推路径；
 * cwd 缺失或编码目录对不上时，退化为扫所有项目目录。
 */
export function dshSessionFile(env: Env, sessionId: string, cwd?: string): string | undefined {
  const root = path.join(env.home, ".dsh", "sessions");
  const dirs: string[] = [];
  if (cwd) dirs.push(path.join(root, projectKeyForCwd(cwd)));
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const dir = path.join(root, entry.name);
        if (!dirs.includes(dir)) dirs.push(dir);
      }
    }
  } catch {
    /* 没有 sessions 目录 */
  }
  for (const dir of dirs) {
    const file = pickSessionFile(path.join(dir, sessionId));
    if (file) return file;
  }
  return undefined;
}
