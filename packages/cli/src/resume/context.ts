import fs from "node:fs";
import path from "node:path";

import type { Env, SessionRef } from "../core/types.js";
import { currentEnv } from "../core/env.js";
import { loadFilters, isDirExcluded, isSessionDeleted, type Filters } from "../core/filters.js";
import { collectGitState, resolveProject, type GitWorkingState, type ProjectIdentity } from "../core/project.js";
import { TOOL_REGISTRY, type ToolDefinition } from "../core/tool-registry.js";
import { allAdapters } from "../adapters/all.js";
import { isPathInside, peekHead } from "../adapters/jsonl-family/parser.js";
import type { SerializedJsonlAdapter, SessionScan } from "../adapters/jsonl-family/jsonl-adapter.js";
import { openReadOnly } from "../store/db.js";

export interface ResumeContext {
  env: Env;
  cwd: string;
  project: ProjectIdentity;
  git: GitWorkingState;
  adapters: SerializedJsonlAdapter[];
  callerTool?: ToolDefinition;
  filters: Filters;
}

function detectCallerTool(env: Env): ToolDefinition | undefined {
  const e = env.env;
  const markers: Array<[string, string]> = [
    ["CLAUDECODE", "claude-code"],
    ["CLAUDE_CODE_ENTRYPOINT", "claude-code"],
    ["CLAUDE_CODE_SSE_PORT", "claude-code"],
    ["QODER_CLI", "qoder"],
    ["QODER_ID", "qoder"],
    ["QODER_SESSION_ID", "qoder"],
    ["QODER_AGENT_SDK_ENTRYPOINT", "qoder"],
    ["CODEX_SANDBOX", "codex"],
    ["CODEX_SANDBOX_NETWORK_DISABLED", "codex"],
    ["CURSOR_TRACE_ID", "cursor"],
    ["CURSOR_CHANNEL", "cursor"],
    ["TRAE_MODE", "trae-cn"],
  ];
  for (const [key, id] of markers) {
    if (e[key]) return TOOL_REGISTRY.find((t) => t.id === id);
  }
  return undefined;
}

export function resolveContext(cwd = process.cwd()): ResumeContext {
  const env = currentEnv();
  const project = resolveProject(cwd);
  const git = collectGitState(cwd);
  const adapters = allAdapters();
  return {
    env,
    cwd,
    project,
    git,
    adapters,
    callerTool: detectCallerTool(env),
    filters: loadFilters(env),
  };
}

export async function scanAll(ctx: ResumeContext): Promise<SessionScan[]> {
  const scope = { projectRoot: ctx.project.projectRoot, cwd: ctx.cwd };
  const all: SessionScan[] = [];
  for (const adapter of ctx.adapters) {
    const detection = await adapter.detect(ctx.env);
    if (!detection.installed) continue;
    all.push(...(await adapter.scanProject(scope, ctx.env)));
  }
  return all.filter((scan) => {
    if (isSessionDeleted(scan.id, ctx.filters)) return false;
    if (scan.cwd && isDirExcluded(scan.cwd, ctx.filters, ctx.env.platform)) return false;
    return true;
  });
}

export function findAdapter(ctx: ResumeContext, agent: string): SerializedJsonlAdapter | undefined {
  return ctx.adapters.find((a) => a.agent === agent);
}

/** 同一 agent 可能有多个来源适配器（CodeBuddy CLI / IDE）：按会话文件路径选真正归属的那个。 */
function adapterOwning(
  candidates: SerializedJsonlAdapter[],
  filePath: string,
  env: Env,
): SerializedJsonlAdapter | undefined {
  return candidates.find((a) =>
    a.acceptsPath
      ? a.acceptsPath(filePath, env)
      : isPathInside(filePath, a.basePath(env), env.platform),
  );
}

/** 按 sourcePath 归属选适配器；无法判断时退回同 agent 的第一个。 */
export function pickAdapter(
  candidates: SerializedJsonlAdapter[],
  filePath: string,
  env: Env,
): SerializedJsonlAdapter | undefined {
  return adapterOwning(candidates, filePath, env) ?? candidates[0];
}

export function adapterForScan(
  ctx: ResumeContext,
  scan: { agent: SerializedJsonlAdapter["agent"]; sourcePath: string },
): SerializedJsonlAdapter | undefined {
  return pickAdapter(
    ctx.adapters.filter((adapter) => adapter.agent === scan.agent),
    scan.sourcePath,
    ctx.env,
  );
}

function refAllowed(ctx: ResumeContext, ref: SessionRef): boolean {
  if (isSessionDeleted(ref.id, ctx.filters)) return false;
  if (ref.cwd && isDirExcluded(ref.cwd, ctx.filters, ctx.env.platform)) return false;
  return true;
}

/**
 * 按会话 id 找到原始文件。支持完整 id 或唯一前缀（菜单里显示的就是短 id）。
 * 先查当前项目（顺手），再按 agent 的会话根目录全量查找，这样 show 在任意目录下都能用。
 */
export async function resolveSessionRef(
  ctx: ResumeContext,
  sessionId: string,
): Promise<{ adapter: SerializedJsonlAdapter; ref: SessionRef } | undefined> {
  const sep = sessionId.indexOf(":");
  if (sep <= 0) return undefined;
  const agent = sessionId.slice(0, sep);
  const ownerAdapters = ctx.adapters.filter((a) => a.agent === agent);
  const adapter = ownerAdapters[0];
  if (!adapter) return undefined;

  const nativeIdWanted = sessionId.slice(sep + 1).toLowerCase();
  const matches = (id: string): boolean => {
    const native = id.slice(id.indexOf(":") + 1).toLowerCase();
    return native === nativeIdWanted || native.startsWith(nativeIdWanted);
  };

  const scans = await scanAll(ctx);
  const inProject = scans.find((s) => matches(s.id));
  if (inProject) {
    const { tail: _tail, ...ref } = inProject;
    if (refAllowed(ctx, ref)) {
      return { adapter: pickAdapter(ownerAdapters, inProject.sourcePath, ctx.env) ?? adapter, ref };
    }
  }

  // 项目外优先查索引：已入过库的会话直接拿 source_path，避免全盘扫描。
  const indexed = indexedRef(ctx, ownerAdapters, agent, nativeIdWanted);
  if (indexed && refAllowed(ctx, indexed.ref)) return indexed;

  // 没入过库才交给适配器全量扫描（Codex 日期目录、DSH/OpenCode/Cursor 伪路径、
  // CodeBuddy IDE 的多来源都能按 id 命中），比通用目录布局可靠。
  for (const candidate of ownerAdapters) {
    const all = await candidate.scanAll(ctx.env).catch(() => []);
    const anywhere = all.find((scan) => matches(scan.id));
    if (anywhere) {
      const { tail: _tail, ...ref } = anywhere;
      if (!refAllowed(ctx, ref)) continue;
      return { adapter: pickAdapter(ownerAdapters, anywhere.sourcePath, ctx.env) ?? candidate, ref };
    }
  }

  const root = adapter.basePath(ctx.env);
  const candidates = listAllFiles(root, nativeIdWanted);
  for (const file of candidates) {
    const head = peekHead(file);
    let st: { mtimeMs: number; size: number };
    try {
      const s = fs.statSync(file);
      st = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      continue;
    }
    const ref: SessionRef = {
      id: `${agent}:${path.basename(file).replace(/\.jsonl$/, "")}`,
      agent,
      sourcePath: file,
      cwd: head.cwd,
      gitBranch: head.gitBranch,
      startedAt: head.startedAt,
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
    };
    if (!refAllowed(ctx, ref)) continue;
    return { adapter, ref };
  }
  return undefined;
}

/** 已入索引的会话：直接按 id 查 source_path，项目外 show 不必全盘扫描。 */
function indexedRef(
  ctx: ResumeContext,
  ownerAdapters: SerializedJsonlAdapter[],
  agent: string,
  nativeIdWanted: string,
): { adapter: SerializedJsonlAdapter; ref: SessionRef } | undefined {
  let db;
  try {
    db = openReadOnly(ctx.env);
  } catch {
    return undefined;
  }
  try {
    const escaped = nativeIdWanted.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const row = db
      .prepare(
        `SELECT s.id AS id, s.source_path AS source_path, s.cwd AS cwd, s.git_branch AS git_branch,
                s.started_at AS started_at, COALESCE(src.mtime_ms, 0) AS mtime_ms,
                COALESCE(src.size, 0) AS size_bytes
         FROM sessions s LEFT JOIN sources src ON src.path = s.source_path
         WHERE s.agent = ? AND s.deleted_at IS NULL
           AND lower(s.id) LIKE ? ESCAPE '\\'
         ORDER BY s.id LIMIT 1`,
      )
      .get(agent, `${agent.toLowerCase()}:${escaped}%`) as
      | {
          id: string;
          source_path: string | null;
          cwd: string | null;
          git_branch: string | null;
          started_at: string | null;
          mtime_ms: number;
          size_bytes: number;
        }
      | undefined;
    if (!row?.source_path) return undefined;
    // 普通文件必须还在；Cursor/OpenCode 的伪路径（<db>#<id>）由适配器自己判断。
    if (!row.source_path.includes("#") && !fs.existsSync(row.source_path)) return undefined;
    const adapter = pickAdapter(ownerAdapters, row.source_path, ctx.env);
    if (!adapter) return undefined;
    return {
      adapter,
      ref: {
        id: row.id,
        agent: row.id.slice(0, row.id.indexOf(":")) as SessionRef["agent"],
        sourcePath: row.source_path,
        cwd: row.cwd ?? undefined,
        gitBranch: row.git_branch ?? undefined,
        startedAt: row.started_at ?? undefined,
        mtimeMs: Number(row.mtime_ms),
        sizeBytes: Number(row.size_bytes),
      },
    };
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

function listAllFiles(root: string, nativeIdPrefix: string): string[] {
  const out: string[] = [];
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let subs: string[];
    try {
      subs = fs.readdirSync(path.join(root, dir.name));
    } catch {
      continue;
    }
    for (const sub of subs) {
      if (!sub.endsWith(".jsonl")) continue;
      if (sub.toLowerCase().startsWith(nativeIdPrefix)) {
        out.push(path.join(root, dir.name, sub));
      }
    }
    // 嵌套目录（Qoder 把子会话放 <id>/<id>.jsonl）
    for (const sub of subs) {
      const nested = path.join(root, dir.name, sub, `${sub}.jsonl`);
      if (!sub.toLowerCase().startsWith(nativeIdPrefix)) continue;
      if (fs.existsSync(nested)) out.push(nested);
    }
  }
  return out;
}
