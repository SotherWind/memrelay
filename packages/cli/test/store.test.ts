import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { claudeCodeAdapter } from "../src/adapters/claude-code/index.js";
import { qoderAdapter } from "../src/adapters/qoder/index.js";
import { codexAdapter } from "../src/adapters/codex/index.js";
import type { SerializedJsonlAdapter } from "../src/adapters/jsonl-family/jsonl-adapter.js";
import { buildIndex, indexOneScan, linkTasks } from "../src/store/indexer.js";
import {
  StoreMissingError,
  StoreTooNewError,
  checkpoint,
  dbPath,
  openReadOnly,
  openWritable,
} from "../src/store/db.js";
import { MAX_INLINE_CHARS, loadBlob } from "../src/store/ingest.js";
import { searchSessions } from "../src/store/search.js";
import { SCHEMA_VERSION } from "../src/store/schema.js";
import {
  makeTempHome,
  qoderAssistantRec,
  qoderSessionDir,
  qoderUserRec,
  wholeSecondDate,
  writeJsonlFile,
  type TempHome,
} from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const DEMO_PROJECT = "D:\\webProject\\demo-site";
const NOTES_PROJECT = "D:\\webProject\\notes-app";
const CALLER_PROJECT = "D:\\webProject\\relay-target";

function backdate(file: string, minutes: number): void {
  const past = new Date(Date.now() - minutes * 60 * 1000);
  fs.utimesSync(file, past, past);
}

/** 造一个带 fixture 的临时 HOME。 */
function setupHome(): TempHome {
  const temp = makeTempHome();
  cleanups.push(temp.cleanup);
  const qoderDir = path.join(temp.home, ".qoder", "projects", "d--webproject-demo-site");
  fs.mkdirSync(qoderDir, { recursive: true });
  fs.copyFileSync(
    path.resolve("test/fixtures/qoder/demo-site.jsonl"),
    path.join(qoderDir, "demo-site.jsonl"),
  );
  backdate(path.join(qoderDir, "demo-site.jsonl"), 90);

  const qoderSecrets = path.join(temp.home, ".qoder", "projects", "d--webproject-ops-check");
  fs.mkdirSync(qoderSecrets, { recursive: true });
  fs.copyFileSync(
    path.resolve("test/fixtures/qoder/long-secrets.jsonl"),
    path.join(qoderSecrets, "long-secrets.jsonl"),
  );
  backdate(path.join(qoderSecrets, "long-secrets.jsonl"), 80);

  const claudeDir = path.join(temp.home, ".claude", "projects", "d--webproject-notes-app");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.copyFileSync(
    path.resolve("test/fixtures/claude-code/notes-app.jsonl"),
    path.join(claudeDir, "notes-app.jsonl"),
  );
  backdate(path.join(claudeDir, "notes-app.jsonl"), 70);

  const callerDir = path.join(temp.home, ".claude", "projects", "d--webproject-relay-target");
  fs.mkdirSync(callerDir, { recursive: true });
  fs.copyFileSync(
    path.resolve("test/fixtures/claude-code/caller-resume.jsonl"),
    path.join(callerDir, "caller-resume.jsonl"),
  );
  backdate(path.join(callerDir, "caller-resume.jsonl"), 60);

  const codexDir = path.join(temp.home, ".codex", "sessions", "2026", "10", "11");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.copyFileSync(
    path.resolve("test/fixtures/codex/rollout-basic.jsonl"),
    path.join(codexDir, "rollout-basic.jsonl"),
  );
  backdate(path.join(codexDir, "rollout-basic.jsonl"), 50);
  return temp;
}

function adapters(): SerializedJsonlAdapter[] {
  return [claudeCodeAdapter(), qoderAdapter(), codexAdapter()];
}

describe("存储层：打开与迁移", () => {
  it("首次打开建库、设 schema 版本、WAL 模式", () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    const db = openWritable({ home: temp.home, platform: process.platform, env: {} });
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(SCHEMA_VERSION);
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(journal.journal_mode).toBe("wal");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of ["sources", "sessions", "messages", "parts", "blobs", "tasks", "secret_findings", "tombstones", "settings"]) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it("v1 旧库启动时补齐偏好整理表（未发版，版本仍为 1）", () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    const env = { home: temp.home, platform: process.platform, env: {} };
    let db = openWritable(env);
    for (const table of ["memory_exports", "memory_plan", "memory_items", "memory_sources"]) {
      db.exec(`DROP TABLE ${table}`);
    }
    db.exec("PRAGMA user_version = 1");
    db.close();

    db = openWritable(env);
    expect(db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    for (const table of ["memory_sources", "memory_items", "memory_plan", "memory_exports"]) {
      expect(tables).toContain(table);
    }
    db.close();
  });

  it("库版本比程序新时拒绝打开（读写与只读一致）", () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    const env = { home: temp.home, platform: process.platform, env: {} };
    const db = openWritable(env);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openWritable(env)).toThrow(StoreTooNewError);
    expect(() => openReadOnly(env)).toThrow(StoreTooNewError);
  });

  it("只读打开：缺库报错、写入被拒", () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    const env = { home: temp.home, platform: process.platform, env: {} };
    expect(() => openReadOnly(env)).toThrow(StoreMissingError);
    const db = openWritable(env);
    db.close();
    const ro = openReadOnly(env);
    expect(() => ro.exec("INSERT INTO settings (key) VALUES ('x')")).toThrow();
    ro.close();
  });
});

describe("索引器", () => {
  it("首次索引：会话、消息、片段、待办与状态落库", async () => {
    const temp = setupHome();
    const env = { home: temp.home, platform: process.platform, env: {} };
    const stats = await buildIndex(env, { adapters: adapters() });

    expect(stats.byAgent["qoder"]!.sessions).toBe(2);
    expect(stats.byAgent["claude-code"]!.sessions).toBe(2);
    expect(stats.byAgent["codex"]!.sessions).toBe(1);
    expect(stats.updated).toBe(5);
    expect(stats.failed).toBe(0);

    // 会话行：项目根、状态
    const db = openReadOnly(env);
    const demo = db
      .prepare("SELECT * FROM sessions WHERE id LIKE 'qoder:11111111%'")
      .get() as { project_root: string; status: string; first_user_message: string };
    expect(demo.project_root).toBe(DEMO_PROJECT);
    expect(demo.status).toBe("interrupted"); // 待办没清完
    expect(demo.first_user_message).toContain("公司官网首页");

    const notes = db
      .prepare("SELECT status FROM sessions WHERE id LIKE 'claude-code:33333333%'")
      .get() as { status: string };
    expect(notes.status).toBe("unknown"); // 读了文件后没有下文，也谈不上收尾总结

    const codex = db
      .prepare("SELECT status FROM sessions WHERE id LIKE 'codex:c0de0001%'")
      .get() as { status: string };
    expect(codex.status).toBe("done");
    db.close();
  });

  it("二次索引：没变过的会话全部跳过", async () => {
    const temp = setupHome();
    const env = { home: temp.home, platform: process.platform, env: {} };
    await buildIndex(env, { adapters: adapters() });
    const stats2 = await buildIndex(env, { adapters: adapters() });
    expect(stats2.updated).toBe(0);
    expect(stats2.skipped).toBe(5);
  });

  it("追加内容后：只重读变化的会话，行数随新内容更新", async () => {
    const temp = setupHome();
    const env = { home: temp.home, platform: process.platform, env: {} };
    await buildIndex(env, { adapters: adapters() });

    const file = path.join(
      temp.home,
      ".qoder",
      "projects",
      "d--webproject-demo-site",
      "demo-site.jsonl",
    );
    const extra = `${JSON.stringify({
      type: "user",
      uuid: "a1000000-0000-4000-8000-000000000099",
      timestamp: "2026-10-12T07:40:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "再加一个联系表单" }] },
      parentUuid: "a1000000-0000-4000-8000-000000000030",
      isSidechain: false,
      cwd: DEMO_PROJECT,
      sessionId: "11111111-1111-4111-8111-111111111111",
      gitBranch: "main",
    })}\n${JSON.stringify({
      type: "active-leaf",
      sessionId: "11111111-1111-4111-8111-111111111111",
      leafUuid: "a1000000-0000-4000-8000-000000000099",
    })}\n`;
    fs.appendFileSync(file, extra);
    backdate(file, 30); // 变化过，但不算"刚写"——状态保持按内容判断

    const stats2 = await buildIndex(env, { adapters: adapters() });
    expect(stats2.updated).toBe(1);
    expect(stats2.skipped).toBe(4);

    const db = openReadOnly(env);
    const found = db
      .prepare(
        "SELECT COUNT(*) AS c FROM parts p JOIN messages m ON p.message_id = m.id WHERE m.session_id LIKE 'qoder:11111111%' AND p.text LIKE '%联系表单%'",
      )
      .get() as { c: number };
    expect(found.c).toBe(1);
    db.close();
  });

  it("文件被截断时整文件重读", async () => {
    const temp = setupHome();
    const env = { home: temp.home, platform: process.platform, env: {} };
    await buildIndex(env, { adapters: adapters() });

    const file = path.join(
      temp.home,
      ".qoder",
      "projects",
      "d--webproject-demo-site",
      "demo-site.jsonl",
    );
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    fs.writeFileSync(file, `${lines.slice(0, 4).join("\n")}\n`, "utf8"); // 截掉一半
    backdate(file, 30);

    const stats2 = await buildIndex(env, { adapters: adapters() });
    expect(stats2.updated).toBe(1);

    const db = openReadOnly(env);
    const count = db
      .prepare(
        "SELECT COUNT(*) AS c FROM messages WHERE session_id LIKE 'qoder:11111111%'",
      )
      .get() as { c: number };
    expect(count.c).toBeLessThanOrEqual(3); // 只剩前面几条
    db.close();
  });

  it("适配器版本变化时重新解析", async () => {
    const temp = setupHome();
    const env = { home: temp.home, platform: process.platform, env: {} };
    await buildIndex(env, { adapters: adapters() });
    // 手动把 sources 里的版本改小，模拟适配器升级
    const db = openWritable(env);
    db.exec("UPDATE sources SET adapter_version = 0");
    db.close();

    const stats2 = await buildIndex(env, { adapters: adapters() });
    expect(stats2.updated).toBe(5);
  });

  it("超长片段：截断入库 + blobs 去重压缩保存", async () => {
    const temp = setupHome();
    const env = { home: temp.home, platform: process.platform, env: {} };

    // 往 notes 会话里塞一条超长工具输出
    const file = path.join(
      temp.home,
      ".claude",
      "projects",
      "d--webproject-notes-app",
      "notes-app.jsonl",
    );
    const huge = "X".repeat(MAX_INLINE_CHARS + 5000);
    const extra = `${JSON.stringify({
      type: "user",
      uuid: "c3000000-0000-4000-8000-000000000099",
      timestamp: "2026-10-11T02:10:00.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_huge", content: huge }],
      },
      parentUuid: "c3000000-0000-4000-8000-000000000071",
      isSidechain: false,
      cwd: NOTES_PROJECT,
      sessionId: "33333333-3333-4333-8333-333333333333",
      gitBranch: "main",
    })}\n`;
    fs.appendFileSync(file, extra);
    backdate(file, 30);

    await buildIndex(env, { adapters: adapters() });
    const db = openReadOnly(env);
    const part = db
      .prepare("SELECT id, text, truncated, blob_sha256 FROM parts WHERE text LIKE '%XXXX%' LIMIT 1")
      .get() as { id: number; text: string; truncated: number; blob_sha256: string };
    expect(part.truncated).toBe(1);
    expect(part.text).toContain("省略");
    const blobCount = db.prepare("SELECT COUNT(*) AS c FROM blobs").get() as { c: number };
    expect(blobCount.c).toBeGreaterThanOrEqual(1);
    db.close();

    // blob 能还原出完整内容
    const db2 = openReadOnly(env);
    const full = loadBlob(db2, part.blob_sha256);
    expect(full).toBeDefined();
    expect(full!.length).toBe(huge.length);
    db2.close();
  });

  it("密钥在入库时登记（只存遮盖预览）", async () => {
    const temp = setupHome();
    const env = { home: temp.home, platform: process.platform, env: {} };
    await buildIndex(env, { adapters: adapters() });
    const db = openReadOnly(env);
    const findings = db
      .prepare("SELECT rule_id, preview FROM secret_findings")
      .all() as Array<{ rule_id: string; preview: string }>;
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings.some((f) => f.rule_id === "connection-string")).toBe(true);
    // 预览里不能出现完整密钥
    expect(findings.every((f) => !f.preview.includes("hunter2secret"))).toBe(true);
    db.close();
  });

  it("接力链入库：两个会话串成一个任务", async () => {
    const temp = setupHome();
    const env = { home: temp.home, platform: process.platform, env: {} };
    await buildIndex(env, { adapters: adapters() });
    const db = openWritable(env);
    const link = db
      .prepare(
        "SELECT ts.task_id, ts.session_id, ts.position FROM task_sessions ts WHERE ts.session_id LIKE 'claude-code:55555555%'",
      )
      .get() as { task_id: number; session_id: string; position: number } | undefined;
    expect(link).toBeDefined();
    const members = db
      .prepare("SELECT session_id, position FROM task_sessions WHERE task_id = ? ORDER BY position")
      .all(link!.task_id) as Array<{ session_id: string; position: number }>;
    expect(members).toHaveLength(2);
    expect(members[0]!.session_id).toContain("qoder:11111111");
    expect(members[1]!.session_id).toContain("claude-code:55555555");
    const task = db.prepare("SELECT name FROM tasks WHERE id = ?").get(link!.task_id) as {
      name: string;
    };
    expect(task.name).toContain("公司官网首页");
    db.close();
  });

  it("跨项目误接保护：只是测试 resume 的会话不会被挂进别的项目链", async () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    const env = { home: temp.home, platform: process.platform, env: {} };
    const parentProject = "D:\\webProject\\chain-parent";
    const testProject = "D:\\webProject\\chain-test";
    const contProject = "D:\\webProject\\chain-cont";
    const parentId = "99999999-9999-4999-8999-999999999999";
    const testId = "88888888-8888-4888-8888-888888888888";
    const contId = "77777777-7777-4777-8777-777777777777";
    const marker = (project: string): string =>
      `【MemRelay 续接】\n续接自 Qoder:${parentId} · 会话数 1 · 2026-10-13 17:55 · ${project}\n\n## 接手须知\n- 继续做。\n`;
    const recordsFor = (id: string, project: string, first: string, prefix: string) => {
      const uid = (n: number): string => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
      return [
        qoderUserRec(id, uid(1), first, project),
        qoderAssistantRec(id, uid(2), [{ type: "text", text: "我先看一下。" }], project),
        {
          type: "user",
          sessionId: id,
          uuid: uid(3),
          timestamp: "2026-10-13T18:00:00.000Z",
          cwd: project,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_relay", content: marker(project) }],
          },
        },
        qoderAssistantRec(id, uid(4), [{ type: "text", text: "处理完成。" }], project),
      ];
    };
    const write = (id: string, project: string, first: string, prefix: string): void => {
      writeJsonlFile(
        path.join(qoderSessionDir(temp.home, project), `${id}.jsonl`),
        recordsFor(id, project, first, prefix),
        wholeSecondDate(30),
      );
    };
    write(parentId, parentProject, "做一个登录页", "99990000");
    // 只是在本项目的开发会话里测试 resume："看看这个 hooks 问题" 不是续接指令
    write(testId, testProject, "看看这个 hooks 问题", "88880000");
    // 真正的跨项目续接：首条指令明确是"继续完成"
    write(contId, contProject, "继续完成登录页", "77770000");

    await buildIndex(env, { adapters: [qoderAdapter()] });
    const db = openReadOnly(env);
    const parentOf = (id: string): string | null =>
      (db.prepare("SELECT parent_session_id AS p FROM sessions WHERE id = ?").get(`qoder:${id}`) as {
        p: string | null;
      }).p;
    expect(parentOf(testId)).toBeNull();
    expect(parentOf(contId)).toBe(`qoder:${parentId}`);
    const linked = db
      .prepare("SELECT session_id AS id FROM task_sessions WHERE session_id IN (?, ?)")
      .all(`qoder:${testId}`, `qoder:${contId}`) as Array<{ id: string }>;
    expect(linked.map((r) => r.id)).toEqual([`qoder:${contId}`]);
    db.close();
  });
  it("适配器读不出会话时保留旧索引，不把会话覆盖成空壳", async () => {
    const temp = setupHome();
    const env = { home: temp.home, platform: process.platform, env: {} };
    await buildIndex(env, { adapters: adapters() });
    const db = openWritable(env);
    const before = db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
    const source = db
      .prepare("SELECT path, size, mtime_ms FROM sources WHERE agent = 'qoder' LIMIT 1")
      .get() as { path: string; size: number; mtime_ms: number };
    db.close();

    const broken = {
      agent: "qoder",
      version: 1,
      async *readSession() {},
    } as unknown as SerializedJsonlAdapter;
    await expect(
      indexOneScan(
        env,
        broken,
        {
          id: "qoder:11111111-1111-4111-8111-111111111111",
          agent: "qoder",
          sourcePath: source.path,
          cwd: DEMO_PROJECT,
          mtimeMs: source.mtime_ms + 1000,
          sizeBytes: source.size + 1,
          tail: {
            statusInfo: {
              pendingToolCallIds: [],
              lastUserMessageUnanswered: false,
              quotaOrLimitDetected: false,
              errorDetected: false,
            },
            hasActiveLeaf: false,
            memrelayCalledRecently: false,
          },
        },
        Date.now(),
      ),
    ).rejects.toThrow(/会话元数据/);

    const after = openReadOnly(env);
    expect(after.prepare("SELECT COUNT(*) AS n FROM messages").get()).toMatchObject({ n: before.n });
    expect(after.prepare("SELECT size FROM sources WHERE path = ?").get(source.path)).toMatchObject({
      size: source.size,
    });
    after.close();
  });

  it("索引器版本不一致时 hook 只跳过本次增量，不清空全库", async () => {
    const temp = setupHome();
    const env = { home: temp.home, platform: process.platform, env: {} };
    await buildIndex(env, { adapters: adapters() });
    const db = openWritable(env);
    const before = db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
    db.prepare("UPDATE settings SET value = '0' WHERE key = 'indexer_version'").run();
    db.close();

    const result = await indexOneScan(
      env,
      claudeCodeAdapter(),
      {
        id: "claude-code:33333333-3333-4333-8333-333333333333",
        agent: "claude-code",
        sourcePath: "D:/not-used.jsonl",
        cwd: NOTES_PROJECT,
        mtimeMs: 1,
        sizeBytes: 1,
        tail: {
          statusInfo: {
            pendingToolCallIds: [],
            lastUserMessageUnanswered: false,
            quotaOrLimitDetected: false,
            errorDetected: false,
          },
          hasActiveLeaf: false,
          memrelayCalledRecently: false,
        },
      },
      Date.now(),
    );
    expect(result.updated).toBe(false);

    const after = openReadOnly(env);
    expect(after.prepare("SELECT COUNT(*) AS n FROM messages").get()).toMatchObject({ n: before.n });
    after.close();
  });
});

describe("搜索（只读）", () => {
  async function indexedEnv(): Promise<{ temp: TempHome; env: { home: string; platform: NodeJS.Platform; env: Record<string, string | undefined> } }> {
    const temp = setupHome();
    const env = { home: temp.home, platform: process.platform, env: {} as Record<string, string | undefined> };
    await buildIndex(env, { adapters: adapters() });
    return { temp, env };
  }

  it("两个字的中文词能搜到（相邻两字切分）", async () => {
    const { env } = await indexedEnv();
    const db = openReadOnly(env);
    const results = searchSessions(db, { projectRoot: DEMO_PROJECT, query: "官网", env });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.session.id).toContain("qoder:11111111");
    expect(results[0]!.matches[0]!.snippet).toContain("官网");
    db.close();
  });

  it("中文词组（多词）也能命中", async () => {
    const { env } = await indexedEnv();
    const db = openReadOnly(env);
    const results = searchSessions(db, { projectRoot: DEMO_PROJECT, query: "公司官网", env });
    expect(results.length).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it("词组中间插入文字仍能命中；单字也能搜到", async () => {
    const { temp, env } = await indexedEnv();
    const dir = path.join(temp.home, ".qoder", "projects", "d--webproject-demo-site");
    const id = "aaaaaaaa-1111-4111-8111-111111111111";
    writeJsonlFile(path.join(dir, "extra.jsonl"), [
      qoderUserRec(id, "e1000000-0000-4000-8000-000000000001", "帮我生成一个公司前端网站，包含鲲鹏展示页", DEMO_PROJECT),
      qoderAssistantRec(
        id,
        "e1000000-0000-4000-8000-000000000002",
        [{ type: "text", text: "前端网站骨架已生成" }],
        DEMO_PROJECT,
      ),
    ], wholeSecondDate(10));
    await buildIndex(env, { adapters: adapters() });

    const db = openReadOnly(env);
    const inserted = searchSessions(db, { projectRoot: DEMO_PROJECT, query: "生成前端网站", env });
    expect(inserted.some((r) => r.session.id === `qoder:${id}`)).toBe(true);
    const single = searchSessions(db, { projectRoot: DEMO_PROJECT, query: "鲲", env });
    expect(single.some((r) => r.session.id === `qoder:${id}`)).toBe(true);
    db.close();
  });

  it("英文与代码词走默认分词", async () => {
    const { env } = await indexedEnv();
    const db = openReadOnly(env);
    const results = searchSessions(db, { projectRoot: NOTES_PROJECT, query: "markdown", env });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.session.id).toContain("claude-code:33333333");
    db.close();
  });

  it("只搜当前项目", async () => {
    const { env } = await indexedEnv();
    const db = openReadOnly(env);
    const results = searchSessions(db, { projectRoot: NOTES_PROJECT, query: "官网", env });
    expect(results).toHaveLength(0);
    db.close();
  });

  it("filters.json 里删除的会话不出现在结果里", async () => {
    const { temp, env } = await indexedEnv();
    fs.writeFileSync(
      path.join(temp.home, ".memrelay", "filters.json"),
      JSON.stringify({ deletedSessions: ["qoder:11111111-1111-4111-8111-111111111111"] }),
    );
    const db = openReadOnly(env);
    const results = searchSessions(db, { projectRoot: DEMO_PROJECT, query: "官网", env });
    expect(results).toHaveLength(0);
    db.close();
  });
});

describe("dbPath 与 MEMRELAY_HOME", () => {
  it("MEMRELAY_HOME 覆盖库位置", () => {
    const custom = path.join(path.sep === "\\" ? "C:\\" : "/", "tmp-memrelay-test-home");
    const env = { home: custom, platform: process.platform, env: { MEMRELAY_HOME: custom } };
    expect(dbPath(env)).toBe(path.join(custom, "memrelay.db"));
  });
});
