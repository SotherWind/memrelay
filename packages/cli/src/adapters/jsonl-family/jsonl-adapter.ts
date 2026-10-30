import fs from "node:fs";
import path from "node:path";

import type {
  Adapter,
  AgentId,
  Detection,
  Env,
  NormalizedEvent,
  ProjectScope,
  Session,
  SessionRef,
} from "../../core/types.js";
import { readJsonl } from "./jsonl.js";
import {
  analyzeTailRecords,
  finalizeSession,
  isPathInside,
  peekHead,
  projectSlugVariants,
  readTailRecords,
  recordToLocalMessage,
  sessionIdFromPath,
  toNormalizedMessages,
  walkBranch,
  type TailAnalysis,
} from "./parser.js";
import type { LocalMessage } from "./records.js";

export interface JsonlAdapterOptions {
  agent: AgentId;
  version: number;
  /** 会话根目录，相对 home，如 .claude/projects */
  sessionsRootRel: string;
  /** 解析 JSONL 之外的额外记录类型（如 Qoder 的 workspace-directories） */
  extractMetadata?: (
    record: Record<string, unknown>,
    state: { cwd?: string; gitBranch?: string; title?: string; explicitLeaf?: string },
  ) => void;
  /** 某些工具（Qoder）把子会话放在以会话 id 命名的子目录里 */
  nestedSessionFiles?: boolean;
}

export interface SessionScan extends SessionRef {
  tail: TailAnalysis;
}

const EMPTY_TAIL: TailAnalysis = {
  statusInfo: {
    pendingToolCallIds: [],
    lastUserMessageUnanswered: false,
    quotaOrLimitDetected: false,
    errorDetected: false,
  },
  hasActiveLeaf: false,
  memrelayCalledRecently: false,
};

/** 目录名编码不对称（大小写、符号替换）时也尽量命中：先精确匹配，再忽略大小写匹配。 */
function findProjectDirs(root: string, projectPath: string): string[] {
  const wanted = new Set(projectSlugVariants(projectPath));
  const wantedLower = new Set([...wanted].map((s) => s.toLowerCase()));
  const dirs: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (wanted.has(entry.name) || wantedLower.has(entry.name.toLowerCase())) {
      dirs.push(path.join(root, entry.name));
    }
  }
  return dirs;
}

function listSessionFiles(dir: string, nested: boolean): string[] {
  const out = new Set<string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.add(path.join(dir, entry.name));
    } else if (nested && entry.isDirectory()) {
      try {
        for (const sub of fs.readdirSync(path.join(dir, entry.name))) {
          if (sub.endsWith(".jsonl")) out.add(path.join(dir, entry.name, sub));
        }
      } catch {
        /* ignore */
      }
    }
  }
  return [...out];
}

export interface SerializedJsonlAdapter extends Adapter {
  basePath(env: Env): string;
  /** 多来源工具：判断某个文件路径是否归自己（优先于 basePath 的单一前缀判断） */
  acceptsPath?(filePath: string, env: Env): boolean;
  scanProject(scope: ProjectScope, env: Env): Promise<SessionScan[]>;
  /** 索引器用：枚举该工具的所有会话（不按项目过滤）。 */
  scanAll(env: Env): Promise<SessionScan[]>;
  /** 快路径 / hook 用：列出可能属于某个项目的会话文件（只看目录名，不读内容）。 */
  listProjectFiles(scope: ProjectScope, env: Env): Promise<string[]>;
  /** 快路径 / hook 用：扫描单个文件，返回元数据（不做项目过滤）。 */
  scanFile(filePath: string, env: Env): Promise<SessionScan | undefined>;
}

export function createJsonlAdapter(opts: JsonlAdapterOptions): SerializedJsonlAdapter {
  const rootOf = (env: Env): string => path.join(env.home, ...opts.sessionsRootRel.split("/"));

  async function detect(env: Env): Promise<Detection> {
    const root = rootOf(env);
    try {
      const st = fs.statSync(root);
      return { installed: st.isDirectory(), sessionsRoot: root };
    } catch {
      return { installed: false, sessionsRoot: root };
    }
  }

  function metaFromRecord(
    record: Record<string, unknown>,
    state: { cwd?: string; gitBranch?: string; title?: string; explicitLeaf?: string },
  ): void {
    const type = record["type"];
    if (type === "active-leaf" && typeof record["leafUuid"] === "string") {
      // Qoder 会持续写 active-leaf，最后一条就是当前叶子
      state.explicitLeaf = record["leafUuid"];
    }
    const cwd = record["cwd"];
    if (typeof cwd === "string" && cwd && !state.cwd) state.cwd = cwd;
    const branch = record["gitBranch"];
    if (typeof branch === "string" && branch) state.gitBranch = branch;
    if (typeof record["title"] === "string" && record["title"]) state.title = record["title"];
    opts.extractMetadata?.(record, state);
  }

  function scanSessionFile(filePath: string, env: Env): SessionScan | undefined {
    const fileNameId = sessionIdFromPath(filePath);
    let st: fs.Stats;
    try {
      st = fs.statSync(filePath);
    } catch {
      return undefined;
    }
    if (st.size === 0) return undefined;
    const head = peekHead(filePath);
    // 原生 id 优先：接力链标记引用的是内容里的 sessionId
    const id = `${opts.agent}:${head.sessionId ?? fileNameId}`;
    let tail = EMPTY_TAIL;
    try {
      tail = analyzeTailRecords(readTailRecords(filePath));
    } catch {
      tail = EMPTY_TAIL;
    }
    return {
      id,
      agent: opts.agent,
      sourcePath: filePath,
      cwd: head.cwd,
      gitBranch: head.gitBranch,
      startedAt: head.startedAt,
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      tail,
    };
  }

  async function scanProject(scope: ProjectScope, env: Env): Promise<SessionScan[]> {
    const root = rootOf(env);
    const dirs = findProjectDirs(root, scope.projectRoot);
    const out: SessionScan[] = [];
    for (const dir of dirs) {
      for (const file of listSessionFiles(dir, opts.nestedSessionFiles ?? false)) {
        const scan = scanSessionFile(file, env);
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
    const out: SessionScan[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      for (const file of listSessionFiles(dir, opts.nestedSessionFiles ?? false)) {
        const scan = scanSessionFile(file, env);
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
    const messages: LocalMessage[] = [];
    const links = new Map<string, string | undefined>();
    const state: { cwd?: string; gitBranch?: string; title?: string; explicitLeaf?: string } = {};
    let lastMessageUuid: string | undefined;
    let maxTs: string | undefined;
    let rawRecordCount = 0;

    for await (const { value } of readJsonl(ref.sourcePath)) {
      rawRecordCount++;
      metaFromRecord(value, state);
      // 全量 uuid→parent 链接：链上夹着被跳过的记录时也能走到根
      const uuidRaw = value["uuid"];
      if (typeof uuidRaw === "string" && uuidRaw) {
        links.set(
          uuidRaw,
          typeof value["parentUuid"] === "string" ? value["parentUuid"] : undefined,
        );
      }
      const msg = recordToLocalMessage(value);
      if (msg) {
        messages.push(msg);
        // 叶子取"最后一条非 sidechain 记录"（含工具结果）：对话树里最后一个节点才是当前分支的终点
        if (!msg.isSidechain) lastMessageUuid = msg.uuid;
        if (msg.timestamp && (!maxTs || msg.timestamp > maxTs)) maxTs = msg.timestamp;
      }
    }

    const leaf = state.explicitLeaf ?? lastMessageUuid ?? messages[messages.length - 1]?.uuid;
    // 有的记录格式（Qoder transcript 等）没有 parentUuid，整份就是线性流水账：
    // 直接从叶子回溯会只剩一条，此时按文件顺序整体取。
    const isLinear =
      messages.length > 0 && messages.every((m) => m.parentUuid === undefined);
    const { branch } = isLinear
      ? { branch: messages.filter((m) => !m.isSidechain) }
      : walkBranch(messages, leaf, links);

    const parsed = finalizeSession(
      { agent: opts.agent, sessionId: ref.id, sourcePath: ref.sourcePath },
      messages,
      {
        cwd: state.cwd ?? ref.cwd,
        gitBranch: state.gitBranch ?? ref.gitBranch,
        title: state.title,
        explicitLeaf: state.explicitLeaf,
      },
    );

    const session: Session = {
      id: ref.id,
      agent: opts.agent,
      sourcePath: ref.sourcePath,
      cwd: parsed.cwd || ref.cwd || "",
      projectRoot: parsed.cwd || ref.cwd || "",
      gitBranch: parsed.gitBranch,
      title: parsed.title,
      firstUserMessage: parsed.firstUserMessage,
      startedAt: ref.startedAt ?? "",
      endedAt: maxTs ?? "",
      status: "unknown",
      rawRecords: rawRecordCount,
    };
    yield { kind: "session", session };

    const start = readOpts?.fromOffset ?? 0;
    if (state.explicitLeaf) {
      yield { kind: "active-leaf", leafUuid: state.explicitLeaf };
    }
    for (const event of toNormalizedMessages({ sessionId: ref.id }, branch)) {
      if (event.kind === "message" && event.message.ordinal >= start) yield event;
    }
  }

  return {
    agent: opts.agent,
    version: opts.version,
    detect,
    listSessions: async (scope, env) => (await scanProject(scope, env)).map(toRef),
    readSession,
    basePath: rootOf,
    scanProject,
    scanAll,
    listProjectFiles: async (scope, env) => {
      const root = rootOf(env);
      const out: string[] = [];
      for (const dir of findProjectDirs(root, scope.projectRoot)) {
        out.push(...listSessionFiles(dir, opts.nestedSessionFiles ?? false));
      }
      return out;
    },
    scanFile: async (filePath, env) => scanSessionFile(filePath, env),
  };
}

function toRef(scan: SessionScan): SessionRef {
  const { tail: _tail, ...ref } = scan;
  return ref;
}
