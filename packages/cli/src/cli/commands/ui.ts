import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { allAdapters } from "../../adapters/all.js";
import { currentEnv, memrelayDir } from "../../core/env.js";
import { maybeAutoIntegrateHint } from "../../server/integrations.js";
import { generateToken } from "../../server/security.js";
import { startServer } from "../../server/server.js";
import { openWritable } from "../../store/db.js";
import { buildIndex } from "../../store/indexer.js";
import { drainWithCurrentConfig } from "../../store/semantic.js";
import { drainSummaryWithCurrentConfig } from "../../store/summarizer.js";
import { drainNamesWithCurrentConfig } from "../../store/namer.js";
import { runTidy } from "../../store/tidy-runner.js";
import { helpText } from "../help.js";

/** 固定端口让浏览器 origin（含端口）保持不变，界面的主题/语言偏好才能留在 localStorage 里。 */
const DEFAULT_PORT = 4823;

export async function runUi(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: { port: { type: "string" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number.parseInt(values.port, 10);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      process.stdout.write("--port 需要一个 0-65535 的端口号（0 表示自动选择）。\n");
      return 1;
    }
  }
  return uiCommand({ port });
}

/** 打包后是 dist/cli.mjs 旁边的 ui/；从源码直跑时（src/cli/commands）上溯到包根的 dist/ui。 */
function resolveWebRoot(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, "ui"), path.resolve(here, "..", "..", "..", "dist", "ui")];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return undefined;
}

function openInBrowser(url: string): void {
  const done = () => {
    /* 打不开就让用户手动打开打印出来的地址 */
  };
  try {
    if (process.platform === "win32") {
      execFile("cmd.exe", ["/c", "start", "", url], { windowsHide: true }, done);
    } else if (process.platform === "darwin") {
      execFile("open", [url], done);
    } else {
      execFile("xdg-open", [url], done);
    }
  } catch {
    /* 同上 */
  }
}

interface UiOptions {
  port?: number;
  openBrowser?: boolean;
  stdout?: (line: string) => void;
}

async function uiCommand(options: UiOptions = {}): Promise<number> {
  const out = options.stdout ?? ((line: string) => console.log(line));
  const env = currentEnv();

  const webRoot = resolveWebRoot();
  if (!webRoot) {
    out("找不到前端产物。请先在仓库里运行 pnpm build（或重新安装 memrelay）。");
    return 2;
  }

  out(`数据目录：${memrelayDir(env)}`);
  const adapters = allAdapters();
  try {
    const stats = await buildIndex(env, { adapters, onProgress: (message) => out(`  …${message}`) });
    out(`索引已更新：本次解析 ${stats.updated} 个会话、跳过 ${stats.skipped} 个（耗时 ${(stats.durationMs / 1000).toFixed(1)}s）。`);
  } catch (err) {
    out(`建立索引失败：${err instanceof Error ? err.message : err}`);
    return 2;
  }

  const db = openWritable(env);
  // 自动接入提示（设置开启时）：已安装但未接入的工具列一行；只提示，写文件仍走「接入」页确认
  const autoHint = maybeAutoIntegrateHint(db, env);
  if (autoHint) out(`提示：${autoHint}`);
  // 后台 30s 循环与界面「重新索引」共享同一个在跑任务：幂等、不会被点两次。
  let reindexPromise: Promise<Awaited<ReturnType<typeof buildIndex>>> | null = null;
  const runReindex = (): Promise<Awaited<ReturnType<typeof buildIndex>>> => {
    if (reindexPromise) return reindexPromise;
    const promise = buildIndex(env, { adapters }).finally(() => {
      reindexPromise = null;
    });
    reindexPromise = promise;
    return promise;
  };
  const token = generateToken();
  const startOn = (port: number | undefined) =>
    startServer({
      db,
      webRoot,
      token,
      env,
      port,
      reindex: async () => {
        const stats = await runReindex();
        return { updated: stats.updated, skipped: stats.skipped, durationMs: stats.durationMs };
      },
    });

  let server;
  try {
    server = await startOn(options.port ?? DEFAULT_PORT);
  } catch (err) {
    const busy = (err as NodeJS.ErrnoException).code === "EADDRINUSE";
    if (options.port === undefined && busy) {
      out(`端口 ${DEFAULT_PORT} 已被占用，改用随机端口（主题/语言偏好不会带进下一次启动）。`);
      try {
        server = await startOn(0);
      } catch (retryErr) {
        db.close();
        out(`启动本地服务失败：${retryErr instanceof Error ? retryErr.message : retryErr}`);
        return 2;
      }
    } else {
      db.close();
      out(`启动本地服务失败：${err instanceof Error ? err.message : err}`);
      return 2;
    }
  }

  const url = `${server.baseUrl}/?token=${token}`;
  out(`MemRelay 管理界面已启动：${url}`);
  out("（地址带一次性令牌，只在本机有效；按 Ctrl+C 退出）");
  if (options.openBrowser !== false) openInBrowser(url);

  // 向量回填与会话摘要的后台出口（设计文档 §3）：开启对应功能时每 30s 各补一轮有预算的 drain；
  // 未启用 / 配置不全时每轮都是零成本空转。防重入：上一轮没跑完就跳过本轮。
  // 连续失败暂停（paused）后退避：配置错误时不做无限重试（错误在配置页状态区可见）。
  let draining = false;
  let pausedMs = 0;
  let pausedUntil = 0;
  let tidyPausedUntil = 0;
  const drainTick = async (): Promise<void> => {
    if (draining || Date.now() < pausedUntil) return;
    draining = true;
    try {
      const result = await drainWithCurrentConfig(env, { maxSessions: 4, maxMs: 20_000 });
      if (result) {
        if (result.paused) {
          pausedMs = pausedMs === 0 ? 5 * 60 * 1000 : Math.min(pausedMs * 2, 30 * 60 * 1000);
          pausedUntil = Date.now() + pausedMs;
          out(`  …语义回填连续失败，暂停 ${Math.round(pausedMs / 60000)} 分钟后再试（详情见配置页状态）`);
          return;
        }
        if (result.failed === 0) pausedMs = 0;
        if (result.processed > 0 || result.failed > 0) {
          out(
            `  …语义回填：嵌入 ${result.processed} 个、未变化跳过 ${result.skipped} 个、失败 ${result.failed} 个、剩余 ${result.remaining} 个`,
          );
        }
      }
      const names = await drainNamesWithCurrentConfig(env, { maxSessions: 8, maxMs: 20_000 });
      if (names) {
        if (names.paused) {
          pausedMs = pausedMs === 0 ? 5 * 60 * 1000 : Math.min(pausedMs * 2, 30 * 60 * 1000);
          pausedUntil = Date.now() + pausedMs;
          out(`  …任务名生成连续失败，暂停 ${Math.round(pausedMs / 60000)} 分钟后再试（详情见配置页状态）`);
          return;
        }
        if (names.failed === 0) pausedMs = 0;
        if (names.processed > 0 || names.failed > 0) {
          out(
            `  …任务名生成：生成 ${names.processed} 个、跳过 ${names.skipped} 个、失败 ${names.failed} 个、剩余 ${names.remaining} 个`,
          );
        }
      }
      const summary = await drainSummaryWithCurrentConfig(env, { maxSessions: 3, maxMs: 20_000 });
      if (summary) {
        if (summary.paused) {
          pausedMs = pausedMs === 0 ? 5 * 60 * 1000 : Math.min(pausedMs * 2, 30 * 60 * 1000);
          pausedUntil = Date.now() + pausedMs;
          out(`  …摘要生成连续失败，暂停 ${Math.round(pausedMs / 60000)} 分钟后再试（详情见配置页状态）`);
          return;
        }
        if (summary.failed === 0) pausedMs = 0;
        if (summary.processed > 0 || summary.failed > 0) {
          out(
            `  …摘要生成：生成 ${summary.processed} 个、未变化跳过 ${summary.skipped} 个、失败 ${summary.failed} 个、剩余 ${summary.remaining} 个`,
          );
        }
      }
      // 偏好整理：源文件没变时零请求；出错退避 5 分钟（配置错误不无限重试）。
      if (Date.now() >= tidyPausedUntil) {
        const tidy = await runTidy(db, env);
        if (tidy?.error) {
          tidyPausedUntil = Date.now() + 5 * 60 * 1000;
          out(`  …偏好整理失败，暂停 5 分钟后再试（${tidy.error}）`);
        } else if (tidy?.ran) {
          out(`  …偏好整理：合并 ${tidy.entries} 条，下发 ${tidy.written} 个文件`);
        }
      }
    } finally {
      draining = false;
    }
  };
  void drainTick();
  const drainTimer = setInterval(() => void drainTick(), 30_000);

  // hooks 只在 Stop/SessionStart 时更新索引；正在跑的回合和新会话要等下一轮，
  // 否则"进行中"筛选要等回合结束才有数据。buildIndex 只重读变化的文件，未变的 stat 后跳过。
  const reindexTick = async (): Promise<void> => {
    try {
      const stats = await runReindex();
      if (stats.updated > 0) out(`  …索引已更新：本次解析 ${stats.updated} 个会话`);
    } catch {
      /* 后台失败静默，下一轮再试 */
    }
  };
  const reindexTimer = setInterval(() => void reindexTick(), 30_000);

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  clearInterval(drainTimer);
  clearInterval(reindexTimer);
  await server.close();
  db.close();
  out("已退出。");
  return 0;
}
