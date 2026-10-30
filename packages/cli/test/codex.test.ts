import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { codexAdapter, hasZstd, parseCodexRecords } from "../src/adapters/codex/index.js";
import { readSessionDetail } from "../src/resume/session-reader.js";
import {
  decideStatus,
  extractTodos,
  filesTouched,
  lastAssistantText,
  userInstructions,
} from "../src/resume/extract.js";
import { buildAllRanked, selectSession } from "../src/resume/select.js";
import { makeTempHome } from "./helpers.js";
import type { SessionScan } from "../src/adapters/jsonl-family/jsonl-adapter.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const API_PROJECT = "D:/webProject/api-server";
const VUE_PROJECT = "D:/webProject/vue-admin";
const BIRD_PROJECT = "D:/webProject/bird-game";

function fixture(name: string): string {
  return path.resolve(process.cwd(), "test", "fixtures", "codex", name);
}

/** 把 fixture 放进临时 HOME 的 ~/.codex/sessions/2026/10/11/ 下。 */
function setupCodexHome(files: Array<{ fixture: string; as?: string }>): {
  home: string;
  cleanup: () => void;
} {
  const temp = makeTempHome();
  const dir = path.join(temp.home, ".codex", "sessions", "2026", "10", "11");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    fs.copyFileSync(fixture(f.fixture), path.join(dir, f.as ?? f.fixture));
  }
  return { home: temp.home, cleanup: temp.cleanup };
}

function envOf(home: string) {
  return { home, platform: process.platform, env: {} as Record<string, string | undefined> };
}

function scanByFile(scans: SessionScan[], filePart: string): SessionScan {
  const found = scans.find((s) => s.sourcePath.includes(filePart));
  if (!found) throw new Error(`missing ${filePart}: ${scans.map((s) => s.sourcePath).join(", ")}`);
  return found;
}

function refOf(scan: SessionScan) {
  const { tail: _tail, ...ref } = scan;
  return ref;
}

describe("Codex 适配器", () => {
  it("按项目扫描会话，只返回项目内的", async () => {
    const setup = setupCodexHome([
      { fixture: "rollout-basic.jsonl" },
      { fixture: "rollout-interrupted.jsonl" },
    ]);
    cleanups.push(setup.cleanup);
    const adapter = codexAdapter();
    const detection = await adapter.detect(envOf(setup.home));
    expect(detection.installed).toBe(true);

    const apiScans = await adapter.scanProject(
      { projectRoot: API_PROJECT, cwd: API_PROJECT },
      envOf(setup.home),
    );
    expect(apiScans).toHaveLength(1);
    expect(apiScans[0]!.id).toBe("codex:c0de0001-1111-4111-8111-111111111111");
    expect(apiScans[0]!.cwd).toBe("D:\\webProject\\api-server");

    const vueScans = await adapter.scanProject(
      { projectRoot: VUE_PROJECT, cwd: VUE_PROJECT },
      envOf(setup.home),
    );
    expect(vueScans).toHaveLength(1);
    expect(vueScans[0]!.id).toBe("codex:c0de0002-2222-4222-8222-222222222222");
  });

  it("解析消息：用户指令去重、环境注入过滤、思考与管理工具", async () => {
    const setup = setupCodexHome([{ fixture: "rollout-basic.jsonl" }]);
    cleanups.push(setup.cleanup);
    const adapter = codexAdapter();
    const scans = await adapter.scanProject(
      { projectRoot: API_PROJECT, cwd: API_PROJECT },
      envOf(setup.home),
    );
    const detail = await readSessionDetail(adapter, refOf(scanByFile(scans, "rollout-basic")));

    const instructions = userInstructions(detail.branchMessages);
    expect(instructions).toHaveLength(1); // event_msg 与 response_item 只算一次
    expect(instructions[0]).toContain("分页排序");
    expect(instructions[0]).not.toContain("environment_context");

    const todos = extractTodos(detail.branchMessages);
    expect(todos).toHaveLength(4);
    expect(todos[0]).toEqual({ content: "读接口文档", status: "done" });

    const files = filesTouched(detail.branchMessages);
    expect(files.join("\n")).toContain("src/routes/users.ts");

    // 推理内容只取 summary，不泄露 encrypted
    const reasoning = detail.branchMessages
      .flatMap((m) => m.parts)
      .filter((p) => p.kind === "reasoning");
    expect(reasoning.length).toBeGreaterThan(0);
    expect(reasoning.every((p) => !p.text?.includes("gAAAAA"))).toBe(true);
  });

  it("状态：task_complete 且待办清完 → 完成", async () => {
    const setup = setupCodexHome([{ fixture: "rollout-basic.jsonl" }]);
    cleanups.push(setup.cleanup);
    const adapter = codexAdapter();
    const scans = await adapter.scanProject(
      { projectRoot: API_PROJECT, cwd: API_PROJECT },
      envOf(setup.home),
    );
    const detail = await readSessionDetail(adapter, refOf(scanByFile(scans, "rollout-basic")));
    const status = decideStatus(detail.statusInfo, detail.branchMessages, 0, 3000 * 60 * 1000);
    expect(status).toBe("done");
  });

  it("状态：turn_aborted → 中断", async () => {
    const setup = setupCodexHome([{ fixture: "rollout-interrupted.jsonl" }]);
    cleanups.push(setup.cleanup);
    const adapter = codexAdapter();
    const scans = await adapter.scanProject(
      { projectRoot: VUE_PROJECT, cwd: VUE_PROJECT },
      envOf(setup.home),
    );
    const scan = scanByFile(scans, "rollout-interrupted");
    expect(scan.tail.statusInfo.errorDetected).toBe(true);
    const detail = await readSessionDetail(adapter, refOf(scan));
    const status = decideStatus(detail.statusInfo, detail.branchMessages, 0, 3000 * 60 * 1000);
    expect(status).toBe("interrupted");
  });

  it("threads 表提供标题与分支（只读）", async () => {
    const setup = setupCodexHome([{ fixture: "rollout-basic.jsonl" }]);
    cleanups.push(setup.cleanup);
    const dir = path.join(setup.home, ".codex");
    const file = path.join(dir, "sessions", "2026", "10", "11", "rollout-basic.jsonl");
    const db = new DatabaseSync(path.join(dir, "state_1.sqlite"));
    db.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, git_branch TEXT, updated_at_ms INTEGER)",
    );
    db.prepare(
      "INSERT INTO threads (id, rollout_path, cwd, title, git_branch, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "c0de0001-1111-4111-8111-111111111111",
      file,
      "\\\\?\\D:\\webProject\\api-server",
      "用户接口分页改造",
      "feat/pagination",
      Date.now(),
    );
    db.close();

    const adapter = codexAdapter();
    const scans = await adapter.scanProject(
      { projectRoot: API_PROJECT, cwd: API_PROJECT },
      envOf(setup.home),
    );
    const scan = scanByFile(scans, "rollout-basic");
    expect(scan.tail.lastTitle).toBe("用户接口分页改造");
    expect(scan.gitBranch).toBe("feat/pagination");
  });

  it.runIf(hasZstd())(".jsonl.zst 能解压解析", async () => {
    const setup = setupCodexHome([]);
    cleanups.push(setup.cleanup);
    const dir = path.join(setup.home, ".codex", "sessions", "2026", "10", "11");
    const raw = fs.readFileSync(fixture("rollout-basic.jsonl"));
    const zstdCompress = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer })
      .zstdCompressSync;
    fs.writeFileSync(path.join(dir, "rollout-zst-01.jsonl.zst"), zstdCompress!(raw));

    const adapter = codexAdapter();
    const scans = await adapter.scanProject(
      { projectRoot: API_PROJECT, cwd: API_PROJECT },
      envOf(setup.home),
    );
    expect(scans).toHaveLength(1);
    const detail = await readSessionDetail(adapter, refOf(scans[0]!));
    expect(userInstructions(detail.branchMessages)[0]).toContain("分页排序");
  });

  it("容忍最后一行写了一半", async () => {
    const setup = setupCodexHome([{ fixture: "rollout-basic.jsonl" }]);
    cleanups.push(setup.cleanup);
    const file = path.join(setup.home, ".codex", "sessions", "2026", "10", "11", "rollout-basic.jsonl");
    fs.appendFileSync(file, '{"timestamp":"2026-10-11T06:03:00.000Z","type":"response_item","payl');

    const adapter = codexAdapter();
    const scans = await adapter.scanProject(
      { projectRoot: API_PROJECT, cwd: API_PROJECT },
      envOf(setup.home),
    );
    const detail = await readSessionDetail(adapter, refOf(scans[0]!));
    expect(detail.branchMessages.length).toBeGreaterThan(0);
  });
});

describe("Codex 0.16x 新格式（item_completed）", () => {
  /** 把两个 fixture 放进临时 HOME；可指定 mtime 年龄。 */
  function setupNewFormatHome(files: Array<{ fixture: string; as: string; ageMin: number }>): {
    home: string;
    cleanup: () => void;
  } {
    const temp = makeTempHome();
    const dir = path.join(temp.home, ".codex", "sessions", "2026", "10", "13");
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) {
      const target = path.join(dir, f.as);
      fs.copyFileSync(fixture(f.fixture), target);
      const past = new Date(Date.now() - f.ageMin * 60 * 1000);
      fs.utimesSync(target, past, past);
    }
    return { home: temp.home, cleanup: temp.cleanup };
  }

  it("解析：用户指令去重、AGENTS.md/环境注入过滤、助手与思考不重复", async () => {
    const setup = setupNewFormatHome([
      { fixture: "rollout-v0162.jsonl", as: "rollout-work.jsonl", ageMin: 40 },
    ]);
    cleanups.push(setup.cleanup);
    const adapter = codexAdapter();
    const scans = await adapter.scanProject(
      { projectRoot: BIRD_PROJECT, cwd: BIRD_PROJECT },
      envOf(setup.home),
    );
    expect(scans).toHaveLength(1);
    const detail = await readSessionDetail(adapter, refOf(scanByFile(scans, "work.jsonl")));

    // 你的原始指令：只有真正的提问，且只出现一次
    const instructions = userInstructions(detail.branchMessages);
    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toBe("做一个打飞机小游戏，React + Vite，注意测试驱动");

    // 助手文本经 response_item 与 AgentMessage 双份写入，只保留一份
    const assistantTexts = detail.branchMessages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.parts.filter((p) => p.kind === "text" && p.text))
      .map((p) => p.text!.trim());
    expect(assistantTexts.filter((t) => t.includes("脚手架搭好了"))).toHaveLength(1);
    expect(assistantTexts.filter((t) => t.includes("player.ts 第 42 行"))).toHaveLength(1);

    // 思考同理只留一份；加密内容不泄露
    const reasoning = detail.branchMessages.flatMap((m) =>
      m.parts.filter((p) => p.kind === "reasoning"),
    );
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]!.text).toContain("先看看工作区现状");
    expect(reasoning[0]!.text).not.toContain("gAAAA");

    // exec_command 归类为 shell；CommandExecution item 与 function_call 按 call_id 去重
    const calls = detail.branchMessages.flatMap((m) => m.toolCalls);
    expect(calls.map((c) => c.toolCallId).sort()).toEqual(["call_a", "call_b", "call_c"]);
    expect(calls.every((c) => c.category === "shell")).toBe(true);

    // 最后进展不再是空的：取自最后一条助手消息
    expect(lastAssistantText(detail.branchMessages)).toContain("player.ts 第 42 行");
  });

  it("状态：末尾有失败命令 → 中断（write_stdin failed / Process exited with code 1）", async () => {
    const setup = setupNewFormatHome([
      { fixture: "rollout-v0162.jsonl", as: "rollout-work.jsonl", ageMin: 40 },
    ]);
    cleanups.push(setup.cleanup);
    const adapter = codexAdapter();
    const scans = await adapter.scanProject(
      { projectRoot: BIRD_PROJECT, cwd: BIRD_PROJECT },
      envOf(setup.home),
    );
    const detail = await readSessionDetail(adapter, refOf(scanByFile(scans, "work.jsonl")));
    expect(detail.statusInfo.lastToolError).toContain("write_stdin failed");
    const status = decideStatus(detail.statusInfo, detail.branchMessages, 0, 4000 * 60 * 1000);
    expect(status).toBe("interrupted");
  });

  it("空壳会话不参与续接：只有提问、没有产出的会话被跳过", async () => {
    const setup = setupNewFormatHome([
      { fixture: "rollout-v0162.jsonl", as: "rollout-work.jsonl", ageMin: 40 },
      { fixture: "rollout-shell.jsonl", as: "rollout-shell.jsonl", ageMin: 5 }, // 更近，但没产出
    ]);
    cleanups.push(setup.cleanup);
    const adapter = codexAdapter();
    const env = envOf(setup.home);
    const scans = await adapter.scanProject({ projectRoot: BIRD_PROJECT, cwd: BIRD_PROJECT }, env);
    expect(scans).toHaveLength(2);

    const ranked = await buildAllRanked([adapter], scans, {
      keyword: "",
      cwd: BIRD_PROJECT,
      gitChangedFiles: [],
      now: Date.now(),
    });
    const shell = ranked.find((r) => r.scan.sourcePath.includes("shell.jsonl"))!;
    const work = ranked.find((r) => r.scan.sourcePath.includes("work.jsonl"))!;
    expect(shell.hasContent).toBe(false);
    expect(work.hasContent).toBe(true);

    const selection = selectSession(ranked, "");
    expect(selection.mode).toBe("single");
    expect(selection.chosen!.scan.sourcePath).toContain("work.jsonl");
  });

  it("全是空壳会话时：给出明确说明而不是硬接一个", async () => {
    const setup = setupNewFormatHome([
      { fixture: "rollout-shell.jsonl", as: "rollout-shell.jsonl", ageMin: 5 },
    ]);
    cleanups.push(setup.cleanup);
    const adapter = codexAdapter();
    const env = envOf(setup.home);
    const scans = await adapter.scanProject({ projectRoot: BIRD_PROJECT, cwd: BIRD_PROJECT }, env);
    const ranked = await buildAllRanked([adapter], scans, {
      keyword: "",
      cwd: BIRD_PROJECT,
      gitChangedFiles: [],
      now: Date.now(),
    });
    const selection = selectSession(ranked, "");
    expect(selection.mode).toBe("empty");
    expect(selection.onlyEmpty).toBe(true);
  });
});

describe("parseCodexRecords 纯函数", () => {
  it("未知记录类型保留为 system_event", () => {
    const { messages } = parseCodexRecords([
      { timestamp: "t", type: "mystery_record", payload: { foo: "bar" } },
    ]);
    // 顶层未知类型不产出消息（只处理 response_item / event_msg），由适配器层再兜底
    expect(messages).toHaveLength(0);
  });

  it("tool 输出 Exit code 非零判定为错误", () => {
    const { messages } = parseCodexRecords([
      {
        timestamp: "t",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "c1", output: "Exit code: 2\n boom" },
      },
    ]);
    expect(messages[0]!.toolResults[0]!.isError).toBe(true);
  });

  it("去重只作用于同一回合：两轮相同的“继续”都保留", () => {
    const user = (text: string) => ({
      timestamp: "t",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    const { messages } = parseCodexRecords([
      { type: "session_meta", payload: { id: "s1", cwd: BIRD_PROJECT } },
      { type: "turn_context", payload: { cwd: BIRD_PROJECT } },
      user("继续"),
      { type: "task_complete", payload: { last_agent_message: "第一轮完成" } },
      { type: "turn_context", payload: { cwd: BIRD_PROJECT } },
      user("继续"),
    ]);
    expect(messages.filter((message) => message.isUserPrompt)).toHaveLength(2);
  });
});
