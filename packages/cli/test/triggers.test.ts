import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  claudeHookCommand,
  claudeSettingsPath,
  codebuddySettingsPath,
  codexConfigPath,
  codexHooksPath,
  disableClaudeCodeHook,
  disableCodebuddyHook,
  disableCodexHook,
  disableQoderHook,
  disableWorkbuddyHook,
  disableZCodeHook,
  enhanceClaudeCode,
  enhanceCodebuddy,
  enhanceCodex,
  enhanceQoder,
  enhanceWorkbuddy,
  enhanceZCode,
  qoderSettingsPath,
  workbuddySettingsPath,
  zcodeUserConfigPath,
} from "../src/integrations/triggers.js";
import { makeTempHome } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup(): { home: string; env: { home: string; platform: NodeJS.Platform; env: Record<string, string | undefined> }; cleanup: () => void } {
  const temp = makeTempHome();
  cleanups.push(temp.cleanup);
  return { home: temp.home, env: { home: temp.home, platform: process.platform, env: {} }, cleanup: temp.cleanup };
}

describe("Claude Code 触发增强（b 层 hook）", () => {
  it("追加 SessionStart hook，保留原有设置，并先备份", () => {
    const { home, env } = setup();
    const settingsPath = claudeSettingsPath(env);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const original = {
      model: "fable",
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:15721" },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo user-own-hook" }] }] },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    const result = enhanceClaudeCode(env);
    expect(result.enabled).toBe(true);
    expect(result.already).toBeUndefined();

    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    // 原有内容都在
    expect(after.model).toBe("fable");
    expect(after.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:15721");
    const sessionStart = after.hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
    expect(sessionStart).toHaveLength(2);
    expect(sessionStart[0]!.hooks[0]!.command).toBe("echo user-own-hook"); // 用户条目原样
    expect(sessionStart[1]!.hooks[0]!.command).toBe(claudeHookCommand(env));
    // 备份存在且等于改前内容
    const backup = fs.readFileSync(`${settingsPath}.memrelay-backup`, "utf8");
    expect(backup).toBe(JSON.stringify(original, null, 2));
  });

  it("幂等：重复启用不会叠加", () => {
    const { env } = setup();
    enhanceClaudeCode(env);
    const again = enhanceClaudeCode(env);
    expect(again.already).toBe(true);
    const after = JSON.parse(fs.readFileSync(claudeSettingsPath(env), "utf8"));
    expect((after.hooks.SessionStart as unknown[]).length).toBe(1);
  });

  it("撤销：只移除我们的条目，用户自己的 hook 保留", () => {
    const { env } = setup();
    const settingsPath = claudeSettingsPath(env);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo user-own-hook" }] }] } }),
    );
    enhanceClaudeCode(env);
    const result = disableClaudeCodeHook(env);
    expect(result.enabled).toBe(false);
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const sessionStart = after.hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
    expect(sessionStart).toHaveLength(1);
    expect(sessionStart[0]!.hooks[0]!.command).toBe("echo user-own-hook");
  });

  it("settings.json 不合法时拒绝改动", () => {
    const { env } = setup();
    const settingsPath = claudeSettingsPath(env);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, "{ not valid json");
    const result = enhanceClaudeCode(env);
    expect(result.enabled).toBe(false);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe("{ not valid json");
  });

  it("没有 settings.json 时从空文件创建（保留备份逻辑不报错）", () => {
    const { env } = setup();
    const result = enhanceClaudeCode(env);
    expect(result.enabled).toBe(true);
    const after = JSON.parse(fs.readFileSync(claudeSettingsPath(env), "utf8"));
    expect(after.hooks.SessionStart).toHaveLength(1);
    expect(fs.existsSync(`${claudeSettingsPath(env)}.memrelay-backup`)).toBe(false); // 无原文件则不备份
  });

  it("三件套：SessionStart / Stop / SessionEnd 各一条，命令统一为 hook", () => {
    const { env } = setup();
    enhanceClaudeCode(env);
    const after = JSON.parse(fs.readFileSync(claudeSettingsPath(env), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout: number }> }>>;
    };
    for (const event of ["SessionStart", "Stop", "SessionEnd"]) {
      expect(after.hooks[event]).toHaveLength(1);
      expect(after.hooks[event]![0]!.hooks[0]!.command).toBe(claudeHookCommand(env));
      expect(after.hooks[event]![0]!.hooks[0]!.command).toContain("hook");
    }
    expect(after.hooks.SessionStart![0]!.hooks[0]!.timeout).toBe(30);
    expect(after.hooks.Stop![0]!.hooks[0]!.timeout).toBe(15);
  });

  it("从旧版升级：hint 条目被换成三件套，不叠加", () => {
    const { env } = setup();
    const settingsPath = claudeSettingsPath(env);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const oldCommand = '"$HOME/.memrelay/bin/memrelay" hint 2>/dev/null || true';
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: oldCommand, timeout: 10 }] }],
          Stop: [{ hooks: [{ type: "command", command: "echo user-own-stop" }] }],
        },
      }),
    );

    enhanceClaudeCode(env);
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    // SessionStart：旧 hint 条目被替换（不叠加）
    expect(after.hooks.SessionStart).toHaveLength(1);
    expect(after.hooks.SessionStart![0]!.hooks[0]!.command).toBe(claudeHookCommand(env));
    // Stop：用户自己的条目保留，我们的追加在后面
    expect(after.hooks.Stop).toHaveLength(2);
    expect(after.hooks.Stop![0]!.hooks[0]!.command).toBe("echo user-own-stop");
    expect(after.hooks.Stop![1]!.hooks[0]!.command).toBe(claudeHookCommand(env));
    // 新补上的 SessionEnd
    expect(after.hooks.SessionEnd).toHaveLength(1);
  });

  it("MEMRELAY_HOME 改位置时，hook 命令跟着走", () => {
    const { home } = setup();
    const custom = path.join(home, "custom-memrelay");
    const env = { home, platform: process.platform, env: { MEMRELAY_HOME: custom } };
    expect(claudeHookCommand(env)).toContain("custom-memrelay/bin/memrelay");
  });
});

describe("Codex 触发增强（hooks.json，command + commandWindows）", () => {
  interface CodexHandler {
    type: string;
    command: string;
    commandWindows: string;
    async: boolean;
    timeout: number;
  }

  function readConfig(env: Parameters<typeof codexConfigPath>[0]): string {
    return fs.readFileSync(codexConfigPath(env), "utf8");
  }

  it("写入 ~/.codex/hooks.json 的三件套，handler 带 commandWindows 且 async=false", () => {
    const { env } = setup();
    const result = enhanceCodex(env);
    expect(result.enabled).toBe(true);
    expect(result.already).toBeUndefined();

    const after = JSON.parse(fs.readFileSync(codexHooksPath(env), "utf8")) as {
      hooks: Record<string, Array<{ hooks: CodexHandler[] }>>;
    };
    for (const event of ["SessionStart", "Stop", "SessionEnd"]) {
      expect(after.hooks[event]).toHaveLength(1);
      const handler = after.hooks[event]![0]!.hooks[0]!;
      expect(handler.type).toBe("command");
      expect(handler.command).toContain(".memrelay");
      expect(handler.command).toContain("hook");
      expect(handler.commandWindows).toContain("memrelay.cmd");
      expect(handler.commandWindows).toContain("Test-Path");
      expect(handler.async).toBe(false);
    }
    // Codex 只认 timeout（timeoutSec 会被忽略，回落到 600 秒）
    expect(after.hooks.SessionStart![0]!.hooks[0]!.timeout).toBe(30);
    expect(after.hooks.Stop![0]!.hooks[0]!.timeout).toBe(15);
    expect(after.hooks.SessionEnd![0]!.hooks[0]!.timeout).toBe(3);
  });

  it("预置 trusted_hash（与 Codex 的 hook_hash 算法一致），无需手动审查", () => {
    const { env } = setup();
    const configFile = codexConfigPath(env);
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, 'model = "gpt-5"\n\n[mcp_servers.demo]\ncommand = "echo"\n');

    enhanceCodex(env);

    const config = readConfig(env);
    expect(config).toContain('model = "gpt-5"');
    expect(config).toContain("[mcp_servers.demo]");
    for (const event of ["SessionStart", "Stop", "SessionEnd"] as const) {
      const label = { SessionStart: "session_start", Stop: "stop", SessionEnd: "session_end" }[event];
      expect(config).toContain(`:${label}:0:0'`);
    }
    expect(config.match(/trusted_hash = "sha256:[a-f0-9]{64}"/g)).toHaveLength(3);
    expect(fs.readFileSync(`${configFile}.memrelay-backup`, "utf8")).toContain('model = "gpt-5"');

    // 幂等：再次 setup 不重复追加表
    expect(enhanceCodex(env).already).toBe(true);
    expect(readConfig(env).match(/\[hooks\.state\./g)).toHaveLength(3);
  });

  it("组下标跟随用户已有 hook；旧信任值会被更新", () => {
    const { env } = setup();
    const hooksFile = codexHooksPath(env);
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(
      hooksFile,
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo user-own" }] }] },
      }),
    );
    const configFile = codexConfigPath(env);
    fs.writeFileSync(
      configFile,
      `[hooks.state.'${hooksFile}:session_start:1:0']\ntrusted_hash = "sha256:stale"\n`,
    );

    enhanceCodex(env);

    const config = readConfig(env);
    expect(config).toContain(":session_start:1:0'");
    expect(config).not.toContain("sha256:stale");
    expect(config).toMatch(/trusted_hash = "sha256:[a-f0-9]{64}"/);
  });

  it("保留用户自己的 hooks，幂等，撤销只移除我们的条目与信任标记", () => {
    const { env } = setup();
    const file = codexHooksPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user-own" }] }] } }),
    );
    enhanceCodex(env);
    expect(enhanceCodex(env).already).toBe(true);

    const result = disableCodexHook(env);
    expect(result.enabled).toBe(false);
    const after = JSON.parse(fs.readFileSync(file, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const stop = after.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stop).toHaveLength(1);
    expect(stop[0]!.hooks[0]!.command).toBe("echo user-own");
    expect(after.hooks.SessionStart).toBeUndefined();
    expect(fs.existsSync(codexConfigPath(env)) ? readConfig(env) : "").not.toContain("hooks.state");
  });

  it("hooks.json 不合法时拒绝改动，也不写信任", () => {
    const { env } = setup();
    const file = codexHooksPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not valid json");
    const result = enhanceCodex(env);
    expect(result.enabled).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("{ not valid json");
    expect(fs.existsSync(codexConfigPath(env))).toBe(false);
  });
});

describe("CodeBuddy 触发增强（~/.codebuddy/settings.json，CLI/IDE 共用）", () => {
  it("写入三件套（sh 形态命令），保留 settings.json 的其它字段", () => {
    const { env } = setup();
    const file = codebuddySettingsPath(env);
    expect(file).toBe(path.join(env.home, ".codebuddy", "settings.json"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ enabledPlugins: { "docx@codebuddy-plugins-official": true } }, null, 2),
    );

    const result = enhanceCodebuddy(env);
    expect(result.enabled).toBe(true);

    const after = JSON.parse(fs.readFileSync(file, "utf8")) as {
      enabledPlugins: Record<string, boolean>;
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>>;
    };
    expect(after.enabledPlugins).toEqual({ "docx@codebuddy-plugins-official": true });
    for (const event of ["SessionStart", "Stop", "SessionEnd"]) {
      const entry = after.hooks[event]![0]!.hooks[0]!;
      expect(entry.type).toBe("command");
      expect(entry.command).toContain(".memrelay");
      expect(entry.command).toContain("hook");
      expect(entry.timeout).toBe(event === "SessionStart" ? 30 : 15);
    }

    expect(enhanceCodebuddy(env).already).toBe(true);
    const result2 = disableCodebuddyHook(env);
    expect(result2.enabled).toBe(false);
    const restored = JSON.parse(fs.readFileSync(file, "utf8")) as {
      hooks?: unknown;
      enabledPlugins?: unknown;
    };
    expect(restored.hooks).toBeUndefined();
    expect(restored.enabledPlugins).toBeDefined();
  });

  it("settings.json 不合法时拒绝改动", () => {
    const { env } = setup();
    const file = codebuddySettingsPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not valid json");
    const result = enhanceCodebuddy(env);
    expect(result.enabled).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("{ not valid json");
  });
});

describe("WorkBuddy 触发增强（~/.workbuddy/settings.json）", () => {
  it("写入三件套（sh 形态命令），保留 settings.json 的其它字段", () => {
    const { env } = setup();
    const file = workbuddySettingsPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sandbox: { extraAllowWrite: ["~/x"] } }, null, 2));

    const result = enhanceWorkbuddy(env);
    expect(result.enabled).toBe(true);

    const after = JSON.parse(fs.readFileSync(file, "utf8")) as {
      sandbox: { extraAllowWrite: string[] };
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>>;
    };
    expect(after.sandbox.extraAllowWrite).toEqual(["~/x"]); // 其它字段不动
    for (const event of ["SessionStart", "Stop", "SessionEnd"]) {
      const entry = after.hooks[event]![0]!.hooks[0]!;
      expect(entry.type).toBe("command");
      expect(entry.command).toContain(".memrelay");
      expect(entry.command).toContain("hook");
      expect(entry.timeout).toBe(event === "SessionStart" ? 30 : 15);
    }

    expect(enhanceWorkbuddy(env).already).toBe(true);
    const result2 = disableWorkbuddyHook(env);
    expect(result2.enabled).toBe(false);
    const restored = JSON.parse(fs.readFileSync(file, "utf8")) as { hooks?: unknown };
    expect(restored.hooks).toBeUndefined();
  });

  it("settings.json 不合法时拒绝改动", () => {
    const { env } = setup();
    const file = workbuddySettingsPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not valid json");
    const result = enhanceWorkbuddy(env);
    expect(result.enabled).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("{ not valid json");
  });
});

describe("ZCode 触发增强（用户级 config.json，process 形态）", () => {
  interface ZcodeHandler {
    type: string;
    command: string;
    args: string[];
    enabled: boolean;
    timeoutMs: number;
  }

  it("写入 hooks.events（root enabled + 每条 enabled），保留配置里其它字段", () => {
    const { env } = setup();
    const file = zcodeUserConfigPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ plugins: { enabledPlugins: { demo: true } } }, null, 2));

    const result = enhanceZCode(env);
    expect(result.enabled).toBe(true);
    expect(result.already).toBeUndefined();

    const after = JSON.parse(fs.readFileSync(file, "utf8")) as {
      plugins: unknown;
      hooks: { enabled: boolean; events: Record<string, Array<{ hooks: ZcodeHandler[] }>> };
    };
    expect(after.plugins).toEqual({ enabledPlugins: { demo: true } }); // 其它字段不动
    expect(after.hooks.enabled).toBe(true);
    expect(Object.keys(after.hooks.events).sort()).toEqual(["SessionStart", "Stop"]); // 没有 SessionEnd
    for (const event of ["SessionStart", "Stop"] as const) {
      expect(after.hooks.events[event]).toHaveLength(1);
      const handler = after.hooks.events[event]![0]!.hooks[0]!;
      expect(handler.type).toBe("process"); // 桌面内核只跑得动 process 形态
      expect(handler.enabled).toBe(true);
      expect(handler.timeoutMs).toBe(event === "SessionStart" ? 30000 : 15000);
      const joined = [handler.command, ...handler.args].join(" ");
      expect(joined).toContain(".memrelay");
      expect(joined).toContain("--flavor");
      expect(joined).toContain("zcode");
      if (process.platform === "win32") {
        expect(handler.command).toContain("cmd.exe");
        expect(joined).toContain("memrelay.cmd");
        expect(handler.args[0]).toBe("/c");
      }
    }

    expect(enhanceZCode(env).already).toBe(true);
  });

  it("撤销只移除我们的条目；用户自己的 hooks 与 root enabled 语义保留", () => {
    const { env } = setup();
    const file = zcodeUserConfigPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          enabled: true,
          events: { Stop: [{ hooks: [{ type: "command", command: "echo user-own" }] }] },
        },
      }),
    );
    enhanceZCode(env);
    const result = disableZCodeHook(env);
    expect(result.enabled).toBe(false);

    const after = JSON.parse(fs.readFileSync(file, "utf8")) as {
      hooks: { events: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    };
    const stop = after.hooks.events.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stop).toHaveLength(1);
    expect(stop[0]!.hooks[0]!.command).toBe("echo user-own");
    expect(after.hooks.events.SessionStart).toBeUndefined();
  });

  it("从空文件安装再撤销：hooks 键整体清理掉", () => {
    const { env } = setup();
    enhanceZCode(env);
    const file = zcodeUserConfigPath(env);
    expect(fs.existsSync(file)).toBe(true);
    disableZCodeHook(env);
    const after = JSON.parse(fs.readFileSync(file, "utf8")) as { hooks?: unknown };
    expect(after.hooks).toBeUndefined();
  });

  it("config.json 不合法时拒绝改动", () => {
    const { env } = setup();
    const file = zcodeUserConfigPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not valid json");
    const result = enhanceZCode(env);
    expect(result.enabled).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("{ not valid json");
  });
});

describe("OpenCode 实时索引插件", () => {
  it("渲染的插件是 v2 形态（default export + id + setup），且调用 memrelay hook --flavor opencode", async () => {
    const { renderOpencodePlugin, opencodePluginPath } = await import(
      "../src/integrations/opencode-plugin.js"
    );
    const { home } = setup();
    const env = { home, platform: process.platform, env: {} as Record<string, string | undefined> };
    const content = renderOpencodePlugin(env);
    expect(content).toContain("export default {");
    expect(content).toContain('id: "memrelay"');
    expect(content).toContain("setup(ctx)");
    expect(content).toContain("ctx.event.subscribe");
    for (const type of [
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
    ]) {
      expect(content).toContain(type);
    }
    expect(content).toContain('"hook", "--flavor", "opencode"');
    expect(content).toContain("memrelay.cmd"); // Windows 走 cmd.exe /c
    expect(opencodePluginPath(env)).toContain("plugins");
  });
});

describe("Qoder CLI 触发增强（b 层 hook，exec 形态）", () => {
  it("写入 ~/.qoder/settings.json 的三件套；Windows 用 cmd.exe 直调启动脚本", () => {
    const { env } = setup();
    const result = enhanceQoder(env);
    expect(result.enabled).toBe(true);
    expect(result.already).toBeUndefined();

    const after = JSON.parse(fs.readFileSync(qoderSettingsPath(env), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; args?: string[] }> }>>;
    };
    for (const event of ["SessionStart", "Stop", "SessionEnd"]) {
      expect(after.hooks[event]).toHaveLength(1);
      const entry = after.hooks[event]![0]!.hooks[0]!;
      if (process.platform === "win32") {
        expect(entry.command).toBe("cmd.exe");
        expect(entry.args!.slice(0, 2)).toEqual(["/c", expect.stringContaining(".memrelay")]);
        expect(entry.args![1]).toMatch(/memrelay\.cmd$/);
        expect(entry.args![2]).toBe("hook");
      } else {
        expect(entry.command).toContain(".memrelay");
        expect(entry.args).toEqual(["hook"]);
      }
    }
  });

  it("幂等；撤销只移除我们的条目，用户自己的 hook 保留", () => {
    const { env } = setup();
    const settingsPath = qoderSettingsPath(env);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user-own-stop" }] }] } }),
    );
    enhanceQoder(env);
    expect(enhanceQoder(env).already).toBe(true);

    const result = disableQoderHook(env);
    expect(result.enabled).toBe(false);
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    expect(after.hooks.SessionStart).toBeUndefined();
    expect(after.hooks.SessionEnd).toBeUndefined();
    const stop = after.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stop).toHaveLength(1);
    expect(stop[0]!.hooks[0]!.command).toBe("echo user-own-stop");
  });

  it("settings.json 不合法时拒绝改动", () => {
    const { env } = setup();
    const settingsPath = qoderSettingsPath(env);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, "{ not valid json");
    const result = enhanceQoder(env);
    expect(result.enabled).toBe(false);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe("{ not valid json");
  });
});
