import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { createChatProvider, ChatRequestError } from "../src/core/llm.js";
import { EMPTY_FILTERS, saveFilters } from "../src/core/filters.js";
import { openWritable } from "../src/store/db.js";
import { claim, enqueue, pendingCount, release } from "../src/store/queue.js";
import {
  buildSummaryPrompt,
  deleteAllSummaries,
  drainSummaryQueue,
  getSessionSummaries,
  loadSummaryMaterial,
  rebuildSummaries,
  summaryEnabled,
  summaryStatus,
} from "../src/store/summaries-store.js";
import { drainSummaryWithCurrentConfig, readSummaries, resumeSummary } from "../src/store/summarizer.js";
import { runSummarize } from "../src/cli/commands/summarize.js";
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
  opts: { title?: string; sigs?: Partial<Record<"pending" | "quota" | "error" | "unanswered" | "todos", boolean>> } = {},
): void {
  const sig = opts.sigs ?? {};
  db.prepare(
    `INSERT INTO sessions (id, agent, project_root, cwd, status, status_source, title,
       sig_pending, sig_quota, sig_error, sig_unanswered, sig_todos_open)
     VALUES (?, 'qoder', 'D:/webProject/demo', 'D:/webProject/demo', 'interrupted', 'auto', ?,
       ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.title ?? null,
    sig.pending ? 1 : 0,
    sig.quota ? 1 : 0,
    sig.error ? 1 : 0,
    sig.unanswered ? 1 : 0,
    sig.todos ? 1 : 0,
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

function configureSummary(db: DatabaseSync, model = "chat-model"): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('summary.baseUrl', ?)").run(
    "https://api.example.com/v1",
  );
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('summary.model', ?)").run(model);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('summary.apiKey', 'k')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('summary.enabled', '1')").run();
}

function fakeChat(reply: string | ((user: string) => string) = "正在做登录页，初步完成。"): {
  provider: { model: string; complete(system: string, user: string): Promise<string> };
  calls: Array<{ system: string; user: string }>;
} {
  const calls: Array<{ system: string; user: string }> = [];
  return {
    provider: {
      model: "chat-model",
      async complete(system, user) {
        calls.push({ system, user });
        return typeof reply === "function" ? reply(user) : reply;
      },
    },
    calls,
  };
}

function chatFetch(content: string | (() => string)): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: typeof content === "function" ? content() : content } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

const FP = { model: "chat-model", host: "api.example.com" };

// ————————————————————————————————————————————————————————————————
// chat provider（伪 fetch）
// ————————————————————————————————————————————————————————————————

describe("chat provider", () => {
  it("请求形状与响应解析；429 退避后成功", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let attempts = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      attempts++;
      if (attempts === 1) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: " 摘要正文 " } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const provider = createChatProvider({
      config: { model: "chat-model", baseUrl: "https://api.example.com/v1", apiKey: "k", host: "api.example.com" },
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const text = await provider.complete("sys", "usr");
    expect(text).toBe("摘要正文");
    expect(calls[0]!.url).toBe("https://api.example.com/v1/chat/completions");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer k");
    const body = JSON.parse(String(calls[0]!.init.body)) as { model: string; messages: Array<{ role: string; content: string }> };
    expect(body.model).toBe("chat-model");
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(body.messages[1]).toEqual({ role: "user", content: "usr" });
    expect(sleeps).toEqual([1000]);
  });

  it("400 直接抛出；缺 choices 给出明确报错", async () => {
    const bad = createChatProvider({
      config: { model: "m", baseUrl: "https://x/v1", apiKey: "k", host: "x" },
      fetchImpl: (async () => new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 })) as unknown as typeof fetch,
    });
    await expect(bad.complete("s", "u")).rejects.toMatchObject({ status: 400, retryable: false });

    const noChoices = createChatProvider({
      config: { model: "m", baseUrl: "https://x/v1", apiKey: "k", host: "x" },
      fetchImpl: (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(noChoices.complete("s", "u")).rejects.toThrowError(/choices/);
  });
});

// ————————————————————————————————————————————————————————————————
// 素材组装
// ————————————————————————————————————————————————————————————————

describe("素材组装", () => {
  it("标题 + 状态信号 + 最后 20 条正文（保持顺序、带角色）", () => {
    const db = tempDb();
    insertSession(db, "s1", { title: "登录页改造", sigs: { unanswered: true, todos: true } });
    for (let i = 1; i <= 25; i++) {
      appendMessage(db, "s1", i, i % 2 === 1 ? "user" : "assistant", `第${i}条内容`);
    }
    const material = loadSummaryMaterial(db, "s1")!;
    expect(material.title).toBe("登录页改造");
    expect(material.signals).toContain("还没有回复");
    expect(material.signals).toContain("未完成的待办");
    expect(material.excerpt).toContain("第25条内容"); // 最新在
    expect(material.excerpt).not.toContain("第5条内容"); // 超出窗口的最旧一条不在
    const prompt = buildSummaryPrompt(material);
    expect(prompt.user).toContain("任务名：登录页改造");
    expect(prompt.user).toContain("状态：");
    expect(prompt.user).toContain("会话尾部：");
  });

  it("超长素材保留最新尾部（≤8KB）", () => {
    const db = tempDb();
    insertSession(db, "s1");
    appendMessage(db, "s1", 1, "user", `很旧的头部${"x".repeat(9000)}`);
    appendMessage(db, "s1", 2, "assistant", `最新尾部标记`);
    const material = loadSummaryMaterial(db, "s1")!;
    expect(material.excerpt.length).toBeLessThanOrEqual(8000);
    expect(material.excerpt).toContain("最新尾部标记");
    expect(material.excerpt).not.toContain("很旧的头部");
  });

  it("没有可摘要正文 → undefined", () => {
    const db = tempDb();
    insertSession(db, "s1");
    appendMessage(db, "s1", 1, "user", "   ");
    expect(loadSummaryMaterial(db, "s1")).toBeUndefined();
  });
});

// ————————————————————————————————————————————————————————————————
// 生成 / drain / 幂等 / 脱敏
// ————————————————————————————————————————————————————————————————

describe("摘要生成与 drain", () => {
  it("生成并出队；重复 drain 零 API 跳过（幂等）", async () => {
    const db = tempDb();
    insertSession(db, "s1", { title: "T" });
    appendMessage(db, "s1", 1, "user", "帮我做登录页");
    enqueue(db, "summary_queue", "s1");
    const { provider, calls } = fakeChat();
    const first = await drainSummaryQueue(db, provider, { config: FP });
    expect(first.processed).toBe(1);
    expect(first.remaining).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM summaries").get()).toMatchObject({ n: 1 });

    enqueue(db, "summary_queue", "s1");
    const second = await drainSummaryQueue(db, provider, { config: FP });
    expect(second.skipped).toBe(1);
    expect(calls.length).toBe(1); // 没有第二次调用
  });

  it("内容变化后重生成；素材含密钥时先脱敏再发送", async () => {
    const db = tempDb();
    insertSession(db, "s1");
    appendMessage(db, "s1", 1, "user", "token 是 sk-abcdefghijklmnopqrstuvwxyz 记好");
    enqueue(db, "summary_queue", "s1");
    const { provider, calls } = fakeChat();
    await drainSummaryQueue(db, provider, { config: FP });
    expect(calls[0]!.user).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(calls[0]!.user).toContain("sk-…wxyz");
    // 模型返回里带密文也要脱敏后入库
    const withSecret = fakeChat("摘要：已记录 sk-abcdefghijklmnopqrstuvwxyz。");
    appendMessage(db, "s1", 2, "assistant", "新增一条");
    enqueue(db, "summary_queue", "s1");
    await drainSummaryQueue(db, withSecret.provider, { config: FP });
    const row = db.prepare("SELECT text FROM summaries WHERE session_id = 's1'").get() as { text: string };
    expect(row.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(withSecret.calls.length).toBe(1);
  });

  it("已删除的会话不调用摘要接口，旧摘要同时清掉", async () => {
    const temp = tempHome();
    const db = openWritable(temp.env);
    cleanups.push(() => db.close());
    insertSession(db, "s1", { title: "T" });
    appendMessage(db, "s1", 1, "user", "帮我做登录页");
    enqueue(db, "summary_queue", "s1");
    const { provider, calls } = fakeChat();
    await drainSummaryQueue(db, provider, { config: FP, env: temp.env });
    expect(calls.length).toBe(1);

    saveFilters(temp.env, { ...EMPTY_FILTERS, deletedSessions: ["s1"] });
    enqueue(db, "summary_queue", "s1");
    const second = await drainSummaryQueue(db, provider, { config: FP, env: temp.env });

    expect(second.skipped).toBe(1);
    expect(calls.length).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM summaries").get()).toMatchObject({ n: 0 });
  });

  it("失败归还 claim；连续失败暂停并写状态；恢复后清零", async () => {
    const db = tempDb();
    for (const id of ["s1", "s2", "s3", "s4"]) {
      insertSession(db, id);
      appendMessage(db, id, 1, "user", `任务 ${id}`);
      enqueue(db, "summary_queue", id);
    }
    const bad = {
      model: "chat-model",
      complete: async () => {
        throw new ChatRequestError("HTTP 500", 500, true);
      },
    };
    const result = await drainSummaryQueue(db, bad, { config: FP, batchSessions: 1 });
    expect(result.paused).toBe(true);
    expect(result.failed).toBe(3);
    expect(result.remaining).toBe(4); // 全部归还、留在队列
    expect(summaryStatus(db).lastError).toContain("HTTP 500");

    const { provider } = fakeChat();
    const resumed = await drainSummaryQueue(db, provider, { config: FP });
    expect(resumed.processed).toBe(4);
    expect(summaryStatus(db).lastError).toBeNull();
  });

  it("未启用时运行时不产生任何调用", async () => {
    const temp = tempHome();
    const db = openWritable(temp.env);
    try {
      insertSession(db, "s1");
      appendMessage(db, "s1", 1, "user", "x");
      enqueue(db, "summary_queue", "s1");
      expect(summaryEnabled(db)).toBe(false);
    } finally {
      db.close();
    }
    const fetchImpl = vi.fn();
    expect(await drainSummaryWithCurrentConfig(temp.env, { deps: { fetchImpl: fetchImpl as unknown as typeof fetch } })).toBeUndefined();
    expect(await resumeSummary(temp.env, "s1", { fetchImpl: fetchImpl as unknown as typeof fetch })).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("空壳会话（无可摘要正文）清旧行并出队，不调用 API", async () => {
    const db = tempDb();
    insertSession(db, "s1");
    appendMessage(db, "s1", 1, "user", "有内容");
    enqueue(db, "summary_queue", "s1");
    const { provider, calls } = fakeChat();
    await drainSummaryQueue(db, provider, { config: FP });
    db.prepare("DELETE FROM parts").run();
    db.prepare("DELETE FROM messages").run();
    enqueue(db, "summary_queue", "s1");
    const second = await drainSummaryQueue(db, provider, { config: FP });
    expect(second.skipped).toBe(1);
    expect(calls.length).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM summaries").get()).toMatchObject({ n: 0 });
  });
});

// ————————————————————————————————————————————————————————————————
// 定向生成（resume 路径）
// ————————————————————————————————————————————————————————————————

describe("定向生成 resumeSummary", () => {
  it("已有摘要零成本返回；缺失时按预算生成；接口挂掉静默返回 undefined", async () => {
    const temp = tempHome();
    {
      const db = openWritable(temp.env);
      try {
        insertSession(db, "s1", { title: "T" });
        appendMessage(db, "s1", 1, "user", "做登录页");
        configureSummary(db);
        enqueue(db, "summary_queue", "s1");
      } finally {
        db.close();
      }
    }

    // 缺失 → 定向生成（伪 fetch 走真实 provider 链路）
    const text = await resumeSummary(temp.env, "s1", { fetchImpl: chatFetch("登录页进行中。") });
    expect(text).toBe("登录页进行中。");

    // 已有 → 零 API（failing fetch 也能拿到）
    const failing = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await resumeSummary(temp.env, "s1", { fetchImpl: failing })).toBe("登录页进行中。");

    // 缺失 + 接口挂 → undefined（且归还 claim、排队还在）
    {
      const db = openWritable(temp.env);
      try {
        db.prepare("DELETE FROM summaries").run();
        enqueue(db, "summary_queue", "s1");
      } finally {
        db.close();
      }
    }
    expect(await resumeSummary(temp.env, "s1", { fetchImpl: failing })).toBeUndefined();
    {
      const db = openWritable(temp.env);
      try {
        expect(pendingCount(db, "summary_queue")).toBe(1);
        const row = db.prepare("SELECT claimed_at FROM summary_queue WHERE session_id='s1'").get() as {
          claimed_at: string | null;
        };
        expect(row.claimed_at).toBeNull(); // claim 已归还，下次还能重试
      } finally {
        db.close();
      }
    }
  });
});

// ————————————————————————————————————————————————————————————————
// 指纹与重建 / 状态 / 清除
// ————————————————————————————————————————————————————————————————

describe("指纹、状态与重建", () => {
  it("换模型后旧行失效（读不到）、状态给出遗留数；重建后恢复", async () => {
    const db = tempDb();
    insertSession(db, "s1", { title: "T" });
    appendMessage(db, "s1", 1, "user", "做登录页");
    configureSummary(db, "model-a");
    enqueue(db, "summary_queue", "s1");
    const { provider } = fakeChat();
    await drainSummaryQueue(db, provider, { config: { model: "model-a", host: "api.example.com" } });

    db.prepare("UPDATE settings SET value = 'model-b' WHERE key = 'summary.model'").run();
    expect(getSessionSummaries(db, ["s1"]).size).toBe(0);
    const status = summaryStatus(db);
    expect(status.staleSessions).toBe(1);
    expect(status.summarizedSessions).toBe(0);

    const rebuild = rebuildSummaries(db, { model: "model-b", host: "api.example.com" });
    expect(rebuild.deleted).toBe(1);
    expect(rebuild.queued).toBe(1);
    await drainSummaryQueue(db, provider, { config: { model: "model-b", host: "api.example.com" } });
    expect(getSessionSummaries(db, ["s1"]).size).toBe(1);
    expect(summaryStatus(db).staleSessions).toBe(0);
  });

  it("删除全部摘要：行与队列都清空", async () => {
    const db = tempDb();
    insertSession(db, "s1");
    appendMessage(db, "s1", 1, "user", "x");
    configureSummary(db);
    enqueue(db, "summary_queue", "s1");
    const { provider } = fakeChat();
    await drainSummaryQueue(db, provider, { config: FP });
    enqueue(db, "summary_queue", "s1");
    deleteAllSummaries(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM summaries").get()).toMatchObject({ n: 0 });
    expect(pendingCount(db, "summary_queue")).toBe(0);
    expect(readSummaries({ home: "", platform: process.platform, env: {} }, ["s1"]).size).toBe(0);
  });

  it("队列原语在 summary_queue 上同样成立（claim 租约互斥）", () => {
    const db = tempDb();
    insertSession(db, "s1");
    enqueue(db, "summary_queue", "s1");
    expect(claim(db, "summary_queue", { limit: 5, now: 1_000_000 })).toEqual(["s1"]);
    expect(claim(db, "summary_queue", { limit: 5, now: 1_000_001 })).toEqual([]);
    release(db, "summary_queue", "s1");
    expect(claim(db, "summary_queue", { limit: 5, now: 1_000_002 })).toEqual(["s1"]);
  });
});

// ————————————————————————————————————————————————————————————————
// 命令壳（--status）
// ————————————————————————————————————————————————————————————————

describe("memrelay summarize 命令", () => {
  it("--status 输出开关与计数；未启用时提示默认关", async () => {
    const temp = tempHome();
    {
      const db = openWritable(temp.env);
      db.close();
    }
    const prevHome = process.env["MEMRELAY_TEST_HOME"];
    const prevDir = process.env["MEMRELAY_HOME"];
    process.env["MEMRELAY_TEST_HOME"] = temp.home;
    process.env["MEMRELAY_HOME"] = `${temp.home}/.memrelay`;
    try {
      const lines: string[] = [];
      const code = await runSummarize(["--status"], (text) => lines.push(text));
      expect(code).toBe(0);
      const out = lines.join("\n");
      expect(out).toContain("未启用");

      // 开启 + 配置后：状态行带模型与计数
      const db = openWritable({ home: temp.home, platform: process.platform, env: process.env as Record<string, string | undefined> });
      try {
        configureSummary(db, "chat-model");
      } finally {
        db.close();
      }
      const lines2: string[] = [];
      await runSummarize(["--status"], (text) => lines2.push(text));
      const out2 = lines2.join("\n");
      expect(out2).toContain("已开启");
      expect(out2).toContain("chat-model");
      expect(out2).toContain("已摘要：0");
    } finally {
      if (prevHome === undefined) delete process.env["MEMRELAY_TEST_HOME"];
      else process.env["MEMRELAY_TEST_HOME"] = prevHome;
      if (prevDir === undefined) delete process.env["MEMRELAY_HOME"];
      else process.env["MEMRELAY_HOME"] = prevDir;
    }
  });
});
