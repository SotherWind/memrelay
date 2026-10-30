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
 * Cursor 适配器：会话存在 VS Code 式状态库 globalStorage/state.vscdb 的 cursorDiskKV 表里
 * （明文）：composerData:<id> 是会话元数据，bubbleId:<composerId>:<bubbleId> 是每条消息。
 * 会话"文件"是伪路径 <state.vscdb>#<composerId>，让 sources 表按会话记新鲜度。
 */

const FRAGMENT_SEP = "#";
export const CURSOR_AGENT = "cursor";

function globalStorageDir(env: Env): string | undefined {
  const candidates: string[] = [];
  if (env.platform === "win32") {
    const appData = env.env["APPDATA"] ?? path.join(env.home, "AppData", "Roaming");
    candidates.push(path.join(appData, "Cursor", "User", "globalStorage"));
  } else if (env.platform === "darwin") {
    candidates.push(
      path.join(env.home, "Library", "Application Support", "Cursor", "User", "globalStorage"),
    );
  } else {
    const xdg = env.env["XDG_CONFIG_HOME"] ?? path.join(env.home, ".config");
    candidates.push(path.join(xdg, "Cursor", "User", "globalStorage"));
  }
  return candidates[0];
}

export function cursorStorageFile(env: Env): string | undefined {
  const dir = globalStorageDir(env);
  if (!dir) return undefined;
  const file = path.join(dir, "state.vscdb");
  try {
    return fs.statSync(file).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

interface ComposerMeta {
  id: string;
  name: string | undefined;
  createdAt: number;
  lastUpdatedAt: number;
  cwd: string | undefined;
  gitBranch: string | undefined;
  headerCount: number;
  /** 消息 bubble id 尾部（最多 40 个），用于扫描阶段判断状态 */
  bubbleIds: string[];
  /** 元数据串长度，作为会话级 size 代理（会话增长时会变，供增量索引比较） */
  metaSize: number;
}

/** file:///d%3A/webProject/... → 绝对路径（跨平台）。 */
function fileUriToPath(uri: string): string | undefined {
  if (!uri.startsWith("file://")) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri.slice("file://".length));
  } catch {
    return undefined;
  }
  if (process.platform === "win32") return decoded.replace(/^\/+/, "");
  return decoded.startsWith("/") ? decoded : `/${decoded.replace(/^\/+/, "")}`;
}

// 第一轮优先找"工作区根"类标记（git / monorepo 工作区），避免停在子包的 package.json 上
const ROOT_MARKERS_PRIMARY = [".git", ".hg", "pnpm-workspace.yaml", "pnpm-workspace.yml", ".code-workspace", ".sln"];
const ROOT_MARKERS_FALLBACK = ["package.json", "go.mod", "Cargo.toml"];
const rootCache = new Map<string, string>();

/** 从一组文件的公共目录向上找项目根标记（先工作区类，再包级），找不到就用公共目录本身。 */
function climbToProjectRoot(paths: string[]): string | undefined {
  const normalized = paths
    .map((p) => fileUriToPath(p) ?? p)
    .filter((p) => p.length > 0)
    .map((p) => p.replace(/\\/g, "/"));
  if (normalized.length === 0) return undefined;
  let prefix = normalized[0]!;
  for (const p of normalized.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < p.length && prefix[i]!.toLowerCase() === p[i]!.toLowerCase()) i++;
    prefix = prefix.slice(0, i);
  }
  const cut = prefix.lastIndexOf("/");
  if (cut <= 2) return undefined;
  const start = prefix.slice(0, cut);
  const cached = rootCache.get(start);
  if (cached !== undefined) return cached;
  const climbFinding = (markers: string[]): string | undefined => {
    let current = path.resolve(start);
    for (let hops = 0; hops < 8; hops++) {
      if (markers.some((marker) => fs.existsSync(path.join(current, marker)))) return current;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return undefined;
  };
  const found = climbFinding(ROOT_MARKERS_PRIMARY) ?? climbFinding(ROOT_MARKERS_FALLBACK) ?? path.resolve(start);
  rootCache.set(start, found);
  return found;
}

function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 2000");
  return db;
}

function parseComposer(id: string, rawValue: unknown): ComposerMeta | undefined {
  try {
    const raw = typeof rawValue === "string" ? rawValue : Buffer.from(rawValue as Uint8Array).toString("utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const headers = Array.isArray(data["fullConversationHeadersOnly"])
      ? (data["fullConversationHeadersOnly"] as unknown[])
      : [];
    if (headers.length === 0) return undefined; // 空壳（草稿 / 未开始）不当作会话
    const repos = Array.isArray(data["trackedGitRepos"])
      ? (data["trackedGitRepos"] as Array<Record<string, unknown>>)
      : [];
    const repo = repos[0];
    const repoPath = repo && typeof repo["repoPath"] === "string" ? repo["repoPath"] : undefined;
    let branch: string | undefined;
    if (repo && Array.isArray(repo["branches"])) {
      const branches = repo["branches"] as Array<Record<string, unknown>>;
      const best = branches.reduce<Record<string, unknown> | undefined>((acc, cur) => {
        if (!acc) return cur;
        return Number(cur["lastInteractionAt"] ?? 0) > Number(acc["lastInteractionAt"] ?? 0) ? cur : acc;
      }, undefined);
      if (best && typeof best["branchName"] === "string") branch = best["branchName"];
    }
    // 没有 repoPath 的会话（普通文件夹对话）：用对话里出现过的文件路径反推项目目录
    let cwd = repoPath;
    if (!cwd && data["originalFileStates"] && typeof data["originalFileStates"] === "object") {
      const uris = Object.keys(data["originalFileStates"] as Record<string, unknown>);
      cwd = climbToProjectRoot(uris);
    }
    return {
      id,
      name: typeof data["name"] === "string" && data["name"].trim() ? (data["name"] as string) : undefined,
      createdAt: Number(data["createdAt"] ?? 0) || 0,
      lastUpdatedAt: Number(data["lastUpdatedAt"] ?? 0) || 0,
      cwd,
      gitBranch: branch,
      headerCount: headers.length,
      bubbleIds: headers
        .slice(-40)
        .map((header) => String((header as Record<string, unknown>)["bubbleId"] ?? ""))
        .filter(Boolean),
      metaSize: raw.length,
    };
  } catch {
    return undefined;
  }
}

/** 读取库里所有非空会话的元数据（一次打开、批量解析）。 */
function readComposers(env: Env): { file: string; composers: ComposerMeta[] } | undefined {
  const file = cursorStorageFile(env);
  if (!file) return undefined;
  let db: DatabaseSync;
  try {
    db = openDb(file);
  } catch {
    return undefined;
  }
  try {
    const rows = db
      .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
      .all() as Array<{ key: string; value: unknown }>;
    const composers: ComposerMeta[] = [];
    for (const row of rows) {
      const id = row.key.slice("composerData:".length);
      const meta = parseComposer(id, row.value);
      if (meta) composers.push(meta);
    }
    return { file, composers };
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

function isoOf(ms: number): string | undefined {
  return ms > 0 ? new Date(ms).toISOString() : undefined;
}

function scanOf(file: string, meta: ComposerMeta, statusInfo?: StatusInfo): SessionScan {
  return {
    id: `${CURSOR_AGENT}:${meta.id}`,
    agent: CURSOR_AGENT,
    sourcePath: `${file}${FRAGMENT_SEP}${meta.id}`,
    cwd: meta.cwd,
    gitBranch: meta.gitBranch,
    startedAt: isoOf(meta.createdAt),
    mtimeMs: meta.lastUpdatedAt,
    sizeBytes: meta.metaSize,
    tail: {
      statusInfo: statusInfo ?? {
        pendingToolCallIds: [],
        lastUserMessageUnanswered: false,
        quotaOrLimitDetected: false,
        errorDetected: false,
      },
      hasActiveLeaf: false,
      lastTitle: meta.name,
      lastTimestamp: isoOf(meta.lastUpdatedAt),
      memrelayCalledRecently: false,
    },
  };
}

/** 扫描阶段只读最后 40 个 bubble，足够判断是否中断/等待。 */
function statusFromComposer(db: DatabaseSync, meta: ComposerMeta): StatusInfo {
  const tailIds = meta.bubbleIds;
  if (tailIds.length === 0) {
    return {
      pendingToolCallIds: [],
      lastUserMessageUnanswered: false,
      quotaOrLimitDetected: false,
      errorDetected: false,
    };
  }
  const bubbleStmt = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
  const messages: Message[] = [];
  const offset = Math.max(0, meta.headerCount - tailIds.length);
  tailIds.forEach((bubbleId, index) => {
    const row = bubbleStmt.get(`bubbleId:${meta.id}:${bubbleId}`) as { value?: unknown } | undefined;
    if (!row || row.value === undefined) return;
    const message = messageFromBubble(`${CURSOR_AGENT}:${meta.id}`, offset + index + 1, bubbleId, row.value);
    if (message) messages.push(message);
  });
  return analyzeStatus(toLocalMessages(messages));
}

function messageFromBubble(
  sessionId: string,
  ordinal: number,
  bubbleKey: string,
  rawValue: unknown,
): Message | undefined {
  let data: Record<string, unknown>;
  try {
    const raw = typeof rawValue === "string" ? rawValue : Buffer.from(rawValue as Uint8Array).toString("utf8");
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const type = Number(data["type"] ?? 0);
  const role: Message["role"] = type === 1 ? "user" : type === 2 ? "assistant" : "system";
  const parts: Part[] = [];

  const text = typeof data["text"] === "string" ? data["text"] : "";
  if (text.trim()) parts.push({ kind: "text", text });

  if (Array.isArray(data["allThinkingBlocks"])) {
    for (const block of data["allThinkingBlocks"] as Array<Record<string, unknown>>) {
      const thinking = typeof block["text"] === "string" ? block["text"] : "";
      if (thinking.trim()) parts.push({ kind: "reasoning", text: thinking });
    }
  }

  const tool = data["toolFormerData"];
  if (tool && typeof tool === "object" && !Array.isArray(tool)) {
    const t = tool as Record<string, unknown>;
    const toolName = typeof t["name"] === "string" ? t["name"] : undefined;
    const toolCallId = typeof t["toolCallId"] === "string" ? t["toolCallId"] : undefined;
    const status = t["status"] === "completed" ? "ok" : t["status"] === "error" ? "error" : undefined;
    let json: unknown = t["rawArgs"];
    if (typeof json === "string") {
      try {
        json = JSON.parse(json);
      } catch {
        /* 保持原始字符串 */
      }
    }
    parts.push({ kind: "tool_call", toolName, toolCallId, json, status });
    const result = t["result"];
    let resultText: string | undefined;
    if (typeof result === "string") resultText = result;
    else if (result && typeof result === "object") {
      const rec = result as Record<string, unknown>;
      resultText = typeof rec["result"] === "string" ? (rec["result"] as string) : JSON.stringify(result);
    }
    if (resultText !== undefined) {
      parts.push({ kind: "tool_result", toolCallId, text: resultText, status });
    }
  }

  if (parts.length === 0) return undefined;
  return {
    sessionId,
    ordinal,
    nativeId: bubbleKey.slice(bubbleKey.lastIndexOf(":") + 1),
    role,
    createdAt: typeof data["createdAt"] === "string" ? (data["createdAt"] as string) : "",
    isSidechain: false,
    isCompactBoundary: false,
    parts,
  };
}

export function cursorAdapter(): SerializedJsonlAdapter {
  // v2：无仓库路径的会话改用文件路径反推项目目录；v3：爬升优先工作区标记（git/pnpm-workspace），再退到 package.json
  const version = 3;

  async function detect(env: Env): Promise<Detection> {
    const file = cursorStorageFile(env);
    return { installed: file !== undefined, sessionsRoot: file ? path.dirname(file) : undefined };
  }

  async function scanAllOf(env: Env): Promise<SessionScan[]> {
    const found = readComposers(env);
    if (!found) return [];
    let db: DatabaseSync;
    try {
      db = openDb(found.file);
    } catch {
      return found.composers.map((meta) => scanOf(found.file, meta));
    }
    try {
      return found.composers.map((meta) => scanOf(found.file, meta, statusFromComposer(db, meta)));
    } finally {
      db.close();
    }
  }

  async function scanProjectOf(scope: ProjectScope, env: Env): Promise<SessionScan[]> {
    const all = await scanAllOf(env);
    return all.filter(
      (scan) => scan.cwd !== undefined && isPathInside(scan.cwd, scope.projectRoot, env.platform),
    );
  }

  return {
    agent: CURSOR_AGENT,
    version,
    detect,

    basePath(env: Env): string {
      return globalStorageDir(env) ?? path.join(env.home, ".cursor");
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
      const sep = filePath.lastIndexOf(FRAGMENT_SEP);
      if (sep <= 0) return undefined;
      const file = filePath.slice(0, sep);
      const id = filePath.slice(sep + 1);
      if (!fs.existsSync(file)) return undefined;
      let db: DatabaseSync;
      try {
        db = openDb(file);
      } catch {
        return undefined;
      }
      try {
        const row = db
          .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
          .get(`composerData:${id}`) as { value?: unknown } | undefined;
        if (!row) return undefined;
        const meta = parseComposer(id, row.value);
        return meta ? scanOf(file, meta, statusFromComposer(db, meta)) : undefined;
      } catch {
        return undefined;
      } finally {
        db.close();
      }
    },

    async *readSession(ref: SessionRef): AsyncIterable<NormalizedEvent> {
      const sep = ref.sourcePath.lastIndexOf(FRAGMENT_SEP);
      const file = sep > 0 ? ref.sourcePath.slice(0, sep) : ref.sourcePath;
      const composerId = ref.id.slice(ref.id.indexOf(":") + 1);
      let db: DatabaseSync;
      try {
        db = openDb(file);
      } catch {
        return;
      }
      try {
        const metaRow = db
          .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
          .get(`composerData:${composerId}`) as { value?: unknown } | undefined;
        if (!metaRow) return;
        const rawMeta =
          typeof metaRow.value === "string"
            ? (metaRow.value as string)
            : Buffer.from(metaRow.value as Uint8Array).toString("utf8");
        const meta = JSON.parse(rawMeta) as Record<string, unknown>;
        const headers = Array.isArray(meta["fullConversationHeadersOnly"])
          ? (meta["fullConversationHeadersOnly"] as Array<Record<string, unknown>>)
          : [];

        const bubbleStmt = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
        const messages: Message[] = [];
        for (let index = 0; index < headers.length; index++) {
          const bubbleId = String(headers[index]!["bubbleId"] ?? "");
          if (!bubbleId) continue;
          const row = bubbleStmt.get(`bubbleId:${composerId}:${bubbleId}`) as
            | { value?: unknown }
            | undefined;
          if (!row || row.value === undefined) continue;
          const message = messageFromBubble(
            ref.id,
            index + 1,
            `bubbleId:${bubbleId}`,
            row.value,
          );
          if (message) messages.push(message);
        }
        const composer = parseComposer(composerId, metaRow.value);
        const firstUser = messages.find((message) => message.role === "user")?.parts.find((p) => p.kind === "text")?.text;
        const session: Session = {
          id: ref.id,
          agent: CURSOR_AGENT,
          sourcePath: ref.sourcePath,
          cwd: composer?.cwd ?? "",
          projectRoot: "",
          gitBranch: composer?.gitBranch,
          title: composer?.name,
          firstUserMessage: firstUser,
          startedAt: isoOf(composer?.createdAt ?? 0) ?? "",
          endedAt: isoOf(composer?.lastUpdatedAt ?? 0) ?? "",
          status: "unknown",
          rawRecords: headers.length,
        };
        yield { kind: "session", session };
        for (const message of messages) {
          yield { kind: "message", message };
        }
      } catch {
        /* 读不动就当这个会话不存在 */
      } finally {
        db.close();
      }
    },
  };
}
