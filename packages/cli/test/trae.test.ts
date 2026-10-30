import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { traeCliAdapter } from "../src/adapters/codex/index.js";
import { traeEventsAdapter } from "../src/adapters/trae-events/index.js";
import { runHookCommand } from "../src/integrations/hook.js";
import { traeAgentHooksRoots } from "../src/integrations/relay-events.js";
import { disableTraeHook, enhanceTrae, traeHookCommand } from "../src/integrations/triggers.js";
import { buildIndex } from "../src/store/indexer.js";
import { openReadOnly } from "../src/store/db.js";
import { getSessionMessages } from "../src/server/conversations.js";
import type { NormalizedEvent } from "../src/core/types.js";
import { allTasks, makeTempHome, writeJsonlFile, type TempHome } from "./helpers.js";

const cleanups: Array<() => void> = [];
const ORIGINAL_HOME_ENV = process.env["MEMRELAY_TEST_HOME"];
const ORIGINAL_MEMRELAY_ENV = process.env["MEMRELAY_HOME"];

afterEach(() => {
  if (ORIGINAL_HOME_ENV === undefined) delete process.env["MEMRELAY_TEST_HOME"];
  else process.env["MEMRELAY_TEST_HOME"] = ORIGINAL_HOME_ENV;
  if (ORIGINAL_MEMRELAY_ENV === undefined) delete process.env["MEMRELAY_HOME"];
  else process.env["MEMRELAY_HOME"] = ORIGINAL_MEMRELAY_ENV;
  while (cleanups.length) cleanups.pop()!();
});

function withEnvFor(temp: TempHome): void {
  process.env["MEMRELAY_TEST_HOME"] = temp.home;
  process.env["MEMRELAY_HOME"] = path.join(temp.home, ".memrelay");
}

describe("Trae CLI 适配器（Codex 兼容 rollout）", () => {
  it("按 trae 来源扫描入库", async () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    const dir = path.join(temp.home, ".trae", "cli", "sessions", "2026", "10", "14");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(
      path.resolve("test/fixtures/codex/rollout-basic.jsonl"),
      path.join(dir, "rollout-2026-10-14T01-00-00-11111111-1111-4111-8111-111111111111.jsonl"),
    );

    const adapter = traeCliAdapter();
    expect((await adapter.detect(temp.env)).installed).toBe(true);
    const scans = await adapter.scanAll(temp.env);
    expect(scans).toHaveLength(1);
    expect(scans[0]!.id).toMatch(/^trae:/);
    expect(scans[0]!.agent).toBe("trae");
    expect(scans[0]!.cwd).toBeTruthy();

    const stats = await buildIndex(temp.env, { adapters: [adapter] });
    expect(stats.updated).toBe(1);
    const db = openReadOnly(temp.env);
    try {
      const row = db.prepare("SELECT agent FROM sessions LIMIT 1").get() as { agent: string };
      expect(row.agent).toBe("trae");
      expect(allTasks(db, temp.env).length).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });
});

describe("Trae CN：hook 事件采集与重建", () => {
  it("事件落盘→重建会话→入库→增量更新", async () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    withEnvFor(temp);
    const noop = () => {};
    const send = (payload: Record<string, unknown>) =>
      runHookCommand(noop, JSON.stringify(payload), { flavor: "trae-cn" });

    await send({ hook_event_name: "SessionStart", session_id: "trae-session-0001", cwd: "D:\\webProject\\demo-trae" });
    await send({ hook_event_name: "UserPromptSubmit", session_id: "trae-session-0001", prompt: "帮我调整登录页的校验逻辑" });
    await send({
      hook_event_name: "PostToolUse",
      session_id: "trae-session-0001",
      tool_name: "read_file",
      input: { path: "src/login.ts" },
      response: "export function login() {}",
    });
    await send({
      hook_event_name: "Stop",
      session_id: "trae-session-0001",
      last_assistant_message: "已经看完登录页，校验逻辑在 login 函数里，接下来我动手改。",
    });

    const eventsFile = path.join(
      temp.home,
      ".memrelay",
      "relay-events",
      "trae-cn",
      "trae-session-0001.jsonl",
    );
    expect(fs.existsSync(eventsFile)).toBe(true);
    const lines = fs.readFileSync(eventsFile, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(5); // 元数据 + start + 提示 + 工具调用/结果 + 助手

    const adapter = traeEventsAdapter();
    const scans = await adapter.scanAll(temp.env);
    expect(scans).toHaveLength(1);
    expect(scans[0]!.id).toBe("trae-cn:trae-session-0001");
    expect(scans[0]!.cwd).toBe("D:\\webProject\\demo-trae");
    expect(scans[0]!.tail.lastTitle).toContain("登录页");

    const stats = await buildIndex(temp.env, { adapters: [adapter] });
    expect(stats.updated).toBe(1);
    const db = openReadOnly(temp.env);
    try {
      const page = getSessionMessages(db, temp.env, "trae-cn:trae-session-0001", {});
      expect(page).toBeDefined();
      expect(page!.total).toBe(4); // 用户 + 工具调用 + 工具结果 + 助手
      const kinds = page!.messages.flatMap((message) => message.parts.map((part) => part.kind));
      expect(kinds).toContain("tool_call");
      expect(kinds).toContain("tool_result");
      const task = allTasks(db, temp.env).find((t) => t.project.includes("demo-trae"));
      expect(task?.title).toBe("帮我调整登录页的校验逻辑");
    } finally {
      db.close();
    }

    // 再补一个事件 → 文件变化 → 增量重建
    await send({ hook_event_name: "UserPromptSubmit", session_id: "trae-session-0001", prompt: "再补一个测试" });
    const stats2 = await buildIndex(temp.env, { adapters: [adapter] });
    expect(stats2.updated).toBe(1);
  });

  it("Trae 原始事件会先在沙箱内遮盖常见密钥", () => {
    const env = { home: "/tmp/memrelay-trae", platform: process.platform, env: {} };
    const cmd = traeHookCommand(env, "trae-cn");
    if (process.platform === "win32") {
      expect(cmd).toContain("sk-***");
      expect(cmd).toContain("AKIA");
      expect(cmd).toContain("PRIVATE KEY");
    } else {
      const match = /node -e '([\s\S]*)' #/.exec(cmd);
      expect(match).not.toBeNull();
      expect(match![1]).toContain("sk-[A-Za-z0-9_-]{20,}");
      expect(match![1]).toContain("PRIVATE KEY");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-trae-hook-"));
      const file = path.join(dir, "hook.js");
      try {
        fs.writeFileSync(file, match![1]!);
        execFileSync(process.execPath, ["--check", file], { stdio: "ignore" });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("hooks 安装/撤销：幂等、写入 hooks.json、撤销只移除我们的条目", () => {    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    const hooksFile = path.join(temp.home, ".trae-cn", "hooks.json");
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(
      hooksFile,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user-hook" }] }] } }, null, 2),
    );

    const first = enhanceTrae(temp.env);
    expect(first.enabled).toBe(true);
    const content = JSON.parse(fs.readFileSync(hooksFile, "utf8")) as {
      version?: number;
      hooks: Record<string, unknown>;
    };
    expect(content.version).toBe(1);
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
      expect(Array.isArray(content.hooks[event])).toBe(true);
    }
    const ourStop = JSON.stringify(content.hooks["Stop"]);
    expect(ourStop).toContain("hooks_env");
    expect(ourStop).toContain("memrelay-events");
    expect(ourStop).toContain(".memrelay hook");
    expect(ourStop).toContain("echo user-hook");
    expect(fs.existsSync(`${hooksFile}.memrelay-backup`)).toBe(true);

    const second = enhanceTrae(temp.env);
    expect(second.already).toBe(true);

    const removed = disableTraeHook(temp.env);
    expect(removed.enabled).toBe(false);
    const after = JSON.parse(fs.readFileSync(hooksFile, "utf8")) as { hooks?: Record<string, unknown> };
    const afterStop = JSON.stringify(after.hooks?.["Stop"] ?? []);
    expect(afterStop).toContain("echo user-hook");
    expect(afterStop).not.toContain("memrelay-events");
    expect(afterStop).not.toContain("--flavor trae-cn");
  });

  it("hooks_env 路径跨平台：Windows / macOS / Linux", () => {
    const darwin = traeAgentHooksRoots({ home: "/Users/x", platform: "darwin", env: {} })[0]!;
    expect(darwin.replace(/\\/g, "/")).toContain(
      "Library/Application Support/Trae CN/ModularData/ai-agent/hooks_env/memrelay-events",
    );
    const linux = traeAgentHooksRoots({ home: "/home/x", platform: "linux", env: {} })[0]!;
    expect(linux.replace(/\\/g, "/")).toContain(
      ".config/Trae CN/ModularData/ai-agent/hooks_env/memrelay-events",
    );
    const win = traeAgentHooksRoots({
      home: "C:/Users/x",
      platform: "win32",
      env: { APPDATA: "C:/Users/x/AppData/Roaming" },
    })[0]!;
    expect(win.replace(/\\/g, "/")).toContain(
      "AppData/Roaming/Trae CN/ModularData/ai-agent/hooks_env/memrelay-events",
    );
  });

  it("Agent 沙箱的原始 hook payload（hooks_env）也能重建会话", async () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    const appData = path.join(temp.home, "appdata");
    const env = {
      home: temp.home,
      platform: process.platform,
      env: { APPDATA: appData },
    };
    const rawDir = path.join(
      appData,
      "Trae CN",
      "ModularData",
      "ai-agent",
      "hooks_env",
      "memrelay-events",
    );
    const project = temp.home;
    const sid = "trae-raw-agent-0001";
    writeJsonlFile(path.join(rawDir, `${sid}.jsonl`), [
      { hook_event_name: "SessionStart", session_id: sid, cwd: project },
      { hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "把登录页修一下" },
      {
        hook_event_name: "PostToolUse",
        session_id: sid,
        tool_name: "read_file",
        input: { path: "src/login.ts" },
        response: "ok",
      },
      {
        hook_event_name: "Stop",
        session_id: sid,
        last_assistant_message: "登录页已经修好并验证通过。",
      },
    ]);

    const adapter = traeEventsAdapter();
    const scans = await adapter.scanAll(env);
    expect(scans).toHaveLength(1);
    expect(scans[0]!.id).toBe(`trae-cn:${sid}`);
    expect(scans[0]!.cwd).toBe(project);
    expect(scans[0]!.tail.statusInfo.lastAssistantFinal).toBe(true);

    const events: NormalizedEvent[] = [];
    for await (const event of adapter.readSession(scans[0]!)) events.push(event);
    const messages = events.filter((event) => event.kind === "message");
    const texts = messages.flatMap((event) =>
      event.kind === "message" ? event.message.parts.map((part) => part.text ?? "") : [],
    );
    expect(texts.join("\n")).toContain("把登录页修一下");
    expect(texts.join("\n")).toContain("登录页已经修好并验证通过。");
  });
});
