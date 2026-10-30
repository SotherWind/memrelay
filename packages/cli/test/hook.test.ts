import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { codebuddyIdeWorkspaceHash } from "../src/core/codebuddy-paths.js";
import {
  makeTempHome,
  qoderAssistantRec,
  qoderSessionDir,
  qoderToolResultRec,
  qoderUserRec,
  realDir,
  wholeSecondDate,
  writeJsonlFile,
} from "./helpers.js";

/** memrelay hook 端到端：Stop/SessionEnd 精准写库、SessionStart 补扫 + 提示、任何异常静默退出 0。 */

const CLI = path.resolve(process.cwd(), "dist", "cli.mjs");
const hasBuild = fs.existsSync(CLI);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

interface RunResult {
  stdout: string;
  status: number;
}

/** 清掉可能的调用方工具环境变量，避免影响"排除调用方自己"的判定。 */
function cleanEnv(home: string): Record<string, string> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    MEMRELAY_HOME: path.join(home, ".memrelay"),
    USERPROFILE: home,
    HOME: home,
  };
  for (const key of [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
    "QODER_CLI",
    "QODER_ID",
    "QODER_SESSION_ID",
    "QODER_AGENT_SDK_ENTRYPOINT",
    "CODEX_SANDBOX",
    "CODEX_SANDBOX_NETWORK_DISABLED",
  ]) {
    delete env[key];
  }
  return env as Record<string, string>;
}

function runCli(
  args: string[],
  opts: { cwd: string; home: string; input?: string },
): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: opts.cwd,
      env: cleanEnv(opts.home),
      encoding: "utf8",
      input: opts.input,
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; status?: number; stderr?: Buffer | string };
    return { stdout: String(e.stdout ?? ""), status: e.status ?? 1 };
  }
}

function runHook(
  payload: unknown,
  opts: { cwd: string; home: string },
  raw?: string,
): RunResult {
  const input = raw ?? JSON.stringify(payload);
  return runCli(["hook"], { ...opts, input });
}

function openDb(home: string): DatabaseSync {
  return new DatabaseSync(path.join(home, ".memrelay", "memrelay.db"), { readOnly: true });
}

function dbHasPartText(home: string, needle: string): boolean {
  const db = openDb(home);
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM parts WHERE text LIKE ?")
      .get(`%${needle}%`) as { n: number };
    return row.n > 0;
  } finally {
    db.close();
  }
}

function dbSessionByPath(home: string, file: string): { size: number } | undefined {
  const db = openDb(home);
  try {
    const row = db
      .prepare(
        `SELECT src.size AS size FROM sessions s JOIN sources src ON src.path = s.source_path
         WHERE s.source_path = ?`,
      )
      .get(file) as { size: number } | undefined;
    return row;
  } finally {
    db.close();
  }
}

const SID_A = "ba110000-0000-4000-8000-00000000000a";

function ideLocalDataBase(home: string): string {
  if (process.platform === "win32") return path.join(home, "AppData", "Local");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support");
  return path.join(home, ".local", "share");
}

/** 一个停在没有结果的 Read 上的线性会话（中断）。 */
function interruptedSession(cwd: string): Array<Record<string, unknown>> {
  return [
    { type: "workspace-directories", sessionId: SID_A, directories: [cwd] },
    qoderUserRec(SID_A, "ba11a000-0000-4000-8000-000000000001", "帮我设计一个公司官网首页", cwd),
    qoderAssistantRec(SID_A, "ba11a000-0000-4000-8000-000000000010", [
      { type: "text", text: "好，我先写首页静态页。" },
      { type: "tool_use", id: "call_hook_write1", name: "Write", input: { file_path: `${cwd}/src/pages/Home.tsx`, content: "<Home/>" } },
    ], cwd),
    qoderToolResultRec(SID_A, "ba11a000-0000-4000-8000-000000000011", "call_hook_write1", "File created successfully", cwd),
    qoderAssistantRec(SID_A, "ba11a000-0000-4000-8000-000000000020", [
      { type: "text", text: "静态页完成，开始接通知数据。" },
      { type: "tool_use", id: "call_hook_read1", name: "Read", input: { file_path: `${cwd}/src/api/notice.ts` } },
    ], cwd),
  ];
}

function appendLine(file: string, record: Record<string, unknown>): void {
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
}

describe.skipIf(!hasBuild)("memrelay hook 端到端", () => {
  it("Stop 事件把刚写完的回合增量写进库（幂等、静默）", () => {
    const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-repo-")));
    const temp = makeTempHome();
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);

    const file = path.join(qoderSessionDir(temp.home, repoDir), `${SID_A}.jsonl`);
    writeJsonlFile(file, interruptedSession(repoDir), wholeSecondDate(90));

    expect(runCli(["doctor"], { cwd: repoDir, home: temp.home }).status).toBe(0);

    // agent 又干了一个回合：追加一条带标记的记录
    appendLine(
      file,
      qoderAssistantRec(SID_A, "ba11a000-0000-4000-8000-000000000030", [
        { type: "text", text: "通知接口已接好，等着联调。STOPHOOK追记标记" },
      ], repoDir),
    );

    const res = runHook(
      { hook_event_name: "Stop", transcript_path: file, cwd: repoDir, session_id: SID_A },
      { cwd: repoDir, home: temp.home },
    );
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(""); // Stop 事件不输出
    expect(dbHasPartText(temp.home, "STOPHOOK追记标记")).toBe(true);

    // sources 的大小同步到了新文件的尺寸
    const row = dbSessionByPath(temp.home, file);
    expect(row?.size).toBe(fs.statSync(file).size);

    // 幂等：再跑一次不出错、输出仍为空
    const again = runHook(
      { hook_event_name: "Stop", transcript_path: file, cwd: repoDir },
      { cwd: repoDir, home: temp.home },
    );
    expect(again.status).toBe(0);
    expect(again.stdout.trim()).toBe("");
  });

  it("CodeBuddy IDE：Stop 的 transcript_path 指向会话 index.json，也能按单会话增量索引", () => {
    const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-ide-repo-")));
    const temp = makeTempHome();
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);

    // 当前版本的真实布局：CodeBuddyExtension/Data/<uid>/CodeBuddyIDE/<uid>/history/<md5(工作区)>
    const uid = "b94e729c-0505-460a-866c-5f52c4766fea";
    const wsDir = path.join(
      ideLocalDataBase(temp.home),
      "CodeBuddyExtension",
      "Data",
      uid,
      "CodeBuddyIDE",
      uid,
      "history",
      codebuddyIdeWorkspaceHash(repoDir, process.platform),
    );
    const convDir = path.join(wsDir, "conv-hook");
    const messagesDir = path.join(convDir, "messages");
    fs.mkdirSync(messagesDir, { recursive: true });
    const indexPath = path.join(convDir, "index.json");
    const old = new Date(Date.now() - 3_600_000);
    fs.writeFileSync(
      path.join(wsDir, "index.json"),
      JSON.stringify({
        conversations: [
          { id: "conv-hook", type: "craft", name: "IDE 首页改造", createdAt: old.toISOString() },
        ],
        current: "conv-hook",
      }),
    );
    const writeMessage = (id: string, role: string, content: unknown, ms: number) =>
      fs.writeFileSync(
        path.join(messagesDir, `${id}.json`),
        JSON.stringify({
          id,
          type: "text",
          role,
          createdAt: new Date(ms).toISOString(),
          message: JSON.stringify({ role, content }),
          extra: "{}",
        }),
      );
    writeMessage(
      "m1",
      "user",
      [
        {
          type: "text",
          text: `<user_info>\nWorkspace Folder: ${repoDir}\n</user_info>\n\n<user_query>\n帮我改一下 IDE 首页\n</user_query>`,
        },
      ],
      old.getTime(),
    );
    fs.writeFileSync(indexPath, JSON.stringify({ messages: ["m1"].map((id) => ({ id, role: "user" })) }));
    fs.utimesSync(indexPath, old, old);

    expect(runCli(["doctor"], { cwd: repoDir, home: temp.home }).status).toBe(0);
    expect(dbHasPartText(temp.home, "帮我改一下 IDE 首页")).toBe(true);

    // IDE 又完成了一个回合：新增消息并重写会话索引
    writeMessage(
      "m2",
      "assistant",
      [{ type: "text", text: "首页已经改好，IDEHOOK追记标记" }],
      Date.now(),
    );
    fs.writeFileSync(
      indexPath,
      JSON.stringify({
        messages: [
          { id: "m1", role: "user" },
          { id: "m2", role: "assistant" },
        ],
      }),
    );

    const res = runHook(
      { hook_event_name: "Stop", transcript_path: indexPath, cwd: repoDir, session_id: "conv-hook" },
      { cwd: repoDir, home: temp.home },
    );
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
    expect(dbHasPartText(temp.home, "IDEHOOK追记标记")).toBe(true);
    // 新鲜度记录的是 index.json + 所有消息文件的总大小
    const freshnessDir = path.join(path.dirname(indexPath), "messages");
    const expectedSize = [indexPath, ...fs.readdirSync(freshnessDir).map((name) => path.join(freshnessDir, name))]
      .reduce((sum, file) => sum + fs.statSync(file).size, 0);
    expect(dbSessionByPath(temp.home, indexPath)?.size).toBe(expectedSize);
  });

  it("SessionEnd 事件同样增量写库", () => {
    const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-repo-")));
    const temp = makeTempHome();
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);

    const file = path.join(qoderSessionDir(temp.home, repoDir), `${SID_A}.jsonl`);
    writeJsonlFile(file, interruptedSession(repoDir), wholeSecondDate(90));
    expect(runCli(["doctor"], { cwd: repoDir, home: temp.home }).status).toBe(0);

    appendLine(
      file,
      qoderAssistantRec(SID_A, "ba11a000-0000-4000-8000-000000000040", [
        { type: "text", text: "会话收尾：ENDHOOK追记标记" },
      ], repoDir),
    );

    const res = runHook(
      { hook_event_name: "SessionEnd", transcript_path: file, cwd: repoDir, reason: "exit" },
      { cwd: repoDir, home: temp.home },
    );
    expect(res.status).toBe(0);
    expect(dbHasPartText(temp.home, "ENDHOOK追记标记")).toBe(true);
  });

  it("SessionStart 补扫新出现的会话文件，并把未完成任务提示输出到 stdout", () => {
    const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-repo-")));
    const temp = makeTempHome();
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);

    const fileA = path.join(qoderSessionDir(temp.home, repoDir), `${SID_A}.jsonl`);
    writeJsonlFile(fileA, interruptedSession(repoDir), wholeSecondDate(90));
    expect(runCli(["doctor"], { cwd: repoDir, home: temp.home }).status).toBe(0);

    // doctor 之后才出现的新会话：靠 SessionStart 的补扫收进库
    const sidB = "ba110000-0000-4000-8000-00000000000b";
    const fileB = path.join(qoderSessionDir(temp.home, repoDir), `${sidB}.jsonl`);
    writeJsonlFile(
      fileB,
      [
        { type: "workspace-directories", sessionId: sidB, directories: [repoDir] },
        qoderUserRec(sidB, "ba11b000-0000-4000-8000-000000000001", "把 README 的截图换掉", repoDir),
        qoderAssistantRec(sidB, "ba11b000-0000-4000-8000-000000000010", [
          { type: "text", text: "截图已替换完成，这一轮收尾。" },
        ], repoDir),
      ],
      wholeSecondDate(30),
    );

    const res = runHook(
      { hook_event_name: "SessionStart", transcript_path: fileB, cwd: repoDir, source: "startup" },
      { cwd: repoDir, home: temp.home },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("中断的任务"); // 一行提示注入上下文（A 还停在没结果的工具调用上）
    expect(res.stdout).toContain("Qoder");
    expect(dbSessionByPath(temp.home, fileB)).toBeDefined(); // 补扫把新会话收进库
  });

  it("静默契约：空 stdin、坏 JSON、未知事件、没有 transcript_path 都不报错", () => {
    const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-repo-")));
    const temp = makeTempHome();
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);

    for (const raw of ["", "这不是 JSON", JSON.stringify({ hook_event_name: "PreToolUse" })]) {
      const res = runHook(undefined as unknown, { cwd: repoDir, home: temp.home }, raw);
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe("");
    }
    // 没有 transcript_path 的 Stop：退回补扫，但库还不存在 → 什么都不做
    const res = runHook({ hook_event_name: "Stop", cwd: repoDir }, { cwd: repoDir, home: temp.home });
    expect(res.status).toBe(0);
    expect(fs.existsSync(path.join(temp.home, ".memrelay", "memrelay.db"))).toBe(false);
  });

  it("半截记录（最后一行没写完）也能索引，不报错", () => {
    const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-repo-")));
    const temp = makeTempHome();
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);

    const file = path.join(qoderSessionDir(temp.home, repoDir), `${SID_A}.jsonl`);
    writeJsonlFile(file, interruptedSession(repoDir), wholeSecondDate(90));
    expect(runCli(["doctor"], { cwd: repoDir, home: temp.home }).status).toBe(0);

    fs.appendFileSync(file, '{"type":"assistant","uuid":"ba11a000-0000-4000', "utf8"); // 正在写：不完整

    const res = runHook(
      { hook_event_name: "Stop", transcript_path: file, cwd: repoDir },
      { cwd: repoDir, home: temp.home },
    );
    expect(res.status).toBe(0);
    const row = dbSessionByPath(temp.home, file);
    expect(row?.size).toBe(fs.statSync(file).size); // 半截文件也被索引过（sources 更新）
    expect(dbHasPartText(temp.home, "开始接通知数据")).toBe(true);
  });

  it("不认识的 transcript_path：退回增量全扫，照样把变更收进库", () => {
    const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-repo-")));
    const temp = makeTempHome();
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);

    const file = path.join(qoderSessionDir(temp.home, repoDir), `${SID_A}.jsonl`);
    writeJsonlFile(file, interruptedSession(repoDir), wholeSecondDate(90));
    expect(runCli(["doctor"], { cwd: repoDir, home: temp.home }).status).toBe(0);

    appendLine(
      file,
      qoderAssistantRec(SID_A, "ba11a000-0000-4000-8000-000000000050", [
        { type: "text", text: "FALLBACK追记标记" },
      ], repoDir),
    );
    const unknown = path.join(temp.home, "somewhere-else.jsonl");
    fs.writeFileSync(unknown, "{}\n", "utf8");

    const res = runHook(
      { hook_event_name: "Stop", transcript_path: unknown, cwd: repoDir },
      { cwd: repoDir, home: temp.home },
    );
    expect(res.status).toBe(0);
    expect(dbHasPartText(temp.home, "FALLBACK追记标记")).toBe(true);
  });

  it("opencode flavor：按 payload 的 session_id 精准增量索引那一次会话", () => {
    const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-repo-")));
    const temp = makeTempHome();
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);

    const dbDir = path.join(temp.home, ".local", "share", "opencode");
    fs.mkdirSync(dbDir, { recursive: true });
    const dbFile = path.join(dbDir, "opencode.db");
    const sid = "ses_hook0001";
    const now = Date.now() - 60_000;
    const db = new DatabaseSync(dbFile);
    db.exec(
      "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);",
    );
    db.exec(
      "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);",
    );
    db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?)").run(sid, repoDir, "测试会话", now, now);
    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "msg_1",
      sid,
      "user",
      1,
      now,
      now,
      JSON.stringify({ time: { created: now }, text: "起个会话" }),
    );
    db.close();

    expect(runCli(["doctor"], { cwd: repoDir, home: temp.home }).status).toBe(0);

    // 回合结束后又写了一轮：新消息只在库里，hook 用 session_id 精准收进索引
    const db2 = new DatabaseSync(dbFile);
    db2.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "msg_2",
      sid,
      "assistant",
      2,
      now + 5000,
      now + 5000,
      JSON.stringify({
        time: { created: now + 5000 },
        content: [{ type: "text", text: "OPENCODE_HOOK追记标记" }],
      }),
    );
    db2.prepare("UPDATE session_v2 SET time_updated = ? WHERE id = ?").run(now + 5000, sid);
    db2.close();

    const res = runCli(["hook", "--flavor", "opencode"], {
      cwd: repoDir,
      home: temp.home,
      input: JSON.stringify({ hook_event_name: "Stop", session_id: sid, cwd: repoDir }),
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
    expect(dbHasPartText(temp.home, "OPENCODE_HOOK追记标记")).toBe(true);

    // 没有 session_id 时退回补扫，也不报错
    const res2 = runCli(["hook", "--flavor", "opencode"], {
      cwd: repoDir,
      home: temp.home,
      input: JSON.stringify({ hook_event_name: "Stop" }),
    });
    expect(res2.status).toBe(0);
  });
});
