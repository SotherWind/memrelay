import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { claudeCodeAdapter } from "../src/adapters/claude-code/index.js";
import { qoderAdapter } from "../src/adapters/qoder/index.js";
import {
  readSessionDetail,
  findChainMarker,
  containsMemrelayCall,
} from "../src/resume/session-reader.js";
import {
  decideStatus,
  extractTodos,
  filesRead,
  filesTouched,
  userInstructions,
} from "../src/resume/extract.js";
import { makeTempHome, setupFakeHome, FIXTURE_PROJECTS } from "./helpers.js";
import type { SessionScan } from "../src/adapters/jsonl-family/jsonl-adapter.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function scanByFile(scans: SessionScan[], filePart: string): SessionScan {
  const found = scans.find((s) => s.sourcePath.includes(filePart));
  if (!found) {
    throw new Error(`missing scan ${filePart}: ${scans.map((s) => s.sourcePath).join(", ")}`);
  }
  return found;
}

function refOf(scan: SessionScan) {
  const { tail: _tail, ...ref } = scan;
  return ref;
}

describe("Qoder 适配器", () => {
  it("检测会话目录并列出会话", async () => {
    const temp = setupFakeHome({
      projectPath: FIXTURE_PROJECTS.demo,
      qoderSessions: [{ file: "demo-site.jsonl" }],
    });
    cleanups.push(temp.cleanup);
    const adapter = qoderAdapter();
    const detection = await adapter.detect(temp.env);
    expect(detection.installed).toBe(true);

    const scans = await adapter.scanProject(
      { projectRoot: FIXTURE_PROJECTS.demo, cwd: FIXTURE_PROJECTS.demo },
      temp.env,
    );
    expect(scans).toHaveLength(1);
    const demo = scanByFile(scans, "demo-site.jsonl");
    expect(demo.gitBranch).toBe("main");
    expect(demo.startedAt).toBe("2026-10-12T07:30:00.000Z");
    expect(demo.tail.lastTitle).toContain("公司官网首页");
  });

  it("解析消息、工具调用、待办与文件改动", async () => {
    const temp = setupFakeHome({
      projectPath: FIXTURE_PROJECTS.demo,
      qoderSessions: [{ file: "demo-site.jsonl" }],
    });
    cleanups.push(temp.cleanup);
    const adapter = qoderAdapter();
    const scans = await adapter.scanProject(
      { projectRoot: FIXTURE_PROJECTS.demo, cwd: FIXTURE_PROJECTS.demo },
      temp.env,
    );
    const detail = await readSessionDetail(adapter, refOf(scanByFile(scans, "demo-site.jsonl")));

    const instructions = userInstructions(detail.branchMessages);
    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toContain("公司官网首页");
    expect(instructions[0]).not.toContain("system-reminder");

    const todos = extractTodos(detail.branchMessages);
    expect(todos).toHaveLength(3);
    expect(todos[1]).toEqual({ content: "首页静态页", status: "in_progress" });

    const files = filesTouched(detail.branchMessages);
    expect(files.join("\n")).toContain("Home.tsx");
  });

  it("状态：中断（工具报错后停下）", async () => {
    const temp = setupFakeHome({
      projectPath: FIXTURE_PROJECTS.db,
      qoderSessions: [{ file: "db-error.jsonl" }],
    });
    cleanups.push(temp.cleanup);
    const adapter = qoderAdapter();
    const scans = await adapter.scanProject(
      { projectRoot: FIXTURE_PROJECTS.db, cwd: FIXTURE_PROJECTS.db },
      temp.env,
    );
    const detail = await readSessionDetail(adapter, refOf(scanByFile(scans, "db-error.jsonl")));
    const status = decideStatus(detail.statusInfo, detail.branchMessages, 0, 2000 * 60 * 1000);
    expect(status).toBe("interrupted");
  });

  it("状态：完成（最后一条是总结、待办清完）", async () => {
    const temp = setupFakeHome({
      projectPath: FIXTURE_PROJECTS.secrets,
      qoderSessions: [{ file: "long-secrets.jsonl" }],
    });
    cleanups.push(temp.cleanup);
    const adapter = qoderAdapter();
    const scans = await adapter.scanProject(
      { projectRoot: FIXTURE_PROJECTS.secrets, cwd: FIXTURE_PROJECTS.secrets },
      temp.env,
    );
    const detail = await readSessionDetail(adapter, refOf(scanByFile(scans, "long-secrets.jsonl")));
    const status = decideStatus(detail.statusInfo, detail.branchMessages, 0, 3000 * 60 * 1000);
    expect(status).toBe("done");

    const files = filesTouched(detail.branchMessages);
    expect(files.join("\n")).toContain("db-troubleshooting.md");
    const read = filesRead(detail.branchMessages);
    expect(read.join("\n")).toContain("app.env");
  });

  it("demo-site 的待办没清完：算中断而不是完成", async () => {
    const temp = setupFakeHome({
      projectPath: FIXTURE_PROJECTS.demo,
      qoderSessions: [{ file: "demo-site.jsonl" }],
    });
    cleanups.push(temp.cleanup);
    const adapter = qoderAdapter();
    const scans = await adapter.scanProject(
      { projectRoot: FIXTURE_PROJECTS.demo, cwd: FIXTURE_PROJECTS.demo },
      temp.env,
    );
    const detail = await readSessionDetail(adapter, refOf(scanByFile(scans, "demo-site.jsonl")));
    const status = decideStatus(detail.statusInfo, detail.branchMessages, 0, 3000 * 60 * 1000);
    expect(status).toBe("interrupted");
  });

  it("IDE 侧 transcript 格式（无 parentUuid 的线性流水账）按顺序整体解析", async () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    // Qoder IDE 用另一套目录编码：小写盘符 + 单横线（d-webProject-ide-check），放在 transcript/ 子目录
    const dir = path.join(temp.home, ".qoder", "projects", "d-webProject-ide-check", "transcript");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(
      path.resolve(process.cwd(), "test", "fixtures", "qoder", "transcript-linear.jsonl"),
      path.join(dir, "transcript-linear.jsonl"),
    );
    const adapter = qoderAdapter();
    const scans = await adapter.scanProject(
      { projectRoot: "D:\\webProject\\ide-check", cwd: "D:\\webProject\\ide-check" },
      temp.env,
    );
    expect(scans).toHaveLength(1); // 目录编码变体也要能命中

    const detail = await readSessionDetail(adapter, refOf(scanByFile(scans, "transcript-linear")));
    // 线性记录整份保留：user + thinking + tool_use + tool_result + text = 5 条；progress/session_meta 跳过
    expect(detail.branchMessages).toHaveLength(5);
    expect(userInstructions(detail.branchMessages)).toEqual(["接着做"]);
    const toolCall = detail.branchMessages.flatMap((m) => m.toolCalls);
    expect(toolCall.some((c) => c.toolName === "Bash")).toBe(true);
    const toolResult = detail.branchMessages.flatMap((m) => m.toolResults);
    expect(toolResult.some((r) => r.content.includes("【MemRelay 续接】"))).toBe(true);
    expect(containsMemrelayCall(detail.branchMessages)).toBe(true);
  });

  it("容忍最后一行写了一半", async () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    const dir = path.join(temp.home, ".qoder", "projects", "d--webproject-demo-site");
    fs.mkdirSync(dir, { recursive: true });
    const src = fs.readFileSync(
      path.join(process.cwd(), "test", "fixtures", "qoder", "demo-site.jsonl"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "partial.jsonl"),
      src + '{"type":"assistant","uuid":"half',
      "utf8",
    );

    const adapter = qoderAdapter();
    const scans = await adapter.scanProject(
      { projectRoot: FIXTURE_PROJECTS.demo, cwd: FIXTURE_PROJECTS.demo },
      temp.env,
    );
    const detail = await readSessionDetail(adapter, refOf(scanByFile(scans, "partial.jsonl")));
    expect(detail.branchMessages.length).toBeGreaterThan(0);
  });
});

describe("Claude Code 适配器", () => {
  it("对话树：压缩边界保留，回退后的分支仍可解析", async () => {
    const temp = setupFakeHome({
      projectPath: FIXTURE_PROJECTS.notes,
      claudeSessions: [{ file: "notes-app.jsonl" }],
    });
    cleanups.push(temp.cleanup);
    const adapter = claudeCodeAdapter();
    const scans = await adapter.scanProject(
      { projectRoot: FIXTURE_PROJECTS.notes, cwd: FIXTURE_PROJECTS.notes },
      temp.env,
    );
    expect(scans).toHaveLength(1);
    const detail = await readSessionDetail(adapter, refOf(scanByFile(scans, "notes-app.jsonl")));

    expect(detail.branchMessages.length).toBeGreaterThan(3);
    expect(detail.branchMessages.some((m) => m.isCompactBoundary)).toBe(true);

    const instructions = userInstructions(detail.branchMessages);
    expect(instructions.some((t) => t.includes("markdown 导出功能"))).toBe(true);
    expect(instructions.some((t) => t.includes("回到上一步"))).toBe(true);

    const files = filesTouched(detail.branchMessages);
    expect(files.join("\n")).toContain("markdown.ts");
  });

  it("链上夹着被跳过的记录（isMeta）时，分支回溯能跨过空档", async () => {
    const temp = setupFakeHome({
      projectPath: "D:/webProject/gap-check",
      claudeSessions: [{ file: "gap.jsonl" }],
    });
    cleanups.push(temp.cleanup);
    const adapter = claudeCodeAdapter();
    const scans = await adapter.scanProject(
      { projectRoot: "D:/webProject/gap-check", cwd: "D:/webProject/gap-check" },
      temp.env,
    );
    expect(scans).toHaveLength(1);
    const detail = await readSessionDetail(adapter, refOf(scanByFile(scans, "gap.jsonl")));

    // isMeta 记录被跳过，但它在链中间：两条助手消息都应该在分支上
    const uuids = detail.branchMessages.map((m) => m.uuid);
    expect(uuids).toContain("9a000000-0000-4000-8000-000000000001");
    expect(uuids).toContain("9a000000-0000-4000-8000-000000000010");
    expect(uuids).toContain("9a000000-0000-4000-8000-000000000030");
    expect(detail.branchMessages.filter((m) => m.role === "assistant")).toHaveLength(2);
  });

  it("识别接手工具自己的会话（调用了 memrelay）", async () => {
    const temp = setupFakeHome({
      projectPath: FIXTURE_PROJECTS.caller,
      claudeSessions: [{ file: "caller-resume.jsonl" }],
    });
    cleanups.push(temp.cleanup);
    const adapter = claudeCodeAdapter();
    const scans = await adapter.scanProject(
      { projectRoot: FIXTURE_PROJECTS.caller, cwd: FIXTURE_PROJECTS.caller },
      temp.env,
    );
    const detail = await readSessionDetail(adapter, refOf(scanByFile(scans, "caller-resume.jsonl")));
    expect(containsMemrelayCall(detail.branchMessages)).toBe(true);
    expect(findChainMarker(detail.branchMessages)).toMatchObject({
      agent: "qoder",
      nativeId: "11111111-1111-4111-8111-111111111111",
      sessionCount: 1,
    });
  });
});
