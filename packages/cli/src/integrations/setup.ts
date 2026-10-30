import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { VERSION } from "../core/version.js";
import { currentEnv, memrelayDir } from "../core/env.js";
import type { Env } from "../core/types.js";
import { TOOL_REGISTRY } from "../core/tool-registry.js";
import { runChecklist, type CheckItem } from "./checklist.js";
import { detectTools, resolvePhysicalDir } from "./inspect.js";
import {
  claudeSettingsPath,
  codebuddySettingsPath,
  codexHooksPath,
  disableToolHooks,
  dshPatchPath,
  enhanceToolHooks,
  HOOK_TOOL_IDS,
  hookSettingsPathFor,
  qoderSettingsPath,
  traeHooksPath,
  workbuddySettingsPath,
  zcodeUserConfigPath,
  type EnhanceResult,
  type HookToolId,
} from "./triggers.js";
import { opencodePluginPath, renderOpencodePlugin } from "./opencode-plugin.js";
import { renderSkill } from "./skill-template.js";
import { renderCmd, renderSh } from "./scripts.js";
import { runTerminalSelfTests, type TerminalTest } from "./selftest.js";

export interface SetupOptions {
  undo: boolean;
  purge: boolean;
  yes: boolean;
  /** 显式请求启用触发增强的工具 id（一般不用加：需要它的工具默认就会包含） */
  enhance?: string[];
  /** 跳过所有触发增强（启动提示） */
  noEnhance?: boolean;
  /** 非交互场景跳过指定工具的接入（交互场景用勾选列表代替） */
  skip?: string[];
}

interface ManifestFile {
  path: string;
  hash: string;
  kind: "skill" | "launcher" | "runtime" | "hook" | "plugin";
  /** hook / plugin 类条目记录它属于哪个工具（旧清单没有这个字段，按设置文件路径归属） */
  tool?: string;
}

export interface Manifest {
  version: string;
  writtenAt: string;
  files: ManifestFile[];
}

export const sha256 = (text: string): string =>
  crypto.createHash("sha256").update(text, "utf8").digest("hex");

function manifestPath(env: Env): string {
  return path.join(memrelayDir(env), "integrations.json");
}

export function readManifest(env: Env): Manifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(env), "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

export function writeFileTracked(
  target: string,
  content: string,
  kind: ManifestFile["kind"],
): ManifestFile {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return { path: target, hash: sha256(content), kind };
}

export function resolveCliPath(): string {
  const override = process.env["MEMRELAY_CLI_PATH"];
  if (override) return override;
  const current = process.argv[1] ?? "";
  if (/cli\.(mjs|js|ts)$/.test(current) && path.basename(current).startsWith("cli")) {
    return path.resolve(current);
  }
  return path.resolve("dist/cli.mjs");
}

function inTemporaryRun(): boolean {
  const exec = (process.env["npm_execpath"] ?? "") + process.execPath;
  const argv1 = process.argv[1] ?? "";
  return (
    /_npx|_cacache|pnpm\/dlx/.test(argv1) ||
    /_npx|_cacache/.test(exec) ||
    (process.env["npm_lifecycle_event"] === "npx" && path.basename(argv1).includes("npx"))
  );
}

function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function commandForms(env: Env): { bashCmd: string; powershellCmd: string; cmdCmd: string } {
  const binSh = toPosixPath(path.join(memrelayDir(env), "bin", "memrelay"));
  const binCmd = path.join(memrelayDir(env), "bin", "memrelay.cmd");
  return {
    bashCmd: `'${binSh}'`,
    powershellCmd: `& "${binCmd}"`,
    cmdCmd: `"${binCmd}"`,
  };
}

export function skillContent(env: Env, version = VERSION): string {
  return renderSkill({ version, ...commandForms(env) });
}

export function nodeCandidates(): string[] {
  // 真实路径优先：nvm 等版本管理器的"当前版本"路径会随切换指向别的 Node（可能过旧）。
  // 启动脚本对每个候选做版本闸门，过旧的跳过；真实路径没了再回退到原路径。
  const out: string[] = [];
  try {
    out.push(fs.realpathSync(process.execPath));
  } catch {
    /* keep the original below */
  }
  if (!out.includes(process.execPath)) out.push(process.execPath);
  return out;
}

function writeRuntime(env: Env, skillContent?: string): ManifestFile {
  const cli = resolveCliPath();
  const runtime = {
    version: VERSION,
    node: process.execPath,
    nodeReal: (() => {
      try {
        return fs.realpathSync(process.execPath);
      } catch {
        return process.execPath;
      }
    })(),
    nodeVersion: process.version,
    cli,
    ...(skillContent !== undefined ? { skillHash: sha256(skillContent) } : {}),
    updatedAt: new Date().toISOString(),
  };
  return writeFileTracked(
    path.join(memrelayDir(env), "runtime.json"),
    `${JSON.stringify(runtime, null, 2)}\n`,
    "runtime",
  );
}

function preflightWarnings(env: Env): string[] {
  const warnings: string[] = [];
  if (inTemporaryRun()) {
    warnings.push(
      "检测到正在通过 npx / pnpm dlx 临时运行。为避免写入指向临时目录的脚本，请先全局安装：npm i -g memrelay，再运行 memrelay setup。",
    );
  }
  const home = env.home;
  if ([...home].some((ch) => ch.charCodeAt(0) > 127)) {
    warnings.push(`主目录包含非 ASCII 字符（${home}）——路径已尽量用环境变量表示，仍请留意终端编码。`);
  }
  return warnings;
}

export interface SkillTarget {
  toolId: string;
  toolName: string;
  dir: string;
  file: string;
}

function listSkillTargets(env: Env, includeAll = false): SkillTarget[] {
  const out: SkillTarget[] = [];
  const seen = new Set<string>();
  for (const detection of detectTools(env)) {
    if (!detection.installed && !includeAll) continue;
    for (const dir of detection.skillDirs) {
      const physical = resolvePhysicalDir(dir);
      if (seen.has(physical)) continue;
      seen.add(physical);
      out.push({
        toolId: detection.tool.id,
        toolName: detection.tool.name,
        dir,
        file: path.join(dir, "memrelay", "SKILL.md"),
      });
    }
  }
  return out;
}

/** 供自动更新使用：当前所有可写入的 Skill 目标。 */
export function allSkillTargets(env: Env): SkillTarget[] {
  return listSkillTargets(env, true);
}

/** 触发增强能力的显示名（用于勾选清单与计划输出）。 */
const ENHANCE_LABELS: Record<string, string> = {
  "claude-code": "启动提示 + 实时索引",
  qoder: "启动提示 + 实时索引",
  codex: "启动提示 + 实时索引",
  codebuddy: "启动提示 + 实时索引",
  workbuddy: "启动提示 + 实时索引",
  zcode: "启动提示 + 实时索引",
  dsh: "启动提示 + 实时索引",
  "trae-cn": "事件采集",
  opencode: "实时索引插件",
};

/** 各家装的事件名（计划输出用；ZCode 没有 SessionEnd）。 */
const HOOK_EVENT_NAMES: Record<string, string> = {
  "claude-code": "SessionStart / Stop / SessionEnd",
  qoder: "SessionStart / Stop / SessionEnd",
  codex: "SessionStart / Stop / SessionEnd",
  codebuddy: "SessionStart / Stop / SessionEnd",
  workbuddy: "SessionStart / Stop / SessionEnd",
  zcode: "SessionStart / Stop",
  dsh: "SessionStart / Stop",
};

/** 本机检测到的、可启用触发增强的工具（不扣除 skip，由调用方决定）。 */
function enhanceCandidates(env: Env): string[] {
  const out: string[] = [];
  for (const detection of detectTools(env)) {
    if (detection.installed && ENHANCE_LABELS[detection.tool.id]) out.push(detection.tool.id);
  }
  return out;
}

/**
 * 交互模式：把检测到的工具列成勾选清单（默认全选，取消勾选=不接入）。
 * 勾选即代表同意——不再二次确认。用户取消（Ctrl+C）时返回 undefined。
 */
async function chooseToolsChecklist(
  env: Env,
  presetSkip: Set<string>,
  hookWillApply: boolean,
): Promise<Set<string> | undefined> {
  const grouped = new Map<string, SkillTarget>();
  for (const t of listSkillTargets(env)) {
    if (!grouped.has(t.toolId)) grouped.set(t.toolId, t);
  }
  const items: CheckItem[] = [...grouped.values()].map((t) => {
    const extra = hookWillApply ? ENHANCE_LABELS[t.toolId] : undefined;
    return {
      id: t.toolId,
      label: extra ? `${t.toolName}（Skill + ${extra}）` : `${t.toolName}（Skill）`,
      checked: !presetSkip.has(t.toolId),
    };
  });
  // 只有触发增强、没有 Skill 目录的工具（如 OpenCode）也列出来，让用户能取消勾选
  if (hookWillApply) {
    for (const id of enhanceCandidates(env)) {
      if (grouped.has(id)) continue;
      items.push({ id, label: `${displayNameOf(id)}（${ENHANCE_LABELS[id]}）`, checked: !presetSkip.has(id) });
    }
  }
  if (items.length === 0) return new Set();
  const chosen = await runChecklist(items);
  if (!chosen) return undefined;
  const selected = new Set(chosen.filter((c) => c.checked).map((c) => c.id));
  return new Set(items.filter((i) => !selected.has(i.id)).map((i) => i.id));
}

/**
 * 决定这次 setup 要启用哪些"启动提示 + 实时索引"（b 层触发增强）。
 * 默认包含"需要它才能正常续接"的工具：Claude Code 的技能清单不显示描述（2026-10 实测），
 * 纯 Skill 无法可靠自动触发，不装基本用不起来；Qoder CLI 的事件与 payload 兼容，
 * 一并装上实时索引。--no-enhance 可整体跳过。
 */
function resolveEnhanceTargets(env: Env, opts: SetupOptions, skipped: Set<string>): string[] {
  if (opts.noEnhance) return [];
  const targets = new Set(opts.enhance ?? []);
  for (const id of enhanceCandidates(env)) targets.add(id);
  for (const id of skipped) targets.delete(id);
  return [...targets];
}

function printPlan(
  env: Env,
  undo: boolean,
  skillTargets: SkillTarget[],
  enhanceTargets: string[],
  skipped: string[],
): void {
  const dir = memrelayDir(env);
  console.log(`MemRelay ${VERSION} · 数据目录 ${dir}`);
  console.log("");
  if (undo) {
    const manifest = readManifest(env);
    if (!manifest || manifest.files.length === 0) {
      console.log("没有找到接入记录（integrations.json）。");
      return;
    }
    console.log("将删除以下文件（被用户改过的不动）：");
    for (const f of manifest.files) {
      if (f.kind === "hook") console.log(`  - ${f.path} 里的 MemRelay 启动提示条目`);
      else console.log(`  - ${f.path}`);
    }
    return;
  }
  console.log("将写入以下文件：");
  console.log(`  - ${path.join(dir, "bin", "memrelay")}`);
  console.log(`  - ${path.join(dir, "bin", "memrelay.cmd")}`);
  console.log(`  - ${path.join(dir, "runtime.json")}`);
  console.log(`  - ${path.join(dir, "integrations.json")}`);
  for (const target of skillTargets) {
    console.log(`  - ${target.file}   （${target.toolName}）`);
  }
  for (const tool of enhanceTargets) {
    if (tool === "opencode") {
      console.log(
        `将追加实时索引插件（OpenCode）：写入 ${opencodePluginPath(env)}；每次回合结束自动更新索引`,
      );
      console.log("            删除该文件即可撤销；memrelay setup --undo 可撤销，--no-enhance 可跳过");
    } else if (tool === "trae-cn") {
      const file = hookSettingsPathFor("trae-cn", env);
      console.log(
        `将让 Trae CN 自动同步对话进度：写入 ${file}，之后 Trae 里聊过的任务会自动出现在 MemRelay 任务列表`,
      );
      console.log(
        "            安装后需要你在 Trae 的「设置 → Hooks」里打开一次「已配置的 Hooks」；Agent 模式没有这个设置页，但会和 IDE 共用这个开关。不需要调整 Trae 的沙箱或命令运行方式",
      );
      console.log(
        "            改动前先备份为 hooks.json.memrelay-backup；memrelay setup --undo 可撤销，--no-enhance 可跳过",
      );
    } else if ((HOOK_TOOL_IDS as string[]).includes(tool)) {
      const file = hookSettingsPathFor(tool as HookToolId, env);
      const events = HOOK_EVENT_NAMES[tool] ?? "SessionStart / Stop / SessionEnd";
      console.log(
        `将追加启动提示 + 实时索引（${displayNameOf(tool)}）：在 ${file} 增加 ${events} hook，启动时提示未完成任务，干活时自动更新索引`,
      );
      if (tool === "codex") {
        console.log(
          "            说明：同时把三条 hook 的 trusted_hash 预置到 ~/.codex/config.toml 的 hooks.state，Codex 不会再弹出「审查钩子」要求手动放行",
        );
      }
      if (tool === "codebuddy") {
        console.log(
          "            说明：CLI 与 IDE 共用这份用户级设置，一次安装两边都生效（IDE 侧同时读取 CLI 与 IDE 的会话）",
        );
      }
      if (tool === "dsh") {
        console.log(
          "            说明：hooks 桥与实时索引插件（进程内执行，不经它沙箱的 hook 通道）都挂在 home 级 cordis patch 的同一块里（独立文件，可整块撤销）；进程启动时加载，重启 DeepSeek Harness 后生效",
        );
      }
      console.log(
        `            改动前先备份为 ${path.basename(file)}.memrelay-backup；memrelay setup --undo 可撤销，--no-enhance 可跳过`,
      );
    } else {
      console.log(`将追加启动提示（${tool}）：暂不支持该工具，会跳过`);
    }
  }
  if (skipped.length > 0) {
    console.log("");
    console.log(
      `跳过：${skipped.map((id) => displayNameOf(id)).join("、")}（之前装过会同时移除；之后想接入再运行 memrelay setup）`,
    );
  }
  console.log("");
  console.log("除此之外不会修改任何文件；其他工具的会话、权限和配置始终只读。");
}

function displayNameOf(toolId: string): string {
  return TOOL_REGISTRY.find((t) => t.id === toolId)?.name ?? toolId;
}

/** hook 条目的工具归属：优先清单里的 tool 字段，旧版清单按设置文件路径识别。 */
function hookToolIdOf(file: ManifestFile, env: Env): HookToolId | undefined {
  if (file.tool && (HOOK_TOOL_IDS as string[]).includes(file.tool)) return file.tool as HookToolId;
  const norm = (p: string): string => p.replace(/[\\/]+/g, "/").toLowerCase();
  const byPath: Array<[HookToolId, string]> = [
    ["claude-code", claudeSettingsPath(env)],
    ["qoder", qoderSettingsPath(env)],
    ["codex", codexHooksPath(env)],
    ["codebuddy", codebuddySettingsPath(env)],
    ["workbuddy", workbuddySettingsPath(env)],
    ["zcode", zcodeUserConfigPath(env)],
    ["trae-cn", traeHooksPath(env)],
  ];
  for (const [id, settings] of byPath) {
    if (norm(file.path) === norm(settings)) return id;
  }
  return undefined;
}

/** 判断清单里的文件属于哪个工具（skill 按目录归属；hook / plugin 按工具记录或路径归属）。 */
function entryBelongsToTool(file: ManifestFile, toolId: string, env: Env): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").toLowerCase();
  if (file.kind === "hook") {
    if (file.tool) return file.tool === toolId;
    return hookToolIdOf(file, env) === toolId;
  }
  if (file.kind === "plugin") {
    return file.tool === toolId;
  }
  if (file.kind !== "skill") return false;
  const tool = TOOL_REGISTRY.find((t) => t.id === toolId);
  if (!tool) return false;
  return tool.skillDirs.some((rel) =>
    norm(file.path).startsWith(norm(path.join(env.home, ...rel.split("/"))) + "/"),
  );
}

/**
 * 执行"取消接入"：把之前装过、这次被跳过的工具的文件清掉。
 * 哈希一致才删；用户改过的保留并提示。返回被移除的路径集合。
 */
function removeToolArtifacts(
  env: Env,
  toolIds: Set<string>,
  oldManifest: Manifest,
): { removedPaths: Set<string>; notes: string[] } {
  const removedPaths = new Set<string>();
  const notes: string[] = [];
  const removedCount = new Map<string, number>();
  for (const file of oldManifest.files) {
    const toolId = [...toolIds].find((id) => entryBelongsToTool(file, id, env));
    if (!toolId) continue;
    if (file.kind === "hook") {
      const hookTool = hookToolIdOf(file, env);
      if (hookTool) {
        disableToolHooks(env, hookTool);
        removedPaths.add(file.path);
        notes.push(
          hookTool === "trae-cn"
            ? `已移除 ${displayNameOf(hookTool)} 的事件采集 hook 条目`
            : `已移除 ${displayNameOf(hookTool)} 的启动提示 / 实时索引 hook 条目`,
        );
      }
      continue;
    }
    let current: string | undefined;
    try {
      current = fs.readFileSync(file.path, "utf8");
    } catch {
      removedPaths.add(file.path);
      continue; // 文件已不在，记录也清掉
    }
    if (sha256(current) !== file.hash) {
      notes.push(`保留（已被修改过）：${file.path}`);
      continue;
    }
    try {
      fs.rmSync(file.path, { force: true });
      removedPaths.add(file.path);
      removedCount.set(toolId, (removedCount.get(toolId) ?? 0) + 1);
    } catch {
      /* ignore */
    }
  }
  for (const [toolId, count] of removedCount) {
    notes.push(`已移除 ${displayNameOf(toolId)} 的接入文件（${count} 个）`);
  }
  return { removedPaths, notes };
}

async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.log(`${question} 非交互环境：请加 --yes 跳过确认。`);
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function runSetupCommand(opts: SetupOptions): Promise<number> {
  const env = currentEnv();
  if (opts.undo) return await runUndo(env, opts);

  const presetSkip = new Set(opts.skip ?? []);
  const allSkillTargets = listSkillTargets(env);
  const detectedToolIds = [...new Set(allSkillTargets.map((t) => t.toolId))];

  // 交互场景：勾选列表（默认全选，取消勾选=不接入；勾选即代表同意，不再二次确认）
  let skipped: Set<string>;
  let consented = false;
  const interactive = !opts.yes && process.stdin.isTTY && detectedToolIds.length > 0;
  if (interactive) {
    const result = await chooseToolsChecklist(env, presetSkip, !opts.noEnhance);
    if (!result) {
      console.log("");
      console.log("已取消，没有写入任何文件。");
      return 0;
    }
    skipped = result;
    consented = true;
    console.log("");
  } else {
    skipped = new Set(presetSkip);
  }

  const skillTargets = allSkillTargets.filter((t) => !skipped.has(t.toolId));
  const enhanceTargets = resolveEnhanceTargets(env, opts, skipped);
  printPlan(env, false, skillTargets, enhanceTargets, [...skipped]);
  for (const warning of preflightWarnings(env)) {
    console.log(`注意：${warning}`);
  }
  console.log("");
  if (!consented && !(await confirm("继续？", opts.yes))) {
    console.log("已取消，没有写入任何文件。");
    return 0;
  }

  const written: ManifestFile[] = [];

  // 取消接入：把之前装过、这次被跳过（取消勾选 / --skip）的工具的文件清掉；
  // --no-enhance 同样视为"不要启动提示和实时索引"，把已装的 hook 撤掉。
  const oldManifest = readManifest(env) ?? { version: VERSION, writtenAt: "", files: [] };
  const removalTools = new Set(skipped);
  const removalNotes: string[] = [];
  const removal = removeToolArtifacts(env, removalTools, oldManifest);
  removalNotes.push(...removal.notes);
  if (opts.noEnhance) {
    const hookRemoval = removeToolArtifacts(
      env,
      new Set([...HOOK_TOOL_IDS, "opencode"].filter((t) => !skipped.has(t))),
      { ...oldManifest, files: oldManifest.files.filter((f) => f.kind === "hook" || f.kind === "plugin") },
    );
    for (const p of hookRemoval.removedPaths) removal.removedPaths.add(p);
    removalNotes.push(...hookRemoval.notes);
  }

  const skill = skillContent(env);
  written.push(writeRuntime(env, skill));

  const binDir = path.join(memrelayDir(env), "bin");
  const scriptInput = {
    nodeCandidates: nodeCandidates(),
    cliPath: resolveCliPath(),
    home: env.home,
    appData: env.env["APPDATA"],
    localAppData: env.env["LOCALAPPDATA"],
  };
  written.push(writeFileTracked(path.join(binDir, "memrelay"), renderSh(scriptInput), "launcher"));
  if (process.platform === "win32") {
    try {
      fs.chmodSync(path.join(binDir, "memrelay"), 0o755);
    } catch {
      /* Windows 上不可执行位无关紧要 */
    }
  }
  written.push(
    writeFileTracked(path.join(binDir, "memrelay.cmd"), renderCmd(scriptInput), "launcher"),
  );

  for (const target of skillTargets) {
    written.push(writeFileTracked(target.file, skill, "skill"));
  }

  // 触发增强（b 层）：默认包含需要它的工具（见 resolveEnhanceTargets）；记入清单以便 --undo 撤销
  const enhanceResults: EnhanceResult[] = [];
  for (const tool of enhanceTargets) {
    if (tool === "opencode") {
      const content = renderOpencodePlugin(env);
      let already = false;
      try {
        already = fs.readFileSync(opencodePluginPath(env), "utf8") === content;
      } catch {
        /* 还没有装过 */
      }
      written.push({ ...writeFileTracked(opencodePluginPath(env), content, "plugin"), tool });
      enhanceResults.push(already ? { tool, enabled: true, already: true } : { tool, enabled: true });
    } else if ((HOOK_TOOL_IDS as string[]).includes(tool)) {
      const result = enhanceToolHooks(env, tool as HookToolId);
      enhanceResults.push(result);
      if (result.enabled) {
        written.push({
          path: hookSettingsPathFor(tool as HookToolId, env),
          hash: "",
          kind: "hook",
          tool,
        });
        if (tool === "dsh") {
          // dsh 的接入同时改两份文件：hooks.json（桥配置）+ home 级 cordis patch（挂载桥）
          written.push({ path: dshPatchPath(env), hash: "", kind: "hook", tool });
        }
      }
    } else {
      enhanceResults.push({ tool, enabled: false, detail: "暂不支持该工具的触发增强" });
    }
  }

  // 清单合并：本次写入 + 保留的历史记录（跳过/已移除的不再保留）
  const writtenPaths = new Set(written.map((f) => f.path));
  const keptOld = oldManifest.files.filter(
    (f) => !writtenPaths.has(f.path) && !removal.removedPaths.has(f.path) && f.kind !== "runtime",
  );
  const manifest: Manifest = {
    version: VERSION,
    writtenAt: new Date().toISOString(),
    files: [...written, ...keptOld],
  };
  writeFileTracked(manifestPath(env), `${JSON.stringify(manifest, null, 2)}\n`, "runtime");

  console.log("");
  console.log(
    `已写入 ${written.filter((f) => f.kind !== "hook").length} 个文件（Skill：${skillTargets.length} 个工具目录）。`,
  );
  for (const note of removalNotes) console.log(note);
  if (skillTargets.length === 0) {
    console.log("没有检测到可作为接手工具的 Skill 目录——之后安装了再运行一次 memrelay setup 即可。");
  }
  for (const r of enhanceResults) {
    const name = displayNameOf(r.tool);
    if (!r.enabled) {
      console.log(`触发增强（${name}）：未启用${r.detail ? `（${r.detail}）` : ""}`);
    } else if (r.already) {
      console.log(`触发增强（${name}）：已是启用状态${r.detail ? `（${r.detail}）` : ""}`);
    } else {
      const note = r.detail ? `（${r.detail}）` : "";
      console.log(
        `触发增强（${name}）：已启用${note}——启动时提示未完成任务，干活时自动更新索引（配置已备份为 .memrelay-backup，setup --undo 可撤销）`,
      );
    }
  }

  if (enhanceResults.some((r) => r.tool === "trae-cn" && r.enabled)) {
    console.log("");
    console.log("[Trae CN 还需要一次手动确认]");
    console.log("  打开 Trae IDE → 设置 → Hooks → 已配置的 Hooks，把开关打开。");
    console.log("  Agent 模式设置页没有 Hooks 入口，但共享这个开关；开启一次后 IDE / Agent 都会执行。");
    console.log("  这是 Trae 的安全确认，setup 不能代替你点击；hook 本身已经装好并做了沙箱适配。");
  }

  console.log("");
  console.log("终端自测：");
  const tests: TerminalTest[] = runTerminalSelfTests(binDir);
  for (const test of tests) {
    const mark = test.passed === true ? "✓" : test.passed === false ? "✗" : "–";
    const detail = test.passed === false ? `（${test.detail}）` : test.passed === null ? "" : "";
    console.log(`  ${mark} ${test.terminal}${detail}`);
  }
  const failed = tests.filter((t) => t.passed === false);
  const skippedTerminals = tests.filter((t) => t.passed === null).map((t) => t.terminal);
  if (skippedTerminals.length > 0) console.log(`  （未检测到：${skippedTerminals.join("、")}，已跳过）`);

  console.log("");
  console.log("正在建立会话索引……");
  try {
    const { buildIndex } = await import("../store/indexer.js");
    const { allAdapters } = await import("../adapters/all.js");
    const stats = await buildIndex(env, {
      adapters: allAdapters(),
    });
    const totals = Object.entries(stats.byAgent)
      .filter(([, a]) => a.sessions > 0)
      .map(([id, a]) => `${id} ${a.sessions} 个`)
      .join("、");
    console.log(
      `索引完成：${totals || "暂无会话"}（本次更新 ${stats.updated} 个，耗时 ${(stats.durationMs / 1000).toFixed(1)}s）`,
    );
  } catch (err) {
    console.log(`索引建立失败：${err instanceof Error ? err.message : err}（不影响接入，可稍后运行 memrelay doctor 重试）`);
  }

  if (failed.length > 0) {
    console.log("");
    console.log("有终端自测失败。可以让用户检查该终端的 Node 路径，或重新运行 memrelay setup。");
    return 1;
  }
  console.log("");
  console.log("完成。之后在各工具里照常说「继续完成 XX 任务」即可。");
  return 0;
}

async function runUndo(env: Env, opts: SetupOptions): Promise<number> {
  const dir = memrelayDir(env);
  if (opts.purge && (dir === env.home || path.dirname(dir) === path.dirname(env.home))) {
    console.log("拒绝操作：数据目录异常。");
    return 2;
  }
  const code = await runUndoCore(env, opts.purge ? { ...opts, purge: false, yes: true } : opts);
  if (code !== 0) return code;
  if (opts.purge) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`已删除数据目录 ${dir}。`);
  }
  // Trae hook 在沙箱里把原始 payload 写进工具自己的目录；撤销时一并清掉。
  for (const eventDir of traeEventDirs(env)) {
    fs.rmSync(eventDir, { recursive: true, force: true });
  }
  return 0;
}

function traeEventDirs(env: Env): string[] {
  const base =
    env.platform === "win32"
      ? (env.env["APPDATA"] ?? path.join(env.home, "AppData", "Roaming"))
      : env.platform === "darwin"
        ? path.join(env.home, "Library", "Application Support")
        : (env.env["XDG_CONFIG_HOME"] ?? path.join(env.home, ".config"));
  return ["Trae CN", "Trae"].map((product) =>
    path.join(base, product, "ModularData", "ai-agent", "hooks_env", "memrelay-events"),
  );
}

async function runUndoCore(env: Env, opts: SetupOptions): Promise<number> {
  const dir = memrelayDir(env);

  printPlan(env, true, [], [], []);
  const manifest = readManifest(env);
  if (!manifest || manifest.files.length === 0) return 0;
  if (!(await confirm("删除以上文件？", opts.yes))) {
    console.log("已取消。");
    return 0;
  }

  let removed = 0;
  let kept = 0;
  let hookFailures = 0;
  for (const file of manifest.files) {
    if (file.kind === "hook") {
      // 用户的 settings.json 是"改过"的文件：只外科手术式移除我们的 hook 条目
      const toolId = hookToolIdOf(file, env);
      if (!toolId) continue;
      const result = disableToolHooks(env, toolId);
      if (!result.enabled && !result.already && result.detail) {
        hookFailures++;
        console.log(`移除失败（${displayNameOf(toolId)}）：${result.detail}`);
        continue;
      }
      removed++;
      console.log(`已移除触发增强条目（${displayNameOf(toolId)}）：${file.path}`);
      continue;
    }
    let current: string | undefined;
    try {
      current = fs.readFileSync(file.path, "utf8");
    } catch {
      continue;
    }
    if (sha256(current) !== file.hash) {
      kept++;
      console.log(`保留（已被修改）：${file.path}`);
      continue;
    }
    try {
      fs.rmSync(file.path, { force: true });
      removed++;
    } catch {
      /* ignore */
    }
  }
  if (hookFailures > 0) {
    console.log(`有 ${hookFailures} 个 hook 未能移除；清单保留，修复后重新运行 memrelay setup --undo。`);
    return 1;
  }
  try {
    fs.rmSync(manifestPath(env), { force: true });
  } catch {
    /* ignore */
  }
  console.log(`已删除 ${removed} 个文件，保留 ${kept} 个被修改过的文件；数据（filters、数据库）保留在 ${dir}。`);
  console.log("加 --purge 可以连数据一起删。");
  return 0;
}
