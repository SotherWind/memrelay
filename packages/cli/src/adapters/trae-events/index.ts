import fs from "node:fs";
import path from "node:path";

import type {
  Detection,
  Env,
  Message,
  NormalizedEvent,
  Part,
  ProjectScope,
  Session,
  SessionRef,
} from "../../core/types.js";
import { decodeBuffer } from "../../core/text-encoding.js";
import { analyzeStatus, toLocalMessages } from "../jsonl-family/records.js";
import { isPathInside } from "../jsonl-family/parser.js";
import type { SessionScan, SerializedJsonlAdapter } from "../jsonl-family/jsonl-adapter.js";
import {
  TRAE_EVENTS_SUBDIR,
  traeAgentHooksRoots,
  traePayloadRecords,
} from "../../integrations/relay-events.js";

/**
 * Trae CN（IDE）的事件型来源：读取 memrelay hook 采集的 relay-events/trae-cn/<sessionId>.jsonl，
 * 把事件重建成会话（消息/工具调用/工具结果），供索引与续接使用。
 */

export const TRAE_CN_AGENT = "trae-cn";

function rootOf(env: Env): string {
  // 与 integrations/relay-events 的写入位置一致；这里从 home 拼，避免依赖 memrelayDir 的 env 变体
  const override = env.env["MEMRELAY_HOME"];
  const base = override ? path.resolve(override) : path.join(env.home, ".memrelay");
  return path.join(base, ...TRAE_EVENTS_SUBDIR.split("/"));
}

function rawRootsOf(env: Env): string[] {
  return traeAgentHooksRoots(env);
}

/** Agent 的 hook 在沙箱里把原始 payload 写到 hooks_env，这里按路径识别原始文件。 */
function isRawPath(file: string): boolean {
  return file
    .replace(/\\/g, "/")
    .toLowerCase()
    .includes("/modulardata/ai-agent/hooks_env/memrelay-events/");
}

function isoOf(ms: number): string | undefined {
  return ms > 0 ? new Date(ms).toISOString() : undefined;
}

interface ParsedEvents {
  records: Array<Record<string, unknown>>;
  cwd?: string;
  firstUserMessage?: string;
  startedAtMs: number;
  lastMs: number;
  hasMarker: boolean;
}

function parseEventsFile(file: string, raw = false): ParsedEvents | undefined {
  let text: string;
  try {
    text = decodeBuffer(fs.readFileSync(file));
  } catch {
    return undefined;
  }
  const records: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      if (raw) {
        records.push(...traePayloadRecords(value as Record<string, unknown>));
      } else {
        records.push(value as Record<string, unknown>);
      }
    } catch {
      /* 半截行跳过 */
    }
  }
  let cwd: string | undefined;
  let firstUserMessage: string | undefined;
  let minMs = 0;
  let maxMs = 0;
  for (const record of records) {
    const ms = Number(record["time"] ?? 0) || 0;
    if (ms > 0) {
      if (minMs === 0 || ms < minMs) minMs = ms;
      if (ms > maxMs) maxMs = ms;
    }
    if (!cwd && record["type"] === "session-meta" && typeof record["cwd"] === "string") {
      cwd = record["cwd"];
    }
    if (
      !firstUserMessage &&
      record["type"] === "message" &&
      record["role"] === "user" &&
      typeof record["text"] === "string"
    ) {
      firstUserMessage = record["text"].replace(/\s+/g, " ").trim().slice(0, 500);
    }
  }
  return {
    records,
    cwd,
    firstUserMessage,
    startedAtMs: minMs,
    lastMs: maxMs,
    hasMarker: text.includes("【MemRelay 续接】"),
  };
}

function messagesFrom(records: Array<Record<string, unknown>>): Message[] {
  const out: Message[] = [];
  let ordinal = 0;
  for (const record of records) {
    const type = record["type"];
    const createdAt = isoOf(Number(record["time"] ?? 0) || 0) ?? "";
    const parts: Part[] = [];
    let role: Message["role"] = "assistant";
    if (type === "message" && (record["role"] === "user" || record["role"] === "assistant")) {
      role = record["role"] as Message["role"];
      const text = typeof record["text"] === "string" ? record["text"] : "";
      if (text.trim()) parts.push({ kind: "text", text });
    } else if (type === "function_call") {
      let json: unknown = record["arguments"];
      if (typeof json === "string") {
        try {
          json = JSON.parse(json);
        } catch {
          /* 保持字符串 */
        }
      }
      parts.push({
        kind: "tool_call",
        toolName: typeof record["name"] === "string" ? record["name"] : undefined,
        toolCallId: typeof record["callId"] === "string" ? record["callId"] : undefined,
        json,
      });
    } else if (type === "function_call_result") {
      parts.push({
        kind: "tool_result",
        toolCallId: typeof record["callId"] === "string" ? record["callId"] : undefined,
        text: typeof record["response"] === "string" ? record["response"] : "",
        status: "ok",
      });
    }
    if (parts.length === 0) continue;
    ordinal++;
    out.push({
      sessionId: "",
      ordinal,
      role,
      createdAt,
      isSidechain: false,
      isCompactBoundary: false,
      parts,
    });
  }
  return out;
}

export function traeEventsAdapter(): SerializedJsonlAdapter {
  const version = 2;
  const agent = TRAE_CN_AGENT;

  function listFiles(env: Env): Array<{ file: string; raw: boolean }> {
    const roots: Array<{ root: string; raw: boolean }> = [
      { root: rootOf(env), raw: false },
      ...rawRootsOf(env).map((root) => ({ root, raw: true })),
    ];
    const out: Array<{ file: string; raw: boolean }> = [];
    for (const { root, raw } of roots) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          out.push({ file: path.join(root, entry.name), raw });
        }
      }
    }
    return out;
  }

  function scanOf(file: string, raw = false): SessionScan | undefined {
    const parsed = parseEventsFile(file, raw);
    if (!parsed || parsed.records.length === 0) return undefined;
    const sessionId = path.basename(file).replace(/\.jsonl$/, "");
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return undefined;
    }
    const title = parsed.firstUserMessage ? parsed.firstUserMessage.slice(0, 60) : undefined;
    const tailMessages = toLocalMessages(messagesFrom(parsed.records.slice(-80)));
    return {
      id: `${agent}:${sessionId}`,
      agent,
      sourcePath: file,
      cwd: parsed.cwd,
      gitBranch: undefined,
      startedAt: isoOf(parsed.startedAtMs),
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      tail: {
        statusInfo: analyzeStatus(tailMessages),
        hasActiveLeaf: false,
        lastTitle: title,
        lastTimestamp: isoOf(parsed.lastMs),
        memrelayCalledRecently: parsed.hasMarker,
      },
    };
  }

  function scanAllOf(env: Env): SessionScan[] {
    const scans: SessionScan[] = [];
    for (const { file, raw } of listFiles(env)) {
      const scan = scanOf(file, raw);
      if (scan) scans.push(scan);
    }
    return scans;
  }

  return {
    agent,
    version,

    async detect(env: Env): Promise<Detection> {
      const root = rootOf(env);
      let installed = false;
      for (const dir of [root, ...rawRootsOf(env)]) {
        try {
          if (fs.statSync(dir).isDirectory()) {
            installed = true;
            break;
          }
        } catch {
          /* 继续看下一个 */
        }
      }
      return { installed, sessionsRoot: root };
    },

    basePath(env: Env): string {
      return rootOf(env);
    },

    async listSessions(scope: ProjectScope, env: Env): Promise<SessionRef[]> {
      return scanAllOf(env)
        .filter((scan) => scan.cwd !== undefined && isPathInside(scan.cwd, scope.projectRoot, env.platform))
        .map(({ tail: _tail, ...ref }) => ref);
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
      return (await this.scanProject(scope, env)).map((scan) => scan.sourcePath);
    },

    async scanFile(filePath: string, env: Env): Promise<SessionScan | undefined> {
      void env;
      if (!filePath.endsWith(".jsonl")) return undefined;
      if (!fs.existsSync(filePath)) return undefined;
      return scanOf(filePath, isRawPath(filePath));
    },

    async *readSession(ref: SessionRef): AsyncIterable<NormalizedEvent> {
      const parsed = parseEventsFile(ref.sourcePath, isRawPath(ref.sourcePath));
      if (!parsed) return;
      const session: Session = {
        id: ref.id,
        agent,
        sourcePath: ref.sourcePath,
        cwd: parsed.cwd ?? "",
        projectRoot: "",
        title: parsed.firstUserMessage ? parsed.firstUserMessage.slice(0, 60) : undefined,
        firstUserMessage: parsed.firstUserMessage,
        startedAt: isoOf(parsed.startedAtMs) ?? "",
        endedAt: isoOf(parsed.lastMs) ?? "",
        status: "unknown",
        rawRecords: parsed.records.length,
      };
      yield { kind: "session", session };
      for (const message of messagesFrom(parsed.records)) {
        yield { kind: "message", message: { ...message, sessionId: ref.id } };
      }
    },
  };
}
