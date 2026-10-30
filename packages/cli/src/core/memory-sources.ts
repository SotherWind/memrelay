import fs from "node:fs";
import path from "node:path";

import { sha256 } from "./hash.js";
import type { Env } from "./types.js";

export const TIDY_BLOCK_BEGIN = "<!-- memrelay:tidy:begin v1 -->";
export const TIDY_BLOCK_END = "<!-- memrelay:tidy:end -->";
export const TIDY_INDEX_BEGIN = "<!-- memrelay:tidy:index:begin -->";
export const TIDY_INDEX_END = "<!-- memrelay:tidy:index:end -->";

export interface MemorySourceDef {
  tool: string;
  label: string;
  /** 相对 home 的文件或目录 */
  path: string;
  kind: "file" | "dir";
  ext?: string;
  skip?: string[];
}

/** 已在本机验证过的全局记忆/规则来源；只读导入。 */
export const MEMORY_SOURCES: MemorySourceDef[] = [
  {
    tool: "qoder",
    label: "Qoder",
    path: ".qoder/memory",
    kind: "dir",
    ext: ".md",
    skip: ["MEMORY.md", "memrelay-preferences.md"],
  },
  { tool: "codex", label: "Codex", path: ".codex/AGENTS.override.md", kind: "file" },
  { tool: "codex", label: "Codex", path: ".codex/AGENTS.md", kind: "file" },
  { tool: "trae-cn", label: "Trae CN", path: ".trae-cn/user_rules", kind: "dir", ext: ".md", skip: ["memrelay.md"] },
  { tool: "trae-cn", label: "Trae CN", path: ".trae-cn/memory/user_profile.md", kind: "file" },
  { tool: "claude-code", label: "Claude Code", path: ".claude/CLAUDE.md", kind: "file" },
  { tool: "zcode", label: "ZCode", path: ".zcode/AGENTS.md", kind: "file" },
  { tool: "opencode", label: "OpenCode", path: ".config/opencode/AGENTS.md", kind: "file" },
  { tool: "dsh", label: "DeepSeek Harness", path: ".dsh/AGENTS.md", kind: "file" },
];

/** WorkBuddy 的全局记忆在 ~/.workbuddy/user-<uid>-personal/MEMORY.md（目录名含用户 id）。 */
export function workBuddyGlobalMemory(env: Env): string | undefined {
  const root = path.join(env.home, ".workbuddy");
  try {
    const dir = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^user-.*-personal$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()[0];
    return dir ? path.join(root, dir, "MEMORY.md") : undefined;
  } catch {
    return undefined;
  }
}

export interface ScannedSource {
  tool: string;
  label: string;
  path: string;
  content: string;
  mtimeMs: number;
}

export interface ParsedItem {
  heading: string | null;
  text: string;
}

function readIfFile(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return undefined;
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Qoder 记忆文件的 frontmatter 类型（metadata.type）。 */
export function memoryType(content: string): string | undefined {
  const text = content.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return undefined;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const match = /^\s*type:\s*([a-z-]+)\s*$/im.exec(text.slice(3, end));
  return match?.[1]?.toLowerCase();
}

/** 全局偏好只收长期反馈与环境事实；user（身份/活动）与 project（项目知识）留给其他线。 */
const GLOBAL_MEMORY_TYPES = new Set(["feedback", "reference"]);

function listDirFiles(dir: string, ext: string, skip: string[]): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.toLowerCase().endsWith(ext) && !skip.includes(name))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/** 只读扫描全局来源；不存在/不可读的文件直接跳过。 */
export function scanMemorySources(env: Env): ScannedSource[] {
  const out: ScannedSource[] = [];
  const codexOverride = path.join(env.home, ".codex", "AGENTS.override.md");
  const hasCodexOverride = fs.existsSync(codexOverride);
  for (const def of MEMORY_SOURCES) {
    // Codex 官方优先级：AGENTS.override.md 存在时替代全局 AGENTS.md
    if (hasCodexOverride && def.tool === "codex" && def.path === ".codex/AGENTS.md") continue;
    const target = path.join(env.home, ...def.path.split("/"));
    const files =
      def.kind === "file"
        ? [target]
        : listDirFiles(target, def.ext ?? ".md", def.skip ?? []);
    for (const file of files) {
      const content = readIfFile(file);
      if (content === undefined) continue;
      if (def.tool === "qoder") {
        const type = memoryType(content);
        if (type && !GLOBAL_MEMORY_TYPES.has(type)) continue;
      }
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        /* 读得到内容就够 */
      }
      out.push({ tool: def.tool, label: def.label, path: file, content, mtimeMs });
    }
  }
  const workBuddy = workBuddyGlobalMemory(env);
  if (workBuddy) {
    const content = readIfFile(workBuddy);
    if (content !== undefined) {
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(workBuddy).mtimeMs;
      } catch {
        /* 读得到内容就够 */
      }
      out.push({ tool: "workbuddy", label: "WorkBuddy", path: workBuddy, content, mtimeMs });
    }
  }
  return out;
}

/** 去掉本功能写入的区块，避免自己的输出被再次导入。 */
export function stripTidyBlock(content: string): string {
  const pattern = new RegExp(`${escapeRe(TIDY_BLOCK_BEGIN)}[\\s\\S]*?${escapeRe(TIDY_BLOCK_END)}`, "g");
  return content.replace(pattern, "");
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function contentFingerprint(content: string): string {
  // 归一化行尾与首尾空白：本功能写入/撤销标记块只改变空白时不应触发重跑。
  return sha256(stripTidyBlock(content).replace(/\r\n/g, "\n").trim());
}

function stripFrontmatter(content: string): string {
  const text = content.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  return text.slice(end + 4).replace(/^\r?\n/, "");
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** WorkBuddy 的 memory 文件末尾带 RAW_JSON 调试块，不当作规则。 */
function stripRawJson(content: string): string {
  return content.replace(/<!--\s*RAW_JSON_START[\s\S]*?RAW_JSON_END\s*-->/g, "");
}

function pushItem(out: ParsedItem[], heading: string | null, text: string): void {
  const value = normalize(text);
  if (value.length < 6) return;
  const clipped = value.length > 1200 ? `${value.slice(0, 1200)}…` : value;
  if (out.some((item) => item.text === clipped)) return;
  out.push({ heading, text: clipped });
}

/**
 * 把 Markdown 规则/记忆切成可比较的条目：
 * 有列表项时按列表项切；否则按段落切。标题作为上下文。
 */
export function parseMemoryItems(content: string): ParsedItem[] {
  const lines = stripTidyBlock(stripFrontmatter(stripRawJson(content))).split(/\r?\n/);
  const out: ParsedItem[] = [];
  let heading: string | null = null;
  let paragraph: string[] = [];
  let bullet: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) pushItem(out, heading, paragraph.join(" "));
    paragraph = [];
  };
  const flushBullet = () => {
    if (bullet) pushItem(out, heading, bullet.join(" "));
    bullet = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (headingMatch) {
      flushParagraph();
      flushBullet();
      heading = normalize(headingMatch[2]!);
      continue;
    }
    if (trimmed === "" || /^>\s*/.test(trimmed)) {
      flushParagraph();
      flushBullet();
      continue;
    }
    const bulletMatch = /^\s{0,3}[-*]\s+(.*)$/.exec(line);
    if (bulletMatch) {
      flushParagraph();
      flushBullet();
      bullet = [bulletMatch[1]!];
      continue;
    }
    if (bullet) {
      // 列表项的续行（缩进更深或以标点开头）
      bullet.push(trimmed);
      continue;
    }
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushBullet();
  return out;
}

export function extractTidyBlock(content: string): string | undefined {
  const start = content.indexOf(TIDY_BLOCK_BEGIN);
  if (start === -1) return undefined;
  const end = content.indexOf(TIDY_BLOCK_END, start);
  if (end === -1) return undefined;
  return content.slice(start, end + TIDY_BLOCK_END.length);
}

/** 有则替换、无则追加；保留原有内容。 */
export function upsertTidyBlock(content: string, block: string): string {
  const normalized = block.trimEnd();
  const start = content.indexOf(TIDY_BLOCK_BEGIN);
  if (start !== -1) {
    const end = content.indexOf(TIDY_BLOCK_END, start);
    if (end !== -1) {
      const tail = content.slice(end + TIDY_BLOCK_END.length).replace(/^\r?\n/, "");
      return `${content.slice(0, start)}${normalized}\n${tail}`;
    }
  }
  const base = content.trimEnd();
  return `${base}${base ? "\n\n" : ""}${normalized}\n`;
}

export function removeTidyBlock(content: string): string {
  const start = content.indexOf(TIDY_BLOCK_BEGIN);
  if (start === -1) return content;
  const end = content.indexOf(TIDY_BLOCK_END, start);
  if (end === -1) return content;
  const next = `${content.slice(0, start)}${content.slice(end + TIDY_BLOCK_END.length)}`
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return next ? `${next}\n` : "";
}

export function renderTidyBlock(entries: string[]): string {
  const body = entries.map((entry) => `- ${entry}`).join("\n");
  return `${TIDY_BLOCK_BEGIN}
## MemRelay 统一偏好（自动整理）
> 由 MemRelay 从各工具的全局记忆整理而来；请勿手动编辑此区块，下次整理会覆盖。

${body}
${TIDY_BLOCK_END}`;
}

export function renderQoderMemoryFile(block: string): string {
  return `---
name: memrelay-preferences
description: MemRelay 从各工具全局记忆整理出的统一偏好（自动维护，勿手改）
metadata:
  type: reference
---

${block.trimEnd()}
`;
}

export function renderTidyIndexBlock(): string {
  return `${TIDY_INDEX_BEGIN}
- [MemRelay 统一偏好](memrelay-preferences.md) — 由 MemRelay 自动整理，勿手改
${TIDY_INDEX_END}`;
}

export function upsertTidyIndexBlock(content: string, block: string): string {
  const normalized = block.trimEnd();
  const start = content.indexOf(TIDY_INDEX_BEGIN);
  if (start !== -1) {
    const end = content.indexOf(TIDY_INDEX_END, start);
    if (end !== -1) {
      const tail = content.slice(end + TIDY_INDEX_END.length).replace(/^\r?\n/, "");
      return `${content.slice(0, start)}${normalized}\n${tail}`;
    }
  }
  const base = content.trimEnd();
  return `${base}${base ? "\n\n" : ""}${normalized}\n`;
}

export function removeTidyIndexBlock(content: string): string {
  const start = content.indexOf(TIDY_INDEX_BEGIN);
  if (start === -1) return content;
  const end = content.indexOf(TIDY_INDEX_END, start);
  if (end === -1) return content;
  const next = `${content.slice(0, start)}${content.slice(end + TIDY_INDEX_END.length)}`
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return next ? `${next}\n` : "";
}
