import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { claudeCodeAdapter } from "../src/adapters/claude-code/index.js";
import { qoderAdapter } from "../src/adapters/qoder/index.js";
import { codexAdapter } from "../src/adapters/codex/index.js";
import type { SerializedJsonlAdapter } from "../src/adapters/jsonl-family/jsonl-adapter.js";
import { clearQueryVectorCache } from "../src/core/embeddings.js";
import { buildIndex } from "../src/store/indexer.js";
import { openReadOnly, openWritable } from "../src/store/db.js";
import { generateToken, hostAllowed, tokenFromCookie, tokensEqual } from "../src/server/security.js";
import { getTaskDetail, listProjectTasks, listTaskSummary } from "../src/server/task-list.js";
import { getSessionMessages, listRecentSessions, searchAllSessions } from "../src/server/conversations.js";
import { deleteSessions, listTrash, restoreSessions } from "../src/server/deletions.js";
import { getExclusions, listSecrets, setExclusions } from "../src/server/privacy.js";
import { readUiSettings, writeUiSettings } from "../src/server/settings-store.js";
import { applyIntegrations, listIntegrations, maybeAutoIntegrateHint } from "../src/server/integrations.js";
import { setSessionsStatus, setTaskName, updateManualChains } from "../src/server/task-status.js";
import { selectSession, type RankedSession } from "../src/resume/select.js";
import type { SessionStatus } from "../src/core/types.js";
import type { SetupOptions } from "../src/integrations/setup.js";
import { startServer, type RunningServer } from "../src/server/server.js";
import { allTasks, FIXTURE_PROJECTS, makeTempHome, type TempHome } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  clearQueryVectorCache();
});

function backdate(file: string, minutes: number): void {
  const past = new Date(Date.now() - minutes * 60 * 1000);
  fs.utimesSync(file, past, past);
}

/** 和 store 测试同一套夹具：qoder 两个项目、claude 两个（其中一个是接力链），codex 一个。 */
function setupHome(): TempHome {
  const temp = makeTempHome();
  cleanups.push(temp.cleanup);

  const qoderDir = path.join(temp.home, ".qoder", "projects", "d--webproject-demo-site");
  fs.mkdirSync(qoderDir, { recursive: true });
  // 文件名用会话 id：和真实 Qoder 布局一致，跨项目按 id 前缀找文件（接力链上游）才能命中
  const demoFile = path.join(qoderDir, "11111111-1111-4111-8111-111111111111.jsonl");
  fs.copyFileSync(path.resolve("test/fixtures/qoder/demo-site.jsonl"), demoFile);
  backdate(demoFile, 90);

  const qoderSecrets = path.join(temp.home, ".qoder", "projects", "d--webproject-ops-check");
  fs.mkdirSync(qoderSecrets, { recursive: true });
  fs.copyFileSync(path.resolve("test/fixtures/qoder/long-secrets.jsonl"), path.join(qoderSecrets, "long-secrets.jsonl"));
  backdate(path.join(qoderSecrets, "long-secrets.jsonl"), 80);

  const claudeDir = path.join(temp.home, ".claude", "projects", "d--webproject-notes-app");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.copyFileSync(path.resolve("test/fixtures/claude-code/notes-app.jsonl"), path.join(claudeDir, "notes-app.jsonl"));
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
  fs.copyFileSync(path.resolve("test/fixtures/codex/rollout-basic.jsonl"), path.join(codexDir, "rollout-basic.jsonl"));
  backdate(path.join(codexDir, "rollout-basic.jsonl"), 50);

  return temp;
}

function adapters(): SerializedJsonlAdapter[] {
  return [claudeCodeAdapter(), qoderAdapter(), codexAdapter()];
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  pathname: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: opts.method ?? "GET",
        headers: opts.headers ?? {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe("安全：令牌与 Host", () => {
  it("hostAllowed 只放行回环名（可带端口）", () => {
    expect(hostAllowed("127.0.0.1:4823")).toBe(true);
    expect(hostAllowed("localhost")).toBe(true);
    expect(hostAllowed("LOCALHOST:80")).toBe(true);
    expect(hostAllowed("[::1]:9000")).toBe(true);
    expect(hostAllowed("evil.example.com")).toBe(false);
    expect(hostAllowed("127.0.0.1.evil.com")).toBe(false);
    expect(hostAllowed("localhost.evil.com:80")).toBe(false);
    expect(hostAllowed(undefined)).toBe(false);
    expect(hostAllowed("")).toBe(false);
  });

  it("tokensEqual 长度不同直接拒绝，相同才通过", () => {
    const token = generateToken();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(tokensEqual(token, token)).toBe(true);
    expect(tokensEqual(token, generateToken())).toBe(false);
    expect(tokensEqual("short", token)).toBe(false);
    expect(tokensEqual("", token)).toBe(false);
  });

  it("tokenFromCookie 从 Cookie 头取出 memrelay_token", () => {
    expect(tokenFromCookie("a=1; memrelay_token=abc%3D123; b=2")).toBe("abc=123");
    expect(tokenFromCookie("memrelay_token=plain")).toBe("plain");
    expect(tokenFromCookie("x=y")).toBeUndefined();
    expect(tokenFromCookie(undefined)).toBeUndefined();
  });
});

describe("任务列表投影", () => {
  it("接力链合成一个任务，两次会话成为两段腿；未知状态如实透传", async () => {
    const temp = setupHome();
    await buildIndex(temp.env, { adapters: adapters() });
    const db = openReadOnly(temp.env);
    try {
      const tasks = allTasks(db, temp.env);
      expect(tasks).toHaveLength(4);

      const chain = tasks.find((t) => t.legs.length === 2);
      expect(chain).toBeDefined();
      expect(chain!.id.startsWith("task:")).toBe(true);
      expect(chain!.title).toContain("公司官网");
      expect(chain!.legs[0]!.tool).toBe("qoder");
      expect(chain!.legs[1]!.tool).toBe("claude-code");
      expect(chain!.lastActiveAt).toBeGreaterThan(0);

      // 每个任务的腿都有消息数；文件数按 file_edit 片段去重统计
      for (const task of tasks) {
        for (const leg of task.legs) {
          expect(leg.messageCount).toBeGreaterThan(0);
          expect(leg.fileCount).toBeGreaterThanOrEqual(0);
        }
      }

      // notes-app 正常结束后没有总结：状态是 unknown，也要出现在列表里
      expect(tasks.some((t) => t.status === "unknown")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("老库回填：统计列缺失时重跑 buildIndex 补齐，结果与全新索引一致", async () => {
    const temp = setupHome();
    await buildIndex(temp.env, { adapters: adapters() });
    const db = openReadOnly(temp.env);
    const reference = allTasks(db, temp.env).map((t) => ({ id: t.id, status: t.status, legs: t.legs }));
    db.close();

    // 模拟升级前的老库：v3 的统计与信号列全是默认值
    const wdb = openWritable(temp.env);
    wdb.exec(
      `UPDATE sessions SET message_count = -1, file_count = -1, sig_pending = 0, sig_quota = 0,
         sig_error = 0, sig_unanswered = 0, sig_todos_open = 0, sig_last_real = NULL, sig_reply_len = 0`,
    );
    wdb.close();

    const stats = await buildIndex(temp.env, { adapters: adapters() });
    expect(stats.updated).toBe(0); // 会话文件没变，不重扫

    const db2 = openReadOnly(temp.env);
    try {
      const left = db2
        .prepare("SELECT COUNT(*) AS c FROM sessions WHERE message_count < 0")
        .get() as { c: number };
      expect(left.c).toBe(0);
      const after = allTasks(db2, temp.env).map((t) => ({ id: t.id, status: t.status, legs: t.legs }));
      expect(after).toEqual(reference);
    } finally {
      db2.close();
    }
  });

  it("任务 id 用根会话身份：重索引导致链接行重建，id 不变", async () => {
    const temp = setupHome();
    await buildIndex(temp.env, { adapters: adapters() });
    const db1 = openReadOnly(temp.env);
    const before = allTasks(db1, temp.env).find((t) => t.legs.length === 2)!;
    expect(before.id.startsWith("task:")).toBe(true);
    db1.close();

    // 动一下根会话文件（mtime 变化 → 重索引 → task_sessions 行删除并重建）
    const rootFile = path.join(
      temp.home,
      ".qoder",
      "projects",
      "d--webproject-demo-site",
      "11111111-1111-4111-8111-111111111111.jsonl",
    );
    fs.utimesSync(rootFile, new Date(), new Date());
    const stats = await buildIndex(temp.env, { adapters: adapters() });
    expect(stats.updated).toBe(1);

    const db2 = openReadOnly(temp.env);
    const after = allTasks(db2, temp.env).find((t) => t.legs.length === 2);
    expect(after?.id).toBe(before.id);
    const detail = getTaskDetail(db2, temp.env, before.id);
    expect(detail).toBeDefined();
    expect(detail!.legs).toHaveLength(2);
    db2.close();
  });

  it("同项目内按最近活动倒序（不再按状态排序）", async () => {
    const temp = setupHome();
    await buildIndex(temp.env, { adapters: adapters() });
    const db = openReadOnly(temp.env);
    try {
      const summary = listTaskSummary(db, temp.env);
      for (const project of summary.projects) {
        const page = listProjectTasks(db, temp.env, { project: project.project, limit: 200 });
        expect(page.total).toBe(project.count);
        for (let i = 1; i < page.tasks.length; i++) {
          expect(page.tasks[i - 1]!.lastActiveAt).toBeGreaterThanOrEqual(page.tasks[i]!.lastActiveAt);
        }
      }
      // 目录也按各自最新活动倒序
      for (let i = 1; i < summary.projects.length; i++) {
        expect(summary.projects[i - 1]!.lastActiveAt).toBeGreaterThanOrEqual(
          summary.projects[i]!.lastActiveAt,
        );
      }
    } finally {
      db.close();
    }
  });

  it("目录分页：offset/limit 切片，total 是目录内匹配总数", async () => {
    const temp = setupHome();
    await buildIndex(temp.env, { adapters: adapters() });
    const db = openReadOnly(temp.env);
    try {
      const project = listTaskSummary(db, temp.env).projects.find((p) => p.count === 1)!.project;
      const first = listProjectTasks(db, temp.env, { project, limit: 1 });
      expect(first.tasks).toHaveLength(1);
      expect(first.total).toBe(1);
      const second = listProjectTasks(db, temp.env, { project, offset: 1, limit: 1 });
      expect(second.tasks).toHaveLength(0);
      expect(second.total).toBe(1);
    } finally {
      db.close();
    }
  });

  it("状态实时化：新鲜度窗口过后从进行中降级；文件被写新则重新变进行中", async () => {
    const temp = setupHome();
    await buildIndex(temp.env, { adapters: adapters() });
    const db = openReadOnly(temp.env);
    try {
      const target = "qoder:11111111-1111-4111-8111-111111111111";
      const findTask = (now: number) => {
        for (const project of listTaskSummary(db, temp.env).projects) {
          const hit = listProjectTasks(db, temp.env, { project: project.project, now, limit: 200 }).tasks.find(
            (t) => t.id.includes(target),
          );
          if (hit) return hit;
        }
        throw new Error("task not found");
      };

      const baseline = findTask(Date.now());
      expect(baseline.lastActiveAt).toBeGreaterThan(0);

      // 距文件 mtime 1 分钟内查询：进行中（纯新鲜度）
      expect(findTask(baseline.lastActiveAt + 60_000).status).toBe("in_progress");
      // 窗口过后按信号实时判定：链尾（claude 夹具）停在 Bash 工具结果上，末条助手不是纯文本收尾 → 未判定
      expect(findTask(baseline.lastActiveAt + 10 * 60_000).status).toBe("unknown");

      // 文件在磁盘上被写新（hook 还没跑）：freshness 走 stat，判定重新变"进行中"。
      // 接力链的状态看链尾（claude 那段），所以要 touch 链尾文件。
      const file = path.join(
        temp.home,
        ".claude",
        "projects",
        "d--webproject-relay-target",
        "caller-resume.jsonl",
      );
      const now = Date.now();
      fs.utimesSync(file, new Date(now), new Date(now));
      expect(findTask(now + 30_000).status).toBe("in_progress");
    } finally {
      db.close();
    }
  });
});

describe("会话浏览与搜索", () => {
  async function indexedTemp(): Promise<TempHome> {
    const temp = setupHome();
    await buildIndex(temp.env, { adapters: adapters() });
    return temp;
  }

  it("最近会话按最近活动排序，空壳不出现", async () => {
    const temp = await indexedTemp();
    const db = openReadOnly(temp.env);
    try {
      const sessions = listRecentSessions(db, temp.env);
      expect(sessions).toHaveLength(5);
      expect(sessions[0]!.id).toContain("codex:"); // 夹具里最近（50 分钟前）
      for (const session of sessions) {
        expect(session.project).toBeTruthy();
        expect(session.messageCount).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }
  });

  it("全局搜索：跨项目命中、带摘要与项目信息", async () => {
    const temp = await indexedTemp();
    const db = openReadOnly(temp.env);
    try {
      const results = searchAllSessions(db, temp.env, "官网");
      expect(results.length).toBeGreaterThanOrEqual(1);
      const demo = results.find((r) => r.id.includes("qoder:11111111"));
      expect(demo).toBeDefined();
      expect(demo!.snippets[0]!.snippet).toContain("官网");
      expect(demo!.project).toContain("demo-site");
      expect(demo!.messageCount).toBeGreaterThan(0);
      expect(demo!.lastActiveAt).toBeGreaterThan(0);

      const notes = searchAllSessions(db, temp.env, "markdown");
      expect(notes.some((r) => r.id.includes("claude-code:33333333"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("消息分页：ordinal 升序、带片段、hasMore 正确", async () => {
    const temp = await indexedTemp();
    const db = openReadOnly(temp.env);
    try {
      const page = getSessionMessages(db, temp.env, "qoder:11111111-1111-4111-8111-111111111111", { from: 0, limit: 2 });
      expect(page).toBeDefined();
      expect(page!.total).toBeGreaterThanOrEqual(3);
      expect(page!.messages).toHaveLength(2);
      expect(page!.messages[0]!.ordinal).toBe(1);
      expect(page!.messages[0]!.role).toBe("user");
      expect(page!.hasMore).toBe(true);
      const textPart = page!.messages[0]!.parts.find((p) => p.kind === "text");
      expect(textPart?.text).toContain("公司官网首页");

      expect(getSessionMessages(db, temp.env, "qoder:nope", {})).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("删除、隐私与设置", () => {
  async function indexedTemp(): Promise<TempHome> {
    const temp = setupHome();
    await buildIndex(temp.env, { adapters: adapters() });
    return temp;
  }

  it("删除会话：列表/消息/搜索/任务里都消失；恢复后回来", async () => {
    const temp = await indexedTemp();
    const target = "qoder:11111111-1111-4111-8111-111111111111";
    const db = openReadOnly(temp.env);
    try {
      expect(deleteSessions(temp.env, [target])).toBe(1);
      expect(deleteSessions(temp.env, [target])).toBe(0); // 幂等
      expect(listRecentSessions(db, temp.env).some((s) => s.id === target)).toBe(false);
      expect(getSessionMessages(db, temp.env, target, {})).toBeUndefined();
      expect(searchAllSessions(db, temp.env, "官网").some((r) => r.id === target)).toBe(false);
      expect(allTasks(db, temp.env).some((t) => t.id.includes(target))).toBe(false);

      expect(restoreSessions(temp.env, [target])).toBe(1);
      expect(listRecentSessions(db, temp.env).some((s) => s.id === target)).toBe(true);
      expect(getSessionMessages(db, temp.env, target, {})).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("写 filters.json 时保留排除目录与手动状态字段", async () => {
    const temp = await indexedTemp();
    fs.writeFileSync(
      path.join(temp.home, ".memrelay", "filters.json"),
      JSON.stringify({
        excludedDirs: ["D:/excluded-dir"],
        deletedSessions: [],
        manualStatus: { "qoder:zzz": "abandoned" },
      }),
    );
    deleteSessions(temp.env, ["qoder:aaa"]);
    const filters = JSON.parse(
      fs.readFileSync(path.join(temp.home, ".memrelay", "filters.json"), "utf8"),
    ) as { excludedDirs: string[]; deletedSessions: string[]; manualStatus: Record<string, string> };
    expect(filters.excludedDirs).toEqual(["D:/excluded-dir"]);
    expect(filters.manualStatus["qoder:zzz"]).toBe("abandoned");
    expect(filters.deletedSessions).toEqual(["qoder:aaa"]);
  });

  it("排除目录：该目录下的会话从列表消失，恢复排除后回来", async () => {
    const temp = await indexedTemp();
    const db = openReadOnly(temp.env);
    try {
      setExclusions(temp.env, ["D:/webProject/notes-app"]);
      const sessions = listRecentSessions(db, temp.env);
      expect(sessions.some((s) => s.id.includes("claude-code:33333333"))).toBe(false);
      expect(sessions.some((s) => s.id.includes("qoder:11111111"))).toBe(true);

      setExclusions(temp.env, []);
      expect(listRecentSessions(db, temp.env).some((s) => s.id.includes("claude-code:33333333"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("已删除列表带元数据；索引里找不到的会话如实标注", async () => {
    const temp = await indexedTemp();
    deleteSessions(temp.env, ["qoder:11111111-1111-4111-8111-111111111111", "qoder:missing"]);
    const db = openReadOnly(temp.env);
    try {
      const items = listTrash(db, temp.env);
      expect(items).toHaveLength(2);
      const found = items.find((item) => item.id.includes("11111111"))!;
      expect(found.inIndex).toBe(true);
      expect(found.project).toContain("demo-site");
      expect(found.messageCount).toBeGreaterThan(0);
      const missing = items.find((item) => item.id === "qoder:missing")!;
      expect(missing.inIndex).toBe(false);
    } finally {
      db.close();
    }
  });

  it("密钥清单：只给遮盖预览；删除该会话后不再显示", async () => {
    const temp = await indexedTemp();
    const db = openReadOnly(temp.env);
    try {
      const secrets = listSecrets(db, temp.env);
      expect(secrets.length).toBeGreaterThanOrEqual(2);
      expect(secrets.every((s) => !s.preview.includes("hunter2secret"))).toBe(true);
      const sessionId = secrets[0]!.sessionId;
      deleteSessions(temp.env, [sessionId]);
      expect(listSecrets(db, temp.env).some((s) => s.sessionId === sessionId)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("设置读写：每功能独立接口与自动接入开关", () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    const db = openWritable(temp.env);
    try {
      expect(readUiSettings(db)).toEqual({
        embedding: { enabled: false, baseUrl: "", model: "", apiKeySet: false },
        autoIntegrate: false,
        summary: { enabled: false, baseUrl: "", model: "", apiKeySet: false },
        tidy: { enabled: false, baseUrl: "", model: "", apiKeySet: false },
      });
      const saved = writeUiSettings(db, {
        summary: {
          enabled: true,
          baseUrl: "https://api.example.com/v1",
          model: "gpt-x",
          apiKey: "sk-123",
        },
        autoIntegrate: true,
      });
      expect(saved.summary.baseUrl).toBe("https://api.example.com/v1");
      expect(saved.summary.apiKeySet).toBe(true);
      expect(saved.autoIntegrate).toBe(true);
      expect(readUiSettings(db)).toEqual(saved);

      writeUiSettings(db, { summary: { apiKey: "" } });
      expect(readUiSettings(db).summary.apiKeySet).toBe(false);

      // 另一个功能的接口独立：语义检索不会从摘要继承任何字段
      expect(readUiSettings(db).embedding).toEqual({
        enabled: false,
        baseUrl: "",
        model: "",
        apiKeySet: false,
      });
      // 偏好整理同样是独立接口
      expect(readUiSettings(db).tidy).toEqual({
        enabled: false,
        baseUrl: "",
        model: "",
        apiKeySet: false,
      });
    } finally {
      db.close();
    }
  });

  it("手动状态覆盖：列表与详情反映；恢复后回到自动值", async () => {
    const temp = await indexedTemp();
    const db = openWritable(temp.env);
    const taskId = "task:qoder:11111111-1111-4111-8111-111111111111";
    const head = "claude-code:55555555-5555-4555-8555-555555555555";
    try {
      const before = getTaskDetail(db, temp.env, taskId)!;
      expect(before.manual).toBe(false);
      const autoStatus = before.status;
      expect(autoStatus).not.toBe("abandoned");

      setSessionsStatus(temp.env, [head], "abandoned");
      const after = getTaskDetail(db, temp.env, taskId)!;
      expect(after.status).toBe("abandoned");
      expect(after.manual).toBe(true);
      expect(allTasks(db, temp.env).find((t) => t.id === taskId)!.status).toBe("abandoned");

      setSessionsStatus(temp.env, [head], null);
      const reset = getTaskDetail(db, temp.env, taskId)!;
      expect(reset.status).toBe(autoStatus);
      expect(reset.manual).toBe(false);
    } finally {
      db.close();
    }
  });

  it("手动放弃的任务不进入续接候选", () => {
    const tail = {
      statusInfo: {
        pendingToolCallIds: [] as string[],
        lastUserMessageUnanswered: false,
        quotaOrLimitDetected: false,
        errorDetected: false,
      },
      hasActiveLeaf: false,
      memrelayCalledRecently: false,
    };
    const make = (id: string, status: SessionStatus, total: number): RankedSession => ({
      scan: { id, agent: "qoder", sourcePath: `${id}.jsonl`, mtimeMs: Date.now(), sizeBytes: 1, tail },
      keyword: 0,
      timeScore: 0,
      fileOverlap: 0,
      interruptedBonus: 0,
      total,
      status,
      hasContent: true,
      isCaller: false,
    });

    const picked = selectSession([make("qoder:gone", "abandoned", 5), make("qoder:live", "interrupted", 1)], "");
    expect(picked.mode).toBe("single");
    expect(picked.chosen?.scan.id).toBe("qoder:live");

    const onlyAbandoned = selectSession([make("qoder:gone", "abandoned", 5)], "");
    expect(onlyAbandoned.mode).toBe("empty");
  });

  it("接入状态列表；应用时把未勾选的工具变成 skip 列表", async () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    fs.mkdirSync(path.join(temp.home, ".claude", "projects"), { recursive: true });

    const status = listIntegrations(temp.env);
    const claude = status.tools.find((t) => t.id === "claude-code")!;
    expect(claude.installed).toBe(true);
    expect(claude.integrated).toBe(false);
    const qoder = status.tools.find((t) => t.id === "qoder")!;
    expect(qoder.installed).toBe(false);
    expect(status.dataDir).toContain(".memrelay");

    const calls: SetupOptions[] = [];
    const result = await applyIntegrations({ "claude-code": true, qoder: false }, async (opts) => {
      calls.push(opts);
      return 0;
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.skip).toEqual(["qoder"]);
    expect(calls[0]!.yes).toBe(true);
  });

  it("清单里有 hook/plugin 记录的工具算已接入（ZCode / OpenCode 没有 Skill 形态）", () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    fs.mkdirSync(path.join(temp.home, ".zcode", "cli", "db"), { recursive: true });
    fs.mkdirSync(path.join(temp.home, ".local", "share", "opencode"), { recursive: true });
    const pluginFile = path.join(temp.home, ".config", "opencode", "plugins", "memrelay.js");
    fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
    fs.writeFileSync(pluginFile, "// memrelay plugin\n");
    fs.mkdirSync(path.join(temp.home, ".memrelay"), { recursive: true });
    fs.writeFileSync(
      path.join(temp.home, ".memrelay", "integrations.json"),
      JSON.stringify({
        version: "1.0.0",
        writtenAt: "",
        files: [
          { path: path.join(temp.home, ".zcode", "cli", "config.json"), hash: "", kind: "hook", tool: "zcode" },
          { path: pluginFile, hash: "", kind: "plugin", tool: "opencode" },
          { path: path.join(temp.home, ".trae-cn", "hooks.json"), hash: "", kind: "hook", tool: "trae-cn" },
        ],
      }),
    );

    const status = listIntegrations(temp.env);
    const zcode = status.tools.find((t) => t.id === "zcode")!;
    expect(zcode.installed).toBe(true);
    expect(zcode.hooks).toBe(true);
    expect(zcode.startupHint).toBe(true);
    expect(zcode.liveIndex).toBe(true);
    expect(zcode.integrated).toBe(true);
    const opencode = status.tools.find((t) => t.id === "opencode")!;
    expect(opencode.integrated).toBe(true);
    expect(opencode.startupHint).toBe(false);
    expect(opencode.liveIndex).toBe(true);
    const traeCn = status.tools.find((t) => t.id === "trae-cn")!;
    expect(traeCn.startupHint).toBe(false);
    expect(traeCn.liveIndex).toBe(true);
    // 清单里没有记录的工具仍然未接入
    const claude = status.tools.find((t) => t.id === "claude-code")!;
    expect(claude.integrated).toBe(false);
  });

  it("自动接入提示：默认关不提示；开启后列出已安装未接入的工具；接入后消失", () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    fs.mkdirSync(path.join(temp.home, ".claude", "projects"), { recursive: true });
    const db = openWritable(temp.env);
    try {
      // 默认关：即使有未接入的工具也不提示
      expect(maybeAutoIntegrateHint(db, temp.env)).toBeUndefined();

      writeUiSettings(db, { autoIntegrate: true });
      const hint = maybeAutoIntegrateHint(db, temp.env);
      expect(hint).toContain("Claude Code");
      expect(hint).toContain("不会自动写任何文件");
      expect(hint).not.toContain("Qoder"); // 未安装的不参与

      // 接入（Skill 文件在磁盘 + 清单记录）后不再提示
      const skillFile = path.join(temp.home, ".claude", "skills", "memrelay", "SKILL.md");
      fs.mkdirSync(path.dirname(skillFile), { recursive: true });
      fs.writeFileSync(skillFile, "# memrelay\n");
      fs.writeFileSync(
        path.join(temp.home, ".memrelay", "integrations.json"),
        JSON.stringify({ version: "1.0.0", writtenAt: "", files: [{ path: skillFile, hash: "", kind: "skill" }] }),
      );
      expect(maybeAutoIntegrateHint(db, temp.env)).toBeUndefined();

      // 关闭开关同样不提示
      writeUiSettings(db, { autoIntegrate: false });
      expect(maybeAutoIntegrateHint(db, temp.env)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("手动修正：改名与接力链整理", () => {
  const CHAIN_ID = "task:qoder:11111111-1111-4111-8111-111111111111";
  const ROOT = "qoder:11111111-1111-4111-8111-111111111111";
  const HEAD = "claude-code:55555555-5555-4555-8555-555555555555";

  async function indexedTemp(): Promise<TempHome> {
    const temp = setupHome();
    await buildIndex(temp.env, { adapters: adapters() });
    return temp;
  }

  it("改名：列表与详情用覆盖名；清空恢复原名", async () => {
    const temp = await indexedTemp();
    const db = openReadOnly(temp.env);
    try {
      const before = getTaskDetail(db, temp.env, CHAIN_ID)!;
      setTaskName(temp.env, before.id, "  我的自定义任务名  ");
      const renamed = getTaskDetail(db, temp.env, CHAIN_ID)!;
      expect(renamed.title).toBe("我的自定义任务名");
      expect(renamed.manualName).toBe(true);
      expect(allTasks(db, temp.env).find((t) => t.id === renamed.id)!.title).toBe("我的自定义任务名");

      setTaskName(temp.env, before.id, "");
      const restored = getTaskDetail(db, temp.env, CHAIN_ID)!;
      expect(restored.title).toBe(before.title);
      expect(restored.manualName).toBe(false);
    } finally {
      db.close();
    }
  });

  it("拆开：链变成两个任务；恢复自动后合回一条链", async () => {
    const temp = await indexedTemp();
    const db = openReadOnly(temp.env);
    try {
      expect(getTaskDetail(db, temp.env, CHAIN_ID)!.legs).toHaveLength(2);

      updateManualChains(temp.env, [ROOT, HEAD], [[ROOT], [HEAD]]);
      const first = getTaskDetail(db, temp.env, CHAIN_ID)!;
      expect(first.legs).toHaveLength(1);
      expect(first.manualChain).toBe(true);
      const second = getTaskDetail(db, temp.env, `task:${HEAD}`)!;
      expect(second.legs).toHaveLength(1);
      expect(second.legs[0]!.sessionId).toBe(HEAD);
      const listed = allTasks(db, temp.env);
      expect(listed.filter((t) => t.id === `task:${ROOT}` || t.id === `task:${HEAD}`)).toHaveLength(2);

      updateManualChains(temp.env, [ROOT, HEAD]);
      const mergedBack = getTaskDetail(db, temp.env, CHAIN_ID)!;
      expect(mergedBack.legs).toHaveLength(2);
      expect(mergedBack.manualChain).toBe(false);
    } finally {
      db.close();
    }
  });

  it("合并：链任务和一个单会话任务并成一条；恢复自动后各回各的", async () => {
    const temp = await indexedTemp();
    const db = openReadOnly(temp.env);
    try {
      const solo = allTasks(db, temp.env).find((t) => t.id.startsWith("codex:"))!;
      expect(solo).toBeDefined();
      const chain = getTaskDetail(db, temp.env, CHAIN_ID)!;
      const soloDetail = getTaskDetail(db, temp.env, solo.id)!;
      const allIds = [...chain.legs, ...soloDetail.legs]
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((leg) => leg.sessionId);

      updateManualChains(temp.env, allIds, [allIds]);
      const merged = getTaskDetail(db, temp.env, `task:${allIds[0]!}`)!;
      expect(merged.legs).toHaveLength(3);
      expect(merged.manualChain).toBe(true);
      expect(new Set(merged.legs.map((leg) => leg.sessionId))).toEqual(new Set(allIds));

      updateManualChains(temp.env, allIds);
      expect(getTaskDetail(db, temp.env, CHAIN_ID)!.legs).toHaveLength(2);
      expect(getTaskDetail(db, temp.env, solo.id)!.legs).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("本地服务：令牌、Host 与静态托管", () => {
  async function startFixtureServer(opts: {
    reindex?: () => Promise<{ updated: number; skipped: number; durationMs: number }>;
  } = {}): Promise<{ temp: TempHome; server: RunningServer; token: string }> {
    const temp = setupHome();
    await buildIndex(temp.env, { adapters: adapters() });

    const webRoot = path.join(temp.home, "web-root");
    fs.mkdirSync(path.join(webRoot, "assets"), { recursive: true });
    fs.writeFileSync(path.join(webRoot, "index.html"), "<html><body>MEMRELAY-UI</body></html>");
    fs.writeFileSync(path.join(webRoot, "assets", "app.js"), "console.log('memrelay');");

    const db = openWritable(temp.env);
    cleanups.push(() => db.close());
    const token = generateToken();
    const server = await startServer({ db, webRoot, token, env: temp.env, reindex: opts.reindex });
    cleanups.push(() => void server.close());
    return { temp, server, token };
  }

  it("无令牌 401；非法 Host 403；带令牌 200 且返回真实任务", async () => {
    const { server, token } = await startFixtureServer();

    const noToken = await request(server.port, "/api/tasks/summary");
    expect(noToken.status).toBe(401);

    const badHost = await request(server.port, "/api/tasks/summary", {
      headers: { Host: "evil.example.com", "x-memrelay-token": token },
    });
    expect(badHost.status).toBe(403);

    const evilOrigin = await request(server.port, "/api/trash/delete", {
      method: "POST",
      headers: { "x-memrelay-token": token, "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ ids: [] }),
    });
    expect(evilOrigin.status).toBe(403);

    const sameOrigin = await request(server.port, "/api/trash/delete", {
      method: "POST",
      headers: {
        "x-memrelay-token": token,
        "Content-Type": "application/json",
        Origin: `http://127.0.0.1:${server.port}`,
      },
      body: JSON.stringify({ ids: [] }),
    });
    expect(sameOrigin.status).toBe(200);

    const viaHeader = await request(server.port, "/api/tasks/summary", {
      headers: { "x-memrelay-token": token },
    });
    expect(viaHeader.status).toBe(200);
    const data = JSON.parse(viaHeader.body) as {
      total: number;
      counts: Record<string, number>;
      projects: Array<{ project: string; count: number; lastActiveAt: number }>;
    };
    expect(data.total).toBe(4);
    const total =
      (data.counts.interrupted ?? 0) +
      (data.counts.unknown ?? 0) +
      (data.counts.done ?? 0) +
      (data.counts.in_progress ?? 0);
    expect(total).toBe(4);
    expect(data.projects.length).toBeGreaterThanOrEqual(3);

    const wrongToken = await request(server.port, "/api/tasks/summary", {
      headers: { "x-memrelay-token": "not-the-token" },
    });
    expect(wrongToken.status).toBe(401);

    // 缺 project 参数 → 400
    const missingProject = await request(server.port, "/api/tasks", {
      headers: { "x-memrelay-token": token },
    });
    expect(missingProject.status).toBe(400);

    // 目录分页：返回该目录的任务与总数
    const project = data.projects[0]!.project;
    const pageRes = await request(
      server.port,
      `/api/tasks?project=${encodeURIComponent(project)}&limit=1`,
      { headers: { "x-memrelay-token": token } },
    );
    expect(pageRes.status).toBe(200);
    const page = JSON.parse(pageRes.body) as { tasks: Array<{ legs: unknown[] }>; total: number };
    expect(page.tasks.length).toBeLessThanOrEqual(1);
    expect(page.total).toBe(data.projects[0]!.count);
  });

  it("仪表盘：一次返回状态、接力、工具与活动概览", async () => {
    const { server, token } = await startFixtureServer();
    const res = await request(server.port, "/api/dashboard", {
      headers: { "x-memrelay-token": token },
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as {
      total: number;
      counts: Record<string, number>;
      trash: number;
      tools: Array<{ tool: string; sessions: number }>;
      activity: Array<{ date: string; sessions: number }>;
      recent: Array<{ id: string; tools: string[] }>;
    };
    expect(data.total).toBe(4);
    expect(data.trash).toBe(0);
    expect(data.tools.find((tool) => tool.tool === "claude-code")?.sessions).toBe(2);
    expect(data.activity).toHaveLength(14);
    expect(data.recent.length).toBeGreaterThan(0);
    expect(data.recent.some((task) => task.tools.length > 1)).toBe(true);
  });

  it("任务搜索：q 过滤目录与任务，状态计数保持全局", async () => {
    const { server, token } = await startFixtureServer();
    const headers = { "x-memrelay-token": token };

    const all = JSON.parse(
      (await request(server.port, "/api/tasks/summary", { headers })).body,
    ) as { total: number; counts: Record<string, number> };
    expect(all.total).toBe(4);

    const searched = JSON.parse(
      (await request(server.port, "/api/tasks/summary?q=demo", { headers })).body,
    ) as { total: number; counts: Record<string, number>; projects: Array<{ project: string }> };
    expect(searched.total).toBeGreaterThan(0);
    expect(searched.total).toBeLessThan(all.total);
    expect(searched.projects.every((project) => project.project.toLowerCase().includes("demo"))).toBe(true);
    expect(searched.counts).toEqual(all.counts);

    const project = searched.projects[0]!.project;
    const page = JSON.parse(
      (
        await request(
          server.port,
          `/api/tasks?project=${encodeURIComponent(project)}&q=not-a-real-task-name`,
          { headers },
        )
      ).body,
    ) as { tasks: unknown[]; total: number };
    expect(page.total).toBe(0);
    expect(page.tasks).toHaveLength(0);
  });

  it("重新索引：调用注入的回调并返回本次统计", async () => {
    let calls = 0;
    const { server, token } = await startFixtureServer({
      reindex: async () => {
        calls += 1;
        return { updated: 2, skipped: 3, durationMs: 7 };
      },
    });
    const res = await request(server.port, "/api/reindex", {
      method: "POST",
      headers: { "x-memrelay-token": token },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, updated: 2, skipped: 3, durationMs: 7 });
    expect(calls).toBe(1);
  });

  it("?token= 首次进入种 cookie 并跳转到干净地址；之后靠 cookie 通行", async () => {
    const { server, token } = await startFixtureServer();

    const first = await request(server.port, `/?token=${token}`);
    expect(first.status).toBe(302);
    expect(first.headers["location"]).toBe("/");
    const setCookie = first.headers["set-cookie"];
    expect(Array.isArray(setCookie)).toBe(true);
    const cookieRaw = String(setCookie);
    expect(cookieRaw).toContain("memrelay_token=");
    expect(cookieRaw).toContain("HttpOnly");
    expect(cookieRaw).toContain("SameSite=Strict");
    const cookie = cookieRaw.split(";")[0]!;

    const home = await request(server.port, "/", { headers: { Cookie: cookie } });
    expect(home.status).toBe(200);
    expect(home.body).toContain("MEMRELAY-UI");

    const api = await request(server.port, "/api/tasks/summary", { headers: { Cookie: cookie } });
    expect(api.status).toBe(200);

    // 错令牌不种 cookie，直接 401
    const bad = await request(server.port, "/?token=wrong");
    expect(bad.status).toBe(401);
    expect(bad.headers["set-cookie"]).toBeUndefined();
  });

  it("任务详情：链任务按顺序带出两段腿，单会话任务只有一段", async () => {
    const { server, token } = await startFixtureServer();
    const headers = { "x-memrelay-token": token };

    const summary = JSON.parse(
      (await request(server.port, "/api/tasks/summary", { headers })).body,
    ) as { projects: Array<{ project: string }> };
    let chain: { id: string; legs: unknown[] } | undefined;
    for (const project of summary.projects) {
      const page = JSON.parse(
        (
          await request(server.port, `/api/tasks?project=${encodeURIComponent(project.project)}`, {
            headers,
          })
        ).body,
      ) as { tasks: Array<{ id: string; legs: unknown[] }> };
      chain = page.tasks.find((t) => t.legs.length === 2);
      if (chain) break;
    }
    expect(chain).toBeDefined();

    const detailRes = await request(server.port, `/api/tasks/${encodeURIComponent(chain!.id)}`, { headers });
    expect(detailRes.status).toBe(200);
    const detail = JSON.parse(detailRes.body) as {
      task: {
        title: string;
        legs: Array<{ sessionId: string; title: string; tool: string; startedAt: number }>;
      };
    };
    expect(detail.task.legs).toHaveLength(2);
    expect(detail.task.legs[0]!.sessionId).toContain("qoder:");
    expect(detail.task.legs[1]!.sessionId).toContain("claude-code:");
    expect(detail.task.legs[0]!.startedAt).toBeLessThanOrEqual(detail.task.legs[1]!.startedAt);
    for (const leg of detail.task.legs) {
      expect(leg.title).toBeTruthy();
      expect(leg.title).not.toBe(leg.sessionId);
    }

    const missing = await request(server.port, "/api/tasks/task:99999", { headers });
    expect(missing.status).toBe(404);
  });

  it("续接预览：走真实提炼管线，接力链带上历史；文件没了给 404", async () => {
    const { temp, server, token } = await startFixtureServer();
    const headers = { "x-memrelay-token": token };

    // 从任务摘要出发找接力链（链任务 leg 数为 2）
    const summary = JSON.parse(
      (await request(server.port, "/api/tasks/summary", { headers })).body,
    ) as { projects: Array<{ project: string }> };
    let chainId = "";
    for (const project of summary.projects) {
      const page = JSON.parse(
        (
          await request(server.port, `/api/tasks?project=${encodeURIComponent(project.project)}`, {
            headers,
          })
        ).body,
      ) as { tasks: Array<{ id: string; legs: Array<{ tool: string }> }> };
      const chain = page.tasks.find((t) => t.legs.length === 2);
      if (chain) {
        chainId = chain.id;
        break;
      }
    }
    expect(chainId).not.toBe("");

    const previewRes = await request(
      server.port,
      `/api/tasks/${encodeURIComponent(chainId)}/resume-preview`,
      { headers },
    );
    expect(previewRes.status).toBe(200);
    const preview = JSON.parse(previewRes.body) as { text: string; sessionId: string };
    expect(preview.text).toContain("【MemRelay 续接】");
    expect(preview.text).toContain("接力链：Qoder → Claude Code");
    expect(preview.sessionId).toContain("claude-code:");
    expect(preview.text).toContain("## 接手须知");

    // 已删除的会话不能再通过续接预览读出
    await request(server.port, "/api/trash/delete", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [preview.sessionId] }),
    });
    const deletedPreview = await request(
      server.port,
      `/api/tasks/${encodeURIComponent(chainId)}/resume-preview`,
      { headers },
    );
    expect(deletedPreview.status).toBe(404);
    await request(server.port, "/api/trash/restore", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [preview.sessionId] }),
    });

    // 把链头文件删掉：应报 404 而不是崩
    const claudeFile = path.join(temp.home, ".claude", "projects", "d--webproject-relay-target", "caller-resume.jsonl");
    const backup = `${claudeFile}.bak`;
    fs.renameSync(claudeFile, backup);
    try {
      const gone = await request(
        server.port,
        `/api/tasks/${encodeURIComponent(chainId)}/resume-preview`,
        { headers },
      );
      expect(gone.status).toBe(404);
      expect(gone.body).toContain("找不到会话文件");
    } finally {
      fs.renameSync(backup, claudeFile);
    }
  });

  it("会话浏览与搜索接口（HTTP）", async () => {
    const { server, token } = await startFixtureServer();
    const headers = { "x-memrelay-token": token };

    const listRes = await request(server.port, "/api/sessions", { headers });
    expect(listRes.status).toBe(200);
    const list = JSON.parse(listRes.body) as { sessions: Array<{ id: string }> };
    expect(list.sessions).toHaveLength(5);

    const searchRes = await request(server.port, `/api/sessions?q=${encodeURIComponent("官网")}`, { headers });
    expect(searchRes.status).toBe(200);
    const search = JSON.parse(searchRes.body) as { sessions: Array<{ snippets: unknown[] }> };
    expect(search.sessions.length).toBeGreaterThanOrEqual(1);
    expect(search.sessions[0]!.snippets.length).toBeGreaterThanOrEqual(1);

    const msgRes = await request(
      server.port,
      `/api/sessions/${encodeURIComponent("qoder:11111111-1111-4111-8111-111111111111")}/messages?from=0&limit=3`,
      { headers },
    );
    expect(msgRes.status).toBe(200);
    const messages = JSON.parse(msgRes.body) as { messages: unknown[]; total: number; hasMore: boolean };
    expect(messages.messages).toHaveLength(3);
    expect(messages.total).toBeGreaterThan(0);

    const missing = await request(
      server.port,
      `/api/sessions/${encodeURIComponent("qoder:nope")}/messages`,
      { headers },
    );
    expect(missing.status).toBe(404);
  });

  it("写接口（HTTP）：排除目录、设置、已删除都落到文件/库", async () => {
    const { temp, server, token } = await startFixtureServer();
    const headers = { "x-memrelay-token": token, "Content-Type": "application/json" };

    const exclusions = await request(server.port, "/api/privacy/exclusions", {
      method: "PUT",
      headers,
      body: JSON.stringify({ excludedDirs: ["D:/verify-dir"] }),
    });
    expect(exclusions.status).toBe(200);
    const privacy = await request(server.port, "/api/privacy", { headers: { "x-memrelay-token": token } });
    expect((JSON.parse(privacy.body) as { excludedDirs: string[] }).excludedDirs).toEqual(["D:/verify-dir"]);
    const filters = JSON.parse(
      fs.readFileSync(path.join(temp.home, ".memrelay", "filters.json"), "utf8"),
    ) as { excludedDirs: string[] };
    expect(filters.excludedDirs).toEqual(["D:/verify-dir"]);

    const settings = await request(server.port, "/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ model: { baseUrl: "https://x/v1", model: "m" }, autoIntegrate: true }),
    });
    expect(settings.status).toBe(200);
    expect((JSON.parse(settings.body) as { autoIntegrate: boolean }).autoIntegrate).toBe(true);

    const target = "qoder:11111111-1111-4111-8111-111111111111";
    const deleted = await request(server.port, "/api/trash/delete", {
      method: "POST",
      headers,
      body: JSON.stringify({ ids: [target] }),
    });
    expect(deleted.status).toBe(200);
    expect(
      (JSON.parse(deleted.body) as { items: Array<{ id: string }> }).items.some((item) => item.id === target),
    ).toBe(true);
    const listed = await request(server.port, "/api/sessions", { headers: { "x-memrelay-token": token } });
    expect(
      (JSON.parse(listed.body) as { sessions: Array<{ id: string }> }).sessions.some((s) => s.id === target),
    ).toBe(false);

    const restored = await request(server.port, "/api/trash/restore", {
      method: "POST",
      headers,
      body: JSON.stringify({ ids: [target] }),
    });
    expect(restored.status).toBe(200);
    expect((JSON.parse(restored.body) as { items: unknown[] }).items).toHaveLength(0);

    const bad = await request(server.port, "/api/privacy/exclusions", {
      method: "PUT",
      headers,
      body: JSON.stringify({ excludedDirs: "nope" }),
    });
    expect(bad.status).toBe(400);

    const taskPath = `/api/tasks/${encodeURIComponent("task:qoder:11111111-1111-4111-8111-111111111111")}/status`;
    const status = await request(server.port, taskPath, {
      method: "PUT",
      headers,
      body: JSON.stringify({ status: "done" }),
    });
    expect(status.status).toBe(200);
    const statusBody = JSON.parse(status.body) as { task: { status: string; manual: boolean } };
    expect(statusBody.task.status).toBe("done");
    expect(statusBody.task.manual).toBe(true);

    const cleared = await request(server.port, taskPath, {
      method: "PUT",
      headers,
      body: JSON.stringify({ status: null }),
    });
    expect(cleared.status).toBe(200);
    expect((JSON.parse(cleared.body) as { task: { manual: boolean } }).task.manual).toBe(false);

    const badStatus = await request(server.port, taskPath, {
      method: "PUT",
      headers,
      body: JSON.stringify({ status: "whatever" }),
    });
    expect(badStatus.status).toBe(400);
  });

  it("手动整理接口（HTTP）：改名 / 拆开 / 恢复自动", async () => {
    const { server, token } = await startFixtureServer();
    const headers = { "x-memrelay-token": token, "Content-Type": "application/json" };
    const chainId = "task:qoder:11111111-1111-4111-8111-111111111111";
    const head = "claude-code:55555555-5555-4555-8555-555555555555";

    const renamed = await request(server.port, `/api/tasks/${encodeURIComponent(chainId)}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ title: "改过的名字" }),
    });
    expect(renamed.status).toBe(200);
    expect(
      JSON.parse(renamed.body) as { task: { title: string; manualName: boolean } },
    ).toMatchObject({ task: { title: "改过的名字", manualName: true } });

    const split = await request(server.port, `/api/tasks/${encodeURIComponent(chainId)}/split`, {
      method: "POST",
      headers,
      body: JSON.stringify({ from: head }),
    });
    expect(split.status).toBe(200);
    const splitTask = JSON.parse(split.body) as { task: { legs: unknown[]; manualChain: boolean } };
    expect(splitTask.task.legs).toHaveLength(1);
    expect(splitTask.task.manualChain).toBe(true);

    const reset = await request(server.port, `/api/tasks/${encodeURIComponent(chainId)}/reset-chain`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(reset.status).toBe(200);
    const resetTask = JSON.parse(reset.body) as { task: { legs: unknown[]; manualChain: boolean } };
    expect(resetTask.task.legs).toHaveLength(2);
    expect(resetTask.task.manualChain).toBe(false);

    const badSplit = await request(server.port, `/api/tasks/${encodeURIComponent(chainId)}/split`, {
      method: "POST",
      headers,
      body: JSON.stringify({ from: "qoder:11111111-1111-4111-8111-111111111111" }),
    });
    expect(badSplit.status).toBe(400);
  });

  it("静态托管：SPA 回退、资产、未知 API 404、方法限制", async () => {
    const { server, token } = await startFixtureServer();
    const headers = { "x-memrelay-token": token };

    const spa = await request(server.port, "/tasks", { headers });
    expect(spa.status).toBe(200);
    expect(spa.body).toContain("MEMRELAY-UI");

    const asset = await request(server.port, "/assets/app.js", { headers });
    expect(asset.status).toBe(200);
    expect(asset.headers["content-type"]).toContain("javascript");
    expect(asset.body).toContain("console.log");

    const missing = await request(server.port, "/assets/nope.js", { headers });
    expect(missing.status).toBe(404);

    // 带点的会话/任务 id 也是前端路由，刷新时不能 404
    const dottedRoute = await request(server.port, "/conversations/demo.session", { headers });
    expect(dottedRoute.status).toBe(200);
    expect(dottedRoute.headers["content-type"]).toContain("text/html");

    const unknownApi = await request(server.port, "/api/nope", { headers });
    expect(unknownApi.status).toBe(404);
    expect(unknownApi.headers["content-type"]).toContain("application/json");

    const post = await request(server.port, "/api/tasks", { method: "POST", headers });
    expect(post.status).toBe(405);

    const health = await request(server.port, "/api/health", { headers });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ name: "memrelay" });

    // 目录穿越不出去
    const traversal = await request(server.port, "/../index.html", { headers: { ...headers } });
    expect([200, 404]).toContain(traversal.status); // 被规范化后落在 webRoot 内或 404，绝不越界
    const outside = await request(server.port, "/..%2f..%2fsecret.txt", { headers });
    expect(outside.status).toBe(404);
  });
});

describe("语义检索（向量）：设置、回填、状态与清除（HTTP，伪嵌入服务）", () => {
  async function startFixtureServer(): Promise<{ temp: TempHome; server: RunningServer; token: string }> {
    const temp = setupHome();
    await buildIndex(temp.env, { adapters: adapters() });
    const webRoot = path.join(temp.home, "web-root");
    fs.mkdirSync(webRoot, { recursive: true });
    fs.writeFileSync(path.join(webRoot, "index.html"), "<html></html>");
    const db = openWritable(temp.env);
    cleanups.push(() => db.close());
    const token = generateToken();
    const server = await startServer({ db, webRoot, token, env: temp.env, port: 0 });
    cleanups.push(() => void server.close());
    return { temp, server, token };
  }

  /** 本地伪 /embeddings：把所有输入都嵌成 [1,0]（测试用固定向量空间）。 */
  async function startFakeEmbeddingServer(): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        let inputs: string[] = [];
        try {
          inputs = (JSON.parse(body) as { input?: string[] }).input ?? [];
        } catch {
          /* 保持空 */
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: inputs.map((_, i) => ({ index: i, embedding: [1, 0] })) }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return {
      url: `http://127.0.0.1:${port}/v1`,
      close: () => new Promise((resolve) => server.close(() => resolve())),
    };
  }

  interface StatusShape {
    enabled: boolean;
    configured: boolean;
    model: string;
    host: string | null;
    embeddedSessions: number;
    embeddedChunks: number;
    pendingSessions: number;
    staleChunks: number;
    lastError: string | null;
  }

  async function waitForStatus(
    port: number,
    token: string,
    predicate: (status: StatusShape) => boolean,
    timeoutMs = 10000,
  ): Promise<StatusShape> {
    const deadline = Date.now() + timeoutMs;
    let last: StatusShape | undefined;
    while (Date.now() < deadline) {
      const res = await request(port, "/api/embeddings/status", {
        headers: { "x-memrelay-token": token },
      });
      expect(res.status).toBe(200);
      last = JSON.parse(res.body) as StatusShape;
      if (predicate(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`等待向量状态超时：${JSON.stringify(last)}`);
  }

  it("设置：语义检索块读写；开启转换触发全量入队；非法类型 400", async () => {
    const { server, token } = await startFixtureServer();
    const headers = { "x-memrelay-token": token, "Content-Type": "application/json" };

    const saved = await request(server.port, "/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        embedding: {
          enabled: true,
          baseUrl: "https://api.example.com/v1",
          model: "text-embedding-3-small",
          apiKey: "sk-own",
        },
      }),
    });
    expect(saved.status).toBe(200);
    const dto = JSON.parse(saved.body) as {
      embedding: { enabled: boolean; model: string; baseUrl: string; apiKeySet: boolean };
    };
    expect(dto.embedding.enabled).toBe(true);
    expect(dto.embedding.model).toBe("text-embedding-3-small");
    expect(dto.embedding.baseUrl).toBe("https://api.example.com/v1");
    expect(dto.embedding.apiKeySet).toBe(true);

    const status = await waitForStatus(server.port, token, () => true);
    expect(status.enabled).toBe(true);
    expect(status.configured).toBe(true);
    expect(status.model).toBe("text-embedding-3-small");
    expect(status.host).toBe("api.example.com");
    // 开启转换：全量入队（未变块在 drain 时零成本跳过）
    expect(status.pendingSessions).toBeGreaterThan(0);

    const bad = await request(server.port, "/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ embedding: { enabled: "yes" } }),
    });
    expect(bad.status).toBe(400);
  });

  it("回填 → 融合搜索 → 清除：全链路（后台 drain + 状态轮询）", async () => {
    const fake = await startFakeEmbeddingServer();
    cleanups.push(() => void fake.close());
    const { server, token } = await startFixtureServer();
    const headers = { "x-memrelay-token": token, "Content-Type": "application/json" };

    // 纯 FTS 基线：搜「官网」只命中 qoder demo
    const query = encodeURIComponent("官网");
    const plainRes = await request(server.port, `/api/sessions?q=${query}`, {
      headers: { "x-memrelay-token": token },
    });
    const plain = (JSON.parse(plainRes.body) as { sessions: Array<{ id: string }> }).sessions;
    expect(plain.some((s) => s.id.includes("qoder:11111111"))).toBe(true);

    // 配置并回填
    await request(server.port, "/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ embedding: { enabled: true, baseUrl: fake.url, model: "test-embed", apiKey: "k" } }),
    });
    const backfill = await request(server.port, "/api/embeddings/backfill", {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(backfill.status).toBe(200);
    expect((JSON.parse(backfill.body) as { started: boolean }).started).toBe(true);

    const status = await waitForStatus(
      server.port,
      token,
      (s) => s.pendingSessions === 0 && s.embeddedSessions > 0,
    );
    expect(status.embeddedChunks).toBeGreaterThan(0);
    expect(status.lastError).toBeNull();

    // 融合搜索：常量向量让所有会话都是"向量命中"→ 结果多出纯 FTS 搜不到的会话，
    // 且向量独有命中的摘要来自命中块文本（非空）
    const fusedRes = await request(server.port, `/api/sessions?q=${query}`, {
      headers: { "x-memrelay-token": token },
    });
    const fused = (JSON.parse(fusedRes.body) as { sessions: Array<{ id: string; snippets: unknown[] }> })
      .sessions;
    expect(fused.length).toBeGreaterThan(plain.length);
    const vectorOnly = fused.find((s) => !plain.some((p) => p.id === s.id));
    expect(vectorOnly).toBeDefined();
    expect(vectorOnly!.snippets.length).toBeGreaterThanOrEqual(1);

    // 清除全部向量：唯一清除路径；之后搜索行为回到纯 FTS
    const cleared = await request(server.port, "/api/embeddings/clear", {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(cleared.status).toBe(200);
    const clearedStatus = (JSON.parse(cleared.body) as { status: StatusShape }).status;
    expect(clearedStatus.embeddedSessions).toBe(0);
    expect(clearedStatus.pendingSessions).toBe(0);

    clearQueryVectorCache();
    const afterRes = await request(server.port, `/api/sessions?q=${query}`, {
      headers: { "x-memrelay-token": token },
    });
    const after = (JSON.parse(afterRes.body) as { sessions: Array<{ id: string }> }).sessions;
    expect(after.map((s) => s.id)).toEqual(plain.map((s) => s.id));
  });

  it("嵌入接口挂掉：回填失败写进状态，搜索结果与纯 FTS 完全一致", async () => {
    const dead = await startFakeEmbeddingServer();
    const deadUrl = dead.url;
    await dead.close(); // 关掉端口 → 请求必然失败
    const { server, token } = await startFixtureServer();
    const headers = { "x-memrelay-token": token, "Content-Type": "application/json" };

    await request(server.port, "/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ embedding: { enabled: true, baseUrl: deadUrl, model: "test-embed", apiKey: "k" } }),
    });

    const query = encodeURIComponent("官网");
    const before = await request(server.port, `/api/sessions?q=${query}`, {
      headers: { "x-memrelay-token": token },
    });
    const beforeIds = (JSON.parse(before.body) as { sessions: Array<{ id: string }> }).sessions.map(
      (s) => s.id,
    );

    await request(server.port, "/api/embeddings/backfill", { method: "POST", headers, body: "{}" });
    const status = await waitForStatus(server.port, token, (s) => s.lastError !== null);
    expect(status.embeddedSessions).toBe(0);

    clearQueryVectorCache();
    const after = await request(server.port, `/api/sessions?q=${query}`, {
      headers: { "x-memrelay-token": token },
    });
    const afterIds = (JSON.parse(after.body) as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);
    expect(afterIds).toEqual(beforeIds); // 逐字一致（降级路径）
  });
});

describe("会话摘要（LLM 增强）：设置、生成、状态与清除（HTTP，伪对话服务）", () => {
  async function startFixtureServer(): Promise<{ temp: TempHome; server: RunningServer; token: string }> {
    const temp = setupHome();
    await buildIndex(temp.env, { adapters: adapters() });
    const webRoot = path.join(temp.home, "web-root");
    fs.mkdirSync(webRoot, { recursive: true });
    fs.writeFileSync(path.join(webRoot, "index.html"), "<html></html>");
    const db = openWritable(temp.env);
    cleanups.push(() => db.close());
    const token = generateToken();
    const server = await startServer({ db, webRoot, token, env: temp.env, port: 0 });
    cleanups.push(() => void server.close());
    return { temp, server, token };
  }

  /** 本地伪 /chat/completions：固定返回一条摘要正文。 */
  async function startFakeChatServer(): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        void body;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "任务正在推进，已完成后端部分，下一步做界面。" } }],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return {
      url: `http://127.0.0.1:${port}/v1`,
      close: () => new Promise((resolve) => server.close(() => resolve())),
    };
  }

  interface SummaryStatusShape {
    enabled: boolean;
    configured: boolean;
    model: string;
    host: string | null;
    summarizedSessions: number;
    pendingSessions: number;
    staleSessions: number;
    lastError: string | null;
  }

  async function waitForSummaryStatus(
    port: number,
    token: string,
    predicate: (status: SummaryStatusShape) => boolean,
    timeoutMs = 10000,
  ): Promise<SummaryStatusShape> {
    const deadline = Date.now() + timeoutMs;
    let last: SummaryStatusShape | undefined;
    while (Date.now() < deadline) {
      const res = await request(port, "/api/summaries/status", {
        headers: { "x-memrelay-token": token },
      });
      expect(res.status).toBe(200);
      last = JSON.parse(res.body) as SummaryStatusShape;
      if (predicate(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`等待摘要状态超时：${JSON.stringify(last)}`);
  }

  it("生成 → 任务/会话接口带摘要 → 清除；未开启时摘要字段为 null", async () => {
    const fake = await startFakeChatServer();
    cleanups.push(() => void fake.close());
    const { server, token } = await startFixtureServer();
    const headers = { "x-memrelay-token": token, "Content-Type": "application/json" };

    // 未开启：任务与最近会话的 summary 一律 null（降级基线）；项目名从目录摘要取（保证与投影一致）
    const summaryRes = await request(server.port, "/api/tasks/summary", {
      headers: { "x-memrelay-token": token },
    });
    const project = (JSON.parse(summaryRes.body) as { projects: Array<{ project: string }> }).projects[0]!.project;
    const tasks0 = await request(server.port, `/api/tasks?project=${encodeURIComponent(project)}`, {
      headers: { "x-memrelay-token": token },
    });
    const page0 = JSON.parse(tasks0.body) as { tasks: Array<{ summary: string | null }> };
    expect(page0.tasks.length).toBeGreaterThan(0);
    expect(page0.tasks.every((task) => task.summary === null)).toBe(true);

    // 开启摘要（摘要自己的接口）+ 后台生成
    await request(server.port, "/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        summary: { baseUrl: fake.url, model: "chat-x", apiKey: "k", enabled: true },
      }),
    });
    const backfill = await request(server.port, "/api/summaries/backfill", {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(backfill.status).toBe(200);
    expect((JSON.parse(backfill.body) as { started: boolean }).started).toBe(true);
    const status = await waitForSummaryStatus(
      server.port,
      token,
      (s) => s.pendingSessions === 0 && s.summarizedSessions > 0,
    );
    expect(status.lastError).toBeNull();
    expect(status.model).toBe("chat-x");

    // 任务列表（最新一腿摘要投影）与会话列表都带上摘要
    const tasks1 = await request(server.port, `/api/tasks?project=${encodeURIComponent(project)}`, {
      headers: { "x-memrelay-token": token },
    });
    const page1 = JSON.parse(tasks1.body) as { tasks: Array<{ summary: string | null }> };
    expect(page1.tasks.some((task) => typeof task.summary === "string" && task.summary.includes("下一步"))).toBe(
      true,
    );
    const sessions1 = await request(server.port, "/api/sessions", {
      headers: { "x-memrelay-token": token },
    });
    const recent = (JSON.parse(sessions1.body) as { sessions: Array<{ summary: string | null }> }).sessions;
    expect(recent.some((s) => typeof s.summary === "string" && s.summary.length > 0)).toBe(true);

    // 清除全部摘要：唯一清除路径
    const cleared = await request(server.port, "/api/summaries/clear", {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(cleared.status).toBe(200);
    const clearedStatus = (JSON.parse(cleared.body) as { status: SummaryStatusShape }).status;
    expect(clearedStatus.summarizedSessions).toBe(0);
    expect(clearedStatus.pendingSessions).toBe(0);
    const tasks2 = await request(server.port, `/api/tasks?project=${encodeURIComponent(project)}`, {
      headers: { "x-memrelay-token": token },
    });
    expect(
      (JSON.parse(tasks2.body) as { tasks: Array<{ summary: string | null }> }).tasks.every(
        (task) => task.summary === null,
      ),
    ).toBe(true);
  });

  it("摘要接口挂掉：生成失败写进状态，任务/会话输出与未开启时逐字一致", async () => {
    const dead = await startFakeChatServer();
    const deadUrl = dead.url;
    await dead.close(); // 关掉端口 → 请求必然失败
    const { server, token } = await startFixtureServer();
    const headers = { "x-memrelay-token": token, "Content-Type": "application/json" };

    const summaryRes = await request(server.port, "/api/tasks/summary", {
      headers: { "x-memrelay-token": token },
    });
    const project = (JSON.parse(summaryRes.body) as { projects: Array<{ project: string }> }).projects[0]!.project;
    const tasksBefore = await request(server.port, `/api/tasks?project=${encodeURIComponent(project)}`, {
      headers: { "x-memrelay-token": token },
    });

    await request(server.port, "/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        summary: { baseUrl: deadUrl, model: "chat-x", apiKey: "k", enabled: true },
      }),
    });
    await request(server.port, "/api/summaries/backfill", { method: "POST", headers, body: "{}" });
    const status = await waitForSummaryStatus(server.port, token, (s) => s.lastError !== null);
    expect(status.summarizedSessions).toBe(0);

    const tasksAfter = await request(server.port, `/api/tasks?project=${encodeURIComponent(project)}`, {
      headers: { "x-memrelay-token": token },
    });
    // 逐字一致的降级：任务数与未开启时相同、摘要一律为 null
    const afterPage = JSON.parse(tasksAfter.body) as { tasks: Array<{ summary: string | null }> };
    const beforePage = JSON.parse(tasksBefore.body) as { tasks: Array<{ summary: string | null }> };
    expect(afterPage.tasks.length).toBe(beforePage.tasks.length);
    expect(afterPage.tasks.every((task) => task.summary === null)).toBe(true);
  });
});
