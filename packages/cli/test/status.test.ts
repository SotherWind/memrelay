import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { analyzeStatus, type LocalMessage } from "../src/adapters/jsonl-family/records.js";
import { walkBranch } from "../src/adapters/jsonl-family/parser.js";
import { decideStatus, extractTodos } from "../src/resume/extract.js";
import { openWritable } from "../src/store/db.js";
import {
  backfillSessionStats,
  computeSessionStats,
  statusFromSignals,
  STATS_VERSION,
} from "../src/store/session-stats.js";
import { makeTempHome } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function message(
  uuid: string,
  parent: string | undefined,
  role: "user" | "assistant" | "tool",
  opts: { calls?: string[]; results?: string[]; text?: string } = {},
): LocalMessage {
  return {
    uuid,
    parentUuid: parent,
    role,
    isSidechain: false,
    isCompactBoundary: false,
    parts: opts.text ? [{ kind: "text" as const, text: opts.text }] : [],
    toolCalls: (opts.calls ?? []).map((id) => ({
      toolCallId: id,
      category: "other" as const,
      input: undefined,
      isPlan: false,
      files: [],
    })),
    toolResults: (opts.results ?? []).map((id) => ({
      toolCallId: id,
      content: "ok",
      isError: false,
    })),
    isUserPrompt: role === "user",
  };
}

describe("TaskCreate / TaskUpdate 待办", () => {
  function planMessage(
    uuid: string,
    parts: Array<{ json: Record<string, unknown>; callId: string }>,
  ): LocalMessage {
    return {
      uuid,
      role: "assistant",
      isSidechain: false,
      isCompactBoundary: false,
      parts: parts.map((p) => ({ kind: "plan" as const, json: p.json, toolCallId: p.callId })),
      toolCalls: [],
      toolResults: [],
      isUserPrompt: false,
    };
  }

  function resultMessage(
    uuid: string,
    results: Array<{ callId: string; text: string }>,
  ): LocalMessage {
    return {
      uuid,
      role: "tool",
      isSidechain: false,
      isCompactBoundary: false,
      parts: results.map((r) => ({
        kind: "tool_result" as const,
        text: r.text,
        toolCallId: r.callId,
        status: "ok" as const,
      })),
      toolCalls: [],
      toolResults: results.map((r) => ({
        toolCallId: r.callId,
        content: r.text,
        isError: false,
      })),
      isUserPrompt: false,
    };
  }

  it("创建项的真实 id 来自工具结果，后续更新按 id 对齐", () => {
    const messages = [
      message("u1", undefined, "user"),
      planMessage("a1", [
        { json: { subject: "搭页面" }, callId: "c1" },
        { json: { subject: "写测试" }, callId: "c2" },
      ]),
      resultMessage("r1", [
        { callId: "c1", text: "Task #1 created successfully: 搭页面" },
        { callId: "c2", text: "Task #2 created successfully: 写测试" },
      ]),
      planMessage("a2", [
        { json: { taskId: "1", status: "completed" }, callId: "c3" },
        { json: { taskId: "2", status: "completed" }, callId: "c4" },
      ]),
      resultMessage("r2", [
        { callId: "c3", text: "Updated task #1 status" },
        { callId: "c4", text: "Updated task #2 status" },
      ]),
    ];
    expect(extractTodos(messages)).toEqual([
      { content: "搭页面", status: "done" },
      { content: "写测试", status: "done" },
    ]);
  });
});

describe("pending 只看最后一条助手消息", () => {
  it("历史中段的孤儿调用不再让已收尾的会话判为等待", () => {
    const messages = [
      message("u1", undefined, "user"),
      message("a1", "u1", "assistant", { calls: ["call_orphan"] }),
      message("u2", "a1", "user"),
      message("a2", "u2", "assistant"),
    ];
    expect(analyzeStatus(messages).pendingToolCallIds).toEqual([]);
    expect(
      statusFromSignals(
        {
          pending: false,
          quota: false,
          error: false,
          unanswered: false,
          todosOpen: false,
          lastReal: "assistant",
          replyLen: 1263,
        },
        0,
        10 * 60 * 1000,
      ),
    ).toBe("done");
  });

  it("最后一条助手消息的调用没结果才算等待", () => {
    const messages = [
      message("u1", undefined, "user"),
      message("a1", "u1", "assistant", { calls: ["call_open"] }),
    ];
    expect(analyzeStatus(messages).pendingToolCallIds).toEqual(["call_open"]);
  });

  it("并行调用：兄弟结果补回分支后，两个调用都算已解决", () => {
    const messages = [
      message("a1", undefined, "assistant", { calls: ["c1", "c2"] }),
      message("r1", "a1", "tool", { results: ["c1"] }),
      message("r2", "a1", "tool", { results: ["c2"] }),
    ];
    const { branch } = walkBranch(messages, "r2");
    expect(branch.map((m) => m.uuid)).toEqual(["a1", "r1", "r2"]);
    expect(analyzeStatus(branch).pendingToolCallIds).toEqual([]);
  });
});

describe("完成判定：末条助手是纯文本收尾", () => {
  const OLD = 10 * 60 * 1000;

  it("短回复也算完成（不再看 30 字）", () => {
    const messages = [
      message("u1", undefined, "user", { text: "你好" }),
      message("a1", "u1", "assistant", { text: "你好！有什么可以帮你？" }),
    ];
    expect(analyzeStatus(messages).lastAssistantFinal).toBe(true);
    expect(decideStatus(analyzeStatus(messages), messages, 0, OLD)).toBe("done");
  });

  it("末条助手带工具调用（即使文本很短）不算完成", () => {
    const messages = [
      message("u1", undefined, "user", { text: "读一下文件" }),
      message("a1", "u1", "assistant", { text: "我来看看", calls: ["c1"] }),
      message("r1", "a1", "tool", { results: ["c1"] }),
    ];
    expect(analyzeStatus(messages).lastAssistantFinal).toBe(false);
    expect(decideStatus(analyzeStatus(messages), messages, 0, OLD)).toBe("unknown");
  });

  it("中途工具报错、随后成功修复并收尾：算完成，不算中断", () => {
    const errorResult = message("r1", "a1", "tool", { results: ["c1"] });
    errorResult.toolResults = [{ toolCallId: "c1", content: "error: command failed", isError: true }];
    const messages = [
      message("u1", undefined, "user", { text: "修一下测试" }),
      message("a1", "u1", "assistant", { calls: ["c1"] }),
      errorResult,
      message("a2", "r1", "assistant", { calls: ["c2"] }),
      message("r2", "a2", "tool", { results: ["c2"] }),
      message("a3", "r2", "assistant", { text: "已修复，测试全部通过。" }),
    ];
    const info = analyzeStatus(messages);
    expect(info.lastToolError).toContain("command failed");
    expect(info.errorDetected).toBe(false);
    expect(decideStatus(info, messages, 0, OLD)).toBe("done");
  });

  it("查询时用 replyLen 表示收尾：>0 完成，0 未判定", () => {
    const base = {
      pending: false,
      quota: false,
      error: false,
      unanswered: false,
      todosOpen: false,
      lastReal: "assistant" as const,
    };
    expect(statusFromSignals({ ...base, replyLen: 6 }, 0, OLD)).toBe("done");
    expect(statusFromSignals({ ...base, replyLen: 0 }, 0, OLD)).toBe("unknown");
  });
});

describe("computeSessionStats 与索引口径一致", () => {
  function tempDb(): DatabaseSync {
    const temp = makeTempHome();
    const db = openWritable(temp.env);
    cleanups.push(() => {
      db.close();
      temp.cleanup();
    });
    return db;
  }

  function insertSession(db: DatabaseSync, id: string): void {
    db.prepare(
      "INSERT INTO sessions (id, agent, project_root, cwd, status, status_source) VALUES (?, 'qoder', 'D:/demo', 'D:/demo', 'unknown', 'auto')",
    ).run(id);
  }

  function insertMessage(
    db: DatabaseSync,
    sessionId: string,
    ordinal: number,
    role: string,
    parts: Array<{ kind: string; text?: string; json?: string; toolCallId?: string }>,
  ): void {
    const info = db
      .prepare("INSERT INTO messages (session_id, ordinal, role) VALUES (?, ?, ?)")
      .run(sessionId, ordinal, role);
    parts.forEach((part, idx) => {
      db.prepare(
        "INSERT INTO parts (message_id, idx, kind, text, json, tool_call_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        Number(info.lastInsertRowid),
        idx,
        part.kind,
        part.text ?? null,
        part.json ?? null,
        part.toolCallId ?? null,
      );
    });
  }

  it("老库回填：历史孤儿不算 pending，最后一条未闭合调用才算", () => {
    const db = tempDb();

    insertSession(db, "old-orphan");
    insertMessage(db, "old-orphan", 1, "user", [{ kind: "text", text: "实现登录页" }]);
    insertMessage(db, "old-orphan", 2, "assistant", [
      { kind: "tool_call", toolCallId: "call_orphan" },
    ]);
    insertMessage(db, "old-orphan", 3, "user", [{ kind: "text", text: "继续" }]);
    insertMessage(db, "old-orphan", 4, "assistant", [{ kind: "text", text: "已经完成。" }]);

    insertSession(db, "open-call");
    insertMessage(db, "open-call", 1, "user", [{ kind: "text", text: "读一下文件" }]);
    insertMessage(db, "open-call", 2, "assistant", [
      { kind: "tool_call", toolCallId: "call_open" },
    ]);

    insertSession(db, "resolved");
    insertMessage(db, "resolved", 1, "user", [{ kind: "text", text: "读一下文件" }]);
    insertMessage(db, "resolved", 2, "assistant", [
      { kind: "tool_call", toolCallId: "call_ok" },
    ]);
    insertMessage(db, "resolved", 3, "tool", [
      { kind: "tool_result", toolCallId: "call_ok" },
    ]);
    insertMessage(db, "resolved", 4, "assistant", [{ kind: "text", text: "读完了。" }]);

    const stats = computeSessionStats(db, ["old-orphan", "open-call", "resolved"]);
    expect(stats.get("old-orphan")!.pending).toBe(false);
    expect(stats.get("open-call")!.pending).toBe(true);
    expect(stats.get("resolved")!.pending).toBe(false);
    // 末条助手是纯文本收尾才算 final；停在工具调用上的 replyLen = 0
    expect(stats.get("old-orphan")!.replyLen).toBeGreaterThan(0);
    expect(stats.get("open-call")!.replyLen).toBe(0);
    expect(stats.get("resolved")!.replyLen).toBeGreaterThan(0);
  });

  it("回填口径：TaskCreate 的真实 id 来自工具结果，全部完成后待办不算未收口", () => {
    const db = tempDb();
    insertSession(db, "task-list");
    insertMessage(db, "task-list", 1, "user", [{ kind: "text", text: "实现登录页" }]);
    insertMessage(db, "task-list", 2, "assistant", [
      { kind: "plan", json: JSON.stringify({ subject: "搭页面" }), toolCallId: "c1" },
      { kind: "plan", json: JSON.stringify({ subject: "写测试" }), toolCallId: "c2" },
    ]);
    insertMessage(db, "task-list", 3, "tool", [
      { kind: "tool_result", text: "Task #1 created successfully: 搭页面", toolCallId: "c1" },
      { kind: "tool_result", text: "Task #2 created successfully: 写测试", toolCallId: "c2" },
    ]);
    insertMessage(db, "task-list", 4, "assistant", [
      { kind: "plan", json: JSON.stringify({ taskId: "1", status: "completed" }), toolCallId: "c3" },
      { kind: "plan", json: JSON.stringify({ taskId: "2", status: "completed" }), toolCallId: "c4" },
    ]);
    insertMessage(db, "task-list", 5, "tool", [
      { kind: "tool_result", text: "Updated task #1 status", toolCallId: "c3" },
      { kind: "tool_result", text: "Updated task #2 status", toolCallId: "c4" },
    ]);
    insertMessage(db, "task-list", 6, "assistant", [{ kind: "text", text: "都做完了。" }]);

    const stats = computeSessionStats(db, ["task-list"]);
    expect(stats.get("task-list")!.todosOpen).toBe(false);
  });

  it("状态口径升级：一次性刷新全部会话信号，不删消息", () => {
    const db = tempDb();
    insertSession(db, "legacy");
    insertMessage(db, "legacy", 1, "user", [{ kind: "text", text: "实现登录页" }]);
    insertMessage(db, "legacy", 2, "assistant", [
      { kind: "tool_call", toolCallId: "call_orphan" },
    ]);
    insertMessage(db, "legacy", 3, "user", [{ kind: "text", text: "继续" }]);
    insertMessage(db, "legacy", 4, "assistant", [{ kind: "text", text: "已经完成。" }]);
    db.prepare("UPDATE sessions SET sig_pending = 1 WHERE id = 'legacy'").run();

    expect(backfillSessionStats(db)).toBe(1);
    const row = db
      .prepare("SELECT sig_pending, message_count FROM sessions WHERE id = 'legacy'")
      .get() as { sig_pending: number; message_count: number };
    expect(row.sig_pending).toBe(0);
    expect(row.message_count).toBe(4);

    const version = db
      .prepare("SELECT value FROM settings WHERE key = 'stats_version'")
      .get() as { value: string };
    expect(version.value).toBe(String(STATS_VERSION));
    const messages = db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = 'legacy'")
      .get() as { n: number };
    expect(messages.n).toBe(4);
  });
});
