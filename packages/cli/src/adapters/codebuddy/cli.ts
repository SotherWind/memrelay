import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { categorizeTool, extractFilePaths, isPlanTool } from "../../core/tool-names.js";
import { decodeBuffer } from "../../core/text-encoding.js";
import type {
  AgentId,
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
  stripSystemReminders,
  type LocalMessage,
  type LocalToolCall,
  type LocalToolResult,
} from "../jsonl-family/records.js";
import { isPathInside, toNormalizedMessages } from "../jsonl-family/parser.js";
import type { SessionScan, SerializedJsonlAdapter } from "../jsonl-family/jsonl-adapter.js";

/**
 * CodeBuddy 系（CodeBuddy CLI / WorkBuddy 桌面端）JSONL 适配器工厂：
 * 会话在 `<home>/projects/<项目 slug>/<sessionId>.jsonl`，逐行 JSON。
 * 记录类型：message(user/assistant)、reasoning、function_call、function_call_result、
 * ai-title / topic、session-meta、file-history-snapshot（后两类忽略）。
 * WorkBuddy 另有 `<home>/workbuddy.db` 的 sessions 表可核对 cwd/标题/时间。
 */

export interface CodebuddyCliOptions {
  agent: AgentId;
  /** home 下的配置目录名，如 .codebuddy / .workbuddy */
  homeDir: string;
  /** 会话根目录；缺省为 <home>/<homeDir>/projects */
  rootOf?: (env: Env) => string;
  /** 元数据库文件名（WorkBuddy 有，CodeBuddy CLI 没有） */
  dbFile?: string;
  version?: number;
}

const FRAGMENT = ".file-rollback.ndjson";

export function createCodebuddyCliAdapter(opts: CodebuddyCliOptions): SerializedJsonlAdapter {
  const version = opts.version ?? 1;

  function rootOf(env: Env): string {
    return opts.rootOf ? opts.rootOf(env) : path.join(env.home, opts.homeDir, "projects");
  }

  function dbFile(env: Env): string | undefined {
    if (!opts.dbFile) return undefined;
    const file = path.join(env.home, opts.homeDir, opts.dbFile);
    try {
      return fs.statSync(file).isFile() ? file : undefined;
    } catch {
      return undefined;
    }
  }

  /** readSession 拿不到 env：从会话文件路径反推配置目录找 db。 */
  function dbFileFromSourcePath(sourcePath: string): string | undefined {
    if (!opts.dbFile) return undefined;
    let current = path.dirname(sourcePath);
    for (let hops = 0; hops < 6; hops++) {
      if (path.basename(current) === opts.homeDir) {
        const file = path.join(current, opts.dbFile);
        try {
          return fs.statSync(file).isFile() ? file : undefined;
        } catch {
          return undefined;
        }
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return undefined;
  }

  function isoOf(ms: number): string | undefined {
    return ms > 0 ? new Date(ms).toISOString() : undefined;
  }

  interface DbMeta {
    cwd: string | null;
    title: string | null;
    customTitle: string | null;
    createdAt: number;
    updatedAt: number;
  }

  function readDbMeta(file: string | undefined): Map<string, DbMeta> {
    const out = new Map<string, DbMeta>();
    if (!file) return out;
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 2000");
    } catch {
      return out;
    }
    try {
      const rows = db
        .prepare("SELECT id, cwd, title, custom_title, created_at, updated_at FROM sessions")
        .all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        out.set(String(row["id"]), {
          cwd: typeof row["cwd"] === "string" ? row["cwd"] : null,
          title: typeof row["title"] === "string" ? row["title"] : null,
          customTitle: typeof row["custom_title"] === "string" ? row["custom_title"] : null,
          createdAt: Number(row["created_at"] ?? 0) || 0,
          updatedAt: Number(row["updated_at"] ?? 0) || 0,
        });
      }
    } catch {
      /* 表缺失按没有处理 */
    } finally {
      db.close();
    }
    return out;
  }

  interface ParsedFile {
    records: Array<Record<string, unknown>>;
    cwd?: string;
    title?: string;
    firstUserMessage?: string;
    startedAtMs: number;
    lastTimestampMs: number;
    hasMarker: boolean;
  }

  function parseFile(file: string): ParsedFile | undefined {
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
        if (value && typeof value === "object" && !Array.isArray(value)) {
          records.push(value as Record<string, unknown>);
        }
      } catch {
        /* 半截行（被中断时正在写）跳过 */
      }
    }
    let cwd: string | undefined;
    let title: string | undefined;
    let firstUserMessage: string | undefined;
    let minTs = 0;
    let maxTs = 0;
    for (const record of records) {
      const ts = Number(record["timestamp"] ?? 0) || 0;
      if (ts > 0) {
        if (minTs === 0 || ts < minTs) minTs = ts;
        if (ts > maxTs) maxTs = ts;
      }
      if (!cwd && typeof record["cwd"] === "string" && record["cwd"]) cwd = record["cwd"];
      if (record["type"] === "ai-title") {
        const aiTitle = record["aiTitle"];
        const topic = record["topic"];
        if (typeof aiTitle === "string" && aiTitle.trim()) title = aiTitle;
        else if (typeof topic === "string" && topic.trim()) title = topic;
        if (!cwd && typeof record["cwd"] === "string") cwd = record["cwd"];
      }
      if (!firstUserMessage && record["type"] === "message" && record["role"] === "user") {
        const text2 = collectText(record["content"]);
        if (text2) {
          const stripped = stripSystemReminders(text2);
          firstUserMessage = (stripped || text2).replace(/\s+/g, " ").slice(0, 500);
        }
      }
    }
    return {
      records,
      cwd,
      title,
      firstUserMessage,
      startedAtMs: minTs,
      lastTimestampMs: maxTs,
      hasMarker: text.includes("【MemRelay 续接】"),
    };
  }

  function collectText(content: unknown): string | undefined {
    if (typeof content === "string") {
      const trimmed = content.trim();
      return trimmed || undefined;
    }
    if (!Array.isArray(content)) return undefined;
    const texts = (content as Array<Record<string, unknown>>)
      .filter((block) => typeof block["text"] === "string")
      .map((block) => block["text"] as string);
    const joined = texts.join("\n").trim();
    return joined || undefined;
  }

  function reasoningText(record: Record<string, unknown>): string | undefined {
    const content = collectText(record["content"]);
    if (content) return content;
    const raw = record["rawContent"];
    if (typeof raw === "string" && raw.trim()) return raw;
    if (raw && typeof raw === "object") {
      const rec = raw as Record<string, unknown>;
      if (typeof rec["reasoning"] === "string" && rec["reasoning"].trim()) return rec["reasoning"];
      if (typeof rec["text"] === "string" && rec["text"].trim()) return rec["text"];
    }
    const provider = record["providerData"];
    if (provider && typeof provider === "object") {
      const reasoning = (provider as Record<string, unknown>)["reasoning"];
      if (typeof reasoning === "string" && reasoning.trim()) return reasoning;
    }
    return undefined;
  }

  function timestampOf(record: Record<string, unknown>): string | undefined {
    return isoOf(Number(record["timestamp"] ?? 0) || 0);
  }

  function messagesFrom(records: Array<Record<string, unknown>>): LocalMessage[] {
    const messages: LocalMessage[] = [];
    let ordinal = 0;
    const push = (
      role: MessageRole,
      parts: Part[],
      record: Record<string, unknown>,
      calls: LocalToolCall[] = [],
      results: LocalToolResult[] = [],
    ): void => {
      if (parts.length === 0) return;
      ordinal++;
      const text = parts
        .filter((part) => part.kind === "text" && part.text)
        .map((part) => part.text!)
        .join("\n");
      messages.push({
        uuid: typeof record["id"] === "string" ? record["id"] : `ord-${ordinal}`,
        parentUuid: typeof record["parentId"] === "string" ? record["parentId"] : undefined,
        role,
        timestamp: timestampOf(record),
        isSidechain: false,
        isCompactBoundary: false,
        parts,
        toolCalls: calls,
        toolResults: results,
        isUserPrompt: role === "user" && Boolean(stripSystemReminders(text)),
      });
    };

    for (const record of records) {
      const type = record["type"];
      if (type === "message") {
        const rawRole = record["role"];
        const role: MessageRole =
          rawRole === "user" ? "user" : rawRole === "assistant" ? "assistant" : "system";
        const text = collectText(record["content"]);
        push(role, text ? [{ kind: "text", text }] : [], record);
        continue;
      }
      if (type === "reasoning") {
        const text = reasoningText(record);
        push("assistant", text ? [{ kind: "reasoning", text }] : [], record);
        continue;
      }
      if (type === "function_call") {
        const name = typeof record["name"] === "string" ? record["name"] : undefined;
        const callId = typeof record["callId"] === "string" ? record["callId"] : undefined;
        let json: unknown = record["arguments"];
        if (typeof json === "string") {
          try {
            json = JSON.parse(json);
          } catch {
            /* 保持原始字符串 */
          }
        }
        push("assistant", [{ kind: "tool_call", toolName: name, toolCallId: callId, json }], record, [
          {
            toolCallId: callId ?? "",
            toolName: name,
            category: categorizeTool(name),
            input: json,
            isPlan: isPlanTool(name),
            files: extractFilePaths(json),
          },
        ]);
        continue;
      }
      if (type === "function_call_result") {
        const callId = typeof record["callId"] === "string" ? record["callId"] : undefined;
        const status = record["status"] === "completed" ? "ok" : "error";
        const output = record["output"];
        let text: string | undefined;
        if (output && typeof output === "object") {
          const rec = output as Record<string, unknown>;
          text = typeof rec["text"] === "string" ? rec["text"] : JSON.stringify(output);
        } else if (typeof output === "string") {
          text = output;
        }
        push(
          "user",
          [{ kind: "tool_result", toolCallId: callId, text: text ?? "", status }],
          record,
          [],
          [{ toolCallId: callId, content: text ?? "", isError: status === "error" }],
        );
        continue;
      }
    }
    return messages;
  }

  function scanOf(file: string, dbMeta: Map<string, DbMeta>): SessionScan | undefined {
    const parsed = parseFile(file);
    if (!parsed || parsed.records.length === 0) return undefined;
    const sessionId = path.basename(file).replace(/\.jsonl$/, "");
    const meta = dbMeta.get(sessionId);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return undefined;
    }
    const cwd = parsed.cwd ?? meta?.cwd ?? undefined;
    const startedAt = meta?.createdAt && meta.createdAt > 0 ? meta.createdAt : parsed.startedAtMs;
    const title = meta?.customTitle?.trim() || meta?.title?.trim() || parsed.title;
    const statusInfo = analyzeStatus(messagesFrom(parsed.records));
    return {
      id: `${opts.agent}:${sessionId}`,
      agent: opts.agent,
      sourcePath: file,
      cwd,
      gitBranch: undefined,
      startedAt: isoOf(startedAt),
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      tail: {
        statusInfo,
        hasActiveLeaf: false,
        lastTitle: title,
        lastTimestamp: isoOf(parsed.lastTimestampMs),
        memrelayCalledRecently: parsed.hasMarker,
      },
    };
  }

  function listSessionFiles(env: Env): string[] {
    const root = rootOf(env);
    const out: string[] = [];
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      let files: string[];
      try {
        files = fs.readdirSync(path.join(root, dir.name));
      } catch {
        continue;
      }
      for (const name of files) {
        if (!name.endsWith(".jsonl") || name.endsWith(FRAGMENT)) continue;
        out.push(path.join(root, dir.name, name));
      }
    }
    return out;
  }

  async function scanAllOf(env: Env): Promise<SessionScan[]> {
    const dbMeta = readDbMeta(dbFile(env));
    const scans: SessionScan[] = [];
    for (const file of listSessionFiles(env)) {
      const scan = scanOf(file, dbMeta);
      if (scan) scans.push(scan);
    }
    return scans;
  }

  async function scanProjectOf(scope: ProjectScope, env: Env): Promise<SessionScan[]> {
    const all = await scanAllOf(env);
    return all.filter(
      (scan) => scan.cwd !== undefined && isPathInside(scan.cwd, scope.projectRoot, env.platform),
    );
  }

  return {
    agent: opts.agent,
    version,

    async detect(env: Env): Promise<Detection> {
      const root = rootOf(env);
      try {
        return { installed: fs.statSync(root).isDirectory(), sessionsRoot: root };
      } catch {
        return { installed: false };
      }
    },

    basePath(env: Env): string {
      return rootOf(env);
    },

    async listSessions(scope: ProjectScope, env: Env): Promise<SessionRef[]> {
      const scans = await scanProjectOf(scope, env);
      return scans.map(({ tail: _tail, ...ref }) => ref);
    },

    scanAll: scanAllOf,

    scanProject: scanProjectOf,

    async listProjectFiles(scope: ProjectScope, env: Env): Promise<string[]> {
      const scans = await scanProjectOf(scope, env);
      return scans.map((scan) => scan.sourcePath);
    },

    async scanFile(filePath: string, env: Env): Promise<SessionScan | undefined> {
      if (!filePath.endsWith(".jsonl") || filePath.endsWith(FRAGMENT)) return undefined;
      if (!fs.existsSync(filePath)) return undefined;
      return scanOf(filePath, readDbMeta(dbFile(env)));
    },

    async *readSession(ref: SessionRef): AsyncIterable<NormalizedEvent> {
      const parsed = parseFile(ref.sourcePath);
      if (!parsed) return;
      const sessionId = path.basename(ref.sourcePath).replace(/\.jsonl$/, "");
      const meta = readDbMeta(dbFileFromSourcePath(ref.sourcePath)).get(sessionId);
      const title = meta?.customTitle?.trim() || meta?.title?.trim() || parsed.title;
      const session: Session = {
        id: ref.id,
        agent: opts.agent,
        sourcePath: ref.sourcePath,
        cwd: parsed.cwd ?? meta?.cwd ?? ref.cwd ?? "",
        projectRoot: "",
        title,
        firstUserMessage: parsed.firstUserMessage,
        startedAt: isoOf(meta?.createdAt && meta.createdAt > 0 ? meta.createdAt : parsed.startedAtMs) ?? "",
        endedAt: isoOf(Math.max(meta?.updatedAt ?? 0, parsed.lastTimestampMs)) ?? "",
        status: "unknown",
        rawRecords: parsed.records.length,
      };
      yield { kind: "session", session };
      for (const event of toNormalizedMessages({ sessionId: ref.id }, messagesFrom(parsed.records))) {
        yield event;
      }
    },
  };
}
