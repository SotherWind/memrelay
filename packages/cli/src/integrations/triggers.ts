import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Env } from "../core/types.js";
import { codebuddyHome } from "../core/codebuddy-paths.js";
import { memrelayDir } from "../core/env.js";
import { VERSION } from "../core/version.js";
import { dshPluginEntryUrl } from "./dsh-plugin.js";

/**
 * 触发增强（架构 5.7 的 b 层）：按工具逐个启用，需要用户同意，可以撤销。
 * 现在每个工具装三件套——SessionStart 补扫 + 输出提示、Stop / SessionEnd 增量索引，
 * 让 resume 的查库快路径始终看到最新进度。
 * 只追加自己的 hook 条目，不碰用户的其它配置；改前备份 settings.json.memrelay-backup。
 */

export interface EnhanceResult {
  tool: string;
  enabled: boolean;
  already?: boolean;
  detail?: string;
}

function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.memrelay-tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, content, "utf8");
    fs.rmSync(tmp, { force: true });
  }
}

/** hook 命令统一从 memrelayDir 生成，MEMRELAY_HOME 改过位置时也能找到启动脚本。 */
function shLauncherCommand(env: Env, args = "hook"): string {
  const bin = path.join(memrelayDir(env), "bin", "memrelay").replace(/\\/g, "/");
  return `"${bin}" ${args} 2>/dev/null || true`;
}

function psLauncherPath(env: Env): string {
  return path.join(memrelayDir(env), "bin", "memrelay.cmd");
}

export type HookToolId =
  | "claude-code"
  | "qoder"
  | "trae-cn"
  | "codex"
  | "codebuddy"
  | "workbuddy"
  | "zcode"
  | "dsh";

/** 支持"安装 hook 配置"的工具（OpenCode 走插件文件，不在此列）。 */
export const HOOK_TOOL_IDS: HookToolId[] = [
  "claude-code",
  "qoder",
  "codex",
  "codebuddy",
  "workbuddy",
  "zcode",
  "trae-cn",
  "dsh",
];

export const HOOK_EVENTS = ["SessionStart", "Stop", "SessionEnd"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

function timeoutFor(event: string): number {
  return event === "SessionStart" ? 30 : 15;
}

// ---------- Claude Code ----------

export function claudeSettingsPath(env: Env): string {
  return path.join(env.home, ".claude", "settings.json");
}

/**
 * Claude Code 的 hooks 在各平台都经 Git Bash（sh）执行（2026-10-13 实测 2.1.198）：
 * 用 sh 启动脚本 + $HOME 展开；失败时静默退出 0，避免 hook 报错噪音。
 */
export function claudeHookCommand(env: Env): string {
  return shLauncherCommand(env);
}

function claudeEntry(env: Env, event: HookEvent): Record<string, unknown> {
  return {
    hooks: [{ type: "command", command: claudeHookCommand(env), timeout: timeoutFor(event) }],
  };
}

// ---------- Qoder CLI ----------

export function qoderSettingsPath(env: Env): string {
  return path.join(env.home, ".qoder", "settings.json");
}

/**
 * Qoder CLI 的 hooks 事件名和 payload 与 Claude Code 一致（docs.qoder.com/zh/cli/hooks）。
 * Windows 用 args exec 形态直接调启动脚本（不经 shell 解析，绕开变量展开的坑）：
 * cmd.exe /c <launcher.cmd> hook；其它平台直接执行 sh 启动脚本。
 */
export function qoderHookEntry(env: Env, event: HookEvent): Record<string, unknown> {
  const binDir = path.join(memrelayDir(env), "bin");
  const hook =
    env.platform === "win32"
      ? {
          type: "command",
          command: "cmd.exe",
          args: ["/c", path.join(binDir, "memrelay.cmd"), "hook"],
          timeout: timeoutFor(event),
        }
      : {
          type: "command",
          command: path.join(binDir, "memrelay"),
          args: ["hook"],
          timeout: timeoutFor(event),
        };
  return { hooks: [hook] };
}

export function hookSettingsPathFor(toolId: HookToolId, env: Env): string {
  if (toolId === "claude-code") return claudeSettingsPath(env);
  if (toolId === "qoder") return qoderSettingsPath(env);
  if (toolId === "codex") return codexHooksPath(env);
  if (toolId === "codebuddy") return codebuddySettingsPath(env);
  if (toolId === "workbuddy") return workbuddySettingsPath(env);
  if (toolId === "zcode") return zcodeUserConfigPath(env);
  if (toolId === "dsh") return dshHooksPath(env);
  return traeHooksPath(env, "trae-cn");
}

// ---------- Codex ----------

export function codexHooksPath(env: Env): string {
  return path.join(env.home, ".codex", "hooks.json");
}

export function codexConfigPath(env: Env): string {
  return path.join(env.home, ".codex", "config.toml");
}

const CODEX_EVENT_LABEL: Record<HookEvent, string> = {
  SessionStart: "session_start",
  Stop: "stop",
  SessionEnd: "session_end",
};

/** Codex 把 SessionEnd 的超时夹在 1–3 秒；其余事件按配置值。 */
function codexTimeout(event: HookEvent): number {
  return event === "SessionEnd" ? 3 : timeoutFor(event);
}

/**
 * Codex（0.162/0.163 实测）：未带 commandWindows 时 Windows 上经 PowerShell 执行 command；
 * 带上后 Windows 用 commandWindows、其它平台用 command。事件名与 payload 与 Claude Code 一致
 * （Stop 带 transcript_path，可精准索引）。未信任的 hook 不执行——setup 会同时把 trusted_hash
 * 预置进 config.toml 的 hooks.state（与在桌面端点"允许"等价），不需要首次手动审查。
 */
export function codexHookHandler(env: Env, event: HookEvent): Record<string, unknown> {
  const cmd = psLauncherPath(env);
  return {
    type: "command",
    command: shLauncherCommand(env),
    commandWindows:
      `if (Test-Path "${cmd.replace(/"/g, '`"')}") { & "${cmd.replace(/"/g, '`"')}" hook }`,
    async: false,
    timeout: codexTimeout(event),
  };
}

function codexEntry(env: Env, event: HookEvent): Record<string, unknown> {
  return { hooks: [codexHookHandler(env, event)] };
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortJsonKeys(record[key])]),
  );
}

/**
 * Codex 的信任哈希：事件 + 规范化 handler 的 JSON（键排序）的 sha256。
 * 规范化会丢掉 null 字段、Windows 取 commandWindows、SessionEnd 超时夹到 1–3 秒；
 * 必须与 codex-rs/hooks/src/engine/discovery.rs 的 hook_hash 保持一致，否则会显示"已修改"。
 */
function codexTrustedHash(env: Env, event: HookEvent): string {
  const handler = codexHookHandler(env, event);
  const command = env.platform === "win32" ? handler["commandWindows"] : handler["command"];
  const timeout = Number(handler["timeout"]);
  const normalizedTimeout =
    event === "SessionEnd" ? Math.min(Math.max(timeout, 1), 3) : Math.max(timeout, 1);
  const identity = {
    event_name: CODEX_EVENT_LABEL[event],
    hooks: [
      {
        type: "command",
        command,
        timeout: normalizedTimeout,
        async: handler["async"] === true,
      },
    ],
  };
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(sortJsonKeys(identity)), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

/** 我们的条目录了用户自己的 hook 之后时，分组下标不是 0；信任键必须用实际下标。 */
function codexHookIndex(
  env: Env,
  event: HookEvent,
  match: "canonical" | "owned" = "canonical",
): number | undefined {
  const loaded = readSettings(codexHooksPath(env));
  const hooks = loaded?.settings["hooks"] as Record<string, unknown> | undefined;
  const list = hooks?.[event];
  if (!Array.isArray(list)) return undefined;
  const canonical = codexEntry(env, event);
  const index = list.findIndex((entry) =>
    match === "owned" ? isOurEntry(entry) : sameEntry(entry, canonical),
  );
  return index < 0 ? undefined : index;
}

interface CodexTrustState {
  key: string;
  hash: string;
}

const TOML_STATE_HEADER = /^\s*\[\s*hooks\s*\.\s*state\s*\.\s*(.+?)\s*\]\s*(?:#.*)?$/;

function decodeTomlKey(token: string): string | undefined {
  const text = token.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1);
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text
      .slice(1, -1)
      .replace(/\\(["\\tnr])/g, (_match, ch: string) =>
        ch === "t" ? "\t" : ch === "n" ? "\n" : ch === "r" ? "\r" : ch,
      );
  }
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : undefined;
}

function encodeTomlKey(key: string): string {
  if (!key.includes("'") && !/[\r\n]/.test(key)) return `'${key}'`;
  return `"${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tomlSectionEnd(lines: string[], start: number): number {
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) return i;
  }
  return lines.length;
}

function upsertCodexTrust(raw: string, states: CodexTrustState[]): string {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw ? raw.split(/\r?\n/) : [];
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  for (const state of states) {
    let section = -1;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i]!.match(TOML_STATE_HEADER);
      if (match && decodeTomlKey(match[1]!) === state.key) {
        section = i;
        break;
      }
    }
    if (section >= 0) {
      const end = tomlSectionEnd(lines, section);
      let replaced = false;
      for (let i = section + 1; i < end; i++) {
        const match = lines[i]!.match(/^(\s*)trusted_hash\s*=/);
        if (match) {
          lines[i] = `${match[1]}trusted_hash = "${state.hash}"`;
          replaced = true;
          break;
        }
      }
      if (!replaced) lines.splice(section + 1, 0, `trusted_hash = "${state.hash}"`);
    } else {
      if (lines.length > 0 && lines[lines.length - 1]!.trim() !== "") lines.push("");
      lines.push(`[hooks.state.${encodeTomlKey(state.key)}]`, `trusted_hash = "${state.hash}"`);
    }
  }

  return lines.length ? `${lines.join(eol)}${eol}` : raw;
}

function removeCodexTrust(raw: string, keys: Set<string>): string {
  if (!raw || keys.size === 0) return raw;
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(TOML_STATE_HEADER);
    const key = match ? decodeTomlKey(match[1]!) : undefined;
    if (!key || !keys.has(key)) continue;
    lines.splice(i, tomlSectionEnd(lines, i) - i);
    changed = true;
    i -= 1;
  }
  if (!changed) return raw;
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  for (let i = lines.length - 1; i > 0; i--) {
    if (lines[i]!.trim() === "" && lines[i - 1]!.trim() === "") lines.splice(i, 1);
  }
  return lines.length ? `${lines.join(eol)}${eol}` : "";
}

function writeCodexConfig(env: Env, content: string, raw: string): void {
  const file = codexConfigPath(env);
  const backup = `${file}.memrelay-backup`;
  if (raw && !fs.existsSync(backup)) fs.writeFileSync(backup, raw, "utf8");
  writeFileAtomic(file, content);
}

function writeCodexTrust(env: Env): { changed: boolean; detail?: string } {
  const states: CodexTrustState[] = [];
  for (const event of HOOK_EVENTS) {
    const index = codexHookIndex(env, event);
    if (index === undefined) {
      return { changed: false, detail: "未找到刚写入的 hook 条目，未预置信任标记" };
    }
    states.push({
      key: `${codexHooksPath(env)}:${CODEX_EVENT_LABEL[event]}:${index}:0`,
      hash: codexTrustedHash(env, event),
    });
  }
  const file = codexConfigPath(env);
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return { changed: false, detail: "config.toml 无法读取，未预置信任标记" };
    }
  }
  const next = upsertCodexTrust(raw, states);
  if (next === raw) return { changed: false };
  writeCodexConfig(env, next, raw);
  return { changed: true };
}

function removeCodexTrustState(env: Env, keys: Set<string>): boolean {
  if (keys.size === 0) return false;
  const file = codexConfigPath(env);
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const next = removeCodexTrust(raw, keys);
  if (next === raw) return false;
  writeFileAtomic(file, next);
  return true;
}

// ---------- CodeBuddy（CLI 与 IDE 共用 ~/.codebuddy/settings.json） ----------

export function codebuddySettingsPath(env: Env): string {
  return path.join(codebuddyHome(env), "settings.json");
}

/**
 * CodeBuddy CLI 与 WorkBuddy 同引擎（本机 2.156.0 实测）：hooks 读 <configDir>/settings.json，
 * 命令经 Git Bash（sh）执行；payload 与 Claude Code 兼容（transcript_path 分别指向 CLI 的
 * ~/.codebuddy/projects/*.jsonl 或 IDE 会话的 conversations/<id>/index.json）。
 * CodeBuddy IDE 也读同一份用户级设置，所以一次安装同时覆盖 CLI 与 IDE。
 */
export function codebuddyHookCommand(env: Env): string {
  return shLauncherCommand(env);
}

function codebuddyEntry(env: Env, event: HookEvent): Record<string, unknown> {
  return {
    hooks: [{ type: "command", command: codebuddyHookCommand(env), timeout: timeoutFor(event) }],
  };
}

/** 给 CodeBuddy（CLI + IDE）装三件套（幂等）。 */
export function enhanceCodebuddy(env: Env): EnhanceResult {
  return toEnhanceResult(
    "codebuddy",
    installHooks(codebuddySettingsPath(env), HOOK_EVENTS, (e) => codebuddyEntry(env, e as HookEvent)),
  );
}

/** 撤销 CodeBuddy 的 hook。 */
export function disableCodebuddyHook(env: Env): EnhanceResult {
  return toDisableResult("codebuddy", removeHooks(codebuddySettingsPath(env), HOOK_EVENTS));
}

// ---------- WorkBuddy（CodeBuddy 引擎） ----------

export function workbuddySettingsPath(env: Env): string {
  return path.join(env.home, ".workbuddy", "settings.json");
}

/**
 * WorkBuddy 桌面版的 Agent 引擎是 CodeBuddy CLI（本机 2.156.0 实测）：
 * hooks 读 <configDir>/settings.json（GUI 的 configDir 是 ~/.workbuddy）；
 * 命令经 sh（Git Bash）执行，与 Claude Code 同形；payload 字段亦兼容（transcript_path 指向 ~/.workbuddy/projects）。
 */
export function workbuddyHookCommand(env: Env): string {
  return shLauncherCommand(env);
}

function workbuddyEntry(env: Env, event: HookEvent): Record<string, unknown> {
  return {
    hooks: [{ type: "command", command: workbuddyHookCommand(env), timeout: timeoutFor(event) }],
  };
}

// ---------- ZCode（用户级 hooks，进程直启） ----------

/** ZCode 支持的事件（没有 SessionEnd）。 */
export const ZCODE_HOOK_EVENTS = ["SessionStart", "Stop"] as const;
export type ZcodeHookEvent = (typeof ZCODE_HOOK_EVENTS)[number];

export function zcodeUserConfigPath(env: Env): string {
  return path.join(env.home, ".zcode", "cli", "config.json");
}

/**
 * ZCode（0.16.9 桌面端实测）：用户级 hooks 存 `~/.zcode/cli/config.json` 的
 * `hooks.events.*`，桌面端每个会话都会执行（不需要工作区信任）。
 * 注意：`command`（shell 字符串）形态在桌面内核里执行失败（POSIX shell 解析不到），
 * 必须用 `process` 形态（command + args 直启）：Windows 走 cmd.exe /c 启动脚本，
 * 其它平台直启 sh 启动脚本。payload 同时带 snake_case 与 camelCase 两套字段。
 */
export function zcodeHookHandler(env: Env, event: ZcodeHookEvent): Record<string, unknown> {
  const timeoutMs = timeoutFor(event) * 1000;
  if (env.platform === "win32") {
    const cmdExe = `${env.env["SystemRoot"] ?? "C:\\Windows"}\\System32\\cmd.exe`;
    return {
      type: "process",
      command: cmdExe,
      args: ["/c", path.join(memrelayDir(env), "bin", "memrelay.cmd"), "hook", "--flavor", "zcode"],
      enabled: true,
      timeoutMs,
    };
  }
  return {
    type: "process",
    command: path.join(memrelayDir(env), "bin", "memrelay"),
    args: ["hook", "--flavor", "zcode"],
    enabled: true,
    timeoutMs,
  };
}

/** ZCode 配置结构是 hooks.events.<事件>（与 Claude 系的 hooks.<事件> 不同），单独实现合并/移除。 */
function editZcodeHooks(env: Env, mode: "install" | "remove"): HookEdit {
  const file = zcodeUserConfigPath(env);
  const loaded = readSettings(file);
  if (!loaded) {
    return { ok: false, changed: false, detail: "config.json 不是合法 JSON，未改动任何配置" };
  }
  const { settings, raw } = loaded;
  const hooks = (settings["hooks"] ?? {}) as Record<string, unknown>;
  const events = (hooks["events"] ?? {}) as Record<string, unknown>;
  let changed = false;
  for (const event of ZCODE_HOOK_EVENTS) {
    const list = Array.isArray(events[event]) ? [...(events[event] as unknown[])] : [];
    const canonical = { hooks: [zcodeHookHandler(env, event)] };
    if (mode === "install") {
      const stale = list.filter((e) => isOurEntry(e) && !sameEntry(e, canonical));
      const hasCanonical = list.some((e) => sameEntry(e, canonical));
      if (hasCanonical && stale.length === 0) continue;
      const filtered = list.filter((e) => !(isOurEntry(e) && !sameEntry(e, canonical)));
      if (!hasCanonical) filtered.push(canonical);
      events[event] = filtered;
      changed = true;
    } else {
      const kept = list.filter((e) => !isOurEntry(e));
      if (kept.length === list.length) continue;
      changed = true;
      if (kept.length > 0) events[event] = kept;
      else delete events[event];
    }
  }
  if (mode === "install" && hooks["enabled"] !== true) {
    hooks["enabled"] = true;
    changed = true;
  }
  if (!changed) return { ok: true, changed: false };
  if (Object.keys(events).length === 0) {
    delete hooks["events"];
    // 没有任何事件后，只剩我们写入的 enabled 的空壳就整体删掉（用户自己的其它键保留）
    const keys = Object.keys(hooks);
    if (keys.length === 0 || (keys.length === 1 && keys[0] === "enabled")) {
      delete settings["hooks"];
      writeSettings(file, settings, raw);
      return { ok: true, changed: true };
    }
  } else {
    hooks["events"] = events;
  }
  settings["hooks"] = hooks;
  writeSettings(file, settings, raw);
  return { ok: true, changed: true };
}

/** 给 ZCode 装用户级 hooks（幂等）。 */
export function enhanceZCode(env: Env): EnhanceResult {
  return toEnhanceResult("zcode", editZcodeHooks(env, "install"));
}

/** 撤销 ZCode 的 hook：只移除我们的条目，用户其它钩子与配置保留。 */
export function disableZCodeHook(env: Env): EnhanceResult {
  return toDisableResult("zcode", editZcodeHooks(env, "remove"));
}

// ---------- DeepSeek Harness（桌面端：Claude hooks 兼容桥 + 沙箱内执行） ----------

/** dsh 桥支持的事件（没有 SessionEnd）。 */
export const DSH_HOOK_EVENTS = ["SessionStart", "Stop"] as const;
export type DshHookEvent = (typeof DSH_HOOK_EVENTS)[number];

/** 我们自己拥有的桥配置文件（Claude 格式事件表，桥按 configPath 读取）。 */
export function dshHooksPath(env: Env): string {
  return path.join(env.home, ".dsh", "hooks.json");
}

/** home 级 cordis patch：在 bundle / profile patch 之后应用，用来把桥挂进桌面端组合。 */
export function dshPatchPath(env: Env): string {
  return path.join(env.home, ".dsh", "cordis.patch.yml");
}

const DSH_PATCH_MARK_BEGIN = "# >>> memrelay"; // 前缀匹配：整行还带版本号（版本变化让 patch 内容变化，触发 dsh HMR 重载桥插件）
const DSH_PATCH_MARK_END = "# <<< memrelay";

/**
 * DeepSeek Harness 桌面端（2026-10-15 实测）：hooks 由 @deepseek-ai/dsh-hooks-claude-code 桥执行，
 * payload 与 Claude Code 同形，但 transcript_path 恒为空（会话日志是 zstd，hook 读不了）——
 * memrelay 按 session_id + cwd 回推会话文件。
 * Windows 上命令经 pwsh 执行（bash executor 在 win32 被禁用），进程受 ACL 沙箱限制
 * （受限令牌 + 低完整性级别）。实测这种令牌下 cmd.exe 无法初始化（hook/result 里 exit=0xC0000142），
 * 所以绕过 .cmd 启动脚本：直接用 runtime.json 记录的 node 跑打包好的 cli.mjs，失效时退回启动脚本。
 */
export function dshHookCommand(env: Env): string {
  if (env.platform === "win32") {
    const dir = memrelayDir(env).replace(/\\/g, "/").replace(/"/g, '`"');
    return (
      `$c = "${dir}"; ` +
      `$rt = if (Test-Path "$c/runtime.json") { Get-Content "$c/runtime.json" -Raw | ConvertFrom-Json } else { $null }; ` +
      `if ($rt -and (Test-Path $rt.nodeReal) -and (Test-Path $rt.cli)) { & $rt.nodeReal $rt.cli hook --flavor dsh } ` +
      `elseif (Test-Path "$c/bin/memrelay.cmd") { & "$c/bin/memrelay.cmd" hook --flavor dsh }`
    );
  }
  return shLauncherCommand(env, "hook --flavor dsh");
}

function dshEntry(env: Env, event: DshHookEvent): Record<string, unknown> {
  return { hooks: [{ type: "command", command: dshHookCommand(env), timeout: timeoutFor(event) }] };
}

/**
 * 挂载块：configPath 指向我们自己的 hooks.json（绝对路径，正斜杠对 YAML 更友好）。
 * 注意必须用 `insert:` 包裹——patch 解析器把"没有 id 的裸条目"当非插入补丁拒绝
 * （"id is required for non-insert patches"），追加新插件只能走 insert 列表。
 * stderrSummaryMaxChars 是我们加的固定配置：改了 patch 内容才会触发 dsh 的 HMR 重载桥插件，
 * 让 hooks.json 的改动生效（桥只在自己的插件加载时读一次配置文件）。
 *
 * 同一块里还挂实时索引插件（file:// URL 直指本包内的 dsh-plugin 入口）：dsh 的
 * hook 命令经沙箱受限通道执行（Windows 桌面版受限子进程有已知初始化缺陷，且受限
 * 令牌只能写工作区），进程内插件不受这两条限制；桌面端 profile 归 Electron 应用
 * 独占、装不进依赖，patch 挂载是唯一不碰 profile 的官方扩展面。
 */
function dshPatchBlock(env: Env): string {
  const hooksFile = dshHooksPath(env).replace(/\\/g, "/");
  const pluginUrl = dshPluginEntryUrl();
  const yamlDouble = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const lines = [
    `${DSH_PATCH_MARK_BEGIN} v${VERSION}（DeepSeek Harness 接入：hooks 桥 + 实时索引插件；由 memrelay setup 写入，整块删除即卸载）`,
    "- insert:",
    '    - name: "@deepseek-ai/dsh-hooks-claude-code"',
    "      config:",
    `        configPath: "${yamlDouble(hooksFile)}"`,
    "        stderrSummaryMaxChars: 500",
  ];
  if (pluginUrl) {
    lines.push(`    - name: "${yamlDouble(pluginUrl)}"`);
  }
  lines.push(DSH_PATCH_MARK_END);
  return lines.join("\n");
}

/** 摘掉标记块；标记不完整时原样返回（不动用户的文件）。 */
function stripDshPatchBlock(raw: string): { next: string; found: boolean } {
  const start = raw.indexOf(DSH_PATCH_MARK_BEGIN);
  if (start < 0) return { next: raw, found: false };
  const endMark = raw.indexOf(DSH_PATCH_MARK_END, start);
  if (endMark < 0) return { next: raw, found: false };
  const end = raw.indexOf("\n", endMark);
  const next = raw.slice(0, start) + (end >= 0 ? raw.slice(end + 1) : "");
  return { next, found: true };
}

/** 只剩空白/注释的文件会让 dsh 启动失败（空 patch 要用 []），此时直接删掉文件。 */
function hasMeaningfulYaml(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const t = line.trim();
    return t.length > 0 && !t.startsWith("#");
  });
}

function editDshPatch(env: Env, mode: "install" | "remove"): HookEdit {
  const file = dshPatchPath(env);
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    /* 还没有 home patch：从空文件开始 */
  }
  const block = dshPatchBlock(env);
  if (mode === "install") {
    if (raw.includes(DSH_PATCH_MARK_BEGIN) && raw.includes(block)) {
      return { ok: true, changed: false };
    }
    const { next: stripped } = stripDshPatchBlock(raw);
    const base = stripped.trim();
    const next = base ? `${base}\n${block}\n` : `${block}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next, "utf8");
    return { ok: true, changed: true };
  }
  const { next, found } = stripDshPatchBlock(raw);
  if (!found) return { ok: true, changed: false };
  if (!hasMeaningfulYaml(next)) {
    fs.rmSync(file, { force: true });
    return { ok: true, changed: true };
  }
  fs.writeFileSync(file, next, "utf8");
  return { ok: true, changed: true };
}

/**
 * 给 DeepSeek Harness 装接入：写桥配置 hooks.json + 在 home patch 里挂载桥。
 * hooks.json 用与其它工具相同的 {hooks:{事件:[...]}} 结构（桥兼容 settings 文件形态），
 * 复用安装/卸载原语，用户在里面加的其它条目不会被动。
 */
export function enhanceDsh(env: Env): EnhanceResult {
  const hooksEdit = installHooks(dshHooksPath(env), DSH_HOOK_EVENTS, (e) => dshEntry(env, e as DshHookEvent));
  if (!hooksEdit.ok) return { tool: "dsh", enabled: false, detail: hooksEdit.detail };
  const patchEdit = editDshPatch(env, "install");
  if (!patchEdit.ok) return { tool: "dsh", enabled: false, detail: patchEdit.detail };
  return hooksEdit.changed || patchEdit.changed
    ? { tool: "dsh", enabled: true }
    : { tool: "dsh", enabled: true, already: true };
}

/** 撤销 DeepSeek Harness 的接入：移除我们的 hook 条目 + 摘掉挂载块（用户其它内容保留）。 */
export function disableDshHook(env: Env): EnhanceResult {
  const hooksEdit = removeHooks(dshHooksPath(env), DSH_HOOK_EVENTS);
  const patchEdit = editDshPatch(env, "remove");
  const changed = hooksEdit.changed || patchEdit.changed;
  return changed
    ? { tool: "dsh", enabled: false }
    : { tool: "dsh", enabled: false, already: true, detail: "没有找到 memrelay 的 hook 条目" };
}

// ---------- Trae（IDE：CN 与国际版各自的 hooks.json；IDE 会话库加密，靠事件重建会话） ----------

export const TRAE_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"] as const;
export type TraeHookEvent = (typeof TRAE_HOOK_EVENTS)[number];

export function traeHooksPath(env: Env, flavor: "trae" | "trae-cn" = "trae-cn"): string {
  return path.join(env.home, flavor === "trae-cn" ? ".trae-cn" : ".trae", "hooks.json");
}

/**
 * Trae 的 hooks 可能跑在它的沙箱里（Agent 模式默认如此）：沙箱不允许启动
 * `~/.memrelay/bin/memrelay.cmd`，也不允许写 `~/.memrelay`。所以 Windows 上
 * 直接用 PowerShell 把原始 payload 落到 Trae 自己的 hooks_env（沙箱允许写），
 * 由 trae-events 适配器读取并规范化；不要求用户把运行方式切出沙箱。
 */
export function traeHookCommand(env: Env, flavor: "trae" | "trae-cn"): string {
  if (env.platform === "win32") {
    const product = flavor === "trae-cn" ? "Trae CN" : "Trae";
    return [
      "$ErrorActionPreference='SilentlyContinue';",
      "try {",
      "$raw=[Console]::In.ReadToEnd();",
      "if($raw){",
      "$j=$raw|ConvertFrom-Json;",
      "$sid=$j.session_id; if(-not $sid){$sid=$j.sessionId};",
      "if($sid){",
      "$sid=($sid -replace '[^A-Za-z0-9._-]','_');",
      "$base=$env:APPDATA; if(-not $base){$base=Join-Path $env:USERPROFILE 'AppData\\Roaming'};",
      `$dir=Join-Path $base '${product}\\ModularData\\ai-agent\\hooks_env\\memrelay-events';`,
      "New-Item -ItemType Directory -Force -Path $dir|Out-Null;",
      "$line=($raw -replace '\\r?\\n',' '); if($line.Length -gt 200000){$line=$line.Substring(0,200000)};",
      "$line = $line -replace '(?i)sk-[A-Za-z0-9_-]{20,}', 'sk-***';",
      "$line = $line -replace '(?i)(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{30,}', '$1***';",
      "$line = $line -replace '(?i)(AKIA|ASIA)[A-Z0-9]{16}', '$1***';",
      "$line = $line -replace '(?i)(\"(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[^\"]*\"\\s*:\\s*\")[^\"]{6,}', '$1***';",
      "$line = $line -replace '(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----', '[REDACTED PRIVATE KEY]';",
      "$line = $line -replace '(?i)((?:postgres|postgresql|mysql|mongodb|redis|amqp|mssql):\\/\\/[^:\\s\\/@]+:)[^@\\s/]+@', '$1***@';",
      "$line = $line -replace '(?i)(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}', 'sk-***';",
      "$line = $line -replace '\\bAIza[0-9A-Za-z_-]{35}\\b', 'AIza***';",
      "$line = $line -replace '(?i)\\bBasic\\s+[A-Za-z0-9+/=]{16,}', 'Basic ***';",
      "$line = $line -replace '(?i)\\b(https?:\\/\\/[^\\/\\s:@]+):[^@\\s/]+@', '$1:***@';",
      "[IO.File]::AppendAllText((Join-Path $dir ($sid+'.jsonl')), $line+[Environment]::NewLine, [Text.UTF8Encoding]::new($false))",
      "}",
      "}",
      "} catch {}",
      "# .memrelay hook",
    ].join(" ");
  }
  const product = flavor === "trae-cn" ? "Trae CN" : "Trae";
  const js = [
    'let d="";',
    'process.stdin.on("data",c=>d+=c).on("end",()=>{',
    "try{",
    "const j=JSON.parse(d);",
    "const s=j.session_id||j.sessionId;",
    "if(!s)return;",
    'const fs=require("fs"),path=require("path"),os=require("os");',
    'const base=process.env.APPDATA||(process.platform==="darwin"?path.join(process.env.HOME||os.homedir(),"Library","Application Support"):path.join(process.env.XDG_CONFIG_HOME||path.join(process.env.HOME||os.homedir(),".config")));',
    `const dir=path.join(base,"${product}","ModularData","ai-agent","hooks_env","memrelay-events");`,
    "fs.mkdirSync(dir,{recursive:true});",
    'let line=d.replace(/\\s*\\n\\s*/g," ").slice(0,200000);',
    'line=line.replace(/sk-[A-Za-z0-9_-]{20,}/gi,"sk-***");',
    'line=line.replace(/(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{30,}/gi,"$1***");',
    'line=line.replace(/(AKIA|ASIA)[A-Z0-9]{16}/g,"$1***");',
    'line=line.replace(/("(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[^\"]*\"\\s*:\\s*\")[^\"]{6,}/gi,"$1***");',
    'line=line.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,"[REDACTED PRIVATE KEY]");',
    'line=line.replace(/((?:postgres|postgresql|mysql|mongodb|redis|amqp|mssql):\/\/[^:\s/@]+:)[^@\s/]+@/gi,"$1***@");',
    'line=line.replace(/(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/gi,"sk-***");',
    'line=line.replace(/\bAIza[0-9A-Za-z_-]{35}\b/g,"AIza***");',
    'line=line.replace(/\bBasic\s+[A-Za-z0-9+/=]{16,}/gi,"Basic ***");',
    'line=line.replace(/(https?:\/\/[^\/\s:@]+):[^@\s/]+@/gi,"$1:***@");',
    'fs.appendFileSync(path.join(dir,String(s).replace(/[^A-Za-z0-9._-]/g,"_")+".jsonl"),line+"\\n","utf8");',
    "}catch{}",
    "})",
  ].join("");
  return `node -e '${js}' # .memrelay hook`;
}

function traeEntry(env: Env, event: TraeHookEvent, flavor: "trae" | "trae-cn"): Record<string, unknown> {
  return {
    hooks: [{ type: "command", command: traeHookCommand(env, flavor), timeout: timeoutFor(event) }],
  };
}

// ---------- 通用安装 / 撤销 ----------

/** 判断一个 matcher 分组是否是 MemRelay 装的（跨版本：旧的 hint 条目也要能认出来）。 */
function isOurEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const hooks = (entry as Record<string, unknown>)["hooks"];
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h) => {
    if (!h || typeof h !== "object") return false;
    const rec = h as Record<string, unknown>;
    const command = typeof rec["command"] === "string" ? rec["command"] : "";
    const args = Array.isArray(rec["args"]) ? rec["args"].map(String) : [];
    const mentionsMemrelay =
      command.includes(".memrelay") || args.some((a) => a.includes(".memrelay"));
    return mentionsMemrelay && /\b(hint|hook)\b/.test([command, ...args].join(" "));
  });
}

function sameEntry(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface SettingsLoad {
  settings: Record<string, unknown>;
  raw: string;
}

function readSettings(file: string): SettingsLoad | undefined {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    // 只有"文件不存在"才能当空配置；权限/占用等读取失败不能拿空对象覆盖用户配置。
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: {}, raw: "" };
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return { settings: parsed as Record<string, unknown>, raw };
  } catch {
    return undefined;
  }
}

function writeSettings(file: string, settings: Record<string, unknown>, raw: string): void {
  const backup = `${file}.memrelay-backup`;
  if (!fs.existsSync(backup) && raw) {
    fs.writeFileSync(backup, raw, "utf8");
  }
  writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
}

interface HookEdit {
  ok: boolean;
  changed: boolean;
  detail?: string;
}

/** 安装：每个事件里去掉我们的旧版条目、补上标准条目（幂等）。 */
function installHooks(
  file: string,
  events: readonly string[],
  entryFor: (event: string) => Record<string, unknown>,
  rootExtras?: Record<string, unknown>,
): HookEdit {
  const loaded = readSettings(file);
  if (!loaded) {
    return { ok: false, changed: false, detail: "settings.json 无法读取或不是合法 JSON，未改动任何配置" };
  }
  const { settings, raw } = loaded;
  const hooks = (settings["hooks"] ?? {}) as Record<string, unknown>;
  let changed = false;
  for (const event of events) {
    const list = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    const canonical = entryFor(event);
    const stale = list.filter((e) => isOurEntry(e) && !sameEntry(e, canonical));
    const hasCanonical = list.some((e) => sameEntry(e, canonical));
    if (hasCanonical && stale.length === 0) continue;
    const filtered = list.filter((e) => !(isOurEntry(e) && !sameEntry(e, canonical)));
    if (!hasCanonical) filtered.push(canonical);
    hooks[event] = filtered;
    changed = true;
  }
  for (const [key, value] of Object.entries(rootExtras ?? {})) {
    if (settings[key] !== value) {
      settings[key] = value;
      changed = true;
    }
  }
  if (!changed) return { ok: true, changed: false };
  settings["hooks"] = hooks;
  writeSettings(file, settings, raw);
  return { ok: true, changed: true };
}

/** 撤销：每个事件里去掉我们的条目（含旧版），其它条目保持不变。 */
function removeHooks(file: string, events: readonly string[]): HookEdit {
  const loaded = readSettings(file);
  if (!loaded) {
    return { ok: false, changed: false, detail: "settings.json 不合法或不存在，未改动" };
  }
  const { settings, raw } = loaded;
  const hooks = (settings["hooks"] ?? {}) as Record<string, unknown>;
  let changed = false;
  for (const event of events) {
    if (!Array.isArray(hooks[event])) continue;
    const list = hooks[event] as unknown[];
    const kept = list.filter((e) => !isOurEntry(e));
    if (kept.length === list.length) continue;
    changed = true;
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!changed) {
    return { ok: true, changed: false, detail: "没有找到 memrelay 的 hook 条目" };
  }
  if (Object.keys(hooks).length === 0) delete settings["hooks"];
  else settings["hooks"] = hooks;
  writeSettings(file, settings, raw);
  return { ok: true, changed: true };
}

function toEnhanceResult(tool: string, edit: HookEdit): EnhanceResult {
  if (!edit.ok) return { tool, enabled: false, detail: edit.detail };
  return edit.changed
    ? { tool, enabled: true }
    : { tool, enabled: true, already: true, detail: edit.detail };
}

function toDisableResult(tool: string, edit: HookEdit): EnhanceResult {
  if (!edit.ok) return { tool, enabled: false, detail: edit.detail };
  return edit.changed
    ? { tool, enabled: false }
    : { tool, enabled: true, already: true, detail: edit.detail };
}

/** 给 Claude Code 装三件套（幂等）。 */
export function enhanceClaudeCode(env: Env): EnhanceResult {
  return toEnhanceResult(
    "claude-code",
    installHooks(claudeSettingsPath(env), HOOK_EVENTS, (e) => claudeEntry(env, e as HookEvent)),
  );
}

/** 撤销 Claude Code 的 hook：只移除我们的条目，其它条目保持不变。 */
export function disableClaudeCodeHook(env: Env): EnhanceResult {
  return toDisableResult("claude-code", removeHooks(claudeSettingsPath(env), HOOK_EVENTS));
}

/** 给 Qoder CLI 装三件套（幂等）。 */
export function enhanceQoder(env: Env): EnhanceResult {
  return toEnhanceResult(
    "qoder",
    installHooks(qoderSettingsPath(env), HOOK_EVENTS, (e) => qoderHookEntry(env, e as HookEvent)),
  );
}

/** 撤销 Qoder CLI 的 hook。 */
export function disableQoderHook(env: Env): EnhanceResult {
  return toDisableResult("qoder", removeHooks(qoderSettingsPath(env), HOOK_EVENTS));
}

/** 给 Trae 装事件采集（CN 为主；国际版目录存在时装第二份）。 */
export function enhanceTrae(env: Env): EnhanceResult {
  const edits: HookEdit[] = [
    installHooks(
      traeHooksPath(env, "trae-cn"),
      TRAE_HOOK_EVENTS,
      (e) => traeEntry(env, e as TraeHookEvent, "trae-cn"),
      { version: 1 },
    ),
  ];
  if (fs.existsSync(path.join(env.home, ".trae"))) {
    edits.push(
      installHooks(
        traeHooksPath(env, "trae"),
        TRAE_HOOK_EVENTS,
        (e) => traeEntry(env, e as TraeHookEvent, "trae"),
        { version: 1 },
      ),
    );
  }
  const failed = edits.find((edit) => !edit.ok);
  if (failed) return { tool: "trae-cn", enabled: false, detail: failed.detail };
  const enableNote = "首次需在 Trae IDE 设置 > Hooks 打开「已配置的 Hooks」；Agent 模式共享这个开关";
  return edits.some((edit) => edit.changed)
    ? { tool: "trae-cn", enabled: true, detail: enableNote }
    : { tool: "trae-cn", enabled: true, already: true, detail: enableNote };
}

/** 撤销 Trae 的事件采集（含国际版 hooks.json，若有）。 */
export function disableTraeHook(env: Env): EnhanceResult {
  const union = [...TRAE_HOOK_EVENTS, ...HOOK_EVENTS];
  const edits: HookEdit[] = [removeHooks(traeHooksPath(env, "trae-cn"), union)];
  if (fs.existsSync(path.join(env.home, ".trae"))) {
    edits.push(removeHooks(traeHooksPath(env, "trae"), union));
  }
  const changed = edits.some((edit) => edit.changed);
  const ok = edits.every((edit) => edit.ok || !fs.existsSync(traeHooksPath(env, "trae-cn")));
  return changed
    ? { tool: "trae-cn", enabled: false }
    : { tool: "trae-cn", enabled: false, already: true, detail: ok ? "没有找到 memrelay 的 hook 条目" : undefined };
}

/** 给 Codex 装三件套并预置信任（幂等）。 */
export function enhanceCodex(env: Env): EnhanceResult {
  const edit = installHooks(codexHooksPath(env), HOOK_EVENTS, (e) =>
    codexEntry(env, e as HookEvent),
  );
  if (!edit.ok) return { tool: "codex", enabled: false, detail: edit.detail };
  let trust: { changed: boolean; detail?: string };
  try {
    trust = writeCodexTrust(env);
  } catch (err) {
    trust = {
      changed: false,
      detail: `信任标记写入失败（${err instanceof Error ? err.message : err}），Codex 首次仍会要求审查`,
    };
  }
  if (!edit.changed && !trust.changed && !trust.detail) {
    return { tool: "codex", enabled: true, already: true };
  }
  return { tool: "codex", enabled: true, detail: trust.detail };
}

/** 撤销 Codex 的 hook 与预置的信任标记。 */
export function disableCodexHook(env: Env): EnhanceResult {
  const keys = new Set<string>();
  for (const event of HOOK_EVENTS) {
    const index = codexHookIndex(env, event, "owned");
    if (index !== undefined) {
      keys.add(`${codexHooksPath(env)}:${CODEX_EVENT_LABEL[event]}:${index}:0`);
    }
  }
  const edit = removeHooks(codexHooksPath(env), HOOK_EVENTS);
  if (!edit.ok) return toDisableResult("codex", edit);
  const trustRemoved = removeCodexTrustState(env, keys);
  const changed = edit.changed || trustRemoved;
  return changed
    ? { tool: "codex", enabled: false }
    : {
        tool: "codex",
        enabled: false,
        already: true,
        detail: edit.detail ?? "没有找到 memrelay 的 hook 条目",
      };
}

/** 给 WorkBuddy 装三件套（幂等）。 */
export function enhanceWorkbuddy(env: Env): EnhanceResult {
  return toEnhanceResult(
    "workbuddy",
    installHooks(workbuddySettingsPath(env), HOOK_EVENTS, (e) => workbuddyEntry(env, e as HookEvent)),
  );
}

/** 撤销 WorkBuddy 的 hook。 */
export function disableWorkbuddyHook(env: Env): EnhanceResult {
  return toDisableResult("workbuddy", removeHooks(workbuddySettingsPath(env), HOOK_EVENTS));
}

export function enhanceToolHooks(env: Env, toolId: HookToolId): EnhanceResult {
  if (toolId === "claude-code") return enhanceClaudeCode(env);
  if (toolId === "qoder") return enhanceQoder(env);
  if (toolId === "codex") return enhanceCodex(env);
  if (toolId === "codebuddy") return enhanceCodebuddy(env);
  if (toolId === "workbuddy") return enhanceWorkbuddy(env);
  if (toolId === "zcode") return enhanceZCode(env);
  if (toolId === "dsh") return enhanceDsh(env);
  return enhanceTrae(env);
}

export function disableToolHooks(env: Env, toolId: HookToolId): EnhanceResult {
  if (toolId === "claude-code") return disableClaudeCodeHook(env);
  if (toolId === "qoder") return disableQoderHook(env);
  if (toolId === "codex") return disableCodexHook(env);
  if (toolId === "codebuddy") return disableCodebuddyHook(env);
  if (toolId === "workbuddy") return disableWorkbuddyHook(env);
  if (toolId === "zcode") return disableZCodeHook(env);
  if (toolId === "dsh") return disableDshHook(env);
  return disableTraeHook(env);
}
