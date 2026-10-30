import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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
import { isPathInside } from "../jsonl-family/parser.js";
import { analyzeStatus, toLocalMessages, type StatusInfo } from "../jsonl-family/records.js";
import type { SessionScan, SerializedJsonlAdapter } from "../jsonl-family/jsonl-adapter.js";

/**
 * OpenCode 家族适配器（ZCode 与 OpenCode 同源，均为 drizzle + SQLite）：
 * - OpenCode：~/.local/share/opencode/opencode.db，session_v2 + session_message（内容在 data JSON 里）
 * - ZCode（智谱）：~/.zcode/cli/db/db.sqlite，session + message + part（内容在 part 表）
 * 会话"文件"是伪路径 <db>#<sessionId>，新鲜度用会话级的 time_updated / 消息数做代理。
 */

const FRAGMENT = "#";

export const OPENCODE_AGENT = "opencode";
export const ZCODE_AGENT = "zcode";

function isoOf(ms: number): string | undefined {
  return ms > 0 ? new Date(ms).toISOString() : undefined;
}

function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 2000");
  return db;
}

function exists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function opencodeDbFile(env: Env): string | undefined {
  const file = path.join(env.home, ".local", "share", "opencode", "opencode.db");
  return exists(file) ? file : undefined;
}

export function zcodeDbFile(env: Env): string | undefined {
  const file = path.join(env.home, ".zcode", "cli", "db", "db.sqlite");
  return exists(file) ? file : undefined;
}

/** 单会话伪路径（<db>#<sessionId>），供 hook 精准索引某一次会话。 */
export function familySessionFile(agent: string, env: Env, sessionId: string): string | undefined {
  const file = agent === ZCODE_AGENT ? zcodeDbFile(env) : agent === OPENCODE_AGENT ? opencodeDbFile(env) : undefined;
  return file ? `${file}${FRAGMENT}${sessionId}` : undefined;
}

interface SessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  timeCreated: number;
  timeUpdated: number;
  messageCount: number;
}

interface FamilySpec {
  agent: string;
  dbFile(env: Env): string | undefined;
  /** 列会话元数据（一次打开） */
  loadSessions(db: DatabaseSync): SessionRow[];
  /** 读一个会话的消息（已按顺序） */
  loadMessages(db: DatabaseSync, sessionId: string): Message[];
  /** 只读尾部若干条消息，用于扫描/提示阶段判断状态（缺省表示不支持） */
  loadTailMessages?(db: DatabaseSync, sessionId: string, limit: number): Message[];
}

function scanOf(agent: string, file: string, row: SessionRow, statusInfo?: StatusInfo): SessionScan {
  return {
    id: `${agent}:${row.id}`,
    agent,
    sourcePath: `${file}${FRAGMENT}${row.id}`,
    cwd: row.directory ?? undefined,
    gitBranch: undefined,
    startedAt: isoOf(row.timeCreated),
    mtimeMs: row.timeUpdated,
    sizeBytes: row.messageCount,
    tail: {
      statusInfo: statusInfo ?? {
        pendingToolCallIds: [],
        lastUserMessageUnanswered: false,
        quotaOrLimitDetected: false,
        errorDetected: false,
      },
      hasActiveLeaf: false,
      lastTitle: row.title ?? undefined,
      lastTimestamp: isoOf(row.timeUpdated),
      memrelayCalledRecently: false,
    },
  };
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function textPart(text: unknown): Part | undefined {
  return typeof text === "string" && text.trim() ? { kind: "text", text } : undefined;
}

/** 工具输出可能是字符串、{text}、或 OpenCode v2 的 content 块数组；统一取文本。 */
function toolOutputText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const texts: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        texts.push(item);
        continue;
      }
      if (item && typeof item === "object" && typeof (item as Record<string, unknown>)["text"] === "string") {
        texts.push((item as Record<string, unknown>)["text"] as string);
      }
    }
    return texts.length > 0 ? texts.join("\n") : JSON.stringify(value);
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return typeof record["text"] === "string" ? record["text"] : JSON.stringify(value);
  }
  return String(value);
}

/** OpenCode 的内容块数组（reasoning/text/tool…）→ parts（对未知块做防御性映射）。 */
function partsFromContentBlocks(blocks: unknown): Part[] {
  if (!Array.isArray(blocks)) return [];
  const parts: Part[] = [];
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    const type = String(block["type"] ?? "");
    if (type === "text") {
      const part = textPart(block["text"]);
      if (part) parts.push(part);
      continue;
    }
    if (type === "reasoning") {
      const part = textPart(block["text"]);
      if (part) parts.push({ kind: "reasoning", text: part.text });
      continue;
    }
    if (type.includes("step")) continue; // step-start / step-finish 之类的控制块
    if (type.includes("tool") || type.includes("file") || type.includes("patch")) {
      const state = (block["state"] ?? {}) as Record<string, unknown>;
      const callId =
        typeof block["callID"] === "string"
          ? (block["callID"] as string)
          : typeof block["id"] === "string"
            ? (block["id"] as string)
            : undefined;
      const name =
        typeof block["tool"] === "string"
          ? (block["tool"] as string)
          : typeof block["name"] === "string"
            ? (block["name"] as string)
            : type;
      const input = state["input"] ?? block["input"] ?? undefined;
      parts.push({ kind: "tool_call", toolName: name, toolCallId: callId, json: input });
      const output = state["output"] ?? block["output"] ?? state["content"] ?? block["content"] ?? undefined;
      const status = state["status"] === "error" || block["status"] === "error" ? "error" : "ok";
      const outputText = toolOutputText(output);
      if (outputText !== undefined) {
        parts.push({
          kind: "tool_result",
          toolCallId: callId,
          text: outputText,
          status,
        });
      }
      continue;
    }
    const text = textPart(block["text"]);
    if (text) parts.push(text);
  }
  return parts;
}

function makeMessages(agent: string, sessionId: string, items: Array<{ role: string; createdAt: number; parts: Part[] }>): Message[] {
  const out: Message[] = [];
  let ordinal = 0;
  for (const item of items) {
    if (item.parts.length === 0) continue;
    ordinal++;
    out.push({
      sessionId: `${agent}:${sessionId}`,
      ordinal,
      role: item.role === "user" ? "user" : item.role === "assistant" ? "assistant" : "system",
      createdAt: isoOf(item.createdAt) ?? "",
      isSidechain: false,
      isCompactBoundary: false,
      parts: item.parts,
    });
  }
  return out;
}

// —— OpenCode：内容在 session_message.data 的 content 数组里 ——

function opencodeItemsFromRows(
  rows: Array<Record<string, unknown>>,
): Array<{ role: string; createdAt: number; parts: Part[] }> {
  const items: Array<{ role: string; createdAt: number; parts: Part[] }> = [];
  for (const row of rows) {
    const type = String(row["type"]);
    const data = parseJson(row["data"]);
    const parts: Part[] = [];
    if (type === "user") {
      const part = textPart(data["text"]);
      if (part) parts.push(part);
    } else {
      parts.push(...partsFromContentBlocks(data["content"]));
    }
    if (parts.length === 0) continue;
    items.push({
      role: type,
      createdAt: Number((data["time"] as Record<string, unknown> | undefined)?.["created"] ?? row["time_created"]) || 0,
      parts,
    });
  }
  return items;
}

const opencodeSpec: FamilySpec = {
  agent: OPENCODE_AGENT,
  dbFile: opencodeDbFile,
  loadSessions(db) {
    const rows = db
      .prepare(
        `SELECT s.id, s.directory, s.title, s.time_created, s.time_updated,
                (SELECT COUNT(*) FROM session_message m WHERE m.session_id = s.id) AS msg_count
         FROM session_v2 s`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r["id"]),
      directory: typeof r["directory"] === "string" ? r["directory"] : null,
      title: typeof r["title"] === "string" ? r["title"] : null,
      timeCreated: Number(r["time_created"] ?? 0) || 0,
      timeUpdated: Number(r["time_updated"] ?? 0) || 0,
      messageCount: Number(r["msg_count"] ?? 0) || 0,
    }));
  },
  loadMessages(db, sessionId) {
    const rows = db
      .prepare(
        `SELECT type, time_created, data FROM session_message
         WHERE session_id = ? AND type IN ('user', 'assistant')
         ORDER BY seq`,
      )
      .all(sessionId) as Array<Record<string, unknown>>;
    return makeMessages(OPENCODE_AGENT, sessionId, opencodeItemsFromRows(rows));
  },
  loadTailMessages(db, sessionId, limit) {
    const rows = db
      .prepare(
        `SELECT type, time_created, data FROM session_message
         WHERE session_id = ? AND type IN ('user', 'assistant')
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(sessionId, limit) as Array<Record<string, unknown>>;
    return makeMessages(OPENCODE_AGENT, sessionId, opencodeItemsFromRows(rows.reverse()));
  },
};

// —— ZCode：内容在 part 表（每条消息多个 part），跳出 model-only 的系统注入 ——

function zcodeItemsFromMessages(
  db: DatabaseSync,
  messages: Array<Record<string, unknown>>,
): Array<{ role: string; createdAt: number; parts: Part[] }> {
  const partStmt = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY sequence");
  const items: Array<{ role: string; createdAt: number; parts: Part[] }> = [];
  for (const message of messages) {
    const data = parseJson(message["data"]);
    const role = String(data["role"] ?? "");
    if (role !== "user" && role !== "assistant") continue;
    const metadata = (data["metadata"] ?? {}) as Record<string, unknown>;
    if (metadata["visibility"] === "model-only") continue; // 给模型看的系统注入，不算用户消息
    const parts: Part[] = [];
    for (const row of partStmt.all(String(message["id"])) as Array<Record<string, unknown>>) {
      const partData = parseJson(row["data"]);
      const type = String(partData["type"] ?? "");
      if (type === "text") {
        const part = textPart(partData["text"]);
        if (part) parts.push(part);
        continue;
      }
      if (type === "reasoning") {
        const part = textPart(partData["text"]);
        if (part) parts.push({ kind: "reasoning", text: part.text });
        continue;
      }
      if (type.includes("step")) continue;
      if (type.includes("tool")) {
        const state = (partData["state"] ?? {}) as Record<string, unknown>;
        const name =
          typeof partData["tool"] === "string"
            ? (partData["tool"] as string)
            : typeof partData["name"] === "string"
              ? (partData["name"] as string)
              : type;
        const callId = typeof partData["callID"] === "string" ? (partData["callID"] as string) : undefined;
        const input = state["input"] ?? partData["input"] ?? undefined;
        parts.push({ kind: "tool_call", toolName: name, toolCallId: callId, json: input });
        const output = state["output"] ?? partData["output"] ?? undefined;
        if (output !== undefined) {
          parts.push({
            kind: "tool_result",
            toolCallId: callId,
            text: typeof output === "string" ? output : JSON.stringify(output),
            status: state["status"] === "error" ? "error" : "ok",
          });
        }
        continue;
      }
      const part = textPart(partData["text"]);
      if (part) parts.push(part);
    }
    if (parts.length === 0) continue;
    items.push({
      role,
      createdAt: Number(message["time_created"] ?? 0) || 0,
      parts,
    });
  }
  return items;
}

const zcodeSpec: FamilySpec = {
  agent: ZCODE_AGENT,
  dbFile: zcodeDbFile,
  loadSessions(db) {
    const rows = db
      .prepare(
        `SELECT s.id, s.directory, s.title, s.time_created, s.time_updated,
                (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS msg_count
         FROM session s`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r["id"]),
      directory: typeof r["directory"] === "string" ? r["directory"] : null,
      title: typeof r["title"] === "string" ? r["title"] : null,
      timeCreated: Number(r["time_created"] ?? 0) || 0,
      timeUpdated: Number(r["time_updated"] ?? 0) || 0,
      messageCount: Number(r["msg_count"] ?? 0) || 0,
    }));
  },
  loadMessages(db, sessionId) {
    const messages = db
      .prepare("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY sequence")
      .all(sessionId) as Array<Record<string, unknown>>;
    return makeMessages(ZCODE_AGENT, sessionId, zcodeItemsFromMessages(db, messages));
  },
  loadTailMessages(db, sessionId, limit) {
    const messages = db
      .prepare(
        "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY sequence DESC LIMIT ?",
      )
      .all(sessionId, limit) as Array<Record<string, unknown>>;
    return makeMessages(ZCODE_AGENT, sessionId, zcodeItemsFromMessages(db, messages.reverse()));
  },
};

function createFamilyAdapter(spec: FamilySpec): SerializedJsonlAdapter {
  // v2：解析 OpenCode 工具输出的 state.content（v2 起输出放在 content 块数组里）
  const version = 2;
  const agent = spec.agent;

  function statusOf(db: DatabaseSync, sessionId: string): StatusInfo {
    const tail = spec.loadTailMessages?.(db, sessionId, 40) ?? [];
    return analyzeStatus(toLocalMessages(tail));
  }

  function withDb<T>(env: Env, fn: (db: DatabaseSync, file: string) => T): T | undefined {
    const file = spec.dbFile(env);
    if (!file) return undefined;
    let db: DatabaseSync;
    try {
      db = openDb(file);
    } catch {
      return undefined;
    }
    try {
      return fn(db, file);
    } catch {
      return undefined;
    } finally {
      db.close();
    }
  }

  function scanAllOf(env: Env): SessionScan[] {
    return (
      withDb(env, (db, file) =>
        spec.loadSessions(db).map((row) => scanOf(agent, file, row, statusOf(db, row.id))),
      ) ?? []
    );
  }

  function scanProjectOf(scope: ProjectScope, env: Env): SessionScan[] {
    return scanAllOf(env).filter(
      (scan) => scan.cwd !== undefined && isPathInside(scan.cwd, scope.projectRoot, env.platform),
    );
  }

  return {
    agent,
    version,

    async detect(env: Env): Promise<Detection> {
      const file = spec.dbFile(env);
      return { installed: file !== undefined, sessionsRoot: file ? path.dirname(file) : undefined };
    },

    basePath(env: Env): string {
      return spec.dbFile(env) ? path.dirname(spec.dbFile(env)!) : path.join(env.home, ".opencode");
    },

    async listSessions(scope: ProjectScope, env: Env): Promise<SessionRef[]> {
      return scanProjectOf(scope, env).map(({ tail: _tail, ...ref }) => ref);
    },

    async scanAll(env: Env): Promise<SessionScan[]> {
      return scanAllOf(env);
    },

    async scanProject(scope: ProjectScope, env: Env): Promise<SessionScan[]> {
      return scanProjectOf(scope, env);
    },

    async listProjectFiles(scope: ProjectScope, env: Env): Promise<string[]> {
      return scanProjectOf(scope, env).map((scan) => scan.sourcePath);
    },

    async scanFile(filePath: string, env: Env): Promise<SessionScan | undefined> {
      const sep = filePath.lastIndexOf(FRAGMENT);
      if (sep <= 0) return undefined;
      const id = filePath.slice(sep + 1);
      return withDb(env, (db, file) => {
        const row = spec.loadSessions(db).find((item) => item.id === id);
        return row ? scanOf(agent, file, row, statusOf(db, row.id)) : undefined;
      });
    },

    async *readSession(ref: SessionRef): AsyncIterable<NormalizedEvent> {
      const sessionId = ref.id.slice(ref.id.indexOf(":") + 1);
      // readSession 拿不到 env：从 ref.sourcePath 反推数据库文件
      const sep = ref.sourcePath.lastIndexOf(FRAGMENT);
      const file = sep > 0 ? ref.sourcePath.slice(0, sep) : ref.sourcePath;
      if (!exists(file)) return;
      let db: DatabaseSync;
      try {
        db = openDb(file);
      } catch {
        return;
      }
      try {
        const row = spec.loadSessions(db).find((item) => item.id === sessionId);
        if (!row) return;
        const messages = spec.loadMessages(db, sessionId);
        const session: Session = {
          id: ref.id,
          agent,
          sourcePath: ref.sourcePath,
          cwd: row.directory ?? "",
          projectRoot: "",
          title: row.title ?? undefined,
          firstUserMessage: messages.find((m) => m.role === "user")?.parts.find((p) => p.kind === "text")?.text,
          startedAt: isoOf(row.timeCreated) ?? "",
          endedAt: isoOf(row.timeUpdated) ?? "",
          status: "unknown",
          rawRecords: row.messageCount,
        };
        yield { kind: "session", session };
        for (const message of messages) {
          yield { kind: "message", message };
        }
      } finally {
        db.close();
      }
    },
  };
}

export function opencodeAdapter(): SerializedJsonlAdapter {
  return createFamilyAdapter(opencodeSpec);
}

export function zcodeAdapter(): SerializedJsonlAdapter {
  return createFamilyAdapter(zcodeSpec);
}
