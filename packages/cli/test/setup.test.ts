import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { renderSkill } from "../src/integrations/skill-template.js";
import { renderCmd, renderSh } from "../src/integrations/scripts.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const CLI = path.resolve(process.cwd(), "dist", "cli.mjs");
const hasBuild = fs.existsSync(CLI);

function makeHome(): { home: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-setup-"));
  fs.mkdirSync(path.join(home, ".qoder", "skills"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function runSetup(home: string, args: string[], expectStatus = 0): { stdout: string } {
  let stdout = "";
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, [CLI, "setup", ...args], {
      env: {
        ...process.env,
        MEMRELAY_TEST_HOME: home,
        MEMRELAY_HOME: path.join(home, ".memrelay"),
        MEMRELAY_CLI_PATH: CLI,
      },
      encoding: "utf8",
      timeout: 120000,
    });
  } catch (err) {
    const e = err as { stdout?: Buffer | string; status?: number };
    stdout = String(e.stdout ?? "");
    status = e.status ?? 1;
  }
  expect(status).toBe(expectStatus);
  return { stdout };
}

describe.skipIf(!hasBuild)("setup 接入", () => {
  it("写入 Skill、启动脚本与 runtime.json，并记录写入清单", () => {
    const { home, cleanup } = makeHome();
    cleanups.push(cleanup);
    const { stdout } = runSetup(home, ["--yes"]);

    const skill = fs.readFileSync(
      path.join(home, ".qoder", "skills", "memrelay", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("name: memrelay");
    expect(skill).toContain("继续");
    expect(skill).toContain("resume");
    expect(skill).toContain("memrelay'");
    expect(fs.existsSync(path.join(home, ".claude", "skills", "memrelay", "SKILL.md"))).toBe(true);

    const sh = fs.readFileSync(path.join(home, ".memrelay", "bin", "memrelay"), "utf8");
    expect(sh).toContain("#!/bin/sh");
    expect(sh).toContain("exec");
    const cmd = fs.readFileSync(path.join(home, ".memrelay", "bin", "memrelay.cmd"), "utf8");
    expect(cmd).toContain("@echo off");
    expect(cmd).not.toContain("\u4e2d");

    const manifest = JSON.parse(
      fs.readFileSync(path.join(home, ".memrelay", "integrations.json"), "utf8"),
    ) as { files: Array<{ path: string; hash: string; kind: string }> };
    const paths = manifest.files.map((f) => f.path);
    expect(paths.some((p) => p.endsWith("SKILL.md"))).toBe(true);
    expect(paths.some((p) => p.endsWith("memrelay.cmd"))).toBe(true);
    expect(manifest.files.every((f) => f.kind === "hook" || f.hash.length === 64)).toBe(true);
    expect(stdout).toContain("✓");
    // 默认包含启动提示 + 实时索引（检测到 Claude Code 与 Qoder 的技能目录）
    expect(stdout).toContain("触发增强（Claude Code）：已启用");
    expect(stdout).toContain("触发增强（Qoder）：已启用");
    const settings = JSON.parse(
      fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"),
    ) as { hooks: { SessionStart: unknown[]; Stop: unknown[]; SessionEnd: unknown[] } };
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.SessionEnd).toHaveLength(1);
    const qoderSettings = JSON.parse(
      fs.readFileSync(path.join(home, ".qoder", "settings.json"), "utf8"),
    ) as { hooks: { SessionStart: unknown[]; Stop: unknown[]; SessionEnd: unknown[] } };
    expect(qoderSettings.hooks.SessionStart).toHaveLength(1);
    expect(qoderSettings.hooks.Stop).toHaveLength(1);
  });

  it("--no-enhance 跳过启动提示与实时索引", () => {
    const { home, cleanup } = makeHome();
    cleanups.push(cleanup);
    const { stdout } = runSetup(home, ["--yes", "--no-enhance"]);
    expect(stdout).not.toContain("触发增强（Claude Code）：已启用");
    expect(fs.existsSync(path.join(home, ".claude", "settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".qoder", "settings.json"))).toBe(false);
  });

  it("--skip 跳过指定工具（非交互场景，等价于勾选列表里取消勾选）", () => {
    const { home, cleanup } = makeHome();
    cleanups.push(cleanup);
    const { stdout } = runSetup(home, ["--yes", "--skip", "qoder"]);
    expect(stdout).toContain("跳过：Qoder");
    expect(fs.existsSync(path.join(home, ".qoder", "skills", "memrelay", "SKILL.md"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "memrelay", "SKILL.md"))).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(home, ".memrelay", "integrations.json"), "utf8"),
    ) as { files: Array<{ path: string }> };
    expect(manifest.files.some((f) => f.path.includes(".qoder"))).toBe(false);
  });

  it("新工具接入：Codex hooks.json / WorkBuddy settings.json / ZCode config.json / OpenCode 插件；--skip 与 --undo 可撤销", () => {
    const { home, cleanup } = makeHome();
    cleanups.push(cleanup);
    fs.mkdirSync(path.join(home, ".codex", "sessions"), { recursive: true });
    fs.mkdirSync(path.join(home, ".workbuddy", "projects"), { recursive: true });
    fs.mkdirSync(path.join(home, ".zcode", "cli"), { recursive: true });
    fs.mkdirSync(path.join(home, ".local", "share", "opencode"), { recursive: true });

    const { stdout } = runSetup(home, ["--yes"]);
    expect(stdout).toContain("触发增强（Codex）：已启用");
    expect(stdout).toContain("触发增强（WorkBuddy）：已启用");
    expect(stdout).toContain("触发增强（ZCode）：已启用");
    expect(stdout).toContain("触发增强（OpenCode）：已启用");

    const codex = JSON.parse(fs.readFileSync(path.join(home, ".codex", "hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ commandWindows?: string }> }>>;
    };
    expect(codex.hooks.SessionStart![0]!.hooks[0]!.commandWindows).toContain("memrelay.cmd");
    const codexConfig = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    expect(codexConfig.match(/trusted_hash = "sha256:[0-9a-f]{64}"/g)).toHaveLength(3);

    const wb = JSON.parse(fs.readFileSync(path.join(home, ".workbuddy", "settings.json"), "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(wb.hooks.Stop).toHaveLength(1);

    const zcode = JSON.parse(fs.readFileSync(path.join(home, ".zcode", "cli", "config.json"), "utf8")) as {
      hooks: { enabled: boolean; events: Record<string, Array<{ hooks: Array<{ type: string }> }>> };
    };
    expect(zcode.hooks.enabled).toBe(true);
    expect(zcode.hooks.events.SessionStart![0]!.hooks[0]!.type).toBe("process");
    expect(zcode.hooks.events.Stop![0]!.hooks[0]!.type).toBe("process");

    const plugin = fs.readFileSync(
      path.join(home, ".config", "opencode", "plugins", "memrelay.js"),
      "utf8",
    );
    expect(plugin).toContain("session.execution.succeeded");
    expect(plugin).toContain('"--flavor"');

    const manifest = JSON.parse(
      fs.readFileSync(path.join(home, ".memrelay", "integrations.json"), "utf8"),
    ) as { files: Array<{ kind: string; tool?: string; path: string }> };
    expect(manifest.files.some((f) => f.kind === "hook" && f.tool === "codex")).toBe(true);
    expect(manifest.files.some((f) => f.kind === "hook" && f.tool === "workbuddy")).toBe(true);
    expect(manifest.files.some((f) => f.kind === "hook" && f.tool === "zcode")).toBe(true);
    expect(manifest.files.some((f) => f.kind === "plugin" && f.tool === "opencode")).toBe(true);

    // --skip opencode：插件文件被移除，Codex 的 hooks 不受影响
    runSetup(home, ["--yes", "--skip", "opencode"]);
    expect(fs.existsSync(path.join(home, ".config", "opencode", "plugins", "memrelay.js"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".codex", "hooks.json"))).toBe(true);

    // --undo：外科手术式移除 Codex / WorkBuddy / ZCode 的条目，插件文件删除
    runSetup(home, ["--undo", "--yes"]);
    const codexAfter = JSON.parse(fs.readFileSync(path.join(home, ".codex", "hooks.json"), "utf8")) as {
      hooks?: Record<string, unknown>;
    };
    expect(codexAfter.hooks?.SessionStart).toBeUndefined();
    expect(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).not.toContain(
      "hooks.state",
    );
    const wbAfter = JSON.parse(fs.readFileSync(path.join(home, ".workbuddy", "settings.json"), "utf8")) as {
      hooks?: unknown;
    };
    expect(wbAfter.hooks).toBeUndefined();
    const zcodeAfter = JSON.parse(fs.readFileSync(path.join(home, ".zcode", "cli", "config.json"), "utf8")) as {
      hooks?: unknown;
    };
    expect(zcodeAfter.hooks).toBeUndefined();
  });

  it("CodeBuddy 接入：CLI 与 IDE 共用 settings.json 与 skills", () => {
    const { home, cleanup } = makeHome();
    cleanups.push(cleanup);
    fs.mkdirSync(path.join(home, ".codebuddy", "projects"), { recursive: true });

    const { stdout } = runSetup(home, ["--yes"]);
    expect(stdout).toContain("触发增强（CodeBuddy）：已启用");
    expect(stdout).toContain("CLI 与 IDE 共用这份用户级设置");

    const settings = JSON.parse(
      fs.readFileSync(path.join(home, ".codebuddy", "settings.json"), "utf8"),
    ) as { hooks: Record<string, unknown[]> };
    for (const event of ["SessionStart", "Stop", "SessionEnd"]) {
      expect(settings.hooks[event]).toHaveLength(1);
    }
    expect(fs.existsSync(path.join(home, ".codebuddy", "skills", "memrelay", "SKILL.md"))).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(home, ".memrelay", "integrations.json"), "utf8"),
    ) as { files: Array<{ kind: string; tool?: string; path: string }> };
    expect(manifest.files.some((f) => f.kind === "hook" && f.tool === "codebuddy")).toBe(true);

    runSetup(home, ["--undo", "--yes"]);
    const after = JSON.parse(
      fs.readFileSync(path.join(home, ".codebuddy", "settings.json"), "utf8"),
    ) as { hooks?: unknown };
    expect(after.hooks).toBeUndefined();
    expect(fs.existsSync(path.join(home, ".codebuddy", "skills", "memrelay", "SKILL.md"))).toBe(false);
  });

  it("之前装过再 --skip：该工具的旧文件被移除，其余保留且清单更新", () => {
    const { home, cleanup } = makeHome();
    cleanups.push(cleanup);
    runSetup(home, ["--yes"]); // 先全装
    const qoderSkill = path.join(home, ".qoder", "skills", "memrelay", "SKILL.md");
    expect(fs.existsSync(qoderSkill)).toBe(true);

    const { stdout } = runSetup(home, ["--yes", "--skip", "qoder"]);
    expect(stdout).toContain("跳过：Qoder");
    expect(stdout).toContain("已移除 Qoder 的接入文件");
    expect(fs.existsSync(qoderSkill)).toBe(false);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "memrelay", "SKILL.md"))).toBe(true);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(home, ".memrelay", "integrations.json"), "utf8"),
    ) as { files: Array<{ path: string }> };
    expect(manifest.files.some((f) => f.path.includes(".qoder"))).toBe(false);
    expect(manifest.files.some((f) => f.path.includes(".claude"))).toBe(true);
    // 之后重新 setup（不 skip）能再接回来
    runSetup(home, ["--yes"]);
    expect(fs.existsSync(qoderSkill)).toBe(true);
  });

  it("启动脚本真的能运行：sh 与 cmd 都打印 MEMRELAY-OK", () => {
    const { home, cleanup } = makeHome();
    cleanups.push(cleanup);
    runSetup(home, ["--yes"]);

    const shBin = path.join(home, ".memrelay", "bin", "memrelay");
    const shOut = execFileSync("bash", ["-lc", `'${shBin}' ping`], {
      encoding: "utf8",
      env: { ...process.env, MEMRELAY_HOME: path.join(home, ".memrelay") },
      timeout: 30000,
    });
    expect(shOut).toContain("MEMRELAY-OK");

    if (process.platform === "win32") {
      const cmdBin = path.join(home, ".memrelay", "bin", "memrelay.cmd");
      const cmdOut = execFileSync("cmd.exe", ["/d", "/s", "/c", cmdBin, "ping"], {
        encoding: "utf8",
        env: { ...process.env, MEMRELAY_HOME: path.join(home, ".memrelay") },
        timeout: 30000,
      });
      expect(cmdOut).toContain("MEMRELAY-OK");
    }
  });

  it("setup --undo 删除写入的文件，保留用户改过的", () => {
    const { home, cleanup } = makeHome();
    cleanups.push(cleanup);
    runSetup(home, ["--yes"]);

    const userEdited = path.join(home, ".qoder", "skills", "memrelay", "SKILL.md");
    fs.appendFileSync(userEdited, "\n用户自己加的内容\n", "utf8");

    const { stdout } = runSetup(home, ["--undo", "--yes"]);
    expect(stdout).toContain("保留");
    expect(fs.existsSync(userEdited)).toBe(true);
    expect(fs.existsSync(path.join(home, ".memrelay", "bin", "memrelay.cmd"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".memrelay", "integrations.json"))).toBe(false);
  });

  it("setup --undo --purge 连数据目录一起删", () => {
    const { home, cleanup } = makeHome();
    cleanups.push(cleanup);
    runSetup(home, ["--yes"]);
    fs.writeFileSync(path.join(home, ".memrelay", "filters.json"), "{}");
    runSetup(home, ["--undo", "--purge", "--yes"]);
    expect(fs.existsSync(path.join(home, ".memrelay"))).toBe(false);
  });

  it("setup --enhance claude-code 写入 hook，--undo 时外科手术式移除", () => {
    const { home, cleanup } = makeHome();
    cleanups.push(cleanup);
    const settingsPath = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ model: "fable" }, null, 2));

    const { stdout } = runSetup(home, ["--yes", "--enhance", "claude-code"]);
    expect(stdout).toContain("触发增强（Claude Code）：已启用");
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      model: string;
      hooks: { SessionStart: unknown[] };
    };
    expect(after.model).toBe("fable");
    expect(after.hooks.SessionStart).toHaveLength(1);
    expect(fs.existsSync(`${settingsPath}.memrelay-backup`)).toBe(true);

    runSetup(home, ["--undo", "--yes"]);
    const undone = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      model: string;
      hooks?: unknown;
    };
    expect(undone.model).toBe("fable");
    expect(undone.hooks).toBeUndefined();
  });

  it("同一物理目录只写一次（符号链接去重）", () => {
    if (process.platform !== "win32") return;
    const { home, cleanup } = makeHome();
    cleanups.push(cleanup);
    const qoderSkills = path.join(home, ".qoder", "skills");
    const linkDir = path.join(home, ".claude", "skills");
    fs.rmSync(linkDir, { recursive: true, force: true });
    try {
      fs.symlinkSync(qoderSkills, linkDir, "junction");
    } catch {
      return;
    }
    const { stdout } = runSetup(home, ["--yes"]);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(home, ".memrelay", "integrations.json"), "utf8"),
    ) as { files: Array<{ path: string; kind: string }> };
    const skillWrites = manifest.files.filter((f) => f.kind === "skill");
    expect(skillWrites.length).toBe(1);
    expect(stdout).not.toContain("✗");
  });

  it("选中 Trae CN 时提示用户打开 Hooks 总开关（Agent 模式共享）", () => {
    const { home, cleanup } = makeHome();
    cleanups.push(cleanup);
    fs.mkdirSync(path.join(home, ".trae-cn"), { recursive: true });
    const { stdout } = runSetup(home, ["--yes"]);
    expect(stdout).toContain("自动同步对话进度");
    expect(stdout).toContain("Trae CN 还需要一次手动确认");
    expect(stdout).toContain("设置 → Hooks → 已配置的 Hooks");
    expect(stdout).toContain("Agent 模式设置页没有 Hooks");
  });
});

describe("Skill 模板与启动脚本（纯函数）", () => {
  it("Skill 里按终端分别给出命令", () => {
    const tpl = renderSkill({
      version: "0.1.0",
      bashCmd: "'/c/Users/dev/.memrelay/bin/memrelay'",
      powershellCmd: '& "$env:USERPROFILE\\.memrelay\\bin\\memrelay.cmd"',
      cmdCmd: '"%USERPROFILE%\\.memrelay\\bin\\memrelay.cmd"',
    });
    expect(tpl).toContain("继续");
    expect(tpl).toContain("out");
    expect(tpl).toContain("resume");
    expect(tpl).toContain("codex://threads");
    expect(tpl).toContain("show codex:<id>");
    expect(tpl).toContain("最后进展");
    expect(tpl).toContain("接力来源");
  });

  it("cmd 启动脚本里没有中文字面路径", () => {
    const cmd = renderCmd({
      nodeCandidates: [
        "C:\\Users\\张三\\AppData\\Local\\nvm\\node.exe",
        "C:\\Users\\张三\\AppData\\Roaming\\npm\\node.exe",
        "C:\\Users\\张三\\Documents\\node-portable\\node.exe",
      ],
      cliPath: "C:\\Users\\张三\\AppData\\Roaming\\npm\\node_modules\\memrelay\\dist\\cli.mjs",
      home: "C:\\Users\\张三",
      appData: "C:\\Users\\张三\\AppData\\Roaming",
      localAppData: "C:\\Users\\张三\\AppData\\Local",
    });
    expect(cmd).toContain("@echo off");
    expect(cmd).toContain("%USERPROFILE%");
    expect(cmd).not.toContain("张三");
    expect(cmd).toContain("%LOCALAPPDATA%");
    expect(cmd).toContain("%APPDATA%");
  });

  it("sh 启动脚本先试记录的真实路径，再回退 PATH", () => {
    const sh = renderSh({
      nodeCandidates: ["/usr/local/bin/node"],
      cliPath: "/opt/memrelay/dist/cli.mjs",
    });
    expect(sh).toContain("#!/bin/sh");
    expect(sh).toContain("/usr/local/bin/node");
    expect(sh).toContain("/opt/memrelay/dist/cli.mjs");
    expect(sh).toContain("exit 2");
  });

  it("启动脚本对候选 Node 做版本闸门（过旧则跳过，避免 nvm 切版本后跑挂）", () => {
    const sh = renderSh({ nodeCandidates: ["/usr/local/bin/node"], cliPath: "/opt/cli.mjs" });
    expect(sh).toContain("process.versions.node.split");
    expect(sh).toContain("v[0]>22");
    // 候选与 PATH 回退都过闸门
    expect((sh.match(/process\.versions\.node\.split/g) ?? []).length).toBeGreaterThanOrEqual(2);

    const cmd = renderCmd({ nodeCandidates: ["C:\\nvm\\node.exe"], cliPath: "C:\\cli.mjs" });
    expect(cmd).toContain("process.versions.node.split");
    expect(cmd).toContain("if not errorlevel 1");
    expect((cmd.match(/process\.versions\.node\.split/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // 退出码经 errorlevel 级联传递，块内不直接展开 %ERRORLEVEL%
    expect(cmd).not.toContain("exit /b %ERRORLEVEL%");
  });
});
