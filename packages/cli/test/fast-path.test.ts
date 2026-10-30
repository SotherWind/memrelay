import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import {
  makeTempHome,
  qoderAssistantRec,
  qoderSessionDir,
  qoderToolResultRec,
  qoderUserRec,
  realDir,
  wholeSecondDate,
  writeJsonlFile,
} from "./helpers.js";

/** resume 查库快路径的端到端行为：查库优先、过期重读、新文件补进、库缺失降级。 */

const CLI = path.resolve(process.cwd(), "dist", "cli.mjs");
const hasBuild = fs.existsSync(CLI);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

interface RunResult {
  stdout: string;
  status: number;
}

function runCli(args: string[], opts: { cwd: string; home: string }): RunResult {
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

const SID_A = "ca110000-0000-4000-8000-00000000000a";

/** 一个停在没有结果的 Read 上的线性会话（中断）——官网首页任务。 */
function siteSession(cwd: string): Array<Record<string, unknown>> {
  return [
    { type: "workspace-directories", sessionId: SID_A, directories: [cwd] },
    qoderUserRec(SID_A, "ca11a000-0000-4000-8000-000000000001", "帮我设计一个公司官网首页，先出静态页", cwd),
    qoderAssistantRec(SID_A, "ca11a000-0000-4000-8000-000000000010", [
      { type: "text", text: "好，我先写首页静态页。" },
      { type: "tool_use", id: "call_fp_write1", name: "Write", input: { file_path: `${cwd}/src/pages/Home.tsx`, content: "<Home/>" } },
    ], cwd),
    qoderToolResultRec(SID_A, "ca11a000-0000-4000-8000-000000000011", "call_fp_write1", "File created successfully", cwd),
    qoderAssistantRec(SID_A, "ca11a000-0000-4000-8000-000000000020", [
      { type: "text", text: "静态页完成，开始接通知数据。" },
      { type: "tool_use", id: "call_fp_read1", name: "Read", input: { file_path: `${cwd}/src/api/notice.ts` } },
    ], cwd),
  ];
}

function setupIndexedHome(): { repoDir: string; temp: ReturnType<typeof makeTempHome>; file: string } {
  const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-repo-")));
  const temp = makeTempHome();
  cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);
  const file = path.join(qoderSessionDir(temp.home, repoDir), `${SID_A}.jsonl`);
  writeJsonlFile(file, siteSession(repoDir), wholeSecondDate(90));
  expect(runCli(["doctor"], { cwd: repoDir, home: temp.home }).status).toBe(0);
  return { repoDir, temp, file };
}

describe.skipIf(!hasBuild)("resume 查库快路径（端到端）", () => {
  it("索引最新时直接给出库里排序出来的续接内容", () => {
    const { repoDir, temp } = setupIndexedHome();
    const res = runCli(["resume", "官网"], { cwd: repoDir, home: temp.home });
    expect(res.status).toBe(0);
    expect(res.stdout.startsWith("【MemRelay 续接】")).toBe(true);
    expect(res.stdout).toContain(`会话 qoder:${SID_A}`);
    expect(res.stdout).toContain("公司官网首页");
    expect(res.stdout).toContain("开始接通知数据");
  });

  it("候选来自库：文件被同尺寸改写（size+mtime 未变）时，仍按库里的会话续接", () => {
    const { repoDir, temp, file } = setupIndexedHome();
    const st = fs.statSync(file);

    // 把文件内容整体换成同长度的占位符，并把 mtime 拨回原值（模拟"库比文件新"）
    fs.writeFileSync(file, Buffer.alloc(st.size, 0x78));
    fs.utimesSync(file, st.atime, st.mtime);
    expect(Math.round(fs.statSync(file).mtimeMs)).toBe(Math.round(st.mtimeMs));

    const res = runCli(["resume", "官网"], { cwd: repoDir, home: temp.home });
    expect(res.status).toBe(0);
    // 只有查库路径能知道这里有 qoder 会话 A
    expect(res.stdout.startsWith("【MemRelay 续接】")).toBe(true);
    expect(res.stdout).toContain(`会话 qoder:${SID_A}`);

    // 反向验证：库删掉后，同一份被改写的文件就再也续接不出来
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(path.join(temp.home, ".memrelay", "memrelay.db" + suffix), { force: true });
    }
    const fallback = runCli(["resume", "官网"], { cwd: repoDir, home: temp.home });
    expect(fallback.status).toBe(0);
    expect(fallback.stdout).not.toContain("【MemRelay 续接】");
  });

  it("索引后追加的回合：现场重读过期文件，resume 能看到最新进展", () => {
    const { repoDir, temp, file } = setupIndexedHome();
    fs.appendFileSync(
      file,
      JSON.stringify(
        qoderAssistantRec(SID_A, "ca11a000-0000-4000-8000-000000000030", [
          { type: "text", text: "追记：接口超时来自上游通知服务，正在排查重试策略。" },
        ], repoDir),
      ) + "\n",
      "utf8",
    );

    const res = runCli(["resume", "官网"], { cwd: repoDir, home: temp.home });
    expect(res.status).toBe(0);
    expect(res.stdout.startsWith("【MemRelay 续接】")).toBe(true);
    expect(res.stdout).toContain("追记：接口超时来自上游通知服务");
  });

  it("索引后新增的会话文件：库里没有也能补进候选", () => {
    const { repoDir, temp } = setupIndexedHome();
    const sidB = "ca110000-0000-4000-8000-00000000000b";
    writeJsonlFile(
      path.join(qoderSessionDir(temp.home, repoDir), `${sidB}.jsonl`),
      [
        { type: "workspace-directories", sessionId: sidB, directories: [repoDir] },
        qoderUserRec(sidB, "ca11b000-0000-4000-8000-000000000001", "新做一个产品定价页", repoDir),
        qoderAssistantRec(sidB, "ca11b000-0000-4000-8000-000000000010", [
          { type: "text", text: "定价页框架搭好了，接下来接支付入口。" },
        ], repoDir),
      ],
      wholeSecondDate(60),
    );

    const res = runCli(["resume", "定价"], { cwd: repoDir, home: temp.home });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`会话 qoder:${sidB}`);
    expect(res.stdout).toContain("定价页框架搭好了");
  });

  it("库缺失时照常工作（降级全量扫盘）", () => {
    const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-repo-")));
    const temp = makeTempHome();
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);
    writeJsonlFile(
      path.join(qoderSessionDir(temp.home, repoDir), `${SID_A}.jsonl`),
      siteSession(repoDir),
      wholeSecondDate(90),
    );

    const res = runCli(["resume", "官网"], { cwd: repoDir, home: temp.home });
    expect(res.status).toBe(0);
    expect(res.stdout.startsWith("【MemRelay 续接】")).toBe(true);
    expect(res.stdout).toContain("公司官网首页");
  });
});
