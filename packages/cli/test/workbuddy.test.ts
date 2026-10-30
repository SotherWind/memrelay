import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { workbuddyAdapter } from "../src/adapters/workbuddy/index.js";
import type { NormalizedEvent } from "../src/core/types.js";
import { buildIndex } from "../src/store/indexer.js";
import { openReadOnly } from "../src/store/db.js";
import { getSessionMessages } from "../src/server/conversations.js";
import { allTasks, makeTempHome, type TempHome } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const PROJECT = "C:\\Users\\Administrator\\WorkBuddy\\demo-session";

interface RecordSpec {
  [key: string]: unknown;
}

/** 按实测格式手写一个 WorkBuddy 会话文件（+ 可选 workbuddy.db 元数据）。 */
function setupWorkBuddyHome(
  sessionId: string,
  records: RecordSpec[],
  dbRow?: { title: string; customTitle?: string; cwd: string; createdAt: number; updatedAt: number },
): TempHome {
  const temp = makeTempHome();
  cleanups.push(temp.cleanup);
  const slug = "c-Users-Administrator-WorkBuddy-demo-session";
  const dir = path.join(temp.home, ".workbuddy", "projects", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf8",
  );
  if (dbRow) {
    const wbDir = path.join(temp.home, ".workbuddy");
    const db = new DatabaseSync(path.join(wbDir, "workbuddy.db"));
    db.exec(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, custom_title TEXT, status TEXT, created_at INTEGER, updated_at INTEGER)",
    );
    db.prepare(
      "INSERT INTO sessions (id, cwd, title, custom_title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'completed', ?, ?)",
    ).run(sessionId, dbRow.cwd, dbRow.title, dbRow.customTitle ?? null, dbRow.createdAt, dbRow.updatedAt);
    db.close();
  }
  return temp;
}

function sampleRecords(now: number): RecordSpec[] {
  return [
    { type: "session-meta", id: "m1", sessionId: "s1", timestamp: now, meta: {} },
    {
      type: "message",
      id: "r1",
      parentId: null,
      timestamp: now,
      role: "user",
      content: [
        {
          type: "input_text",
          text: '<system-reminder data-role="user-context">\n<user_info>\nOS Version: win32\nWorkspace Folder: C:/Users/Administrator/WorkBuddy/demo-session\n</user_info>\n</system-reminder>\n帮我用 Playwright 截图',
        },
      ],
    },
    {
      type: "reasoning",
      id: "r2",
      parentId: "r1",
      timestamp: now + 1000,
      providerData: { reasoning: "用户想要截图，先打开页面。" },
    },
    {
      type: "function_call",
      id: "r3",
      parentId: "r2",
      timestamp: now + 2000,
      callId: "call_abc123",
      name: "DeferExecuteTool",
      arguments: '{"tool_name":"mcp__playwright__browser_take_screenshot"}',
      cwd: PROJECT,
    },
    {
      type: "function_call_result",
      id: "r4",
      parentId: "r3",
      timestamp: now + 3000,
      name: "DeferExecuteTool",
      callId: "call_abc123",
      status: "completed",
      output: { type: "text", text: "screenshot saved" },
    },
    {
      type: "message",
      id: "r5",
      parentId: "r4",
      timestamp: now + 4000,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "已经用 Playwright 打开页面并完成截图，文件保存在工作目录。" }],
    },
    { type: "ai-title", id: "t1", timestamp: now + 5000, aiTitle: "打开页面并截图", cwd: PROJECT },
    { type: "file-history-snapshot", id: "f1", timestamp: now + 6000, snapshot: {} },
  ];
}

describe("WorkBuddy 适配器", () => {
  it("扫描与读取：元数据、文本、思考、工具调用与结果都成片段", async () => {
    const now = Date.now() - 3_600_000;
    const temp = setupWorkBuddyHome("11111111-aaaa-4bbb-8ccc-111111111111", sampleRecords(now));
    const adapter = workbuddyAdapter();

    const detection = await adapter.detect(temp.env);
    expect(detection.installed).toBe(true);

    const scans = await adapter.scanAll(temp.env);
    expect(scans).toHaveLength(1);
    const scan = scans[0]!;
    expect(scan.id).toBe("workbuddy:11111111-aaaa-4bbb-8ccc-111111111111");
    expect(scan.cwd).toBe(PROJECT);
    expect(scan.tail.lastTitle).toBe("打开页面并截图");
    expect(scan.tail.lastTimestamp).toBeDefined();

    const events: NormalizedEvent[] = [];
    for await (const event of adapter.readSession(scan)) events.push(event);
    const session = events[0]!;
    if (session.kind === "session") {
      expect(session.session.title).toBe("打开页面并截图");
      expect(session.session.firstUserMessage).toBe("帮我用 Playwright 截图");
      expect(session.session.rawRecords).toBe(8);
    }
    const messages = events.filter((event) => event.kind === "message");
    expect(messages).toHaveLength(5);
    const kinds = messages.flatMap((event) =>
      event.kind === "message" ? event.message.parts.map((part) => part.kind) : [],
    );
    expect(kinds).toContain("text");
    expect(kinds).toContain("reasoning");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    const call = messages
      .flatMap((event) => (event.kind === "message" ? event.message.parts : []))
      .find((part) => part.kind === "tool_call")!;
    expect(call.toolName).toBe("DeferExecuteTool");
    expect(call.toolCallId).toBe("call_abc123");
    expect(call.json).toEqual({ tool_name: "mcp__playwright__browser_take_screenshot" });
  });

  it("workbuddy.db 元数据优先（自定义标题/cwd），入库后列表可见", async () => {
    const now = Date.now() - 2 * 3_600_000;
    const sessionId = "22222222-bbbb-4ccc-8ddd-222222222222";
    const temp = setupWorkBuddyHome(sessionId, sampleRecords(now), {
      title: "库里的标题",
      customTitle: "我改过的标题",
      cwd: PROJECT,
      createdAt: now,
      updatedAt: now + 10_000,
    });
    const adapter = workbuddyAdapter();

    const scans = await adapter.scanAll(temp.env);
    expect(scans).toHaveLength(1);

    const stats = await buildIndex(temp.env, { adapters: [adapter] });
    expect(stats.updated).toBe(1);
    expect(stats.failed).toBe(0);

    const db = openReadOnly(temp.env);
    try {
      const row = db
        .prepare("SELECT title, project_root FROM sessions WHERE id LIKE 'workbuddy:2222%'")
        .get() as { title: string; project_root: string } | undefined;
      expect(row?.title).toBe("我改过的标题");
      expect(row?.project_root).toContain("demo-session");

      const page = getSessionMessages(db, temp.env, `workbuddy:${sessionId}`, {});
      expect(page).toBeDefined();
      expect(page!.total).toBe(5);

      const task = allTasks(db, temp.env).find((t) => t.project.includes("demo-session"));
      expect(task?.title).toBe("我改过的标题");
    } finally {
      db.close();
    }
  });
});
