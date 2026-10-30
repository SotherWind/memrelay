import { parseArgs } from "node:util";

import { currentEnv } from "../../core/env.js";
import { checkpoint, openReadOnly, openWritable, StoreMissingError, StoreTooNewError } from "../../store/db.js";
import { applyExistingTidyPlan, runTidy, undoTidy } from "../../store/tidy-runner.js";
import { tidyStatus } from "../../store/tidy-store.js";
import { helpText } from "../help.js";

/**
 * memrelay tidy —— 跨工具全局偏好整理。
 * 默认导入来源、调摘要同款对话接口合并、写回四家工具的 MemRelay 标记块；
 * --status 只读查看，--apply 重写当前结果，--undo 撤销下发。
 */
export async function runTidyCommand(rest: string[], stdout: (text: string) => void): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: {
      status: { type: "boolean" },
      apply: { type: "boolean" },
      undo: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    stdout(helpText());
    return 0;
  }
  const env = currentEnv();
  if (values.status) return statusCommand(env, stdout);
  if (values.undo) return undoCommand(env, stdout);
  if (values.apply) return applyCommand(env, stdout);
  return runCommand(env, stdout);
}

function openWritableOrReport(
  env: ReturnType<typeof currentEnv>,
  stdout: (text: string) => void,
) {
  try {
    return openWritable(env);
  } catch (err) {
    if (err instanceof StoreMissingError || err instanceof StoreTooNewError) {
      stdout(err.message);
      return undefined;
    }
    throw err;
  }
}

function statusCommand(env: ReturnType<typeof currentEnv>, stdout: (text: string) => void): number {
  let db;
  try {
    db = openReadOnly(env);
  } catch (err) {
    if (err instanceof StoreMissingError || err instanceof StoreTooNewError) {
      stdout(err.message);
      return 2;
    }
    throw err;
  }
  try {
    let status;
    try {
      status = tidyStatus(db);
    } catch {
      stdout("索引库版本过旧（还没有整理表）。先运行 memrelay doctor 或 memrelay ui 升级索引库。");
      return 2;
    }
    stdout("偏好整理状态：");
    stdout(`  开关：${status.enabled ? "已开启" : "未启用（在配置页开启）"}`);
    stdout(
      `  配置：${status.configured ? `模型 ${status.model} · 主机 ${status.host}` : "不完整（在配置页填接口地址、模型名与 Key）"}`,
    );
    stdout(`  来源：${status.sources.length} 个文件 / ${status.items} 条`);
    for (const source of status.sources) {
      stdout(`    · ${source.tool}  ${source.path}  ${source.items} 条`);
    }
    if (status.plan) {
      stdout(`  结果：${status.plan.status} · ${status.plan.content.split("\n").filter(Boolean).length} 条 · ${status.plan.updatedAt}`);
      if (status.plan.conflicts.length > 0) stdout(`  待拍板：${status.plan.conflicts.length} 个冲突`);
    } else {
      stdout("  结果：还没有整理结果");
    }
    stdout(`  已下发：${status.exports.length} 个文件`);
    for (const entry of status.exports) stdout(`    · ${entry.tool}  ${entry.path}`);
    if (status.lastRunAt) stdout(`  最近运行：${status.lastRunAt}`);
    if (status.lastError) stdout(`  最近错误：${status.lastError}`);
    return 0;
  } finally {
    db.close();
  }
}

async function runCommand(env: ReturnType<typeof currentEnv>, stdout: (text: string) => void): Promise<number> {
  const db = openWritableOrReport(env, stdout);
  if (!db) return 2;
  try {
    const result = await runTidy(db, env);
    if (!result) {
      stdout("偏好整理未启用或接口配置不全。先在 memrelay ui 的配置页开启并填完整。");
      return 2;
    }
    if (result.error) {
      stdout(`整理失败：${result.error}`);
      return 1;
    }
    if (result.skipped === "unchanged") {
      stdout(`来源未变化，跳过（${result.entries} 条偏好，${result.conflicts} 个待拍板）。`);
      return 0;
    }
    if (result.skipped === "no-sources") {
      stdout("没有找到可整理的记忆/规则文件。");
      return 0;
    }
    stdout(
      `整理完成：合并 ${result.entries} 条偏好，下发 ${result.written} 个文件，${result.conflicts} 个待拍板。`,
    );
    checkpoint(db);
    return 0;
  } finally {
    db.close();
  }
}

function applyCommand(env: ReturnType<typeof currentEnv>, stdout: (text: string) => void): number {
  const db = openWritableOrReport(env, stdout);
  if (!db) return 2;
  try {
    const result = applyExistingTidyPlan(db, env);
    if (result.error) {
      stdout(result.error);
      return 2;
    }
    stdout(`已重新下发：${result.written} 个文件。`);
    checkpoint(db);
    return 0;
  } finally {
    db.close();
  }
}

function undoCommand(env: ReturnType<typeof currentEnv>, stdout: (text: string) => void): number {
  const db = openWritableOrReport(env, stdout);
  if (!db) return 2;
  try {
    const result = undoTidy(db, env);
    stdout(`已撤销下发：处理 ${result.removed.length} 个文件。`);
    checkpoint(db);
    return 0;
  } finally {
    db.close();
  }
}
