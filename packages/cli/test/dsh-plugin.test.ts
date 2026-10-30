import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { DSH_PLUGIN_NAME } from "../src/integrations/dsh-plugin.js";
import { disableDshHook, enhanceDsh } from "../src/integrations/triggers.js";
import { hasZstd, projectKeyForCwd } from "../src/adapters/dsh/index.js";
import { VERSION } from "../src/core/version.js";
import type { Env } from "../src/core/types.js";
import { openReadOnly } from "../src/store/db.js";
import { makeTempHome, wholeSecondDate, type TempHome } from "./helpers.js";

const cleanups: Array<() => void> = [];
const ENV_KEYS = ["MEMRELAY_TEST_HOME", "MEMRELAY_HOME", "MEMRELAY_DSH_PLUGIN_DIR", "MEMRELAY_CLI_PATH"] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  while (cleanups.length) cleanups.pop()!();
});

const CLI = path.resolve(process.cwd(), "dist", "cli.mjs");
const hasBuild = fs.existsSync(CLI);
const zstdCompress = (zlib as unknown as { zstdCompressSync?: (buf: Buffer) => Buffer }).zstdCompressSync;
const canWriteZstd = hasZstd() && zstdCompress !== undefined;

const PLUGIN_ROOT = path.resolve(process.cwd(), "dsh-plugin");
const PLUGIN_URL = pathToFileURL(path.join(PLUGIN_ROOT, "lib", "index.js")).href;

function fakeEnv(home: string): Env {
  return { home, platform: process.platform, env: {} };
}

// ---------- 插件包清单 ----------

describe("dsh 插件包", () => {
  it("清单与 patch 自洽：bundle 声明、insert 行、版本与 CLI 同步", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8")) as {
      name: string;
      version: string;
      dsh: { bundle: { patch: string } };
    };
    expect(pkg.name).toBe(DSH_PLUGIN_NAME);
    expect(pkg.version).toBe(VERSION);
    expect(pkg.dsh.bundle.patch).toBe("./cordis.patch.yml");

    const patch = fs.readFileSync(path.join(PLUGIN_ROOT, "cordis.patch.yml"), "utf8");
    expect(patch).toContain("insert:");
    expect(patch).toContain("id: memrelay-dsh");
    expect(patch).toContain(`name: '${DSH_PLUGIN_NAME}'`);

    // 发布时插件目录要随包走
    const cliPkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as {
      files: string[];
    };
    expect(cliPkg.files).toContain("dsh-plugin");
  });
});

// ---------- 挂载：home 级 patch 里的 file:// 插件条目 ----------

describe("dsh 实时索引插件的挂载", () => {
  it("enhanceDsh 在 patch 块里同时挂桥与插件（file:// 入口）；撤销整块移除", () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    process.env["MEMRELAY_DSH_PLUGIN_DIR"] = PLUGIN_ROOT;

    const result = enhanceDsh(temp.env);
    expect(result.enabled).toBe(true);

    const patchFile = path.join(temp.home, ".dsh", "cordis.patch.yml");
    const patch = fs.readFileSync(patchFile, "utf8");
    expect(patch).toContain("- insert:");
    expect(patch).toContain("@deepseek-ai/dsh-hooks-claude-code");
    expect(patch).toContain(`name: "${PLUGIN_URL}"`);

    const removed = disableDshHook(temp.env);
    expect(removed.enabled).toBe(false);
    expect(fs.existsSync(patchFile)).toBe(false);
  });

  it("插件文件不存在时不挂插件条目（只挂桥，不留坏引用）", () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    process.env["MEMRELAY_DSH_PLUGIN_DIR"] = path.join(temp.home, "no-such-plugin");

    enhanceDsh(temp.env);
    const patch = fs.readFileSync(path.join(temp.home, ".dsh", "cordis.patch.yml"), "utf8");
    expect(patch).toContain("@deepseek-ai/dsh-hooks-claude-code");
    expect(patch).not.toContain("file://");
  });
});

// ---------- 插件本体（fake cli 断言 payload） ----------

function makeFakeCliDir(home: string): string {
  const dir = path.join(home, "fake-cli");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "cli.mjs"),
    [
      "import fs from 'node:fs';",
      "const chunks = [];",
      "process.stdin.on('data', (c) => chunks.push(c));",
      "process.stdin.on('end', () => {",
      "  fs.writeFileSync(new URL('./payload.json', import.meta.url), Buffer.concat(chunks).toString('utf8'));",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return dir;
}

function writeRuntime(home: string, cli: string): void {
  const dir = path.join(home, ".memrelay");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "runtime.json"),
    JSON.stringify({ nodeReal: process.execPath, node: process.execPath, cli }),
    "utf8",
  );
}

interface FakeCtx {
  on(event: string, handler: (payload: unknown) => unknown): unknown;
}

async function loadPluginHandlers(): Promise<Map<string, (payload: unknown) => unknown>> {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const ctx: FakeCtx = {
    on: (event, handler) => {
      handlers.set(event, handler);
      return undefined;
    },
  };
  const mod = (await import("../dsh-plugin/lib/index.js")) as {
    apply: (ctx: FakeCtx) => void;
  };
  mod.apply(ctx);
  return handlers;
}

describe("dsh 插件的 Stop / SessionStart 路径", () => {
  it("turn-stopping 把 session_id + cwd + Stop 传给 memrelay hook", async () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    process.env["MEMRELAY_HOME"] = path.join(temp.home, ".memrelay");
    const fakeDir = makeFakeCliDir(temp.home);
    writeRuntime(temp.home, path.join(fakeDir, "cli.mjs"));

    const handlers = await loadPluginHandlers();
    expect(handlers.has("agent/created")).toBe(true);
    const stop = handlers.get("agent/turn-stopping");
    expect(stop).toBeDefined();
    await stop!({ agent: { session: { header: { id: "session-abc", cwd: "D:/proj/demo" } } } });

    const payload = JSON.parse(fs.readFileSync(path.join(fakeDir, "payload.json"), "utf8")) as Record<string, unknown>;
    expect(payload).toEqual({
      hook_event_name: "Stop",
      session_id: "session-abc",
      transcript_path: "",
      cwd: "D:/proj/demo",
    });
  });

  it("memrelay 未就绪（没有 runtime.json）时静默完成，不抛错", async () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    process.env["MEMRELAY_HOME"] = path.join(temp.home, ".memrelay");

    const handlers = await loadPluginHandlers();
    await expect(
      handlers.get("agent/turn-stopping")!({ agent: { session: { header: { id: "s", cwd: "D:/x" } } } }),
    ).resolves.toBeUndefined();
  });
});

// ---------- 端到端：真实 dist cli 写库 ----------

const T0 = 1792052381937;

function header(cwd: string, sessionUuid: string): Record<string, unknown> {
  return {
    type: "session",
    version: 4,
    id: `session-${sessionUuid}`,
    createdAt: T0,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: "standard",
  };
}

function userMsg(seq: number, text: string): Record<string, unknown> {
  return {
    type: "user/message",
    seq,
    time: T0 + (seq + 1) * 1000,
    data: {
      content: [{ type: "text", text }],
      source: { kind: "user", rpcId: "rpc-1" },
      role: "user",
      id: `msg-${seq}`,
    },
    surfaceOp: "append",
  };
}

function assistantMsg(seq: number, text: string): Record<string, unknown> {
  return {
    type: "assistant/message",
    seq,
    time: T0 + (seq + 1) * 1000,
    data: {
      turn: 1,
      step: 1,
      message: { role: "assistant", content: [{ type: "text", text }], source: { kind: "model", provider: "agnes" } },
    },
    surfaceOp: "append",
  };
}

function turnEnd(seq: number, kind: string): Record<string, unknown> {
  return {
    type: "turn/end",
    seq,
    time: T0 + (seq + 1) * 1000,
    data: { turn: 1, reason: { kind } },
    surfaceOp: "append",
  };
}

/** 与 dsh.test.ts 相同：多帧 zstd 追加写（每批一帧）。 */
function writeDshSession(
  home: string,
  cwd: string,
  sessionUuid: string,
  batches: Record<string, unknown>[][],
  mtime?: Date,
): string {
  const dir = path.join(home, ".dsh", "sessions", projectKeyForCwd(cwd), `session-${sessionUuid}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "session.v4.jsonl.zstd");
  const frames = batches.map((batch) =>
    zstdCompress!(Buffer.from(`${batch.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8")),
  );
  fs.writeFileSync(file, Buffer.concat(frames));
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

describe.skipIf(!hasBuild || !canWriteZstd)("dsh 插件的端到端（真实 cli 写库）", () => {
  it("turn-stopping 经真实 memrelay hook 把会话写进库", async () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    process.env["MEMRELAY_TEST_HOME"] = temp.home;
    process.env["MEMRELAY_HOME"] = path.join(temp.home, ".memrelay");
    writeRuntime(temp.home, CLI);

    const project = "D:\\webProject\\dsh-plugin-e2e";
    const uuid = "e2e-3333-4333-8333-333333333333";
    const sessionId = `session-${uuid}`;
    writeDshSession(
      temp.home,
      project,
      uuid,
      [
        [header(project, uuid)],
        [
          userMsg(0, "把首页标题改成 MemRelay"),
          assistantMsg(1, "好的，我已经把首页标题改成了 MemRelay，并顺手更新了页面描述与导航文案。"),
          turnEnd(2, "completed"),
        ],
      ],
      wholeSecondDate(5),
    );

    const handlers = await loadPluginHandlers();
    await handlers.get("agent/turn-stopping")!({
      agent: { session: { header: { id: sessionId, cwd: project } } },
    });

    const db = openReadOnly(temp.env);
    try {
      const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(`dsh:${sessionId}`) as
        | { status: string }
        | undefined;
      expect(row?.status).toBe("done");
    } finally {
      db.close();
    }
  });
});

// ---------- setup 流程集成（真实 CLI 子进程） ----------

describe.skipIf(!hasBuild)("setup 流程里的 dsh 接入", () => {
  function runCliSetup(home: string, args: string[]): { stdout: string; status: number } {
    let stdout = "";
    let status = 0;
    try {
      stdout = execFileSync(process.execPath, [CLI, "setup", ...args], {
        env: {
          ...process.env,
          MEMRELAY_TEST_HOME: home,
          MEMRELAY_HOME: path.join(home, ".memrelay"),
          MEMRELAY_CLI_PATH: CLI,
          MEMRELAY_DSH_PLUGIN_DIR: PLUGIN_ROOT,
        },
        encoding: "utf8",
        timeout: 120000,
      });
    } catch (err) {
      const e = err as { stdout?: Buffer | string; status?: number };
      stdout = String(e.stdout ?? "");
      status = e.status ?? 1;
    }
    return { stdout, status };
  }

  it("setup 把插件挂进 patch；undo 整块摘除", () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    fs.mkdirSync(path.join(temp.home, ".dsh", "skills"), { recursive: true });

    const setup = runCliSetup(temp.home, ["--yes"]);
    expect(setup.status).toBe(0);
    expect(setup.stdout).toContain("实时索引插件（进程内执行");

    const patchFile = path.join(temp.home, ".dsh", "cordis.patch.yml");
    const patch = fs.readFileSync(patchFile, "utf8");
    expect(patch).toContain("@deepseek-ai/dsh-hooks-claude-code");
    expect(patch).toContain(`name: "${PLUGIN_URL}"`);

    const undo = runCliSetup(temp.home, ["--undo", "--yes"]);
    expect(undo.status).toBe(0);
    expect(fs.existsSync(patchFile)).toBe(false);
  });
});
