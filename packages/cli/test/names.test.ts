import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { openWritable } from "../src/store/db.js";
import {
  buildNamePrompt,
  drainNameQueue,
  enqueueNamesForSessions,
  getSessionNames,
  loadNameMaterial,
  parseNameReply,
} from "../src/store/names-store.js";
import { displayTitle } from "../src/store/titles.js";
import { listRecentSessions } from "../src/server/conversations.js";
import { getTaskDetail, listProjectTasks } from "../src/server/task-list.js";
import { makeTempHome, type TempHome } from "./helpers.js";

const cleanups: Array<() => void> = [];
function tempDb(): DatabaseSync {
  const temp = makeTempHome();
  const db = openWritable(temp.env);
  cleanups.push(() => {
    db.close();
    temp.cleanup();
  });
  return db;
}
function tempHome(): TempHome {
  const temp = makeTempHome();
  cleanups.push(temp.cleanup);
  return temp;
}
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function insertSession(
  db: DatabaseSync,
  id: string,
  opts: {
    agent?: string;
    title?: string | null;
    firstUser?: string | null;
    parent?: string | null;
    messages?: number;
  } = {},
): void {
  db.prepare(
    `INSERT INTO sessions (id, agent, project_root, cwd, title, first_user_message, parent_session_id, message_count)
     VALUES (?, ?, 'D:/demo', 'D:/demo', ?, ?, ?, ?)`,
  ).run(
    id,
    opts.agent ?? "qoder",
    opts.title ?? null,
    opts.firstUser ?? null,
    opts.parent ?? null,
    opts.messages ?? 2,
  );
}

function appendMessage(db: DatabaseSync, sessionId: string, ordinal: number, role: string, text: string): void {
  const info = db
    .prepare("INSERT INTO messages (session_id, ordinal, role) VALUES (?, ?, ?)")
    .run(sessionId, ordinal, role);
  db.prepare("INSERT INTO parts (message_id, idx, kind, text) VALUES (?, 0, 'text', ?)").run(
    Number(info.lastInsertRowid),
    text,
  );
}

function configureLlm(db: DatabaseSync): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('summary.baseUrl', ?)").run(
    "https://api.example.com/v1",
  );
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('summary.model', 'chat-model')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('summary.apiKey', 'k')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('summary.enabled', '1')").run();
}

function fakeProvider(reply: string | (() => string)): {
  provider: { model: string; complete(system: string, user: string): Promise<string> };
  calls: Array<{ system: string; user: string }>;
} {
  const calls: Array<{ system: string; user: string }> = [];
  return {
    provider: {
      model: "chat-model",
      async complete(system, user) {
        calls.push({ system, user });
        return typeof reply === "function" ? reply() : reply;
      },
    },
    calls,
  };
}

// ————————————————————————————————————————————————————————————————
// 素材挑选
// ————————————————————————————————————————————————————————————————

describe("任务名素材", () => {
  it("跳过寒暄/继续/纯标点，取首条实质指令", () => {
    const db = tempDb();
    insertSession(db, "s1", { firstUser: "你好" });
    appendMessage(db, "s1", 1, "user", "你好");
    appendMessage(db, "s1", 2, "assistant", "你好，有什么可以帮你？");
    appendMessage(db, "s1", 3, "user", "继续");
    appendMessage(db, "s1", 4, "user", "实现登录页，包含手机号验证码登录");

    const material = loadNameMaterial(db, "s1")!;
    expect(material.prompt).toContain("实现登录页");
    expect(material.prompt).not.toContain("你好");
    expect(material.prompt).not.toContain("继续");
    expect(material.sourceSessionId).toBe("s1");
    const prompt = buildNamePrompt(material);
    expect(prompt.system).toContain("任务命名助手");
    expect(prompt.user).toContain("会话开头");
  });

  it("继续 <uuid> 会话：优先回溯父会话，拿到原任务", () => {
    const db = tempDb();
    insertSession(db, "root", { firstUser: "实现订单列表页" });
    appendMessage(db, "root", 1, "user", "实现订单列表页");
    appendMessage(db, "root", 2, "assistant", "好的，先建页面骨架。");
    insertSession(db, "child", {
      firstUser: "继续23c19aa9-8471-48b1-967f-0ca3fa73ff9b会话，先出一个plan",
      parent: "root",
    });
    appendMessage(db, "child", 1, "user", "继续23c19aa9-8471-48b1-967f-0ca3fa73ff9b会话，先出一个plan");

    const material = loadNameMaterial(db, "child")!;
    expect(material.sourceSessionId).toBe("root");
    expect(material.prompt).toContain("实现订单列表页");
  });

  it("没有 parent 时也能按文本里的 uuid 找回原会话", () => {
    const db = tempDb();
    const rootId = "qoder:23c19aa9-8471-48b1-967f-0ca3fa73ff9b";
    insertSession(db, rootId, { firstUser: "实现退款审核列表" });
    appendMessage(db, rootId, 1, "user", "实现退款审核列表");
    appendMessage(db, rootId, 2, "assistant", "先做筛选和表格。");
    insertSession(db, "qoder:child", {
      firstUser: "继续23c19aa9-8471-48b1-967f-0ca3fa73ff9b会话，先出一个A+B的plan任务",
    });
    appendMessage(db, "qoder:child", 1, "user", "继续23c19aa9-8471-48b1-967f-0ca3fa73ff9b会话，先出一个A+B的plan任务");

    const material = loadNameMaterial(db, "qoder:child")!;
    expect(material.sourceSessionId).toBe(rootId);
    expect(material.prompt).toContain("实现退款审核列表");
  });

  it("父会话也是空的：退回到当前会话剥离前缀后的内容", () => {
    const db = tempDb();
    insertSession(db, "empty-parent", { firstUser: "你好" });
    appendMessage(db, "empty-parent", 1, "user", "你好");
    insertSession(db, "child2", {
      firstUser: "继续aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee会话，先出一个plan",
      parent: "empty-parent",
    });
    appendMessage(db, "child2", 1, "user", "继续aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee会话，先出一个plan");

    const material = loadNameMaterial(db, "child2")!;
    expect(material.sourceSessionId).toBe("child2");
    expect(material.prompt).toContain("先出一个plan");
  });

  it("素材里的密钥先脱敏", () => {
    const db = tempDb();
    insertSession(db, "s1", { firstUser: "用 sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 调接口" });
    appendMessage(db, "s1", 1, "user", "用 sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 调接口");
    const material = loadNameMaterial(db, "s1")!;
    expect(material.prompt).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
  });
});

// ————————————————————————————————————————————————————————————————
// 解析
// ————————————————————————————————————————————————————————————————

describe("任务名解析", () => {
  it("JSON / 代码块 / 行格式", () => {
    expect(parseNameReply('{"name":"实现订单列表","objective":"完成订单列表页"}')).toEqual({
      name: "实现订单列表",
      objective: "完成订单列表页",
    });
    expect(
      parseNameReply('```json\n{"name":"修复登录","objective":"修好验证码登录"}\n```'),
    ).toEqual({ name: "修复登录", objective: "修好验证码登录" });
    expect(parseNameReply("任务名：实现审计日志\n目标：交付审计日志页面")).toEqual({
      name: "实现审计日志",
      objective: "交付审计日志页面",
    });
  });

  it("无信息量的名字拒绝入库", () => {
    expect(() => parseNameReply("继续")).toThrow(/没有返回可用名字/);
    expect(() => parseNameReply('{"name":"继续","objective":"x"}')).toThrow(/没有返回可用名字/);
  });
});

// ————————————————————————————————————————————————————————————————
// drain
// ————————————————————————————————————————————————————————————————

describe("任务名 drain", () => {
  it("按需入队 → 生成并持久化；第二次直接跳过", async () => {
    const db = tempDb();
    configureLlm(db);
    insertSession(db, "s1", { firstUser: "实现登录页" });
    appendMessage(db, "s1", 1, "user", "实现登录页");
    appendMessage(db, "s1", 2, "assistant", "好的，先做手机号登录。");

    expect(enqueueNamesForSessions(db, ["s1"])).toBe(1);
    expect(enqueueNamesForSessions(db, ["s1"])).toBe(0);

    const fake = fakeProvider('{"name":"实现登录页","objective":"交付登录页"}');
    const result = await drainNameQueue(db, fake.provider, {
      config: { model: "chat-model", host: "api.example.com" },
    });
    expect(result).toMatchObject({ processed: 1, failed: 0 });
    expect(fake.calls).toHaveLength(1);
    expect(getSessionNames(db, ["s1"]).get("s1")).toEqual({
      name: "实现登录页",
      objective: "交付登录页",
    });

    const again = fakeProvider('{"name":"另一个名字","objective":"x"}');
    const second = await drainNameQueue(db, again.provider, {
      config: { model: "chat-model", host: "api.example.com" },
    });
    expect(second.processed).toBe(0);
    expect(again.calls).toHaveLength(0);
    expect(getSessionNames(db, ["s1"]).get("s1")!.name).toBe("实现登录页");
  });

  it("未启用摘要/配置不全时不入队（零 API 成本）", () => {
    const db = tempDb();
    insertSession(db, "s1", { firstUser: "实现登录页" });
    appendMessage(db, "s1", 1, "user", "实现登录页");
    expect(enqueueNamesForSessions(db, ["s1"])).toBe(0);
  });

  it("连续失败 3 次暂停并写 lastError，队列归还可续跑", async () => {
    const db = tempDb();
    configureLlm(db);
    for (const id of ["a", "b", "c"]) {
      insertSession(db, id, { firstUser: `实现${id}页面` });
      appendMessage(db, id, 1, "user", `实现${id}页面`);
    }
    enqueueNamesForSessions(db, ["a", "b", "c"]);
    const fake = fakeProvider(() => {
      throw new Error("接口挂了");
    });
    const result = await drainNameQueue(db, fake.provider, {
      config: { model: "chat-model", host: "api.example.com" },
      batchSessions: 3,
      maxSessions: 3,
    });
    expect(result.paused).toBe(true);
    expect(result.failed).toBe(3);
    expect(result.lastError).toContain("接口挂了");
    const error = db.prepare("SELECT value FROM settings WHERE key = 'names.lastError'").get() as {
      value: string;
    };
    expect(error.value).toContain("接口挂了");
    expect(result.remaining).toBe(3); // release 归还，修好后可续跑
  });
});

// ————————————————————————————————————————————————————————————————
// 标题与投影
// ————————————————————————————————————————————————————————————————

describe("标题选择", () => {
  it("AI 名字优先；Qoder 的 last-prompt 漂移时用首条指令", () => {
    expect(
      displayTitle({ agent: "qoder", title: "聊完了", firstUser: "研究 dsh hook", generated: "研究 DSH Hook" }),
    ).toBe("研究 DSH Hook");
    expect(displayTitle({ agent: "qoder", title: "聊完了", firstUser: "研究 dsh hook" })).toBe(
      "研究 dsh hook",
    );
    expect(displayTitle({ agent: "qoder", title: "1：200个字符 2：可以", firstUser: "实现向量检索" })).toBe(
      "实现向量检索",
    );
    expect(displayTitle({ agent: "claude-code", title: "登录页改造", firstUser: "你好" })).toBe(
      "登录页改造",
    );
    expect(
      displayTitle({
        agent: "qoder",
        title: null,
        firstUser: "继续23c19aa9-8471-48b1-967f-0ca3fa73ff9b会话，先出一个A+B的plan任务",
      }),
    ).toBe("先出一个A+B的plan任务");
  });

  it("列表与详情使用持久化任务名", () => {
    const home = tempHome();
    const db = openWritable(home.env);
    cleanups.push(() => db.close());
    insertSession(db, "s1", { firstUser: "实现登录页", messages: 2 });
    appendMessage(db, "s1", 1, "user", "实现登录页");
    appendMessage(db, "s1", 2, "assistant", "好的。");
    db.prepare(
      "INSERT INTO session_names (session_id, name, objective, model, host, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("s1", "登录页改造", "交付手机号验证码登录", "chat-model", "api.example.com", new Date().toISOString());

    const sessions = listRecentSessions(db, home.env);
    expect(sessions.find((session) => session.id === "s1")?.title).toBe("登录页改造");

    const page = listProjectTasks(db, home.env, { project: "D:/demo" });
    expect(page.tasks.find((task) => task.id === "s1")?.title).toBe("登录页改造");
    expect(getTaskDetail(db, home.env, "s1")?.title).toBe("登录页改造");
  });
});
