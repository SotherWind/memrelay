import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { clearQueryVectorCache, l2norm, type EmbeddingProvider } from "../src/core/embeddings.js";
import { toCjkIndexText } from "../src/core/fts.js";
import { fuseRankedSemantics, selectSession, type RankedSession } from "../src/resume/select.js";
import { openReadOnly, openWritable } from "../src/store/db.js";
import { encodeVec, embeddingStatus } from "../src/store/embeddings-store.js";
import { enqueue } from "../src/store/queue.js";
import { searchSessions } from "../src/store/search.js";
import {
  semanticHitsForSearch,
  semanticScoresForResume,
  targetedDrain,
} from "../src/store/semantic.js";
import { makeTempHome, type TempHome } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  clearQueryVectorCache();
});

function tempHome(): TempHome {
  const temp = makeTempHome();
  cleanups.push(temp.cleanup);
  return temp;
}

function withDb(temp: TempHome, fn: (db: DatabaseSync) => void): void {
  const db = openWritable(temp.env);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function configureEmbeddings(db: DatabaseSync, model = "test-embed"): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('embed.enabled', '1')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('embed.model', ?)").run(model);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('embed.baseUrl', ?)").run(
    "https://embed.example.com/v1",
  );
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('embed.apiKey', ?)").run("k");
}

function insertSession(db: DatabaseSync, id: string, projectRoot = "D:/webProject/demo"): void {
  db.prepare(
    `INSERT INTO sessions (id, agent, project_root, cwd, status, status_source, started_at)
     VALUES (?, 'qoder', ?, ?, 'interrupted', 'auto', '2026-10-15T10:00:00Z')`,
  ).run(id, projectRoot, projectRoot);
}

function appendText(db: DatabaseSync, sessionId: string, ordinal: number, role: string, text: string): void {
  const info = db
    .prepare("INSERT INTO messages (session_id, ordinal, role) VALUES (?, ?, ?)")
    .run(sessionId, ordinal, role);
  db.prepare("INSERT INTO parts (message_id, idx, kind, text) VALUES (?, 0, 'text', ?)").run(
    Number(info.lastInsertRowid),
    text,
  );
}

function putVector(
  db: DatabaseSync,
  sessionId: string,
  ordinal: number,
  vec: number[],
  model = "test-embed",
): void {
  const f32 = Float32Array.from(vec);
  db.prepare(
    `INSERT INTO embeddings (session_id, ordinal, chunk_ix, content_hash, model, dims, host, vec, norm, updated_at)
     VALUES (?, ?, 0, 'h', ?, ?, 'embed.example.com', ?, ?, '2026-10-16T00:00:00Z')`,
  ).run(sessionId, ordinal, model, f32.length, encodeVec(f32), l2norm(f32));
}

function fetchReturning(vector: number[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: vector }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function makeRanked(id: string, overrides: Partial<RankedSession> = {}): RankedSession {
  const keyword = overrides.keyword ?? 0;
  const timeScore = overrides.timeScore ?? 0.4;
  const fileOverlap = overrides.fileOverlap ?? 0;
  const interruptedBonus = overrides.interruptedBonus ?? 0.15;
  return {
    scan: { id, agent: "qoder", sourcePath: `${id}.jsonl`, mtimeMs: Date.now(), sizeBytes: 10, tail: {} } as RankedSession["scan"],
    keyword,
    timeScore,
    fileOverlap,
    interruptedBonus,
    total: overrides.total ?? timeScore + keyword * 1.2 + fileOverlap * 0.4 + interruptedBonus,
    status: overrides.status ?? "interrupted",
    hasContent: true,
    isCaller: false,
    ...overrides,
  };
}

// ————————————————————————————————————————————————————————————————
// 接力融合（纯函数 + 阈值语义）
// ————————————————————————————————————————————————————————————————

describe("接力语义融合", () => {
  it("keyword 分量 = max(keywordScore, clamp((cos−0.35)/0.4))，total 其余项不变", () => {
    const ranked = [makeRanked("s1", { keyword: 0, timeScore: 0.4 })];
    fuseRankedSemantics(ranked, new Map([["s1", 0.75]]));
    expect(ranked[0]!.keyword).toBe(1);
    expect(ranked[0]!.semantic).toBe(0.75);
    expect(ranked[0]!.total).toBeCloseTo(0.4 + 1.2 + 0.15);
  });

  it("低于 0.35 记 0 分；高于既有 keywordScore 才抬升", () => {
    const low = [makeRanked("s1", { keyword: 0 })];
    fuseRankedSemantics(low, new Map([["s1", 0.3]]));
    expect(low[0]!.keyword).toBe(0);
    expect(low[0]!.total).toBeCloseTo(0.4 + 0.15);

    const strong = [makeRanked("s2", { keyword: 0.8 })];
    fuseRankedSemantics(strong, new Map([["s2", 0.6]])); // 语义折算 0.625 < 0.8
    expect(strong[0]!.keyword).toBe(0.8); // max 保留字面命中
  });

  it("未在分数表中的会话原样不动", () => {
    const ranked = [makeRanked("s1", { keyword: 0.2 })];
    const before = { ...ranked[0]! };
    fuseRankedSemantics(ranked, new Map([["other", 0.9]]));
    expect(ranked[0]!.keyword).toBe(before.keyword);
    expect(ranked[0]!.total).toBe(before.total);
    expect(ranked[0]!.semantic).toBeUndefined();
  });

  it("语义抬升后能过 decisive 阈值（decisive / menu 语义不变）", () => {
    const ranked = [makeRanked("s1", { keyword: 0, timeScore: 0.4 }), makeRanked("s2", { keyword: 0, timeScore: 0.2 })];
    fuseRankedSemantics(ranked, new Map([["s1", 0.82]]));
    const selection = selectSession(ranked, "登录页");
    expect(selection.mode).toBe("confident");
    expect(selection.chosen?.scan.id).toBe("s1");
  });
});

// ————————————————————————————————————————————————————————————————
// 查询侧语义通道（含降级）
// ————————————————————————————————————————————————————————————————

describe("semanticScoresForResume", () => {
  it("未启用时零成本返回空 Map（不发起任何请求）", async () => {
    const temp = tempHome();
    const fetchImpl = vi.fn();
    withDb(temp, (db) => {
      insertSession(db, "s1");
      putVector(db, "s1", 1, [1, 0]);
    });
    const scores = await semanticScoresForResume(temp.env, "登录页", ["s1"], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(scores.size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("启用后：查询词嵌入 → 会话级加权聚合返回", async () => {
    const temp = tempHome();
    withDb(temp, (db) => {
      insertSession(db, "s1");
      configureEmbeddings(db);
      putVector(db, "s1", 1, [0.5, 0.5]); // cos 0.707
      putVector(db, "s1", 10, [1, 0]); // cos 1.0（最新，权重满）
    });
    const scores = await semanticScoresForResume(temp.env, "登录页", ["s1"], {
      fetchImpl: fetchReturning([1, 0]),
    });
    expect(scores.get("s1")).toBeCloseTo(1);
  });

  it("接口失败 / 维度不符时静默返回空 Map（调用方回退关键词通道）", async () => {
    const temp = tempHome();
    withDb(temp, (db) => {
      insertSession(db, "s1");
      configureEmbeddings(db);
      putVector(db, "s1", 1, [1, 0]);
    });
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect((await semanticScoresForResume(temp.env, "k", ["s1"], { fetchImpl: failing })).size).toBe(0);
    // 模型不符（指纹不一致）→ 空
    expect(
      (
        await semanticScoresForResume(temp.env, "k2", ["s1"], {
          fetchImpl: fetchReturning([1, 0, 0]),
        })
      ).size,
    ).toBe(0);
  });
});

describe("semanticHitsForSearch", () => {
  it("返回会话级向量榜；项目过滤与 limit 生效", async () => {
    const temp = tempHome();
    withDb(temp, (db) => {
      insertSession(db, "s1", "D:/webProject/demo");
      insertSession(db, "s2", "D:/webProject/other");
      configureEmbeddings(db);
      putVector(db, "s1", 2, [0.6, 0.8]);
      putVector(db, "s2", 1, [1, 0]); // 更强，但另一个项目
    });
    const hits = await semanticHitsForSearch(temp.env, "登录页", {
      projectRoot: "D:/webProject/demo",
      drain: false,
      fetchImpl: fetchReturning([1, 0]),
    });
    expect(hits.length).toBe(1);
    expect(hits[0]).toMatchObject({ sessionId: "s1", ordinal: 2 });
    expect(hits[0]!.cos).toBeCloseTo(0.6); // [0.6,0.8] 归一后与 [1,0] 的余弦
  });
});

describe("targetedDrain（查询前定向排空）", () => {
  it("有预算地补嵌候选会话；未启用时什么都不做", async () => {
    const temp = tempHome();
    withDb(temp, (db) => {
      insertSession(db, "s1");
      appendText(db, "s1", 1, "user", "帮我做登录页");
      enqueue(db, "embed_queue", "s1");
    });
    // 未启用：直接返回 undefined，不写行
    expect(await targetedDrain(temp.env, { sessionIds: ["s1"] })).toBeUndefined();
    withDb(temp, (db) => {
      expect((db.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number }).n).toBe(0);
    });

    withDb(temp, (db) => configureEmbeddings(db));
    const result = await targetedDrain(temp.env, {
      sessionIds: ["s1"],
      deps: { fetchImpl: fetchReturning([1, 0]) },
    });
    expect(result?.processed).toBe(1);
    withDb(temp, (db) => {
      expect((db.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number }).n).toBe(1);
      // checkpoint 后只读连接可见（resume 的后续读就是只读打开）
      const ro = openReadOnly(temp.env);
      try {
        expect((ro.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number }).n).toBe(1);
      } finally {
        ro.close();
      }
    });
  });
});

// ————————————————————————————————————————————————————————————————
// 搜索混合（RRF k=60）与降级一致性
// ————————————————————————————————————————————————————————————————

describe("搜索 RRF 融合", () => {
  function seedSearchDb(temp: TempHome): void {
    withDb(temp, (db) => {
      insertSession(db, "s1");
      insertSession(db, "s2");
      appendText(db, "s1", 1, "user", "登录页做到一半");
      appendText(db, "s2", 1, "user", "auth page 的会话，用词对不上");
      db.exec("INSERT INTO parts_fts (rowid, text) SELECT id, text FROM parts");
      // CJK 索引按双字组切分（与 indexer 的写入方式一致）
      const insertCjk = db.prepare("INSERT INTO parts_cjk_fts (rowid, text) VALUES (?, ?)");
      for (const row of db.prepare("SELECT id, text FROM parts").all() as Array<{
        id: number;
        text: string;
      }>) {
        insertCjk.run(row.id, toCjkIndexText(row.text));
      }
    });
  }

  it("FTS 独有 + 向量独有都保留；向量独有命中摘要来自命中块文本", () => {
    const temp = tempHome();
    seedSearchDb(temp);
    withDb(temp, (db) => {
      const plain = searchSessions(db, { projectRoot: "", query: "登录页", env: temp.env });
      expect(plain.map((r) => r.session.id)).toEqual(["s1"]);

      const fused = searchSessions(db, {
        projectRoot: "",
        query: "登录页",
        env: temp.env,
        semantic: [{ sessionId: "s2", cos: 0.9, ordinal: 1, chunkIx: 0 }],
      });
      const ids = fused.map((r) => r.session.id);
      expect(ids).toContain("s1");
      expect(ids).toContain("s2");
      const s2 = fused.find((r) => r.session.id === "s2")!;
      expect(s2.matches[0]!.snippet).toContain("auth page");
      // 向量独有命中排前（它的 RRF 更高：排名 1 vs s1 的 FTS 排名 1 并列，时间戳同 → 先出现者无先后断言，改查两者都在）
    });
  });

  it("RRF 排序：两榜交叉时按 1/(60+rank) 之和", () => {
    const temp = tempHome();
    seedSearchDb(temp);
    withDb(temp, (db) => {
      const fused = searchSessions(db, {
        projectRoot: "",
        query: "登录页",
        env: temp.env,
        semantic: [
          { sessionId: "s2", cos: 0.95, ordinal: 1, chunkIx: 0 }, // 向量第 1
          { sessionId: "s1", cos: 0.5, ordinal: 1, chunkIx: 0 }, // 向量第 2（FTS 第 1）
        ],
      });
      // s1: 1/61 + 1/62；s2: 1/61 → s1 总分更高
      expect(fused[0]!.session.id).toBe("s1");
      expect(fused[1]!.session.id).toBe("s2");
    });
  });

  it("降级逐字一致：无 semantic 与 semantic 为空数组结果完全相同", () => {
    const temp = tempHome();
    seedSearchDb(temp);
    withDb(temp, (db) => {
      const a = searchSessions(db, { projectRoot: "", query: "登录页", env: temp.env });
      const b = searchSessions(db, { projectRoot: "", query: "登录页", env: temp.env, semantic: [] });
      expect(b).toEqual(a);
    });
  });

  it("向量命中的会话若已删除 / 被过滤，不进入结果", () => {
    const temp = tempHome();
    seedSearchDb(temp);
    withDb(temp, (db) => {
      db.prepare("UPDATE sessions SET deleted_at = '2026-10-16T00:00:00Z' WHERE id = 's2'").run();
      const fused = searchSessions(db, {
        projectRoot: "",
        query: "登录页",
        env: temp.env,
        semantic: [{ sessionId: "s2", cos: 0.9, ordinal: 1, chunkIx: 0 }],
      });
      expect(fused.map((r) => r.session.id)).toEqual(["s1"]);
    });
  });

  it("FTS 一个都没命中、向量有命中时也能给出结果", () => {
    const temp = tempHome();
    seedSearchDb(temp);
    withDb(temp, (db) => {
      const fused = searchSessions(db, {
        projectRoot: "",
        query: "完全不存在的词xyz",
        env: temp.env,
        semantic: [{ sessionId: "s2", cos: 0.8, ordinal: 1, chunkIx: 0 }],
      });
      expect(fused.map((r) => r.session.id)).toEqual(["s2"]);
    });
  });
});

// ————————————————————————————————————————————————————————————————
// 语义 provider 注入下的端到端小闭环（回填 → 查询 → 融合）
// ————————————————————————————————————————————————————————————————

describe("端到端小闭环", () => {
  it("回填后接力候选能拿到语义分；provider 失败则与未开启一致", async () => {
    const temp = tempHome();
    withDb(temp, (db) => {
      insertSession(db, "s1");
      configureEmbeddings(db);
      appendText(db, "s1", 1, "user", "auth page 重构");
      enqueue(db, "embed_queue", "s1");
    });

    // provider 把任意文本嵌成接近 [1,0]：脱敏后正文与查询词都能对上
    const provider: EmbeddingProvider = {
      model: "test-embed",
      embed: async (texts) => texts.map(() => new Float32Array([1, 0])),
    };
    const db = openWritable(temp.env);
    try {
      const { drainEmbedQueue } = await import("../src/store/embeddings-store.js");
      const result = await drainEmbedQueue(db, provider, {
        fingerprint: { model: "test-embed", host: "embed.example.com" },
      });
      expect(result.processed).toBe(1);
      expect(embeddingStatus(db).embeddedSessions).toBe(1);
    } finally {
      db.close();
    }

    const scores = await semanticScoresForResume(temp.env, "登录界面", ["s1"], {
      fetchImpl: fetchReturning([1, 0]),
    });
    expect(scores.get("s1")).toBeCloseTo(1);

    // 接口挂掉：同一调用返回空 → 调用方（resume 命令）不会融合任何东西
    clearQueryVectorCache(); // 排除 LRU 命中，验证真实降级
    const failing = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const degraded = await semanticScoresForResume(temp.env, "登录界面", ["s1"], { fetchImpl: failing });
    expect(degraded.size).toBe(0);
  });
});
