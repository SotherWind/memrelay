import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import {
  dshAdapter,
  hasZstd,
  parseDshSession,
  projectKeyForCwd,
} from "../src/adapters/dsh/index.js";
import { runHookCommand } from "../src/integrations/hook.js";
import { disableDshHook, enhanceDsh } from "../src/integrations/triggers.js";
import { resolveContext } from "../src/resume/context.js";
import type { NormalizedEvent } from "../src/core/types.js";
import { openReadOnly } from "../src/store/db.js";
import { buildIndex } from "../src/store/indexer.js";
import { getSessionMessages } from "../src/server/conversations.js";
import { allTasks, makeTempHome, wholeSecondDate, type TempHome } from "./helpers.js";

const cleanups: Array<() => void> = [];
const ORIGINAL_HOME_ENV = process.env["MEMRELAY_TEST_HOME"];
const ORIGINAL_MEMRELAY_ENV = process.env["MEMRELAY_HOME"];

afterEach(() => {
  if (ORIGINAL_HOME_ENV === undefined) delete process.env["MEMRELAY_TEST_HOME"];
  else process.env["MEMRELAY_TEST_HOME"] = ORIGINAL_HOME_ENV;
  if (ORIGINAL_MEMRELAY_ENV === undefined) delete process.env["MEMRELAY_HOME"];
  else process.env["MEMRELAY_HOME"] = ORIGINAL_MEMRELAY_ENV;
  while (cleanups.length) cleanups.pop()!();
});

function withEnvFor(temp: TempHome): void {
  process.env["MEMRELAY_TEST_HOME"] = temp.home;
  process.env["MEMRELAY_HOME"] = path.join(temp.home, ".memrelay");
}

const PROJECT = "D:\\Desktop\\dsh-demo";
const T0 = 1792052381937;

const zstdCompress = (zlib as unknown as { zstdCompressSync?: (buf: Buffer) => Buffer })
  .zstdCompressSync;
const canWriteZstd = hasZstd() && zstdCompress !== undefined;

/** 把事件批次写成多帧 zstd 文件（每批一帧，与 dsh 的追加写一致）。 */
function writeDshSession(
  home: string,
  cwd: string,
  sessionUuid: string,
  batches: Record<string, unknown>[][],
  mtime?: Date,
): string {
  const dir = path.join(home, ".dsh", "sessions", projectKeyForCwd(cwd), `session-${sessionUuid}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "session.v4.jsonl.zstd");
  const frames = batches.map((batch) =>
    zstdCompress!(Buffer.from(`${batch.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8")),
  );
  fs.writeFileSync(file, Buffer.concat(frames));
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

function header(cwd: string, sessionUuid: string): Record<string, unknown> {
  return {
    type: "session",
    version: 4,
    id: `session-${sessionUuid}`,
    createdAt: T0,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: "standard",
  };
}

function userMsg(seq: number, text: string): Record<string, unknown> {
  return {
    type: "user/message",
    seq,
    time: T0 + (seq + 1) * 1000,
    data: {
      content: [{ type: "text", text }],
      source: { kind: "user", rpcId: "rpc-1" },
      role: "user",
      id: `msg-${seq}`,
    },
    surfaceOp: "append",
  };
}

function toolCall(seq: number, callId: string, name: string, args: unknown): Record<string, unknown> {
  return {
    type: "tool/call",
    seq,
    time: T0 + (seq + 1) * 1000,
    data: { turn: 1, step: 1, callId, name, arguments: args },
  };
}

function toolResult(seq: number, callId: string, text: string, isError = false): Record<string, unknown> {
  return {
    type: "tool/result",
    seq,
    time: T0 + (seq + 1) * 1000,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: "tool",
        source: { kind: "tool", callId },
        toolCallId: callId,
        content: [{ type: "text", text }],
        isError,
      },
    },
    surfaceOp: "append",
  };
}

function assistantMsg(seq: number, blocks: unknown[]): Record<string, unknown> {
  return {
    type: "assistant/message",
    seq,
    time: T0 + (seq + 1) * 1000,
    data: {
      turn: 1,
      step: 1,
      message: { role: "assistant", content: blocks, source: { kind: "model", provider: "agnes" } },
    },
    surfaceOp: "append",
  };
}

function titleEvent(seq: number, text: string): Record<string, unknown> {
  return {
    type: "session/title",
    seq,
    time: T0 + (seq + 1) * 1000,
    data: { title: text, messageSeqs: [0], source: { kind: "fallback" } },
  };
}

function turnEnd(seq: number, kind: string): Record<string, unknown> {
  return {
    type: "turn/end",
    seq,
    time: T0 + (seq + 1) * 1000,
    data: { turn: 1, reason: { kind } },
  };
}

/** 会话 A：完整的一回合（含工具调用），已完结。 */
function sessionA(): Record<string, unknown>[][] {
  return [
    [header(PROJECT, "aaaaaaaa-1111-4111-8111-111111111111")],
    [
      { type: "turn/start", seq: 0, time: T0 + 500, data: { turn: 1 } },
      userMsg(1, "把首页标题改成 MemRelay，改完跑一下测试"),
      { type: "request/header", seq: 2, time: T0 + 3000, data: { header: { config: { model: "agnes-3.0-flash" } } } },
    ],
    [
      toolCall(3, "call_1", "read_file", { path: "index.html" }),
      toolResult(4, "call_1", "<html><title>demo</title></html>"),
      { type: "agent/inbox/spliced", seq: 5, time: T0 + 6000, data: { target: "next-turn", inserted: [] } },
    ],
    [
      assistantMsg(6, [
        { type: "reasoning", text: "先看一下标题在哪" },
        { type: "text", text: "首页标题已经改成 MemRelay，并跑过了全部测试，你可以放心合并。" },
      ]),
      titleEvent(7, "改首页标题"),
      turnEnd(8, "completed"),
    ],
  ];
}

/** 会话 B：停在工具调用上，最后一回合被中断。 */
function sessionB(): Record<string, unknown>[][] {
  return [
    [header(PROJECT, "bbbbbbbb-2222-4222-8222-222222222222")],
    [userMsg(0, "帮我梳理一下架构文档"), toolCall(1, "call_9", "read_file", { path: "docs/architecture.md" })],
    [turnEnd(2, "aborted")],
  ];
}

/** 会话 C：刚开了个头就断了（没有 turn/end，没有标题）。 */
function sessionC(): Record<string, unknown>[][] {
  return [
    [header(PROJECT, "cccccccc-3333-4333-8333-333333333333")],
    [userMsg(0, "继续做上一次没做完的事情")],
  ];
}

function setupDshHome(): TempHome {
  const temp = makeTempHome();
  cleanups.push(temp.cleanup);
  const aged = wholeSecondDate(10); // 拨旧 mtime，避免落进"3 分钟内=进行中"的窗口
  writeDshSession(temp.home, PROJECT, "aaaaaaaa-1111-4111-8111-111111111111", sessionA(), aged);
  writeDshSession(temp.home, PROJECT, "bbbbbbbb-2222-4222-8222-222222222222", sessionB(), aged);
  writeDshSession(temp.home, PROJECT, "cccccccc-3333-4333-8333-333333333333", sessionC(), aged);
  return temp;
}

describe("DeepSeek Harness 适配器", () => {
  it("projectKey：与 dsh 的目录编码一致（分隔符折叠、特殊字符转义）", () => {
    expect(projectKeyForCwd("D:\\Desktop\\dsh")).toBe("--D-Desktop-dsh--");
    expect(projectKeyForCwd("C:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace")).toBe(
      "--C-Users-Administrator-Documents-deepseek-harness-default-workspace--",
    );
    expect(projectKeyForCwd("C:\\My Projects\\demo")).toBe("--C-My~0020Projects-demo--");
    expect(projectKeyForCwd("/home/user/proj")).toBe("--home-user-proj--");
  });

  it("事件映射：用户/助手/工具调用/工具结果/标题/turn 结束都解析正确，噪声跳过", () => {
    const recordsA = sessionA().flat();
    const { messages, state } = parseDshSession(recordsA);
    expect(state.nativeId).toBe("session-aaaaaaaa-1111-4111-8111-111111111111");
    expect(state.cwd).toBe(PROJECT);
    expect(state.title).toBe("改首页标题");
    expect(state.lastTurnEnd).toBe("completed");
    expect(state.firstUserMessage).toContain("MemRelay");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(messages[1]!.parts[0]!.kind).toBe("tool_call");
    expect(messages[1]!.parts[0]!.toolName).toBe("read_file");
    expect(messages[2]!.parts[0]!.kind).toBe("tool_result");
    expect(messages[2]!.parts[0]!.text).toContain("html");
    expect(messages[3]!.parts.map((p) => p.kind)).toEqual(["reasoning", "text"]);

    const { state: stateB } = parseDshSession(sessionB().flat());
    expect(stateB.lastTurnEnd).toBe("aborted");
  });

  it.runIf(canWriteZstd)("扫描：多帧文件解析出元数据、标题与中断信号", async () => {
    const temp = setupDshHome();
    const adapter = dshAdapter();
    const detection = await adapter.detect(temp.env);
    expect(detection.installed).toBe(true);

    const scans = await adapter.scanAll(temp.env);
    expect(scans).toHaveLength(3);
    const byId = new Map(scans.map((s) => [s.id, s]));
    const a = byId.get("dsh:session-aaaaaaaa-1111-4111-8111-111111111111")!;
    expect(a.cwd).toBe(PROJECT);
    expect(a.tail.lastTitle).toBe("改首页标题");
    expect(a.startedAt).toBe(new Date(T0).toISOString());

    const b = byId.get("dsh:session-bbbbbbbb-2222-4222-8222-222222222222")!;
    expect(b.tail.statusInfo.pendingToolCallIds).toContain("call_9");
    expect(b.tail.statusInfo.errorDetected).toBe(true);

    const c = byId.get("dsh:session-cccccccc-3333-4333-8333-333333333333")!;
    expect(c.tail.statusInfo.lastUserMessageUnanswered).toBe(true);

    // 项目过滤：目录名由 cwd 编码而来，其他项目扫不到
    const other = await adapter.scanProject(
      { projectRoot: "D:\\Desktop\\other", cwd: "D:\\Desktop\\other" },
      temp.env,
    );
    expect(other).toHaveLength(0);
  });

  it.runIf(canWriteZstd)("读取：会话事件 + 按顺序的消息，工具片段完整", async () => {
    const temp = setupDshHome();
    const adapter = dshAdapter();
    const scans = await adapter.scanAll(temp.env);
    const a = scans.find((s) => s.id.includes("aaaaaaaa"))!;

    const events: NormalizedEvent[] = [];
    for await (const event of adapter.readSession(a)) events.push(event);
    const session = events[0]!;
    expect(session.kind).toBe("session");
    if (session.kind === "session") {
      expect(session.session.title).toBe("改首页标题");
      expect(session.session.cwd).toBe(PROJECT);
      expect(session.session.firstUserMessage).toContain("MemRelay");
      expect(session.session.rawRecords).toBe(10);
    }
    const messages = events.filter((e) => e.kind === "message");
    expect(messages).toHaveLength(4);
    const first = messages[0]!;
    if (first.kind === "message") {
      expect(first.message.role).toBe("user");
      expect(first.message.parts[0]!.text).toContain("把首页标题改成");
    }
    const toolMsg = messages[1]!;
    if (toolMsg.kind === "message") {
      expect(toolMsg.message.parts[0]!.kind).toBe("tool_call");
      expect(toolMsg.message.parts[0]!.json).toEqual({ path: "index.html" });
    }
  });

  it.runIf(canWriteZstd)("入库：任务列表可见、状态正确；二次索引跳过", async () => {
    const temp = setupDshHome();
    const adapter = dshAdapter();

    const stats = await buildIndex(temp.env, { adapters: [adapter] });
    expect(stats.updated).toBe(3);
    expect(stats.failed).toBe(0);

    const db = openReadOnly(temp.env);
    try {
      const rowA = db
        .prepare("SELECT status FROM sessions WHERE id = ?")
        .get("dsh:session-aaaaaaaa-1111-4111-8111-111111111111") as { status: string } | undefined;
      expect(rowA?.status).toBe("done");
      const rowB = db
        .prepare("SELECT status FROM sessions WHERE id = ?")
        .get("dsh:session-bbbbbbbb-2222-4222-8222-222222222222") as { status: string } | undefined;
      expect(rowB?.status).toBe("interrupted");

      const page = getSessionMessages(db, temp.env, "dsh:session-aaaaaaaa-1111-4111-8111-111111111111", {});
      expect(page?.total).toBe(4);
      expect(page!.messages[0]!.parts[0]!.text).toContain("把首页标题改成");

      const tasks = allTasks(db, temp.env);
      const titles = tasks.filter((t) => t.project.includes("dsh-demo")).map((t) => t.title);
      expect(titles).toContain("改首页标题");
      expect(titles).toContain("帮我梳理一下架构文档"); // 无标题的会话回退首条用户消息
    } finally {
      db.close();
    }

    const stats2 = await buildIndex(temp.env, { adapters: [adapter] });
    expect(stats2.updated).toBe(0);
    expect(stats2.skipped).toBe(3);
  });

  it("hooks 桥安装/撤销：写桥配置与 home patch；撤销只摘标记块，patch 无剩余内容时删文件", () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);

    const first = enhanceDsh(temp.env);
    expect(first.enabled).toBe(true);

    const hooksFile = path.join(temp.home, ".dsh", "hooks.json");
    const content = JSON.parse(fs.readFileSync(hooksFile, "utf8")) as { hooks: Record<string, unknown> };
    for (const event of ["SessionStart", "Stop"]) {
      expect(JSON.stringify(content.hooks[event])).toContain("--flavor dsh");
    }
    const patchFile = path.join(temp.home, ".dsh", "cordis.patch.yml");
    const patch = fs.readFileSync(patchFile, "utf8");
    // 追加新插件必须走 insert 列表（裸条目会被 dsh 当"非插入补丁"拒绝）
    expect(patch).toContain("- insert:");
    expect(patch).toContain("@deepseek-ai/dsh-hooks-claude-code");
    expect(patch).toContain(hooksFile.replace(/\\/g, "/"));

    const second = enhanceDsh(temp.env);
    expect(second.already).toBe(true);

    const removed = disableDshHook(temp.env);
    expect(removed.enabled).toBe(false);
    // patch 里只剩我们写的标记块 → 整文件删除（空/纯注释的 patch 会让 dsh 启动失败）
    expect(fs.existsSync(patchFile)).toBe(false);
    const after = JSON.parse(fs.readFileSync(hooksFile, "utf8")) as { hooks?: Record<string, unknown> };
    expect(JSON.stringify(after.hooks?.["Stop"] ?? [])).not.toContain("--flavor dsh");
  });

  it("hooks 桥安装：用户自己的 home patch 内容保留，撤销只摘掉 memrelay 块", () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    const patchFile = path.join(temp.home, ".dsh", "cordis.patch.yml");
    fs.mkdirSync(path.dirname(patchFile), { recursive: true });
    fs.writeFileSync(
      patchFile,
      '- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    model: deepseek-flash\n',
      "utf8",
    );

    enhanceDsh(temp.env);
    const installed = fs.readFileSync(patchFile, "utf8");
    expect(installed).toContain("agent-default-model");
    expect(installed).toContain("@deepseek-ai/dsh-hooks-claude-code");

    disableDshHook(temp.env);
    const after = fs.readFileSync(patchFile, "utf8");
    expect(after).toContain("agent-default-model");
    expect(after).not.toContain("dsh-hooks-claude-code");
    expect(after).not.toContain("memrelay");
  });

  it.runIf(canWriteZstd)("hook 事件：SessionStart 输出 JSON 提示；Stop 按 session_id 单会话索引", async () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    withEnvFor(temp);

    // hint 的会话要落在"当前项目"里：项目根按引擎自己的检测口径取（可能是仓库根，不是 cwd）
    const projectRoot = resolveContext().project.projectRoot;
    const hintId = "hint-1111-4111-8111-111111111111";
    writeDshSession(
      temp.home,
      projectRoot,
      hintId,
      [[header(projectRoot, hintId)], [userMsg(0, "帮我重构这个包，先看目录结构")]],
      wholeSecondDate(10),
    );
    await buildIndex(temp.env, { adapters: [dshAdapter()] });

    // SessionStart：stdout 必须是桥认得的 JSON（纯文本不会注入上下文）
    const lines: string[] = [];
    await runHookCommand(
      (text) => lines.push(text),
      JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: `session-${hintId}`,
        cwd: projectRoot,
        transcript_path: "",
      }),
      { flavor: "dsh" },
    );
    const output = lines.join("\n");
    expect(output).toContain('"hookSpecificOutput"');
    expect(output).toContain('"hookEventName":"SessionStart"');
    expect(output).toContain("中断");

    // Stop：只给 session_id + cwd（transcript_path 恒为空），按编码目录回推文件并增量入库
    const stopId = "stop-2222-4222-8222-222222222222";
    writeDshSession(
      temp.home,
      PROJECT,
      stopId,
      [[header(PROJECT, stopId)], [userMsg(0, "把标题改成对照表")]],
      wholeSecondDate(5),
    );
    await runHookCommand(
      () => {},
      JSON.stringify({ hook_event_name: "Stop", session_id: `session-${stopId}`, cwd: PROJECT, transcript_path: "" }),
      { flavor: "dsh" },
    );
    const db = openReadOnly(temp.env);
    try {
      const row = db
        .prepare("SELECT id FROM sessions WHERE id = ?")
        .get(`dsh:session-${stopId}`) as { id: string } | undefined;
      expect(row?.id).toBe(`dsh:session-${stopId}`);
    } finally {
      db.close();
    }
  });
});
