import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import {
  makeTempHome,
  qoderAssistantRec,
  qoderSessionDir,
  qoderUserRec,
  realDir,
  wholeSecondDate,
  writeJsonlFile,
} from "./helpers.js";

/**
 * resume <会话 id>：从候选菜单选定后强制选中该会话。
 * 输出必须与关键字接续一样带【MemRelay 续接】标记，当前会话才能落链。
 */

const CLI = path.resolve(process.cwd(), "dist", "cli.mjs");
const hasBuild = fs.existsSync(CLI);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function runCli(args: string[], opts: { cwd: string; home: string }): { stdout: string; status: number } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    MEMRELAY_HOME: path.join(opts.home, ".memrelay"),
    USERPROFILE: opts.home,
    HOME: opts.home,
  };
  for (const key of [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
    "QODER_CLI",
    "QODER_ID",
    "QODER_SESSION_ID",
    "QODER_AGENT_SDK_ENTRYPOINT",
  ]) {
    delete env[key];
  }
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: opts.cwd,
      env: env as Record<string, string>,
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; status?: number };
    return { stdout: String(e.stdout ?? ""), status: e.status ?? 1 };
  }
}

const SID_A = "a11ce000-0000-4000-8000-00000000000a";
const SID_B = "b0b0b000-0000-4000-8000-00000000000b";
const SID_CHILD = "c11d0000-0000-4000-8000-00000000000c";
const SID_EMPTY = "e1110000-0000-4000-8000-00000000000e";

function pendingTask(sid: string, uuidPrefix: string, prompt: string, cwd: string): Array<Record<string, unknown>> {
  return [
    qoderUserRec(sid, `${uuidPrefix}-0000-4000-8000-000000000001`, prompt, cwd),
    qoderAssistantRec(sid, `${uuidPrefix}-0000-4000-8000-000000000002`, [
      { type: "text", text: "我先从目录结构看起。" },
      { type: "tool_use", id: `call_${uuidPrefix}`, name: "Read", input: { file_path: `${cwd}/README.md` } },
    ], cwd),
  ];
}

function setupHome(): { repoDir: string; temp: ReturnType<typeof makeTempHome>; dir: string } {
  const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-byid-")));
  const temp = makeTempHome();
  cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);
  const dir = qoderSessionDir(temp.home, repoDir);
  const mtime = wholeSecondDate(20);

  writeJsonlFile(
    path.join(dir, `${SID_A}.jsonl`),
    pendingTask(SID_A, "a11ca000", "帮我设计一个公司官网首页，先出静态页", repoDir),
    mtime,
  );
  writeJsonlFile(
    path.join(dir, `${SID_B}.jsonl`),
    pendingTask(SID_B, "b0b0c000", "整理一个读书清单工具", repoDir),
    mtime,
  );
  writeJsonlFile(
    path.join(dir, `${SID_CHILD}.jsonl`),
    [
      qoderUserRec(SID_CHILD, "c11da000-0000-4000-8000-000000000001", "继续官网任务", repoDir),
      qoderAssistantRec(SID_CHILD, "c11da000-0000-4000-8000-000000000002", [
        {
          type: "text",
          text: `【MemRelay 续接】\n续接自 Qoder:${SID_A} · 会话数 1 · 2026-10-12 15:30 · ${repoDir} · 会话 qoder:${SID_A}`,
        },
        { type: "tool_use", id: "call_c11da", name: "Read", input: { file_path: `${repoDir}/src/Home.tsx` } },
      ], repoDir),
    ],
    mtime,
  );
  writeJsonlFile(
    path.join(dir, `${SID_EMPTY}.jsonl`),
    [qoderUserRec(SID_EMPTY, "e111a000-0000-4000-8000-000000000001", "先看看再说", repoDir)],
    mtime,
  );

  expect(runCli(["doctor"], { cwd: repoDir, home: temp.home }).status).toBe(0);
  return { repoDir, temp, dir };
}

describe.skipIf(!hasBuild)("resume <会话 id>：强制选中并落链", () => {
  it("多个中断会话时直接选中指定 id，不再返回候选菜单", () => {
    const { repoDir, temp } = setupHome();
    const res = runCli(["resume", `qoder:${SID_A}`], { cwd: repoDir, home: temp.home });
    expect(res.status).toBe(0);
    expect(res.stdout.startsWith("【MemRelay 续接】")).toBe(true);
    expect(res.stdout).toContain(`会话 qoder:${SID_A}`);
    expect(res.stdout).toContain(`续接自 Qoder:${SID_A} · 会话数 1`);
    expect(res.stdout).toContain("公司官网首页");
    expect(res.stdout).toContain("会话数 1");
    expect(res.stdout).not.toContain("候选会话");
    expect(res.stdout).not.toContain("读书清单");

    // 和 show 一样支持唯一前缀
    const prefix = runCli(["resume", `qoder:${SID_A.slice(0, 8)}`], { cwd: repoDir, home: temp.home });
    expect(prefix.stdout).toContain(`会话 qoder:${SID_A}`);
  });

  it("选中带接力标记的会话时，输出完整接力历史（父会话仍在链上）", () => {
    const { repoDir, temp } = setupHome();
    const res = runCli(["resume", `qoder:${SID_CHILD}`], { cwd: repoDir, home: temp.home });
    expect(res.status).toBe(0);
    expect(res.stdout.startsWith("【MemRelay 续接】")).toBe(true);
    expect(res.stdout).toContain(`会话 qoder:${SID_CHILD}`);
    expect(res.stdout).toContain(`续接自 Qoder:${SID_A} · 会话数 2`);
    expect(res.stdout).toContain("接力历史（前几段）");
    expect(res.stdout).toContain("公司官网首页");
  });

  it("id 不存在时给明确提示，不误当成关键词搜索", () => {
    const { repoDir, temp } = setupHome();
    const res = runCli(["resume", "qoder:ffffffff-ffff-4fff-8fff-ffffffffffff"], {
      cwd: repoDir,
      home: temp.home,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("没有找到会话");
    expect(res.stdout).not.toContain("候选会话");
  });

  it("空壳会话（只有提问、没有产出）不给续接标记", () => {
    const { repoDir, temp } = setupHome();
    const res = runCli(["resume", `qoder:${SID_EMPTY}`], { cwd: repoDir, home: temp.home });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("只是开了个头");
    expect(res.stdout).not.toContain("【MemRelay 续接】");
  });

  it("会话文件被工具清理后给可读提示，不崩溃", () => {
    const { repoDir, temp } = setupHome();
    fs.rmSync(path.join(qoderSessionDir(temp.home, repoDir), `${SID_A}.jsonl`), { force: true });
    const res = runCli(["resume", `qoder:${SID_A}`], { cwd: repoDir, home: temp.home });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("没有找到会话");
    expect(res.stdout).toContain("被工具清理");
    expect(res.stdout).not.toContain("【MemRelay 续接】");
  });
});
