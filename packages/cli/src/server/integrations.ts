import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { Env } from "../core/types.js";
import { VERSION } from "../core/version.js";
import { memrelayDir } from "../core/env.js";
import { detectTools } from "../integrations/inspect.js";
import { readManifest, runSetupCommand, type SetupOptions } from "../integrations/setup.js";
import { runTerminalSelfTests, type TerminalTest } from "../integrations/selftest.js";

export interface IntegrationToolDto {
  id: string;
  name: string;
  installed: boolean;
  canBeSource: boolean;
  encrypted: boolean;
  sessionFileCount: number;
  skillDirs: string[];
  integrated: boolean;
  hooks: boolean;
  startupHint: boolean;
  liveIndex: boolean;
}

export interface IntegrationsDto {
  dataDir: string;
  version: string;
  tools: IntegrationToolDto[];
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

/** 各工具的接入状态（检测 + 清单核对，只读）。 */
export function listIntegrations(env: Env): IntegrationsDto {
  const manifest = readManifest(env);
  const files = manifest?.files ?? [];
  const tools = detectTools(env).map((detection) => {
    const skillFiles = detection.tool.skillDirs.map((rel) =>
      path.join(env.home, ...rel.split("/"), "memrelay", "SKILL.md"),
    );
    const skillIntegrated =
      skillFiles.some((file) => fs.existsSync(file)) &&
      files.some((file) => file.kind === "skill" && skillFiles.some((file2) => samePath(file2, file.path)));
    const hooks = files.some(
      (file) => (file.kind === "hook" || file.kind === "plugin") && file.tool === detection.tool.id,
    );
    // Trae CN 的 hook 只落事件供适配器重建会话，不注入启动提示；OpenCode 是纯 plugin。
    const startupHint =
      files.some((file) => file.kind === "hook" && file.tool === detection.tool.id) &&
      detection.tool.id !== "trae-cn";
    const liveIndex = hooks;
    // 装了任一形态（Skill / hook / plugin）即算已接入；Skill 还要文件在磁盘上，防止手删后仍显示已接入
    const integrated = skillIntegrated || hooks;
    return {
      id: detection.tool.id,
      name: detection.tool.name,
      installed: detection.installed,
      canBeSource: detection.canBeSource,
      encrypted: detection.tool.encryptedSessions === true,
      sessionFileCount: detection.sessionFileCount,
      skillDirs: detection.skillDirs,
      integrated,
      hooks,
      startupHint,
      liveIndex,
    };
  });
  return { dataDir: memrelayDir(env), version: VERSION, tools };
}

export interface ApplyResult {
  ok: boolean;
  log: string;
}

/**
 * 应用接入勾选：勾选即同意接入；取消勾选 = 不接入，并移除之前装过的文件（哈希一致才删）。
 * 驱动 setup 的非交互模式（--yes + --skip），输出收集成日志返回给界面。
 */
export async function applyIntegrations(
  enabled: Record<string, boolean>,
  runner: (opts: SetupOptions) => Promise<number> = runSetupCommand,
): Promise<ApplyResult> {
  const skip = Object.entries(enabled)
    .filter(([, on]) => on === false)
    .map(([id]) => id);
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
  };
  try {
    const code = await runner({ undo: false, purge: false, yes: true, skip });
    return { ok: code === 0, log: lines.join("\n") };
  } catch (err) {
    lines.push(err instanceof Error ? err.message : String(err));
    return { ok: false, log: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

/** 终端自测：用各终端的启动脚本跑 memrelay ping。 */
export function runIntegrationSelfTest(env: Env): TerminalTest[] {
  return runTerminalSelfTests(path.join(memrelayDir(env), "bin"));
}

/** 「自动接入新工具」开关（默认关；库/表缺失按关处理）。 */
export function autoIntegrateEnabled(db: DatabaseSync): boolean {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'autoIntegrate'").get() as
      | { value?: string | null }
      | undefined;
    return row?.value === "1";
  } catch {
    return false;
  }
}

/**
 * 自动接入提示（设置开启时）：列出「已安装但未接入」的工具（判定与接入页同源）。
 * 只提示、绝不自动写文件——接入动作仍走「接入」页的勾选应用或 `memrelay setup` 的显式确认。
 * 出口在用户命令里（memrelay ui 启动 / doctor），hook 路径不查这个（保持静默与低延迟）。
 */
export function maybeAutoIntegrateHint(db: DatabaseSync, env: Env): string | undefined {
  if (!autoIntegrateEnabled(db)) return undefined;
  const pending = listIntegrations(env).tools.filter((tool) => tool.installed && !tool.integrated);
  if (pending.length === 0) return undefined;
  const names = pending.map((tool) => tool.name).join("、");
  return `检测到已安装但未接入的工具：${names}。到 memrelay ui 的「接入」页勾选应用（或运行 memrelay setup）即可接入；MemRelay 不会自动写任何文件。`;
}
