import path from "node:path";

import { memrelayDir } from "../core/env.js";
import type { Env } from "../core/types.js";

/**
 * OpenCode 实时索引插件（b 层触发增强的插件形态）。
 * OpenCode v2 的插件默认导出一个 { id, setup(ctx) } 定义，setup 内可用
 * ctx.event.subscribe() 订阅事件流。会话数据在 opencode.db（明文可读），
 * 所以插件在"回合结束"事件里调 memrelay hook --flavor opencode，
 * 由 hook 端精准增量索引那一次会话（而不是整盘重扫）。
 * 文件是我们完全拥有的静态脚本；删除即可卸载。
 */

export function opencodePluginDir(env: Env): string {
  return path.join(env.home, ".config", "opencode", "plugins");
}

export function opencodePluginPath(env: Env): string {
  return path.join(opencodePluginDir(env), "memrelay.js");
}

export function renderOpencodePlugin(env: Env): string {
  return `// MemRelay 实时索引插件 —— 由 memrelay setup 写入，删除本文件即可卸载。
// 每次回合结束（succeeded / failed / interrupted）时，让 memrelay 增量索引这一次会话。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MEMRELAY_DIR = ${JSON.stringify(memrelayDir(env))};

const EXECUTION_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

function indexSession(sessionId, cwd) {
  try {
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    const cmdPath = path.join(MEMRELAY_DIR, "bin", "memrelay.cmd");
    const shPath = path.join(MEMRELAY_DIR, "bin", "memrelay");
    const payload = JSON.stringify({ hook_event_name: "Stop", session_id: sessionId, cwd });
    let child;
    if (process.platform === "win32") {
      if (!fs.existsSync(cmdPath)) return;
      child = spawn("cmd.exe", ["/c", cmdPath, "hook", "--flavor", "opencode"], {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
    } else {
      if (!fs.existsSync(shPath)) return;
      child = spawn(shPath, ["hook", "--flavor", "opencode"], {
        stdio: ["pipe", "ignore", "ignore"],
      });
    }
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(payload);
    child.unref();
  } catch {
    /* 永不打扰宿主 */
  }
}

export default {
  id: "memrelay",
  async setup(ctx) {
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (!EXECUTION_EVENTS.has(event?.type)) continue;
          indexSession(event?.data?.sessionID, event?.location?.directory);
        }
      } catch {
        /* 订阅结束或宿主退出 */
      }
    })();
    return () => controller.abort();
  },
};
`;
}
