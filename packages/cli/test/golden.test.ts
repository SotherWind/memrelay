import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { makeTempHome, projectSlugLike, realDir } from "./helpers.js";
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const CLI = path.resolve(process.cwd(), "dist", "cli.mjs");
const hasBuild = fs.existsSync(CLI);

interface RunResult {
  stdout: string;
  status: number;
}

function runCli(
  args: string[],
  opts: { cwd: string; home: string; env?: Record<string, string> },
): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        MEMRELAY_HOME: path.join(opts.home, ".memrelay"),
        USERPROFILE: opts.home,
        HOME: opts.home,
        ...opts.env,
      },
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; status?: number };
    return { stdout: String(e.stdout ?? ""), status: e.status ?? 1 };
  }
}

/** 造一个"Qoder 里做到一半"的会话：官网首页任务，TodoWrite 留了未完成待办。 */
const QODER_SESSION_ID = "g0g0g0g0-0000-4000-8000-000000000000";

function writeQoderInterrupted(home: string, projectPath: string, ageMinutes = 30): void {
  const dir = path.join(home, ".qoder", "projects", projectSlugLike(projectPath));
  fs.mkdirSync(dir, { recursive: true });
  const cwd = JSON.stringify(projectPath);
  const lines = [
    `{"type":"workspace-directories","sessionId":"g0g0g0g0-0000-4000-8000-000000000000","directories":[${cwd}]}`,
    `{"type":"user","uuid":"g0000000-0000-4000-8000-000000000001","timestamp":"2026-10-12T07:30:00.000Z","message":{"role":"user","content":[{"type":"text","text":"帮我设计一个公司官网首页，先出静态页再配通知数据"}]},"parentUuid":null,"isSidechain":false,"cwd":${cwd},"sessionId":"g0g0g0g0-0000-4000-8000-000000000000","gitBranch":"main"}`,
    `{"type":"assistant","uuid":"g0000000-0000-4000-8000-000000000010","timestamp":"2026-10-12T07:31:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"好，我先写首页静态页。"},{"type":"tool_use","id":"call_g0_write1","name":"Write","input":{"file_path":${JSON.stringify(path.join(projectPath, "src", "pages", "Home.tsx"))},"content":"export default function Home() { return null; }"}},{"type":"tool_use","id":"call_g0_todo1","name":"TodoWrite","input":{"todos":[{"content":"首页静态页","status":"completed","activeForm":"写静态页"},{"content":"接入通知数据","status":"in_progress","activeForm":"接入通知数据"}]}}]},"parentUuid":"g0000000-0000-4000-8000-000000000001","isSidechain":false,"cwd":${cwd},"sessionId":"g0g0g0g0-0000-4000-8000-000000000000","gitBranch":"main"}`,
    `{"type":"user","uuid":"g0000000-0000-4000-8000-000000000011","timestamp":"2026-10-12T07:31:05.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_g0_write1","content":"File created successfully"}]},"parentUuid":"g0000000-0000-4000-8000-000000000010","isSidechain":false,"cwd":${cwd},"sessionId":"g0g0g0g0-0000-4000-8000-000000000000","gitBranch":"main"}`,
    `{"type":"user","uuid":"g0000000-0000-4000-8000-000000000012","timestamp":"2026-10-12T07:31:06.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_g0_todo1","content":"Todos updated"}]},"parentUuid":"g0000000-0000-4000-8000-000000000011","isSidechain":false,"cwd":${cwd},"sessionId":"g0g0g0g0-0000-4000-8000-000000000000","gitBranch":"main"}`,
    `{"type":"assistant","uuid":"g0000000-0000-4000-8000-000000000020","timestamp":"2026-10-12T07:32:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"静态页完成，开始接通知数据。先看一下接口返回格式。"},{"type":"tool_use","id":"call_g0_read1","name":"Read","input":{"file_path":${JSON.stringify(path.join(projectPath, "src", "api", "notice.ts"))}}}]},"parentUuid":"g0000000-0000-4000-8000-000000000012","isSidechain":false,"cwd":${cwd},"sessionId":"g0g0g0g0-0000-4000-8000-000000000000","gitBranch":"main"}`,
    `{"type":"active-leaf","sessionId":"g0g0g0g0-0000-4000-8000-000000000000","leafUuid":"g0000000-0000-4000-8000-000000000020","explicit":false,"timestamp":1791796980477}`,
  ];
  const file = path.join(dir, `${QODER_SESSION_ID}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  // mtime 拨回：让"正在写入的当前会话"识别规则不误伤这个 fixture
  const past = new Date(Date.now() - ageMinutes * 60 * 1000);
  fs.utimesSync(file, past, past);
}

/** 造一个"Claude Code 正在跑、刚调用过 memrelay"的调用方会话。 */
const CLAUDE_SESSION_ID = "55555555-5555-4555-8555-555555555555";

function writeClaudeCaller(home: string, projectPath: string, ageMinutes = 0): void {
  const dir = path.join(home, ".claude", "projects", projectSlugLike(projectPath));
  fs.mkdirSync(dir, { recursive: true });
  const cwd = JSON.stringify(projectPath);
  // 直接拼 JSON 会被路径里的反斜杠破坏转义，统一用 JSON.stringify 生成字符串字段
  const markerText = [
    "【MemRelay 续接】",
    `续接自 Qoder:${QODER_SESSION_ID} · 会话数 1 · 2026-10-12 15:30 · ${projectPath} · 会话 qoder:${QODER_SESSION_ID}`,
    "",
    "## 接手须知",
    "- 先用一两句话告诉用户：接的是哪个会话……",
    "",
  ].join("\n");
  const lines = [
    `{"type":"user","uuid":"h0000000-0000-4000-8000-000000000001","timestamp":"2026-10-13T02:00:00.000Z","message":{"role":"user","content":"继续完成生成前端网站的任务"},"parentUuid":null,"isSidechain":false,"cwd":${cwd},"sessionId":"${CLAUDE_SESSION_ID}","gitBranch":"main"}`,
    `{"type":"assistant","uuid":"h0000000-0000-4000-8000-000000000010","timestamp":"2026-10-13T02:00:05.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_relay","name":"Bash","input":{"command":"'/c/Users/dev/.memrelay/bin/memrelay' resume 官网首页","description":"Get handoff"}}]},"parentUuid":"h0000000-0000-4000-8000-000000000001","isSidechain":false,"cwd":${cwd},"sessionId":"${CLAUDE_SESSION_ID}","gitBranch":"main"}`,
    `{"type":"user","uuid":"h0000000-0000-4000-8000-000000000011","timestamp":"2026-10-13T02:00:07.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_relay","content":${JSON.stringify(markerText)}}]},"parentUuid":"h0000000-0000-4000-8000-000000000010","isSidechain":false,"cwd":${cwd},"sessionId":"${CLAUDE_SESSION_ID}","gitBranch":"main"}`,
    `{"type":"assistant","uuid":"h0000000-0000-4000-8000-000000000020","timestamp":"2026-10-13T02:00:20.000Z","message":{"role":"assistant","content":[{"type":"text","text":"接的是 Qoder 里昨天那个官网首页任务。我先看一下当前工作区的状态。"},{"type":"tool_use","id":"toolu_bash_git01","name":"Bash","input":{"command":"git status --porcelain","description":"Check working tree"}}]},"parentUuid":"h0000000-0000-4000-8000-000000000011","isSidechain":false,"cwd":${cwd},"sessionId":"${CLAUDE_SESSION_ID}","gitBranch":"main"}`,
    `{"type":"user","uuid":"h0000000-0000-4000-8000-000000000021","timestamp":"2026-10-13T02:00:21.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_bash_git01","content":" M src/pages/Home.tsx"}]},"parentUuid":"h0000000-0000-4000-8000-000000000020","isSidechain":false,"cwd":${cwd},"sessionId":"${CLAUDE_SESSION_ID}","gitBranch":"main"}`,
  ];
  const file = path.join(dir, `${CLAUDE_SESSION_ID}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  if (ageMinutes > 0) {
    const past = new Date(Date.now() - ageMinutes * 60 * 1000);
    fs.utimesSync(file, past, past);
  }
}

/** 造一个"Codex 刚接手过"的会话：从 Claude Code 的会话接力过来。 */
function writeCodexRelay(home: string, projectPath: string, ageMinutes: number): void {
  const dir = path.join(home, ".codex", "sessions", "2026", "10", "13");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "rollout-2026-10-13T06-00-00-c0de0003-3333-4333-8333-333333333333.jsonl");
  let content = fs.readFileSync(
    path.resolve(process.cwd(), "test", "fixtures", "codex", "rollout-relay.jsonl"),
    "utf8",
  );
  content = content.replaceAll("D:\\\\webProject\\\\relay-target", JSON.stringify(projectPath).slice(1, -1));
  fs.writeFileSync(file, content, "utf8");
  const past = new Date(Date.now() - ageMinutes * 60 * 1000);
  fs.utimesSync(file, past, past);
}

function writeDemoRepo(dir: string): void {
  const exec = execFileSync;
  fs.mkdirSync(path.join(dir, "src", "pages"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "pages", "Home.tsx"),
    "export default function Home() { return null; }\n",
  );
  exec("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  exec("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  exec("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  exec("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  exec("git", ["commit", "-qm", "init"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(
    path.join(dir, "src", "pages", "Home.tsx"),
    "export default function Home() { return <main>官网</main>; }\n",
  );
}

describe.skipIf(!hasBuild)("golden：resume 端到端（伪造 HOME 与项目）", () => {
  it("在 Claude Code 里说「继续」，接上 Qoder 中断的官网任务", () => {
    const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-repo-")));
    const temp = makeTempHome();
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);
    writeDemoRepo(repoDir);
    writeQoderInterrupted(temp.home, repoDir);
    writeClaudeCaller(temp.home, repoDir);

    const result = runCli(["resume", "官网首页"], { cwd: repoDir, home: temp.home });
    expect(result.status).toBe(0);
    const out = result.stdout;

    expect(out.startsWith("【MemRelay 续接】")).toBe(true);
    expect(out).toContain("续接自 Qoder");
    expect(out).toContain("会话 qoder:g0g0g0g0");
    expect(out).not.toContain("claude-code:");
    expect(out).toContain("## 接手须知");
    expect(out).toContain("## 你的原始指令");
    expect(out).toContain("公司官网首页");
    expect(out).toContain("## 计划和待办");
    expect(out).toContain("[~] 接入通知数据");
    expect(out).toContain("## 最后进展");
    expect(out).toContain("开始接通知数据");
    expect(out).toContain("## 改过的文件与当前 git 状态");
    expect(out).toContain("Home.tsx");
    expect(out).toContain("memrelay show qoder:g0g0g0g0");
  });

  it("--out 把续接内容写进文件，stdout 安静", () => {
    const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-repo-")));
    const temp = makeTempHome();
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);
    writeDemoRepo(repoDir);
    writeQoderInterrupted(temp.home, repoDir);
    writeClaudeCaller(temp.home, repoDir);

    const outFile = path.join(repoDir, "relay.md");
    const result = runCli(["resume", "官网首页", "--out", outFile], {
      cwd: repoDir,
      home: temp.home,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
    const written = fs.readFileSync(outFile, "utf8");
    expect(written.startsWith("【MemRelay 续接】")).toBe(true);
    expect(written).toContain("qoder:g0g0g0g0");
  });

  it("没有关键词时接最近一个中断的任务", () => {
    const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-repo-")));
    const temp = makeTempHome();
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);
    writeDemoRepo(repoDir);
    writeQoderInterrupted(temp.home, repoDir);

    const result = runCli(["resume"], { cwd: repoDir, home: temp.home });
    expect(result.status).toBe(0);
    expect(result.stdout.startsWith("【MemRelay 续接】")).toBe(true);
    expect(result.stdout).toContain("qoder:g0g0g0g0");
  });

  it("找不到命中任务时打印候选菜单并提示问用户", () => {
    const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-repo-")));
    const temp = makeTempHome();
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);
    writeDemoRepo(repoDir);
    writeQoderInterrupted(temp.home, repoDir);
    writeClaudeCaller(temp.home, repoDir);

    const result = runCli(["resume", "跟这个完全无关的关键词xyz"], {
      cwd: repoDir,
      home: temp.home,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("候选会话");
    expect(result.stdout).toContain("qoder:g0g0g0g0");
    expect(result.stdout).toContain("问用户");
  });

  it("输出的密钥位置被遮盖", () => {
    const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-repo-")));
    const temp = makeTempHome();
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);
    writeDemoRepo(repoDir);
    writeQoderInterrupted(temp.home, repoDir);
    // 把密钥塞进原始指令
    const dir = path.join(temp.home, ".qoder", "projects", projectSlugLike(repoDir));
    const file = path.join(dir, `${QODER_SESSION_ID}.jsonl`);
    const content = fs.readFileSync(file, "utf8").replace(
      "帮我设计一个公司官网首页",
      "帮我设计一个公司官网首页 GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwx",
    );
    fs.writeFileSync(file, content, "utf8");
    const past = new Date(Date.now() - 30 * 60 * 1000);
    fs.utimesSync(file, past, past);

    const result = runCli(["resume", "官网首页"], { cwd: repoDir, home: temp.home });
    expect(result.stdout).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwx");
    expect(result.stdout).toContain("ghp_");
  });

  it("show 能翻看会话记录", () => {
    const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-repo-")));
    const temp = makeTempHome();
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);
    writeDemoRepo(repoDir);
    writeQoderInterrupted(temp.home, repoDir);

    const result = runCli(["show", "qoder:g0g0g0g0", "--from", "0"], {
      cwd: repoDir,
      home: temp.home,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("会话 qoder:g0g0g0g0");
    expect(result.stdout).toContain("公司官网首页");
    expect(result.stdout).toContain("TodoWrite");
  });

  it("ping 与帮助信息可用", () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    const ping = runCli(["ping"], { cwd: process.cwd(), home: temp.home });
    expect(ping.stdout.trim()).toBe("MEMRELAY-OK 0.1.0");
    const help = runCli([], { cwd: process.cwd(), home: temp.home });
    expect(help.stdout).toContain("memrelay resume");
    expect(help.stdout).toContain("memrelay setup");
  });

  it("三段接力：Qoder → Claude Code → Codex，接手方能拿到整条链的进展", () => {
    const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-repo-")));
    const temp = makeTempHome();
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);
    writeDemoRepo(repoDir);
    writeQoderInterrupted(temp.home, repoDir, 1800); // 第一段：Qoder（30 小时前）
    writeClaudeCaller(temp.home, repoDir, 420); // 第二段：Claude Code 接过一次力（7 小时前）
    writeCodexRelay(temp.home, repoDir, 30); // 第三段：Codex 又接过一次力

    const result = runCli(["resume"], { cwd: repoDir, home: temp.home });
    expect(result.status).toBe(0);
    const out = result.stdout;

    // 接的是最新一段：Codex
    expect(out).toContain("会话 codex:c0de0003-3333-4333-8333-333333333333");
    expect(out).toContain("接力链：Qoder → Claude Code → Codex");
    // 机器可读的链根信息（会话数 = 3 段）
    expect(out).toContain(`续接自 Qoder:${QODER_SESSION_ID} · 会话数 3 ·`);
    // 前几段的进展都在里头
    expect(out).toContain("## 接力历史（前几段）");
    expect(out).toContain("Qoder（");
    expect(out).toContain("Claude Code（");
    expect(out).toContain("帮我设计一个公司官网首页");
    expect(out).toContain("接的是 Qoder 里昨天那个官网首页任务");
    // 当前这段自己的进展
    expect(out).toContain("## 你的原始指令");
    expect(out).toContain("继续完成生成前端网站的任务");
  });

  it("doctor 建索引后，search 能搜到两个字的中文词", () => {
    const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-repo-")));
    const temp = makeTempHome();
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);
    writeDemoRepo(repoDir);
    writeQoderInterrupted(temp.home, repoDir);

    const doctor = runCli(["doctor"], { cwd: repoDir, home: temp.home });
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain("索引库");

    const found = runCli(["search", "官网"], { cwd: repoDir, home: temp.home });
    expect(found.status).toBe(0);
    expect(found.stdout).toContain("搜索「官网」");
    expect(found.stdout).toContain("qoder:g0g0g0g0");
    expect(found.stdout).toContain("memrelay show qoder:g0g0g0g0");

    const missing = runCli(["search", "完全不存在ZZZ"], { cwd: repoDir, home: temp.home });
    expect(missing.status).toBe(0);
    expect(missing.stdout).toContain("没有在项目");
  });

  it("search 在只读方式下可用（沙箱场景）", () => {
    const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-repo-")));
    const temp = makeTempHome();
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);
    writeDemoRepo(repoDir);
    writeQoderInterrupted(temp.home, repoDir);
    runCli(["doctor"], { cwd: repoDir, home: temp.home });

    // 把库目录设为只读（模拟沙箱禁写）——search 仍然可用
    const dbFile = path.join(temp.home, ".memrelay", "memrelay.db");
    expect(fs.existsSync(dbFile)).toBe(true);
    const before = fs.statSync(dbFile).mtimeMs;
    const result = runCli(["search", "官网"], { cwd: repoDir, home: temp.home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("qoder:g0g0g0g0");
    expect(fs.statSync(dbFile).mtimeMs).toBe(before); // 没有写库
  });
});
