import fs from "node:fs";
import path from "node:path";

import type { AgentId, Env } from "../core/types.js";
import { currentEnv, memrelayDir } from "../core/env.js";
import { TOOL_REGISTRY, type ToolDefinition } from "../core/tool-registry.js";

export interface ToolDetection {
  tool: ToolDefinition;
  /** 该工具是否安装（按技能目录或会话目录判断） */
  installed: boolean;
  /** 是否可作为来源（有会话目录且存在） */
  canBeSource: boolean;
  /** 存在的 Skill 目录（绝对路径） */
  skillDirs: string[];
  /** 会话根目录（绝对路径，若存在） */
  sessionsRoot?: string;
  sessionFileCount: number;
}

export function detectTools(env: Env): ToolDetection[] {
  const out: ToolDetection[] = [];
  for (const tool of TOOL_REGISTRY) {
    const roots: string[] = [];
    if (tool.sessionsRoot) {
      const root = path.join(env.home, ...tool.sessionsRoot.split("/"));
      if (dirExists(root)) roots.push(root);
    }
    for (const root of tool.extraSourceRoots?.(env) ?? []) {
      if (dirExists(root)) roots.push(root);
    }
    const sessionsRoot = roots[0];
    const sessionFileCount = roots.reduce((count, root) => count + countSessionFiles(root), 0);
    // 工具已装（主目录在）时，配置的技能目录即使还没被工具创建也作为写入目标——
    // setup 会 mkdir 后放 Skill（例如 WorkBuddy 的 ~/.workbuddy/skills）。
    const skillDirs = tool.skillDirs
      .map((rel) => path.join(env.home, ...rel.split("/")))
      .filter((dir) => dirExists(dir) || sessionsRoot !== undefined);
    const installed = skillDirs.length > 0 || sessionsRoot !== undefined;
    out.push({
      tool,
      installed,
      canBeSource: sessionsRoot !== undefined && !tool.encryptedSessions,
      skillDirs,
      sessionsRoot,
      sessionFileCount,
    });
  }
  return out;
}

export function skillDirsForWrite(env: Env, includeMissing: boolean): {
  tool: ToolDefinition;
  dir: string;
}[] {
  const out: Array<{ tool: ToolDefinition; dir: string }> = [];
  for (const tool of TOOL_REGISTRY) {
    if (tool.skillDirs.length === 0) continue;
    for (const rel of tool.skillDirs) {
      const dir = path.join(env.home, ...rel.split("/"));
      if (includeMissing || dirExists(dir)) out.push({ tool, dir });
    }
  }
  return out;
}

export function dirExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** 是否已经接入过（存在 memrelay 数据目录且写过 Skill）。 */
export function isIntegrated(): boolean {
  const env = currentEnv();
  return fs.existsSync(path.join(memrelayDir(env), "integrations.json"));
}

function countSessionFiles(root: string, depth = 0): number {
  if (depth > 3) return 0;
  let count = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile()) {
      if (entry.name.endsWith(".jsonl")) count++;
      // CodeBuddy IDE：<工作区>/[conversations/]<会话 id>/{index.json,messages/}
      else if (entry.name === "index.json" && dirExists(path.join(path.dirname(full), "messages"))) {
        count++;
      }
    } else if (entry.isDirectory()) {
      count += countSessionFiles(full, depth + 1);
    }
  }
  return count;
}

export function resolvePhysicalDir(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

export function agentDisplay(id: AgentId | string): string {
  return TOOL_REGISTRY.find((t) => t.id === id)?.name ?? String(id);
}
