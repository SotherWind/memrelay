import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resolvePathOnAnyPlatform } from "./path-utils.js";

export interface ProjectIdentity {
  projectRoot: string;
  isGitRepo: boolean;
  branch?: string;
  /** 同一仓库的其他 worktree / 克隆：不合并，只在候选里标注 */
  differentDir: boolean;
}

function runGit(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync("git", ["--no-optional-locks", "-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    }).trim();
  } catch {
    return undefined;
  }
}

export function findProjectRoot(cwd: string): string {
  const top = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (top) return canonicalize(top);
  return canonicalize(cwd);
}

/** 解析符号链接与 Windows 8.3 短名，保证各处生成的路径写法一致。 */
function canonicalize(p: string): string {
  const resolved = resolvePathOnAnyPlatform(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    try {
      return fs.realpathSync(resolved);
    } catch {
      return resolved;
    }
  }
}

export function currentBranch(cwd: string): string | undefined {
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return branch && branch !== "HEAD" ? branch : undefined;
}

export function resolveProject(cwd: string): ProjectIdentity {
  const top = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (top) {
    return {
      projectRoot: canonicalize(top),
      isGitRepo: true,
      branch: currentBranch(cwd),
      differentDir: false,
    };
  }
  return { projectRoot: canonicalize(cwd), isGitRepo: false, differentDir: false };
}

export interface GitWorkingState {
  changedFiles: string[];
  untrackedFiles: string[];
  diffStat?: string;
}

export function collectGitState(cwd: string): GitWorkingState {
  const porcelain = runGit(["status", "--porcelain"], cwd);
  const changedFiles: string[] = [];
  const untrackedFiles: string[] = [];
  if (porcelain) {
    for (const line of porcelain.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const status = line.slice(0, 2);
      let file = line.slice(3).trim();
      const arrow = file.indexOf(" -> ");
      if (arrow >= 0) file = file.slice(arrow + 4);
      file = file.replace(/^"|"$/g, "");
      if (status.includes("?")) untrackedFiles.push(file);
      else changedFiles.push(file);
    }
  }
  const diffStat = runGit(["diff", "--stat", "HEAD"], cwd);
  return { changedFiles, untrackedFiles, diffStat: diffStat || undefined };
}
