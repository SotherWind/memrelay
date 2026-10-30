import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";

import type { Env } from "../src/core/types.js";
import { projectSlug } from "../src/adapters/jsonl-family/parser.js";
import { listProjectTasks, listTaskSummary, type TaskDto } from "../src/server/task-list.js";
export interface TempHome {
  home: string;
  env: Env;
  cleanup(): void;
}

/** fixture 会话里写的项目目录（用正斜杠避免转义噪音，路径等价）。 */
export const FIXTURE_PROJECTS = {
  demo: "D:/webProject/demo-site",
  db: "D:/webProject/db-tools",
  secrets: "D:/webProject/ops-check",
  notes: "D:/webProject/notes-app",
  caller: "D:/webProject/relay-target",
};

export function makeTempHome(): TempHome {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-test-"));
  const env: Env = { home, platform: process.platform, env: {} };
  return {
    home,
    env,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

export function fixturePath(...parts: string[]): string {
  return path.resolve(process.cwd(), "test", "fixtures", ...parts);
}

/** 测试用：目录摘要 + 每个目录的任务页拼回"全量任务列表"（夹具里每个目录都远小于一页）。 */
export function allTasks(db: DatabaseSync, env: Env): TaskDto[] {
  const summary = listTaskSummary(db, env);
  const out: TaskDto[] = [];
  for (const project of summary.projects) {
    out.push(...listProjectTasks(db, env, { project: project.project, limit: 200 }).tasks);
  }
  return out;
}

/** 会话目录名：和适配器使用同一套编码规则（小写变体）。 */
export function projectSlugLike(projectPath: string): string {
  return projectSlug(projectPath).toLowerCase();
}

/** 解析到规范路径（Windows 短名 / 符号链接），与会话里记录的 cwd 写法保持一致。 */
export function realDir(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** 把 fixture 会话放进临时 HOME；返回 fake home 与可用的 env。 */
export function setupFakeHome(opts: {
  projectPath: string;
  claudeSessions?: Array<{ file: string; as?: string }>;
  qoderSessions?: Array<{ file: string; as?: string }>;
}): TempHome {
  const temp = makeTempHome();
  const slug = projectSlug(opts.projectPath).toLowerCase();
  if (opts.claudeSessions?.length) {
    const dir = path.join(temp.home, ".claude", "projects", slug);
    fs.mkdirSync(dir, { recursive: true });
    for (const s of opts.claudeSessions) {
      const src = fixturePath("claude-code", s.file);
      const name = s.as ?? path.basename(s.file);
      fs.copyFileSync(src, path.join(dir, name.endsWith(".jsonl") ? name : name + ".jsonl"));
    }
  }
  if (opts.qoderSessions?.length) {
    const dir = path.join(temp.home, ".qoder", "projects", slug);
    fs.mkdirSync(dir, { recursive: true });
    for (const s of opts.qoderSessions) {
      const src = fixturePath("qoder", s.file);
      const name = s.as ?? path.basename(s.file);
      fs.copyFileSync(src, path.join(dir, name.endsWith(".jsonl") ? name : name + ".jsonl"));
    }
  }
  fs.mkdirSync(path.join(temp.home, ".memrelay"), { recursive: true });
  return temp;
}

/** 建一个真实 git 仓库（找不到 git 时退回普通目录）。 */
export function makeDemoRepo(): { dir: string; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-repo-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
    fs.mkdirSync(path.join(dir, "src", "pages"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src", "pages", "Home.tsx"),
      "export default function Home() { return null; }\n",
    );
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: dir, stdio: "ignore" });
  } catch {
    /* 没有 git 也能跑大部分测试 */
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function writeLines(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
}

/** 整秒的时间戳（快路径的新鲜度校验按整秒取整，避免亚秒精度差异）。 */
export function wholeSecondDate(minutesAgo: number): Date {
  const d = new Date(Date.now() - minutesAgo * 60 * 1000);
  d.setMilliseconds(0);
  return d;
}

/** 写一个 JSONL 会话文件（可选整秒 mtime）。 */
export function writeJsonlFile(
  file: string,
  records: Array<Record<string, unknown>>,
  mtime?: Date,
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

/** Qoder 会话目录（项目 slug）。 */
export function qoderSessionDir(home: string, projectPath: string): string {
  return path.join(home, ".qoder", "projects", projectSlug(projectPath).toLowerCase());
}

// —— 线性（无 parentUuid）Qoder 会话记录构造器：hook 与快路径测试共用 ——

export function qoderUserRec(
  sessionId: string,
  uuid: string,
  text: string,
  cwd: string,
): Record<string, unknown> {
  return {
    type: "user",
    uuid,
    timestamp: "2026-10-12T07:30:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
    sessionId,
    cwd,
  };
}

export function qoderToolResultRec(
  sessionId: string,
  uuid: string,
  callId: string,
  content: string,
  cwd: string,
): Record<string, unknown> {
  return {
    type: "user",
    uuid,
    timestamp: "2026-10-12T07:30:05.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content }] },
    sessionId,
    cwd,
  };
}

export function qoderAssistantRec(
  sessionId: string,
  uuid: string,
  parts: unknown[],
  cwd: string,
): Record<string, unknown> {
  return {
    type: "assistant",
    uuid,
    timestamp: "2026-10-12T07:31:00.000Z",
    message: { role: "assistant", content: parts },
    sessionId,
    cwd,
  };
}
