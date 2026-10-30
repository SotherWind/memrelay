import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { cursorAdapter, cursorStorageFile } from "../src/adapters/cursor/index.js";
import type { NormalizedEvent } from "../src/core/types.js";
import { buildIndex } from "../src/store/indexer.js";
import { openReadOnly } from "../src/store/db.js";
import { getSessionMessages } from "../src/server/conversations.js";
import { allTasks, makeTempHome, type TempHome } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const PROJECT = "D:\\webProject\\demo-cursor";
const HOUR = 3_600_000;

interface BubbleSpec {
  id: string;
  type: 1 | 2;
  text: string;
  createdAt: string;
  thinking?: string[];
  tool?: { callId: string; name: string; args: unknown; result: string; status?: string };
}

interface ComposerSpec {
  id: string;
  name: string;
  createdAt: number;
  lastUpdatedAt: number;
  repoPath?: string;
  branch?: string;
  empty?: boolean;
  /** 对话里出现过的文件 URI（file:///...），用于反推项目目录 */
  fileUris?: string[];
  bubbles: BubbleSpec[];
}

/** 手工构造一个 Cursor 状态库（cursorDiskKV 明文表）。composers 可依赖 temp 目录做文件工厂。 */
function setupCursorHome(
  composers: ComposerSpec[] | ((temp: TempHome) => ComposerSpec[]),
): TempHome {
  const temp = makeTempHome();
  cleanups.push(temp.cleanup);
  const specs = typeof composers === "function" ? composers(temp) : composers;
  const appData =
    process.platform === "win32"
      ? path.join(temp.home, "AppData", "Roaming")
      : process.platform === "darwin"
        ? path.join(temp.home, "Library", "Application Support")
        : path.join(temp.home, ".config");
  const storageDir = path.join(appData, "Cursor", "User", "globalStorage");
  fs.mkdirSync(storageDir, { recursive: true });
  const file = path.join(storageDir, "state.vscdb");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
  const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  for (const composer of specs) {
    const headers = composer.bubbles.map((bubble) => ({
      bubbleId: bubble.id,
      type: bubble.type,
      grouping: { isRenderable: true },
      contentHeightHint: 10,
      createdAt: bubble.createdAt,
    }));
    const composerJson: Record<string, unknown> = {
      _v: 13,
      composerId: composer.id,
      name: composer.name,
      createdAt: composer.createdAt,
      lastUpdatedAt: composer.lastUpdatedAt,
      status: "completed",
      fullConversationHeadersOnly: composer.empty ? [] : headers,
      ...(composer.repoPath
        ? {
            trackedGitRepos: [
              {
                repoPath: composer.repoPath,
                branches: [{ branchName: composer.branch ?? "main", lastInteractionAt: composer.lastUpdatedAt }],
              },
            ],
          }
        : {}),
      ...(composer.fileUris?.length
        ? { originalFileStates: Object.fromEntries(composer.fileUris.map((uri) => [uri, { content: "" }])) }
        : {}),
    };
    insert.run(`composerData:${composer.id}`, JSON.stringify(composerJson));
    for (const bubble of composer.bubbles) {
      const bubbleJson: Record<string, unknown> = {
        _v: 3,
        type: bubble.type,
        bubbleId: bubble.id,
        createdAt: bubble.createdAt,
        text: bubble.text,
      };
      if (bubble.thinking?.length) {
        bubbleJson["allThinkingBlocks"] = bubble.thinking.map((text) => ({ text }));
      }
      if (bubble.tool) {
        bubbleJson["toolFormerData"] = {
          toolCallId: bubble.tool.callId,
          toolIndex: 0,
          status: bubble.tool.status ?? "completed",
          name: bubble.tool.name,
          rawArgs: JSON.stringify(bubble.tool.args),
          result: { result: bubble.tool.result },
        };
      }
      insert.run(`bubbleId:${composer.id}:${bubble.id}`, JSON.stringify(bubbleJson));
    }
  }
  db.close();
  temp.env.env["APPDATA"] = appData;
  return temp;
}

function sampleComposers(): ComposerSpec[] {
  const now = Date.now();
  return [
    {
      id: "aaaa1111-1111-4111-8111-111111111111",
      name: "改造导出脚本",
      createdAt: now - 3 * HOUR,
      lastUpdatedAt: now - 2 * HOUR,
      repoPath: PROJECT,
      branch: "feature/export",
      bubbles: [
        { id: "b0000001", type: 1, text: "帮我改造导出脚本，支持 CSV", createdAt: new Date(now - 3 * HOUR).toISOString() },
        {
          id: "b0000002",
          type: 2,
          text: "先看一下现有导出逻辑。",
          createdAt: new Date(now - 3 * HOUR + 60_000).toISOString(),
          thinking: ["先定位导出入口"],
          tool: { callId: "tool_c1", name: "read_file_v2", args: { path: "src/export.ts" }, result: "export function dump() {}" },
        },
        {
          id: "b0000003",
          type: 2,
          text: "已经改好导出脚本并补了 CSV 分支，跑过一遍测试全部通过，你可以直接合并。",
          createdAt: new Date(now - 2 * HOUR).toISOString(),
        },
      ],
    },
    {
      id: "bbbb2222-2222-4222-8222-222222222222",
      name: "空草稿",
      createdAt: now,
      lastUpdatedAt: now,
      empty: true,
      bubbles: [],
    },
  ];
}

describe("Cursor 适配器", () => {
  it("检测：找到状态库；扫描：元数据映射正确、空壳跳过", async () => {
    const temp = setupCursorHome(sampleComposers());
    const adapter = cursorAdapter();
    const detection = await adapter.detect(temp.env);
    expect(detection.installed).toBe(true);
    expect(cursorStorageFile(temp.env)).toBeDefined();

    const scans = await adapter.scanAll(temp.env);
    expect(scans).toHaveLength(1);
    const scan = scans[0]!;
    expect(scan.id).toBe("cursor:aaaa1111-1111-4111-8111-111111111111");
    expect(scan.agent).toBe("cursor");
    expect(scan.sourcePath).toContain("state.vscdb#aaaa1111");
    expect(scan.cwd).toBe(PROJECT);
    expect(scan.gitBranch).toBe("feature/export");
    expect(scan.mtimeMs).toBeGreaterThan(0);
    expect(scan.sizeBytes).toBeGreaterThan(0);
    expect(scan.tail.lastTitle).toBe("改造导出脚本");
    expect(scan.tail.statusInfo.lastAssistantFinal).toBe(true);
  });

  it("读取：会话 + 按顺序的消息，文本/思考/工具调用/工具结果都成片段", async () => {
    const temp = setupCursorHome(sampleComposers());
    const adapter = cursorAdapter();
    const scans = await adapter.scanAll(temp.env);

    const events: NormalizedEvent[] = [];
    for await (const event of adapter.readSession(scans[0]!)) events.push(event);
    const session = events[0]!;
    expect(session.kind).toBe("session");
    if (session.kind === "session") {
      expect(session.session.title).toBe("改造导出脚本");
      expect(session.session.firstUserMessage).toContain("CSV");
      expect(session.session.rawRecords).toBe(3);
    }
    const messages = events.filter((event) => event.kind === "message");
    expect(messages).toHaveLength(3);
    const last = messages[2]!;
    if (last.kind === "message") {
      expect(last.message.role).toBe("assistant");
      expect(last.message.ordinal).toBe(3);
      expect(last.message.parts[0]!.kind).toBe("text");
    }
    const toolMsg = messages[1]!;
    if (toolMsg.kind === "message") {
      const kinds = toolMsg.message.parts.map((part) => part.kind);
      expect(kinds).toContain("reasoning");
      expect(kinds).toContain("tool_call");
      expect(kinds).toContain("tool_result");
      const call = toolMsg.message.parts.find((part) => part.kind === "tool_call")!;
      expect(call.toolName).toBe("read_file_v2");
      expect(call.json).toEqual({ path: "src/export.ts" });
      const result = toolMsg.message.parts.find((part) => part.kind === "tool_result")!;
      expect(result.text).toContain("export function");
    }
  });

  it("没有仓库路径的会话：从对话文件路径反推项目目录（向上找 .git）", async () => {
    const temp = setupCursorHome((t) => {
      const repoDir = path.join(t.home, "repo", "apps", "tool");
      fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
      const uriOf = (p: string) =>
        "file:///" + p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/:/g, "%3A");
      const now = Date.now();
      return [
        {
          id: "cccc3333-3333-4333-8333-333333333333",
          name: "文件夹对话",
          createdAt: now - HOUR,
          lastUpdatedAt: now - HOUR / 2,
          fileUris: [uriOf(path.join(repoDir, "src", "a.ts")), uriOf(path.join(repoDir, "src", "b.ts"))],
          bubbles: [
            { id: "c0000001", type: 1, text: "看看这两个文件", createdAt: new Date(now - HOUR).toISOString() },
          ],
        },
      ];
    });
    const adapter = cursorAdapter();
    const scans = await adapter.scanAll(temp.env);
    expect(scans).toHaveLength(1);
    expect(scans[0]!.cwd).toBe(path.join(temp.home, "repo", "apps", "tool"));
  });

  it("入库：会话与消息进库、列表可见；二次索引跳过、内容变化后增量更新", async () => {
    const temp = setupCursorHome(sampleComposers());
    const adapter = cursorAdapter();

    const stats = await buildIndex(temp.env, { adapters: [adapter] });
    expect(stats.updated).toBe(1);
    expect(stats.failed).toBe(0);

    const db = openReadOnly(temp.env);
    try {
      const dbRow = db.prepare("SELECT project_root, status FROM sessions WHERE id LIKE 'cursor:aaaa%'").get() as
        | { project_root: string; status: string }
        | undefined;
      expect(dbRow?.project_root).toContain("demo-cursor");
      expect(dbRow?.status).toBe("done");

      const page = getSessionMessages(db, temp.env, "cursor:aaaa1111-1111-4111-8111-111111111111", {});
      expect(page).toBeDefined();
      expect(page!.total).toBe(3);
      expect(page!.messages[0]!.parts[0]!.text).toContain("CSV");

      const tasks = allTasks(db, temp.env);
      const task = tasks.find((t) => t.project.includes("demo-cursor"));
      expect(task).toBeDefined();
      expect(task!.title).toBe("改造导出脚本");
    } finally {
      db.close();
    }

    const stats2 = await buildIndex(temp.env, { adapters: [adapter] });
    expect(stats2.updated).toBe(0);
    expect(stats2.skipped).toBe(1);

    // 内容变化（新增气泡 + 更新 lastUpdatedAt）→ 增量重建
    const file = cursorStorageFile(temp.env)!;
    const raw = new DatabaseSync(file);
    const composerKey = "composerData:aaaa1111-1111-4111-8111-111111111111";
    const row = raw.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(composerKey) as {
      value: string;
    };
    const data = JSON.parse(row.value) as {
      lastUpdatedAt: number;
      fullConversationHeadersOnly: unknown[];
    };
    data.lastUpdatedAt = Date.now();
    data.fullConversationHeadersOnly.push({
      bubbleId: "b0000004",
      type: 1,
      createdAt: new Date().toISOString(),
      grouping: {},
    });
    raw.prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?").run(JSON.stringify(data), composerKey);
    raw
      .prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)")
      .run(
        `bubbleId:aaaa1111-1111-4111-8111-111111111111:b0000004`,
        JSON.stringify({ _v: 3, type: 1, bubbleId: "b0000004", createdAt: new Date().toISOString(), text: "再帮我加个测试" }),
      );
    raw.close();

    const stats3 = await buildIndex(temp.env, { adapters: [adapter] });
    expect(stats3.updated).toBe(1);
  });
});
