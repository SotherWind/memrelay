import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  TIDY_BLOCK_BEGIN,
  TIDY_INDEX_BEGIN,
  removeTidyBlock,
  removeTidyIndexBlock,
  renderQoderMemoryFile,
  renderTidyBlock,
  renderTidyIndexBlock,
  upsertTidyBlock,
  upsertTidyIndexBlock,
  workBuddyGlobalMemory,
} from "../core/memory-sources.js";
import { sha256 } from "../core/hash.js";
import type { Env } from "../core/types.js";
import {
  clearTidyExports,
  listTidyExports,
  recordTidyExport,
  type TidyExportKind,
} from "./tidy-store.js";

interface TidyTarget {
  tool: string;
  file: string;
  kind: TidyExportKind;
  /** 新建文件时的标题；空字符串表示不加标题 */
  heading?: string;
}

/** 只写本功能自己的标记块；Qoder 用独立 memory 文件 + MEMORY.md 索引行。 */
const TARGETS: TidyTarget[] = [
  { tool: "qoder", file: ".qoder/memory/memrelay-preferences.md", kind: "own-file" },
  { tool: "qoder", file: ".qoder/memory/MEMORY.md", kind: "index" },
  { tool: "codex", file: ".codex/AGENTS.md", kind: "block", heading: "# 全局 Codex 指令" },
  // Trae CN 的全局规则是目录，不是 memory/user_profile.md
  { tool: "trae-cn", file: ".trae-cn/user_rules/memrelay.md", kind: "block", heading: "" },
  { tool: "claude-code", file: ".claude/CLAUDE.md", kind: "block", heading: "# 全局 Claude Code 指令" },
  { tool: "zcode", file: ".zcode/AGENTS.md", kind: "block", heading: "# 全局指令" },
  { tool: "opencode", file: ".config/opencode/AGENTS.md", kind: "block", heading: "# 全局指令" },
  { tool: "dsh", file: ".dsh/AGENTS.md", kind: "block", heading: "# 全局指令" },
];

/** 旧版曾把块写进 Trae 的 memory 文件；首次 apply 时迁走。 */
const LEGACY_TARGETS = [{ file: ".trae-cn/memory/user_profile.md" }];

function fullPath(env: Env, file: string): string {
  return path.join(env.home, ...file.split("/"));
}

function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function backup(env: Env, file: string, content: string, now: number): string {
  const dir = path.join(env.home, ".memrelay", "backups", "tidy");
  fs.mkdirSync(dir, { recursive: true });
  const name = `${sha256(file).slice(0, 12)}-${now}.bak`;
  const target = path.join(dir, name);
  fs.writeFileSync(target, content, "utf8");
  return target;
}

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.memrelay-tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, content, "utf8");
    fs.rmSync(tmp, { force: true });
  }
}

export interface TidyApplyResult {
  written: string[];
  skipped: string[];
}

/** 旧版本写进 Trae memory 文件的块迁走，避免和新规则文件重复。 */
function cleanupLegacyTargets(db: DatabaseSync, env: Env): void {
  for (const legacy of LEGACY_TARGETS) {
    const file = fullPath(env, legacy.file);
    const current = readIfExists(file);
    if (current === undefined || !current.includes(TIDY_BLOCK_BEGIN)) continue;
    const next = removeTidyBlock(current);
    if (next.trim() === "") {
      fs.rmSync(file, { force: true });
    } else {
      writeAtomic(file, next);
    }
    db.prepare("DELETE FROM memory_exports WHERE path = ?").run(file);
  }
}

/** 把整理后的偏好写成各工具全局规则文件里的标记块。 */
export function applyTidyExports(
  db: DatabaseSync,
  env: Env,
  entries: string[],
  now = Date.now(),
): TidyApplyResult {
  const block = renderTidyBlock(entries);
  const blockHash = sha256(block);
  const written: string[] = [];
  const skipped: string[] = [];
  cleanupLegacyTargets(db, env);
  const targets: TidyTarget[] = [...TARGETS];
  const workBuddy = workBuddyGlobalMemory(env);
  if (workBuddy) {
    targets.push({
      tool: "workbuddy",
      file: path.relative(env.home, workBuddy).split(path.sep).join("/"),
      kind: "block",
      heading: "",
    });
  }

  for (const target of targets) {
    const file = fullPath(env, target.file);
    const current = readIfExists(file);
    if (target.kind === "index" && current === undefined) {
      skipped.push(file); // 不替用户创建 MEMORY.md
      continue;
    }
    const created =
      current === undefined ||
      (db.prepare("SELECT created FROM memory_exports WHERE path = ?").get(file) as
        | { created: number }
        | undefined)?.created === 1;
    let next: string;
    if (target.kind === "own-file") {
      next = renderQoderMemoryFile(block);
    } else if (target.kind === "index") {
      next = upsertTidyIndexBlock(current ?? "", renderTidyIndexBlock());
    } else {
      const base = current ?? (target.heading !== undefined ? `${target.heading}` : "# 全局指令\n");
      next = upsertTidyBlock(base, block);
    }
    if (current === next) {
      skipped.push(file);
      continue;
    }
    const backupPath = created ? null : backup(env, file, current ?? "", now);
    writeAtomic(file, next);
    recordTidyExport(
      db,
      {
        path: file,
        tool: target.tool,
        kind: target.kind,
        blockHash,
        backupPath,
        created,
      },
      now,
    );
    written.push(file);
  }
  return { written, skipped };
}

/** apply 时新建文件会写入的标题；撤销时只删“除了这些标题什么都没有”的文件。 */
const GENERATED_HEADINGS = new Set(["", "# 全局 Codex 指令", "# 全局 Claude Code 指令", "# 全局指令"]);

export interface TidyUndoResult {
  removed: string[];
}

/** 撤销下发：移除标记块；本功能创建的文件直接删掉。 */
export function undoTidyExports(db: DatabaseSync, env: Env): TidyUndoResult {
  const removed: string[] = [];
  for (const entry of listTidyExports(db)) {
    const file = entry.path;
    const current = readIfExists(file);
    if (current === undefined) continue;
    if (entry.kind === "own-file") {
      if (current.includes(TIDY_BLOCK_BEGIN)) {
        fs.rmSync(file, { force: true });
        removed.push(file);
      }
      continue;
    }
    if (entry.kind === "index" && !current.includes(TIDY_INDEX_BEGIN)) continue;
    const next = entry.kind === "index" ? removeTidyIndexBlock(current) : removeTidyBlock(current);
    if (next === current) continue;
    if (entry.created && GENERATED_HEADINGS.has(next.trim())) {
      // 只删 MemRelay 自己创建、且移除后只剩生成标题的文件；用户后来追加的内容要保留。
      fs.rmSync(file, { force: true });
    } else {
      writeAtomic(file, next);
    }
    removed.push(file);
  }
  clearTidyExports(db);
  return { removed };
}
