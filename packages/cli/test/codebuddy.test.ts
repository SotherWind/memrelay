import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { codebuddyCliAdapter, codebuddyIdeAdapter } from "../src/adapters/codebuddy/index.js";
import { workbuddyAdapter } from "../src/adapters/workbuddy/index.js";
import { codebuddyIdeWorkspaceHash, decodeIdeWorkspaceDir } from "../src/core/codebuddy-paths.js";
import { EMPTY_FILTERS } from "../src/core/filters.js";
import { detectTools } from "../src/integrations/inspect.js";
import { resolveSessionRef, type ResumeContext } from "../src/resume/context.js";
import { buildAllRanked } from "../src/resume/select.js";
import { readSessionDetail } from "../src/resume/session-reader.js";
import type { NormalizedEvent } from "../src/core/types.js";
import { buildIndex } from "../src/store/indexer.js";
import { openReadOnly } from "../src/store/db.js";
import { getSessionMessages } from "../src/server/conversations.js";
import { makeTempHome, type TempHome } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** 测试夹具把整个会话目录（index.json + 消息文件）拨回过去，状态才按完成判定。 */
function backdateTree(dir: string, ms: number): void {
  const when = new Date(ms);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) backdateTree(file, ms);
    else fs.utimesSync(file, when, when);
  }
}

const CLI_PROJECT = "C:\\Users\\Administrator\\CodeBuddy\\demo-cli";

interface RecordSpec {
  [key: string]: unknown;
}

function sampleCliRecords(now: number): RecordSpec[] {
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
          text: '<system-reminder data-role="user-context">\n<user_info>\nWorkspace Folder: C:/Users/Administrator/CodeBuddy/demo-cli\n</user_info>\n</system-reminder>\n帮我把首页改成深色',
        },
      ],
    },
    {
      type: "reasoning",
      id: "r2",
      parentId: "r1",
      timestamp: now + 1000,
      providerData: { reasoning: "先看一下现有样式。" },
    },
    {
      type: "function_call",
      id: "r3",
      parentId: "r2",
      timestamp: now + 2000,
      callId: "call_abc123",
      name: "read_file",
      arguments: '{"file_path":"src/styles.css"}',
      cwd: CLI_PROJECT,
    },
    {
      type: "function_call_result",
      id: "r4",
      parentId: "r3",
      timestamp: now + 3000,
      name: "read_file",
      callId: "call_abc123",
      status: "completed",
      output: { type: "text", text: "body { background: #fff; }" },
    },
    {
      type: "message",
      id: "r5",
      parentId: "r4",
      timestamp: now + 4000,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "已经把首页的样式改成深色，并检查了所有使用方。" }],
    },
    { type: "ai-title", id: "t1", timestamp: now + 5000, aiTitle: "首页改深色", cwd: CLI_PROJECT },
    { type: "file-history-snapshot", id: "f1", timestamp: now + 6000, snapshot: {} },
  ];
}

function setupCliHome(sessionId: string, records: RecordSpec[]): TempHome {
  const temp = makeTempHome();
  cleanups.push(temp.cleanup);
  const dir = path.join(temp.home, ".codebuddy", "projects", "c-Users-Administrator-CodeBuddy-demo-cli");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf8",
  );
  return temp;
}

function ideUserDataBase(home: string): string {
  if (process.platform === "win32") return path.join(home, "AppData", "Roaming");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support");
  return path.join(home, ".config");
}

function ideLocalDataBase(home: string): string {
  if (process.platform === "win32") return path.join(home, "AppData", "Local");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support");
  return path.join(home, ".local", "share");
}

function encodeWorkspace(dirPath: string): string {
  return Buffer.from(dirPath, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "_");
}

interface IdeFixture {
  temp: TempHome;
  workspace: string;
  convIndexPath: string;
}

/** 按 IDE 实测格式手写一个会话：workspace index + conversations/<id>/{index.json,messages/*.json}。 */
function setupIdeHome(): IdeFixture {
  const temp = makeTempHome();
  cleanups.push(temp.cleanup);
  const workspace = "D:/webProject/demo-ide";
  const historyRoot = path.join(
    ideUserDataBase(temp.home),
    "CodeBuddy CN",
    "User",
    "globalStorage",
    "tencent-cloud.coding-copilot",
    "genie-history",
  );
  const wsDir = path.join(historyRoot, encodeWorkspace(workspace));
  const convDir = path.join(wsDir, "conversations", "conv1");
  const messagesDir = path.join(convDir, "messages");
  fs.mkdirSync(messagesDir, { recursive: true });

  const now = Date.now() - 2 * 3_600_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  fs.writeFileSync(
    path.join(wsDir, "index.json"),
    JSON.stringify({
      conversations: [
        {
          id: "conv1",
          type: "chat",
          name: "浏览器截图任务",
          createdAt: iso(now),
          lastMessageAt: iso(now + 4000),
        },
      ],
      current: "conv1",
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(wsDir, "current.json"), JSON.stringify({ conversationId: "conv1" }), "utf8");
  fs.writeFileSync(
    path.join(convDir, "index.json"),
    JSON.stringify({
      messages: [
        { id: "m1", type: "text", role: "user", isComplete: true },
        { id: "m2", type: "text", role: "assistant", isComplete: true },
        { id: "m3", type: "text", role: "tool", isComplete: true },
        { id: "m4", type: "text", role: "assistant", isComplete: true },
      ],
      requests: [
        { id: "req1", type: "chat", messages: ["m1", "m2", "m3", "m4"], state: "complete" },
      ],
    }),
    "utf8",
  );

  const writeMessage = (id: string, role: string, content: unknown, extra: unknown, ms: number) => {
    fs.writeFileSync(
      path.join(messagesDir, `${id}.json`),
      JSON.stringify({
        id,
        type: "text",
        role,
        createTime: ms,
        message: JSON.stringify({ role, content }),
        extra: JSON.stringify(extra),
      }),
      "utf8",
    );
  };
  writeMessage("m1", "user", [{ type: "text", text: "帮我用浏览器截一张图" }], {}, now);
  writeMessage(
    "m2",
    "assistant",
    [
      { type: "reasoning", text: "先打开页面。" },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "browser_navigate",
        args: { url: "https://example.com" },
      },
    ],
    { toolStatus: { call_1: { status: "executed" } } },
    now + 1000,
  );
  writeMessage(
    "m3",
    "tool",
    [
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "browser_navigate",
        result: { status: "success", success: true, result: "navigated" },
      },
    ],
    {},
    now + 2000,
  );
  writeMessage(
    "m4",
    "assistant",
    [{ type: "text", text: "页面已经打开并完成截图，文件保存在工作目录，可以继续下一步了。" }],
    {},
    now + 4000,
  );
  // 会话索引与消息文件都拨回过去：变更检测看 max(mtime)，状态判定才不会变成"进行中"
  backdateTree(convDir, now);

  return { temp, workspace, convIndexPath: path.join(convDir, "index.json") };
}

interface RealIdeFixture {
  temp: TempHome;
  workspace: string;
  convIndexPath: string;
}

/**
 * 当前版本的真实布局：CodeBuddyExtension/Data/<uid>/CodeBuddyIDE/<uid>/history/<md5>/
 * 消息时间字段是 createdAt（ISO），用户文本包在 <user_info>/<user_query> 里。
 */
function setupRealIdeHome(opts?: { withWorkspaceStorage?: boolean }): RealIdeFixture {
  const temp = makeTempHome();
  cleanups.push(temp.cleanup);
  const workspace = "D:/Desktop/test";
  const uid = "b94e729c-0505-460a-866c-5f52c4766fea";
  const hash = codebuddyIdeWorkspaceHash(workspace, process.platform);
  const historyRoot = path.join(
    ideLocalDataBase(temp.home),
    "CodeBuddyExtension",
    "Data",
    uid,
    "CodeBuddyIDE",
    uid,
    "history",
    hash,
  );
  const convDir = path.join(historyRoot, "conv-real");
  const messagesDir = path.join(convDir, "messages");
  fs.mkdirSync(messagesDir, { recursive: true });

  if (opts?.withWorkspaceStorage !== false) {
    const wsMeta = path.join(
      ideUserDataBase(temp.home),
      "CodeBuddy CN",
      "User",
      "workspaceStorage",
      "f9ca190dc3d1879fd657676116b6aa4c",
      "workspace.json",
    );
    fs.mkdirSync(path.dirname(wsMeta), { recursive: true });
    fs.writeFileSync(wsMeta, JSON.stringify({ folder: "file:///D%3A/Desktop/test" }), "utf8");
  }

  const now = Date.now() - 2 * 3_600_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  fs.writeFileSync(
    path.join(historyRoot, "index.json"),
    JSON.stringify({
      conversations: [
        {
          id: "conv-real",
          type: "craft",
          name: "你好啊",
          createdAt: iso(now),
          lastMessageAt: iso(now + 4000),
        },
      ],
      current: "conv-real",
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(convDir, "index.json"),
    JSON.stringify({
      messages: [
        { id: "r1", type: "text", role: "user", isComplete: true },
        { id: "r2", type: "text", role: "assistant", isComplete: false },
      ],
      requests: [{ id: "req1", type: "craft", messages: ["r1", "r2"], state: "complete" }],
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(messagesDir, "r1.json"),
    JSON.stringify({
      role: "user",
      id: "r1",
      createdAt: iso(now),
      message: JSON.stringify({
        role: "user",
        content: [
          {
            type: "text",
            text: `<user_info>\nWorkspace Folder: ${workspace}\n</user_info>\n\n<user_query>\n你好啊\n</user_query>`,
          },
        ],
      }),
      extra: JSON.stringify({ isHelperMessage: false }),
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(messagesDir, "r2.json"),
    JSON.stringify({
      role: "assistant",
      id: "r2",
      createdAt: iso(now + 4000),
      message: JSON.stringify({
        role: "assistant",
        content: [
          { type: "reasoning", text: "用户只是打招呼。" },
          { type: "text", text: "你好！有什么我可以帮你的吗？无论是写代码、调试还是项目搭建都可以告诉我。" },
        ],
      }),
      extra: JSON.stringify({ modelId: "hy3" }),
    }),
    "utf8",
  );
  // 会话索引与消息文件都拨回过去：变更检测看 max(mtime)，状态判定才不会变成"进行中"
  backdateTree(convDir, now);

  return { temp, workspace, convIndexPath: path.join(convDir, "index.json") };
}

describe("CodeBuddy CLI 适配器", () => {
  it("扫描与读取：标题、cwd、文本/思考/工具调用与结果都在", async () => {
    const now = Date.now() - 3_600_000;
    const sessionId = "11111111-aaaa-4bbb-8ccc-111111111111";
    const temp = setupCliHome(sessionId, sampleCliRecords(now));
    const adapter = codebuddyCliAdapter();

    expect((await adapter.detect(temp.env)).installed).toBe(true);
    const scans = await adapter.scanAll(temp.env);
    expect(scans).toHaveLength(1);
    const scan = scans[0]!;
    expect(scan.id).toBe(`codebuddy:${sessionId}`);
    expect(scan.agent).toBe("codebuddy");
    expect(scan.cwd).toBe(CLI_PROJECT);
    expect(scan.tail.lastTitle).toBe("首页改深色");
    expect(scan.tail.statusInfo.pendingToolCallIds).toEqual([]);
    expect(scan.tail.statusInfo.lastUserMessageUnanswered).toBe(false);

    const events: NormalizedEvent[] = [];
    for await (const event of adapter.readSession(scan)) events.push(event);
    const session = events[0]!;
    if (session.kind === "session") {
      expect(session.session.title).toBe("首页改深色");
      expect(session.session.firstUserMessage).toBe("帮我把首页改成深色");
      expect(session.session.rawRecords).toBe(8);
    }
    const messages = events.filter((event) => event.kind === "message");
    expect(messages).toHaveLength(5);
    const parts = messages.flatMap((event) =>
      event.kind === "message" ? event.message.parts : [],
    );
    const call = parts.find((part) => part.kind === "tool_call")!;
    expect(call.toolName).toBe("read_file");
    expect(call.toolCallId).toBe("call_abc123");
    expect(call.json).toEqual({ file_path: "src/styles.css" });
    expect(parts.some((part) => part.kind === "reasoning")).toBe(true);
    expect(parts.some((part) => part.kind === "tool_result")).toBe(true);

    const detection = detectTools(temp.env).find((entry) => entry.tool.id === "codebuddy")!;
    expect(detection.installed).toBe(true);
    expect(detection.canBeSource).toBe(true);
    expect(detection.sessionFileCount).toBe(1);
    expect(detection.skillDirs[0]).toContain(".codebuddy");
  });

  it("与 WorkBuddy 各读各的目录；入库后会话可见", async () => {
    const now = Date.now() - 2 * 3_600_000;
    const sessionId = "22222222-bbbb-4ccc-8ddd-222222222222";
    const temp = setupCliHome(sessionId, sampleCliRecords(now));
    const wbDir = path.join(temp.home, ".workbuddy", "projects", "c-Users-Administrator-WorkBuddy-demo");
    fs.mkdirSync(wbDir, { recursive: true });
    fs.writeFileSync(
      path.join(wbDir, "33333333-cccc-4ddd-8eee-333333333333.jsonl"),
      JSON.stringify({
        type: "message",
        id: "w1",
        timestamp: now,
        role: "user",
        content: [{ type: "input_text", text: "WorkBuddy 的会话" }],
      }) + "\n",
      "utf8",
    );

    const cb = codebuddyCliAdapter();
    const wb = workbuddyAdapter();
    expect(await cb.scanAll(temp.env)).toHaveLength(1);
    expect(await wb.scanAll(temp.env)).toHaveLength(1);

    const stats = await buildIndex(temp.env, { adapters: [cb] });
    expect(stats.updated).toBe(1);
    expect(stats.failed).toBe(0);

    const db = openReadOnly(temp.env);
    try {
      const row = db
        .prepare("SELECT agent, title, project_root FROM sessions WHERE id LIKE 'codebuddy:%'")
        .get() as { agent: string; title: string; project_root: string } | undefined;
      expect(row?.agent).toBe("codebuddy");
      expect(row?.title).toBe("首页改深色");
      expect(row?.project_root).toContain("demo-cli");
      const page = getSessionMessages(db, temp.env, `codebuddy:${sessionId}`, {});
      expect(page?.total).toBe(5);
    } finally {
      db.close();
    }
  });
});

describe("CodeBuddy IDE 适配器", () => {
  it("解码工作区目录名", () => {
    expect(
      decodeIdeWorkspaceDir("YzovVXNlcnMvQWRtaW5pc3RyYXRvci9Db2RlQnVkZHkvQ2xhdw__"),
    ).toBe("c:/Users/Administrator/CodeBuddy/Claw");
    expect(decodeIdeWorkspaceDir("not-a-base64-path")).toBeUndefined();
  });

  it("扫描与读取：workspace index、会话消息、工具调用与结果", async () => {
    const { temp, workspace, convIndexPath } = setupIdeHome();
    const adapter = codebuddyIdeAdapter();

    expect((await adapter.detect(temp.env)).installed).toBe(true);
    const scans = await adapter.scanAll(temp.env);
    expect(scans).toHaveLength(1);
    const scan = scans[0]!;
    expect(scan.id).toBe("codebuddy:ide-conv1");
    expect(scan.cwd).toContain("demo-ide");
    expect(scan.tail.lastTitle).toBe("浏览器截图任务");
    expect(scan.tail.statusInfo.pendingToolCallIds).toEqual([]);
    expect(scan.sourcePath).toBe(convIndexPath);

    // hook 的 transcript_path 就是会话 index.json：按单会话精准索引
    const byFile = await adapter.scanFile(convIndexPath, temp.env);
    expect(byFile?.id).toBe("codebuddy:ide-conv1");

    const events: NormalizedEvent[] = [];
    for await (const event of adapter.readSession(scan)) events.push(event);
    const session = events[0]!;
    if (session.kind === "session") {
      expect(session.session.cwd).toContain("demo-ide");
      expect(session.session.title).toBe("浏览器截图任务");
      expect(session.session.firstUserMessage).toBe("帮我用浏览器截一张图");
      expect(session.session.rawRecords).toBe(4);
    }
    const messages = events.filter((event) => event.kind === "message");
    expect(messages).toHaveLength(4);
    const parts = messages.flatMap((event) =>
      event.kind === "message" ? event.message.parts : [],
    );
    expect(parts.some((part) => part.kind === "text")).toBe(true);
    expect(parts.some((part) => part.kind === "reasoning")).toBe(true);
    const call = parts.find((part) => part.kind === "tool_call")!;
    expect(call.toolName).toBe("browser_navigate");
    expect(call.toolCallId).toBe("call_1");
    expect(call.json).toEqual({ url: "https://example.com" });
    const result = parts.find((part) => part.kind === "tool_result")!;
    expect(result.toolCallId).toBe("call_1");
    expect(result.text).toBe("navigated");
    expect(result.status).toBe("ok");
    expect(workspace).toContain("demo-ide");

    // 只有 IDE 历史、没有 CLI projects 时也算已安装、可作来源
    const detection = detectTools(temp.env).find((entry) => entry.tool.id === "codebuddy")!;
    expect(detection.installed).toBe(true);
    expect(detection.canBeSource).toBe(true);
    expect(detection.sessionFileCount).toBe(1);
    expect(detection.skillDirs[0]).toContain(".codebuddy");
  });

  it("真实布局：history/<md5(工作区)>/<会话 id>，cwd 由 workspaceStorage 映射，首条取 user_query", async () => {
    const { temp, convIndexPath } = setupRealIdeHome();
    const adapter = codebuddyIdeAdapter();

    expect((await adapter.detect(temp.env)).installed).toBe(true);
    const scans = await adapter.scanAll(temp.env);
    expect(scans).toHaveLength(1);
    const scan = scans[0]!;
    expect(scan.id).toBe("codebuddy:ide-conv-real");
    expect(scan.cwd?.toLowerCase()).toContain("desktop");
    expect(scan.tail.lastTitle).toBe("你好啊");
    expect(scan.sourcePath).toBe(convIndexPath);

    const byFile = await adapter.scanFile(convIndexPath, temp.env);
    expect(byFile?.id).toBe("codebuddy:ide-conv-real");
    expect(adapter.acceptsPath?.(convIndexPath, temp.env)).toBe(true);

    const events: NormalizedEvent[] = [];
    for await (const event of adapter.readSession(scan)) events.push(event);
    const session = events[0]!;
    if (session.kind === "session") {
      expect(session.session.title).toBe("你好啊");
      // <user_info>/<user_query> 包裹要剥掉，只留真正的提问
      expect(session.session.firstUserMessage).toBe("你好啊");
    }
    const messages = events.filter((event) => event.kind === "message");
    expect(messages).toHaveLength(2);
    const first = messages[0]!;
    if (first.kind === "message") {
      // createdAt（ISO）要变成消息时间
      expect(first.message.createdAt).not.toBe("");
      // <user_info>/<additional_data> 不进 parts，只留 <user_query>
      const text = first.message.parts.find((part) => part.kind === "text")!.text;
      expect(text).toBe("你好啊");
    }

    const detection = detectTools(temp.env).find((entry) => entry.tool.id === "codebuddy")!;
    expect(detection.sessionFileCount).toBe(1);
  });

  it("同名 agent 的两个来源：按会话文件路径选对适配器（resume/show 不能选成 CLI）", async () => {
    const { temp, workspace, convIndexPath } = setupRealIdeHome();
    const cli = codebuddyCliAdapter();
    const ide = codebuddyIdeAdapter();
    const ctx: ResumeContext = {
      env: temp.env,
      cwd: workspace,
      project: { projectRoot: workspace, isGitRepo: false, differentDir: false },
      git: { changedFiles: [], untrackedFiles: [] },
      adapters: [cli, ide],
      filters: EMPTY_FILTERS,
    };
    const resolved = await resolveSessionRef(ctx, "codebuddy:ide-conv-real");
    expect(resolved).toBeDefined();
    expect(resolved!.adapter).toBe(ide);
    expect(resolved!.adapter.acceptsPath?.(resolved!.ref.sourcePath, temp.env)).toBe(true);
    const detail = await readSessionDetail(resolved!.adapter, resolved!.ref);
    expect(detail.branchMessages).toHaveLength(2);

    // 项目外 show：scanAll 兜底仍能找到 IDE 会话，并选中 IDE 适配器
    const outside = await resolveSessionRef(
      {
        ...ctx,
        cwd: "D:/webProject/another-project",
        project: { projectRoot: "D:/webProject/another-project", isGitRepo: false, differentDir: false },
      },
      "codebuddy:ide-conv-real",
    );
    expect(outside?.adapter).toBe(ide);
    expect(outside?.ref.sourcePath).toBe(convIndexPath);

    // 入过库后走索引快路径，不再依赖全量扫描
    await buildIndex(temp.env, { adapters: [ide] });
    const indexedOutside = await resolveSessionRef(
      {
        ...ctx,
        cwd: "D:/webProject/another-project",
        project: { projectRoot: "D:/webProject/another-project", isGitRepo: false, differentDir: false },
      },
      "codebuddy:ide-conv-real",
    );
    expect(indexedOutside?.adapter).toBe(ide);
    expect(indexedOutside?.ref.sourcePath).toBe(convIndexPath);

    // resume 的扫盘路径同样必须按 sourcePath 选适配器，否则 IDE 会话会被 CLI 适配器读成空壳
    const scans = await ide.scanAll(temp.env);
    const ranked = await buildAllRanked([cli, ide], scans, {
      keyword: "",
      cwd: workspace,
      gitChangedFiles: [],
      env: temp.env,
      now: Date.now(),
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.hasContent).toBe(true);
  });

  it("workspaceStorage 丢失时，从首条消息的 Workspace Folder 兜底 cwd", async () => {
    const { temp } = setupRealIdeHome({ withWorkspaceStorage: false });
    const adapter = codebuddyIdeAdapter();
    const scans = await adapter.scanAll(temp.env);
    expect(scans).toHaveLength(1);
    expect(scans[0]!.cwd?.toLowerCase()).toContain("desktop");
  });

  it("真实布局入库：状态 done，标题与首条正确", async () => {
    const { temp } = setupRealIdeHome();
    const adapter = codebuddyIdeAdapter();
    const stats = await buildIndex(temp.env, { adapters: [adapter] });
    expect(stats.updated).toBe(1);
    expect(stats.failed).toBe(0);

    const db = openReadOnly(temp.env);
    try {
      const row = db
        .prepare(
          "SELECT title, first_user_message, project_root, status FROM sessions WHERE id = 'codebuddy:ide-conv-real'",
        )
        .get() as
        | { title: string; first_user_message: string; project_root: string; status: string }
        | undefined;
      expect(row?.title).toBe("你好啊");
      expect(row?.first_user_message).toBe("你好啊");
      expect(row?.project_root.toLowerCase()).toContain("desktop");
      expect(row?.status).toBe("done");
    } finally {
      db.close();
    }
  });

  it("入库：会话与消息可见，标题来自 workspace index", async () => {
    const { temp } = setupIdeHome();
    const adapter = codebuddyIdeAdapter();
    const stats = await buildIndex(temp.env, { adapters: [adapter] });
    expect(stats.updated).toBe(1);
    expect(stats.failed).toBe(0);

    const db = openReadOnly(temp.env);
    try {
      const row = db
        .prepare("SELECT agent, title, project_root, status FROM sessions WHERE id = 'codebuddy:ide-conv1'")
        .get() as { agent: string; title: string; project_root: string; status: string } | undefined;
      expect(row?.agent).toBe("codebuddy");
      expect(row?.title).toBe("浏览器截图任务");
      expect(row?.project_root).toContain("demo-ide");
      expect(row?.status).toBe("done");
      const page = getSessionMessages(db, temp.env, "codebuddy:ide-conv1", {});
      expect(page?.total).toBe(4);
    } finally {
      db.close();
    }
  });
});
