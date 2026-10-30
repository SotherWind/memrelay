import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

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

/**
 * hint 的状态必须按"查询时刻"重算。曾经的问题：索引发生在文件仍在 3 分钟新鲜窗口内，
 * 库里落的是 in_progress；窗口过后 hint 直接信任这行旧 status，真实的中断会话被漏掉。
 */

const CLI = path.resolve(process.cwd(), "dist", "cli.mjs");
const hasBuild = fs.existsSync(CLI);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function runCli(args: string[], opts: { cwd: string; home: string }): { stdout: string; status: number } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    MEMRELAY_HOME: path.join(opts.home, ".memrelay"),
    USERPROFILE: opts.home,
    HOME: opts.home,
  };
  for (const key of [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
    "QODER_CLI",
    "QODER_ID",
    "QODER_SESSION_ID",
    "QODER_AGENT_SDK_ENTRYPOINT",
  ]) {
    delete env[key];
  }
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: opts.cwd,
      env: env as Record<string, string>,
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; status?: number };
    return { stdout: String(e.stdout ?? ""), status: e.status ?? 1 };
  }
}

const SID = "c1a10000-0000-4000-8000-00000000000a";

/** 最后停在一次没有结果的工具调用上（真实中断）。 */
function pendingSession(cwd: string): Array<Record<string, unknown>> {
  return [
    qoderUserRec(SID, "c1a1a000-0000-4000-8000-000000000001", "把读书清单工具的测试补完", cwd),
    qoderAssistantRec(SID, "c1a1a000-0000-4000-8000-000000000010", [
      { type: "text", text: "我先跑一遍现有测试。" },
      { type: "tool_use", id: "call_hint_test1", name: "Bash", input: { command: "npm test" } },
    ], cwd),
  ];
}

describe.skipIf(!hasBuild)("hint：中断提示按查询时刻重算状态", () => {
  it("索引时仍在新鲜窗口内，窗口过后仍能提示这条真实中断", () => {
    const repoDir = realDir(fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-hint-repo-")));
    const temp = makeTempHome();
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }), temp.cleanup);

    const file = path.join(qoderSessionDir(temp.home, repoDir), `${SID}.jsonl`);
    writeJsonlFile(file, pendingSession(repoDir), wholeSecondDate(0));

    // 索引发生在文件刚写完的时刻：落库状态是 in_progress（pending=1）
    expect(runCli(["doctor"], { cwd: repoDir, home: temp.home }).status).toBe(0);
    const db = new DatabaseSync(path.join(temp.home, ".memrelay", "memrelay.db"));
    const row = db.prepare("SELECT status, sig_pending FROM sessions WHERE id = ?").get(`qoder:${SID}`) as
      | { status: string; sig_pending: number }
      | undefined;
    db.close();
    expect(row?.status).toBe("in_progress");
    expect(row?.sig_pending).toBe(1);

    // 时间过去 10 分钟：文件本身没有新写入，源文件与库里的 mtime 都还是整秒值
    const old = wholeSecondDate(10);
    fs.utimesSync(file, old, old);
    const db2 = new DatabaseSync(path.join(temp.home, ".memrelay", "memrelay.db"));
    db2.prepare("UPDATE sources SET mtime_ms = ? WHERE path = ?").run(Math.round(old.getTime()), file);
    db2.close();

    const res = runCli(["hint"], { cwd: repoDir, home: temp.home });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("中断的任务");
    expect(res.stdout).toContain("Qoder");
  });
});
