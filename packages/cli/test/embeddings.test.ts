import { describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import {
  chunkText,
  cosine,
  l2norm,
  semanticToKeyword,
  hostOf,
  createRemoteEmbeddingProvider,
  EmbeddingRequestError,
  clearQueryVectorCache,
  embedQueryText,
  type EmbeddingConfig,
  type EmbeddingProvider,
} from "../src/core/embeddings.js";
import {
  deleteAllEmbeddings,
  drainEmbedQueue,
  embeddingStatus,
  encodeVec,
  readEmbeddingSettings,
  rebuildEmbeddings,
  resolveEmbeddingConfig,
  scoreSessionsByVector,
} from "../src/store/embeddings-store.js";
import { claim, dequeue, enqueue, pendingCount, release } from "../src/store/queue.js";
import { openWritable } from "../src/store/db.js";
import { EMPTY_FILTERS, saveFilters } from "../src/core/filters.js";
import { makeTempHome, type TempHome } from "./helpers.js";

const cleanups: Array<() => void> = [];
function tempDb(): { db: DatabaseSync; temp: TempHome } {
  const temp = makeTempHome();
  const db = openWritable(temp.env);
  cleanups.push(() => {
    db.close();
    temp.cleanup();
  });
  return { db, temp };
}
import { afterEach } from "vitest";
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  clearQueryVectorCache();
});

// ————————————————————————————————————————————————————————————————
// 纯函数
// ————————————————————————————————————————————————————————————————

describe("切块与相似度", () => {
  it("短文本单块；空文本没有块", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
    expect(chunkText("   ")).toEqual([]);
    expect(chunkText("")).toEqual([]);
  });

  it("长文本按 1200/200 固定窗切分且重叠", () => {
    const text = "a".repeat(1300);
    const chunks = chunkText(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.length).toBe(1200);
    expect(chunks[1]!.length).toBe(300);
    expect(chunks[0]!.slice(-200)).toBe(chunks[1]!.slice(0, 200));
  });

  it("切块是纯函数：同样文本永远同样块序列", () => {
    const text = "测".repeat(3000);
    expect(chunkText(text)).toEqual(chunkText(text));
  });

  it("余弦：正交为 0、同向为 1；范数为 0 时返回 0", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    const c = new Float32Array([2, 0]);
    expect(cosine(a, b, l2norm(a), l2norm(b))).toBe(0);
    expect(cosine(a, c, l2norm(a), l2norm(c))).toBeCloseTo(1);
    expect(cosine(new Float32Array([0, 0]), a, 0, 1)).toBe(0);
  });

  it("语义分折算：≤0.35 为 0、≥0.75 为 1、中间线性", () => {
    expect(semanticToKeyword(0.3)).toBe(0);
    expect(semanticToKeyword(0.35)).toBe(0);
    expect(semanticToKeyword(0.55)).toBeCloseTo(0.5);
    expect(semanticToKeyword(0.75)).toBe(1);
    expect(semanticToKeyword(0.9)).toBe(1);
  });

  it("hostOf 取主机（含端口），坏地址原样返回", () => {
    expect(hostOf("https://api.openai.com/v1")).toBe("api.openai.com");
    expect(hostOf("http://127.0.0.1:8787/v1")).toBe("127.0.0.1:8787");
    expect(hostOf("not a url")).toBe("not a url");
  });
});

// ————————————————————————————————————————————————————————————————
// provider 客户端（伪 fetch，离线可测）
// ————————————————————————————————————————————————————————————————

const CONFIG: EmbeddingConfig = {
  model: "test-embed",
  baseUrl: "https://embed.example.com/v1",
  apiKey: "sk-test-key",
  host: "embed.example.com",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function embeddingBody(inputs: number): unknown {
  return {
    data: Array.from({ length: inputs }, (_, i) => ({ index: i, embedding: [i + 1, 0, 0] })),
  };
}

describe("remote provider", () => {
  it("请求形状：URL 拼接 / 认证头 / 批量体；按 index 排序还原", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      const body = JSON.parse(String(init!.body)) as { input: string[] };
      return jsonResponse(200, embeddingBody(body.input.length));
    }) as unknown as typeof fetch;
    const provider = createRemoteEmbeddingProvider({ config: CONFIG, fetchImpl });
    const vectors = await provider.embed(["a", "b"]);
    expect(vectors.length).toBe(2);
    expect(calls[0]!.url).toBe("https://embed.example.com/v1/embeddings");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-test-key");
    const body = JSON.parse(String(calls[0]!.init.body)) as { model: string; input: string[] };
    expect(body.model).toBe("test-embed");
    expect(body.input).toEqual(["a", "b"]);
  });

  it("baseUrl 已含 /embeddings 时不重复拼接", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, embeddingBody(1))) as unknown as typeof fetch;
    const provider = createRemoteEmbeddingProvider({
      config: { ...CONFIG, baseUrl: "https://x.com/v1/embeddings" },
      fetchImpl,
    });
    await provider.embed(["a"]);
    expect(vi.mocked(fetchImpl).mock.calls[0]![0]).toBe("https://x.com/v1/embeddings");
  });

  it("超过批次上限（16）自动拆分多次请求", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { input: string[] };
      return jsonResponse(200, embeddingBody(body.input.length));
    }) as unknown as typeof fetch;
    const provider = createRemoteEmbeddingProvider({ config: CONFIG, fetchImpl });
    await provider.embed(Array.from({ length: 20 }, (_, i) => `t${i}`));
    expect(vi.mocked(fetchImpl).mock.calls.length).toBe(2);
  });

  it("429 指数退避后成功；400 直接抛出", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const retrying = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { input: string[] };
      attempts++;
      if (attempts <= 2) return jsonResponse(429, { error: { message: "rate limited" } });
      return jsonResponse(200, embeddingBody(body.input.length));
    }) as unknown as typeof fetch;
    const provider = createRemoteEmbeddingProvider({
      config: CONFIG,
      fetchImpl: retrying,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await provider.embed(["a"]);
    expect(sleeps).toEqual([1000, 2000]);

    const failing = vi.fn(async () => jsonResponse(400, { error: { message: "bad model" } })) as unknown as typeof fetch;
    const provider2 = createRemoteEmbeddingProvider({ config: CONFIG, fetchImpl: failing });
    await expect(provider2.embed(["a"])).rejects.toMatchObject({ status: 400, retryable: false });
  });

  it("响应数量不符 / 非法 JSON 给出明确报错", async () => {
    const short = vi.fn(async () => jsonResponse(200, embeddingBody(1))) as unknown as typeof fetch;
    const provider = createRemoteEmbeddingProvider({ config: CONFIG, fetchImpl: short });
    await expect(provider.embed(["a", "b"])).rejects.toThrowError(/不支持批量/);

    const badJson = vi.fn(async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    const provider2 = createRemoteEmbeddingProvider({ config: CONFIG, fetchImpl: badJson });
    await expect(provider2.embed(["a"])).rejects.toBeInstanceOf(EmbeddingRequestError);
  });
});

// ————————————————————————————————————————————————————————————————
// 查询向量：脱敏 + LRU
// ————————————————————————————————————————————————————————————————

describe("查询向量 LRU 与脱敏", () => {
  it("同一关键词重复查询只在第一次调 API；输入先脱敏", async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 0])));
    const provider: EmbeddingProvider = { model: CONFIG.model, embed };
    const first = await embedQueryText(provider, CONFIG, "继续做 sk-abcdefghijklmnopqrstuvwxyz 的任务");
    expect(first).toBeDefined();
    const sent = embed.mock.calls[0]![0][0]!;
    expect(sent).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(sent).toContain("sk-…wxyz");
    await embedQueryText(provider, CONFIG, "继续做 sk-abcdefghijklmnopqrstuvwxyz 的任务");
    expect(embed.mock.calls.length).toBe(1);
  });

  it("provider 失败时静默返回 undefined", async () => {
    const provider: EmbeddingProvider = {
      model: CONFIG.model,
      embed: async () => {
        throw new EmbeddingRequestError("boom", 500, true);
      },
    };
    expect(await embedQueryText(provider, CONFIG, "hello")).toBeUndefined();
  });
});

// ————————————————————————————————————————————————————————————————
// 队列 / drain / 状态（手工造库）
// ————————————————————————————————————————————————————————————————

function insertSession(db: DatabaseSync, id: string, projectRoot = "D:/webProject/demo"): void {
  db.prepare(
    `INSERT INTO sessions (id, agent, project_root, cwd, status, status_source)
     VALUES (?, 'qoder', ?, ?, 'interrupted', 'auto')`,
  ).run(id, projectRoot, projectRoot);
}

function appendMessage(db: DatabaseSync, sessionId: string, ordinal: number, role: string, texts: string[]): void {
  const info = db
    .prepare("INSERT INTO messages (session_id, ordinal, role) VALUES (?, ?, ?)")
    .run(sessionId, ordinal, role);
  const messageId = Number(info.lastInsertRowid);
  texts.forEach((text, idx) => {
    db.prepare("INSERT INTO parts (message_id, idx, kind, text) VALUES (?, ?, 'text', ?)").run(
      messageId,
      idx,
      text,
    );
  });
}

function fakeProvider(vectors?: Map<string, Float32Array>): {
  provider: EmbeddingProvider;
  calls: string[][];
} {
  const calls: string[][] = [];
  const provider: EmbeddingProvider = {
    model: CONFIG.model,
    embed: async (texts) => {
      calls.push(texts);
      return texts.map((t) => vectors?.get(t) ?? new Float32Array([1, 1, 1]));
    },
  };
  return { provider, calls };
}

const FP = { model: CONFIG.model, host: CONFIG.host };

describe("入队与 drain", () => {
  it("drain 嵌入并出队；重复 drain 零 API 成本跳过（幂等）", async () => {
    const { db } = tempDb();
    insertSession(db, "s1");
    appendMessage(db, "s1", 1, "user", ["帮我做一个登录页"]);
    appendMessage(db, "s1", 2, "assistant", ["已完成 auth page 的初稿"]);
    enqueue(db, "embed_queue", "s1");

    const { provider, calls } = fakeProvider();
    const first = await drainEmbedQueue(db, provider, { fingerprint: FP });
    expect(first.processed).toBe(1);
    expect(first.remaining).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM embeddings").get()).toMatchObject({ n: 2 });

    enqueue(db, "embed_queue", "s1");
    const second = await drainEmbedQueue(db, provider, { fingerprint: FP });
    expect(second.skipped).toBe(1);
    expect(calls.length).toBe(1); // 没有第二次 API 调用
  });

  it("内容变动后只重嵌变化的块；会话变短时清掉多余旧块", async () => {
    const { db } = tempDb();
    insertSession(db, "s1");
    appendMessage(db, "s1", 1, "user", ["first question"]);
    appendMessage(db, "s1", 2, "assistant", ["first answer"]);
    enqueue(db, "embed_queue", "s1");
    const { provider, calls } = fakeProvider();
    await drainEmbedQueue(db, provider, { fingerprint: FP });

    // 改第 1 条、删第 2 条：只有变化的块要重嵌，旧块（ordinal 2）清掉
    db.prepare("UPDATE parts SET text = 'first question v2' WHERE text = 'first question'").run();
    db.prepare("DELETE FROM parts WHERE message_id IN (SELECT id FROM messages WHERE ordinal = 2)").run();
    db.prepare("DELETE FROM messages WHERE ordinal = 2").run();
    enqueue(db, "embed_queue", "s1");
    const second = await drainEmbedQueue(db, provider, { fingerprint: FP });

    expect(second.processed).toBe(1);
    const rows = db
      .prepare("SELECT ordinal FROM embeddings ORDER BY ordinal")
      .all() as Array<{ ordinal: number }>;
    expect(rows.map((r) => r.ordinal)).toEqual([1]);
    expect(calls.length).toBe(2);
    expect(calls[1]).toEqual(["first question v2"]);
  });

  it("嵌入输入已做密钥脱敏，content_hash 对应脱敏文本", async () => {
    const { db } = tempDb();
    insertSession(db, "s1");
    appendMessage(db, "s1", 1, "user", ["token 是 sk-abcdefghijklmnopqrstuvwxyz 请记好"]);
    enqueue(db, "embed_queue", "s1");
    const { provider, calls } = fakeProvider();
    await drainEmbedQueue(db, provider, { fingerprint: FP });
    expect(calls[0]![0]).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(calls[0]![0]).toContain("sk-…wxyz");
  });

  it("长私钥先整体脱敏再切块，不会跨块泄露", async () => {
    const { db } = tempDb();
    insertSession(db, "s1");
    const pem = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(1500)}\n-----END PRIVATE KEY-----`;
    appendMessage(db, "s1", 1, "user", [`请保存这个私钥：\n${pem}`]);
    enqueue(db, "embed_queue", "s1");
    const { provider, calls } = fakeProvider();
    await drainEmbedQueue(db, provider, { fingerprint: FP });
    expect(calls.length).toBeGreaterThan(0);
    for (const batch of calls) {
      for (const text of batch) {
        expect(text).not.toContain("A".repeat(1500));
        expect(text).not.toContain("BEGIN PRIVATE KEY");
      }
    }
  });

  it("已删除的会话不会再调用远端接口，旧向量会被清掉", async () => {
    const { db, temp } = tempDb();
    insertSession(db, "s1");
    appendMessage(db, "s1", 1, "user", ["帮我做一个登录页"]);
    enqueue(db, "embed_queue", "s1");
    const { provider, calls } = fakeProvider();
    await drainEmbedQueue(db, provider, { fingerprint: FP, env: temp.env });
    expect(calls.length).toBe(1);

    saveFilters(temp.env, { ...EMPTY_FILTERS, deletedSessions: ["s1"] });
    enqueue(db, "embed_queue", "s1");
    const second = await drainEmbedQueue(db, provider, { fingerprint: FP, env: temp.env });

    expect(second.skipped).toBe(1);
    expect(calls.length).toBe(1); // 没有新的外发请求
    expect(db.prepare("SELECT COUNT(*) AS n FROM embeddings").get()).toMatchObject({ n: 0 });
    expect(pendingCount(db, "embed_queue")).toBe(0);
  });

  it("目录被排除的会话同样不外发", async () => {
    const { db, temp } = tempDb();
    insertSession(db, "s1", "D:/webProject/secret-project");
    appendMessage(db, "s1", 1, "user", ["敏感目录里的内容"]);
    enqueue(db, "embed_queue", "s1");
    saveFilters(temp.env, { ...EMPTY_FILTERS, excludedDirs: ["D:/webProject/secret-project"] });
    const { provider, calls } = fakeProvider();
    const result = await drainEmbedQueue(db, provider, { fingerprint: FP, env: temp.env });
    expect(result.skipped).toBe(1);
    expect(calls.length).toBe(0);
  });

  it("失败归还 claim；连续失败暂停并记录状态", async () => {
    const { db } = tempDb();
    for (const id of ["s1", "s2", "s3", "s4"]) {
      insertSession(db, id);
      appendMessage(db, id, 1, "user", [`task ${id}`]);
      enqueue(db, "embed_queue", id);
    }
    const bad: EmbeddingProvider = {
      model: CONFIG.model,
      embed: async () => {
        throw new EmbeddingRequestError("HTTP 500", 500, true);
      },
    };
    const result = await drainEmbedQueue(db, bad, { fingerprint: FP, batchSessions: 1 });
    expect(result.paused).toBe(true);
    expect(result.failed).toBe(3);
    expect(result.remaining).toBe(4); // 失败的会话归还 claim、留在队列
    const status = embeddingStatus(db);
    expect(status.lastError).toContain("HTTP 500");
    // 失败的 claim 已归还：换一个好 provider 能续跑
    const { provider } = fakeProvider();
    const resumed = await drainEmbedQueue(db, provider, { fingerprint: FP });
    expect(resumed.processed).toBe(4);
    expect(embeddingStatus(db).lastError).toBeNull();
  });

  it("claim 租约互斥：并发第二个 claim 拿不到；租约过期后可再拿", () => {
    const { db } = tempDb();
    insertSession(db, "s1");
    enqueue(db, "embed_queue", "s1");
    const first = claim(db, "embed_queue", { limit: 5, now: 1_000_000 });
    expect(first).toEqual(["s1"]);
    expect(claim(db, "embed_queue", { limit: 5, now: 1_000_001 })).toEqual([]);
    // 租约（5 分钟）过期后可以再次 claim
    expect(claim(db, "embed_queue", { limit: 5, now: 1_000_000 + 6 * 60 * 1000 })).toEqual(["s1"]);
    release(db, "embed_queue", "s1");
    expect(claim(db, "embed_queue", { limit: 5, now: 1_000_002 })).toEqual(["s1"]);
    dequeue(db, "embed_queue", "s1");
    expect(pendingCount(db, "embed_queue")).toBe(0);
  });

  it("处理期间被重新入队时，条件出队保留新队列行", () => {
    const { db } = tempDb();
    insertSession(db, "s1");
    enqueue(db, "embed_queue", "s1");
    const claimedAt = 1_000_000;
    expect(claim(db, "embed_queue", { limit: 1, now: claimedAt })).toEqual(["s1"]);
    // 模拟 drain 处理期间索引器重新入队（claimed_at 被清空）
    enqueue(db, "embed_queue", "s1", claimedAt + 10);
    dequeue(db, "embed_queue", "s1", new Date(claimedAt).toISOString());
    expect(pendingCount(db, "embed_queue")).toBe(1);
  });

  it("定向 claim 的项目过滤在 LIMIT 之前生效", () => {
    const { db } = tempDb();
    for (let i = 0; i < 12; i++) {
      insertSession(db, `other-${i}`, "D:/webProject/other");
      enqueue(db, "embed_queue", `other-${i}`, 1000 + i);
    }
    insertSession(db, "target", "D:/webProject/target");
    enqueue(db, "embed_queue", "target", 2000);

    expect(
      claim(db, "embed_queue", { limit: 2, projectRoot: "D:/webProject/target", now: 5000 }),
    ).toEqual(["target"]);
  });

  it("会话没有可嵌正文时不入行（空壳）", async () => {
    const { db } = tempDb();
    insertSession(db, "s1");
    appendMessage(db, "s1", 1, "user", ["   "]);
    enqueue(db, "embed_queue", "s1");
    const { provider, calls } = fakeProvider();
    const result = await drainEmbedQueue(db, provider, { fingerprint: FP });
    expect(result.skipped).toBe(1);
    expect(calls.length).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM embeddings").get()).toMatchObject({ n: 0 });
  });
});

// ————————————————————————————————————————————————————————————————
// 配置解析 / 状态 / 清除 / 重建
// ————————————————————————————————————————————————————————————————

describe("配置与生命周期", () => {
  it("三个字段必须自填；关闭或缺字段则为未配置", () => {
    const { db } = tempDb();
    // 旧共享分组还在库里也不影响：语义检索只认自己的键
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('summary.baseUrl', ?)").run(
      "https://api.openai.com/v1",
    );
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('summary.apiKey', ?)").run("sk-shared");
    expect(resolveEmbeddingConfig(db)).toBeUndefined(); // 还没开
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('embed.enabled', '1')").run();
    expect(resolveEmbeddingConfig(db)).toBeUndefined(); // 没有 model
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('embed.model', 'text-embedding-3-small')").run();
    expect(resolveEmbeddingConfig(db)).toBeUndefined(); // baseUrl / key 不跨功能继承
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('embed.baseUrl', ?)").run(
      "https://api.openai.com/v1",
    );
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('embed.apiKey', 'sk-own')").run();
    const config = resolveEmbeddingConfig(db);
    expect(config).toMatchObject({
      model: "text-embedding-3-small",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-own",
      host: "api.openai.com",
    });
    expect(readEmbeddingSettings(db).enabled).toBe(true);
  });

  it("状态：当前指纹计数、待嵌、遗留指纹、规则版本提示", async () => {
    const { db } = tempDb();
    insertSession(db, "s1");
    appendMessage(db, "s1", 1, "user", ["hello"]);
    enqueue(db, "embed_queue", "s1");
    const { provider } = fakeProvider();
    await drainEmbedQueue(db, provider, { fingerprint: FP });

    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('embed.enabled', '1')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('embed.model', ?)").run(FP.model);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('embed.baseUrl', ?)").run(
      "https://embed.example.com/v1",
    );
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('embed.apiKey', 'k')").run();

    const status = embeddingStatus(db);
    expect(status).toMatchObject({
      enabled: true,
      configured: true,
      embeddedSessions: 1,
      embeddedChunks: 1,
      pendingSessions: 0,
      staleChunks: 0,
    });
    expect(status.rulesOutdated).toBe(false);

    // 换模型 → 旧行变"遗留"，给重建预估
    db.prepare("UPDATE settings SET value = 'other-model' WHERE key = 'embed.model'").run();
    const after = embeddingStatus(db);
    expect(after.staleChunks).toBe(1);
    expect(after.estimate?.chars).toBe(5);

    // 重建：先删旧、再全量入队；drain 用新指纹写入
    const rebuild = rebuildEmbeddings(db, { model: "other-model", host: FP.host });
    expect(rebuild.deleted).toBe(1);
    expect(rebuild.queued).toBe(1);
    await drainEmbedQueue(db, { model: "other-model", embed: provider.embed }, {
      fingerprint: { model: "other-model", host: FP.host },
    });
    expect(embeddingStatus(db).staleChunks).toBe(0);
  });

  it("删除全部向量：行与队列都清空（唯一清除路径）", async () => {
    const { db } = tempDb();
    insertSession(db, "s1");
    appendMessage(db, "s1", 1, "user", ["x"]);
    enqueue(db, "embed_queue", "s1");
    const { provider } = fakeProvider();
    await drainEmbedQueue(db, provider, { fingerprint: FP });
    enqueue(db, "embed_queue", "s1");
    deleteAllEmbeddings(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM embeddings").get()).toMatchObject({ n: 0 });
    expect(pendingCount(db, "embed_queue")).toBe(0);
  });
});

// ————————————————————————————————————————————————————————————————
// 查询侧打分
// ————————————————————————————————————————————————————————————————

describe("向量查询与聚合", () => {
  function put(db: DatabaseSync, sessionId: string, ordinal: number, vec: number[], model = FP.model): void {
    const f32 = Float32Array.from(vec);
    db.prepare(
      `INSERT INTO embeddings (session_id, ordinal, chunk_ix, content_hash, model, dims, host, vec, norm, updated_at)
       VALUES (?, ?, 0, 'h', ?, ?, ?, ?, ?, '2026-10-16T00:00:00Z')`,
    ).run(sessionId, ordinal, model, f32.length, FP.host, encodeVec(f32), l2norm(f32));
  }

  it("按指纹过滤、会话级聚合（maxCos + 新近加权）", () => {
    const { db } = tempDb();
    insertSession(db, "s1", "D:/webProject/demo");
    insertSession(db, "s2", "D:/webProject/other");
    put(db, "s1", 1, [0.5, 0.5]); // cos 与 [1,0] = 0.707
    put(db, "s1", 10, [1, 0]); // cos 1.0（最新）
    put(db, "s2", 1, [0, 1]); // cos 0

    const scores = scoreSessionsByVector(
      db,
      { ...FP, dims: 2 },
      { queryVec: new Float32Array([1, 0]), projectRoot: "D:/webProject/demo" },
    );
    expect(scores.length).toBe(1);
    const s1 = scores[0]!;
    expect(s1.sessionId).toBe("s1");
    expect(s1.maxCos).toBeCloseTo(1);
    expect(s1.bestOrdinal).toBe(10);
    expect(s1.weightedCos).toBeCloseTo(1);

    // 项目域外与定向集合之外都拿不到
    expect(
      scoreSessionsByVector(db, { ...FP, dims: 2 }, { queryVec: new Float32Array([1, 0]), sessionIds: ["s2"] })[0]!
        .maxCos,
    ).toBeCloseTo(0);
    expect(
      scoreSessionsByVector(
        db,
        { ...FP, dims: 2 },
        { queryVec: new Float32Array([1, 0]), projectRoot: "D:/webProject/nowhere" },
      ),
    ).toEqual([]);
  });

  it("只读当前指纹：换模型后旧行不参与计算", () => {
    const { db } = tempDb();
    insertSession(db, "s1");
    put(db, "s1", 1, [1, 0], "old-model");
    expect(
      scoreSessionsByVector(db, { ...FP, dims: 2 }, { queryVec: new Float32Array([1, 0]) }),
    ).toEqual([]);
  });

  it("维度不符的查询向量拿不到结果（静默降级）", () => {
    const { db } = tempDb();
    insertSession(db, "s1");
    put(db, "s1", 1, [1, 0]);
    expect(
      scoreSessionsByVector(db, { ...FP, dims: 3 }, { queryVec: new Float32Array([1, 0, 0]) }),
    ).toEqual([]);
  });
});
