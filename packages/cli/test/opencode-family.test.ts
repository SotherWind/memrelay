import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { opencodeAdapter, zcodeAdapter } from "../src/adapters/opencode-family/index.js";
import type { NormalizedEvent } from "../src/core/types.js";
import { buildIndex } from "../src/store/indexer.js";
import { openReadOnly } from "../src/store/db.js";
import { getSessionMessages } from "../src/server/conversations.js";
import { allTasks, makeTempHome, type TempHome } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const OPEN_PROJECT = "D:\\webProject\\demo-open";
const ZCODE_PROJECT = "D:\\webProject\\demo-zcode";
const HOUR = 3_600_000;

function setupOpencodeHome(): TempHome {
  const temp = makeTempHome();
  cleanups.push(temp.cleanup);
  const dir = path.join(temp.home, ".local", "share", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "opencode.db"));
  db.exec(
    `CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);`,
  );
  db.exec(
    `CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);`,
  );
  const now = Date.now() - 2 * HOUR;
  db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?)").run(
    "ses_test0001",
    OPEN_PROJECT,
    "打个招呼",
    now,
    now + 30_000,
  );
  const insertMsg = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)");
  insertMsg.run(
    "msg_1",
    "ses_test0001",
    "user",
    1,
    now,
    now,
    JSON.stringify({ time: { created: now }, text: "打个招呼" }),
  );
  insertMsg.run(
    "msg_2",
    "ses_test0001",
    "assistant",
    2,
    now + 1000,
    now + 2000,
    JSON.stringify({
      time: { created: now + 1000 },
      agent: "build",
      content: [
        { type: "reasoning", text: "用户只是打个招呼，简单回应。" },
        { type: "text", text: "你好！有什么可以帮你的吗？这是一段超过三十个字的回复方便状态判定为完成。" },
      ],
    }),
  );
  insertMsg.run("msg_3", "ses_test0001", "idle", 3, now + 3000, now + 3000, JSON.stringify({ outcome: "succeeded" }));
  db.close();
  return temp;
}

function setupZcodeHome(): TempHome {
  const temp = makeTempHome();
  cleanups.push(temp.cleanup);
  const dir = path.join(temp.home, ".zcode", "cli", "db");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "db.sqlite"));
  db.exec(
    `CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, path TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);`,
  );
  db.exec(
    `CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER);`,
  );
  db.exec(
    `CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER);`,
  );
  const now = Date.now() - HOUR;
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)").run(
    "sess_test0001",
    ZCODE_PROJECT,
    ZCODE_PROJECT,
    "你好",
    now,
    now + 20_000,
  );
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)").run(
    "msg_u1",
    "sess_test0001",
    now,
    now,
    JSON.stringify({ role: "user", time: { created: now } }),
    0,
  );
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "part_1",
    "msg_u1",
    "sess_test0001",
    now,
    now,
    JSON.stringify({ type: "text", text: "你好" }),
    0,
  );
  // 给模型看的系统注入：带 model-only 标记，不算用户消息
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)").run(
    "msg_sys",
    "sess_test0001",
    now + 100,
    now + 100,
    JSON.stringify({ role: "user", metadata: { source: "agent_listing_delta", visibility: "model-only" } }),
    1,
  );
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "part_sys",
    "msg_sys",
    "sess_test0001",
    now + 100,
    now + 100,
    JSON.stringify({ type: "text", text: "Available agent types for this task:" }),
    0,
  );
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)").run(
    "msg_a1",
    "sess_test0001",
    now + 1000,
    now + 2000,
    JSON.stringify({ role: "assistant", time: { created: now + 1000 } }),
    2,
  );
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "part_s",
    "msg_a1",
    "sess_test0001",
    now + 1000,
    now + 1000,
    JSON.stringify({ type: "step-start" }),
    0,
  );
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "part_t",
    "msg_a1",
    "sess_test0001",
    now + 1500,
    now + 1500,
    JSON.stringify({ type: "text", text: "你好！很高兴见到你，有什么想做的直接说就行。" }),
    1,
  );
  db.close();
  return temp;
}

function setupOpencodeToolChainHome(): TempHome {
  const temp = makeTempHome();
  cleanups.push(temp.cleanup);
  const dir = path.join(temp.home, ".local", "share", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "opencode.db"));
  db.exec(
    `CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);`,
  );
  db.exec(
    `CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);`,
  );
  const now = Date.now() - HOUR;
  db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?)").run(
    "ses_parent01",
    OPEN_PROJECT,
    "父任务",
    now,
    now + 10_000,
  );
  db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?)").run(
    "ses_child01",
    OPEN_PROJECT,
    "继续任务",
    now + 20_000,
    now + 30_000,
  );
  const insertMsg = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)");
  insertMsg.run("msg_p1", "ses_parent01", "user", 1, now, now, JSON.stringify({
    time: { created: now },
    text: "先做官网首页",
  }));
  insertMsg.run("msg_p2", "ses_parent01", "assistant", 2, now + 1000, now + 1000, JSON.stringify({
    time: { created: now + 1000 },
    content: [{ type: "text", text: "首页静态页已经做了一半。" }],
  }));
  insertMsg.run("msg_c1", "ses_child01", "user", 1, now + 20_000, now + 20_000, JSON.stringify({
    time: { created: now + 20_000 },
    text: "继续官网任务",
  }));
  const marker = [
    "【MemRelay 续接】",
    `续接自 OpenCode:ses_parent01 · 会话数 1 · 2026-10-30 10:00 · ${OPEN_PROJECT} · 会话 opencode:ses_parent01`,
    "",
    "## 最后进展",
    "首页做到一半。",
  ].join("\n");
  insertMsg.run("msg_c2", "ses_child01", "assistant", 2, now + 21_000, now + 21_000, JSON.stringify({
    time: { created: now + 21_000 },
    content: [
      {
        type: "tool",
        id: "call_chain",
        name: "shell",
        executed: false,
        state: {
          status: "completed",
          input: { command: "memrelay resume opencode:ses_parent01" },
          content: [{ type: "text", text: marker }],
        },
      },
      { type: "text", text: "已接上父任务。" },
    ],
  }));
  insertMsg.run("msg_c3", "ses_child01", "idle", 3, now + 22_000, now + 22_000, JSON.stringify({ outcome: "succeeded" }));
  db.close();
  return temp;
}

describe("OpenCode 适配器", () => {
  it("扫描/读取/入库：元数据、内容块与空闲事件过滤", async () => {
    const temp = setupOpencodeHome();
    const adapter = opencodeAdapter();
    expect((await adapter.detect(temp.env)).installed).toBe(true);

    const scans = await adapter.scanAll(temp.env);
    expect(scans).toHaveLength(1);
    expect(scans[0]!.id).toBe("opencode:ses_test0001");
    expect(scans[0]!.cwd).toBe(OPEN_PROJECT);
    expect(scans[0]!.tail.lastTitle).toBe("打个招呼");
    expect(scans[0]!.tail.statusInfo.lastAssistantFinal).toBe(true);

    const events: NormalizedEvent[] = [];
    for await (const event of adapter.readSession(scans[0]!)) events.push(event);
    const messages = events.filter((event) => event.kind === "message");
    expect(messages).toHaveLength(2); // idle 不算消息
    const kinds = messages.flatMap((event) =>
      event.kind === "message" ? event.message.parts.map((p) => p.kind) : [],
    );
    expect(kinds).toContain("text");
    expect(kinds).toContain("reasoning");

    const stats = await buildIndex(temp.env, { adapters: [adapter] });
    expect(stats.updated).toBe(1);
    const db = openReadOnly(temp.env);
    try {
      const page = getSessionMessages(db, temp.env, "opencode:ses_test0001", {});
      expect(page).toBeDefined();
      expect(page!.total).toBe(2);
      const task = allTasks(db, temp.env).find((t) => t.project.includes("demo-open"));
      expect(task?.title).toBe("打个招呼");
    } finally {
      db.close();
    }
  });

  it("工具输出在 state.content 时也入库，并据此把先后会话落链", async () => {
    const temp = setupOpencodeToolChainHome();
    const adapter = opencodeAdapter();
    const scans = await adapter.scanAll(temp.env);
    const child = scans.find((scan) => scan.id === "opencode:ses_child01");
    expect(child).toBeDefined();

    const events: NormalizedEvent[] = [];
    for await (const event of adapter.readSession(child!)) events.push(event);
    const parts = events.flatMap((event) => (event.kind === "message" ? event.message.parts : []));
    const toolResult = parts.find((part) => part.kind === "tool_result");
    expect(toolResult?.text).toContain("【MemRelay 续接】");
    expect(toolResult?.text).toContain("首页做到一半");

    await buildIndex(temp.env, { adapters: [adapter] });
    const db = openReadOnly(temp.env);
    try {
      const row = db
        .prepare("SELECT parent_session_id FROM sessions WHERE id = ?")
        .get("opencode:ses_child01") as { parent_session_id: string | null } | undefined;
      expect(row?.parent_session_id).toBe("opencode:ses_parent01");
    } finally {
      db.close();
    }
  });
});

describe("ZCode 适配器", () => {
  it("part 表解析、model-only 注入跳过、入库后列表可见", async () => {
    const temp = setupZcodeHome();
    const adapter = zcodeAdapter();
    expect((await adapter.detect(temp.env)).installed).toBe(true);

    const scans = await adapter.scanAll(temp.env);
    expect(scans).toHaveLength(1);
    expect(scans[0]!.id).toBe("zcode:sess_test0001");
    expect(scans[0]!.cwd).toBe(ZCODE_PROJECT);

    const events: NormalizedEvent[] = [];
    for await (const event of adapter.readSession(scans[0]!)) events.push(event);
    const session = events[0]!;
    if (session.kind === "session") {
      expect(session.session.firstUserMessage).toBe("你好"); // 不是 model-only 注入
    }
    const messages = events.filter((event) => event.kind === "message");
    expect(messages).toHaveLength(2);
    const assistant = messages[1]!;
    if (assistant.kind === "message") {
      expect(assistant.message.parts).toHaveLength(1); // step-start 不占位
      expect(assistant.message.parts[0]!.text).toContain("很高兴见到你");
    }

    const stats = await buildIndex(temp.env, { adapters: [adapter] });
    expect(stats.updated).toBe(1);
    const db = openReadOnly(temp.env);
    try {
      const task = allTasks(db, temp.env).find((t) => t.project.includes("demo-zcode"));
      expect(task?.title).toBe("你好");
    } finally {
      db.close();
    }
  });
});
