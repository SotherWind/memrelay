import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * memrelay-dsh-plugin：MemRelay 在 DeepSeek Harness 里的进程内接入。
 *
 * - agent/turn-stopping（对应 Stop）：该回合结束时增量索引本会话（等待完成，
 *   headless 一次性运行也不丢）；
 * - agent/created（对应 SessionStart）：补扫其它工具的更新（不阻塞会话创建）。
 *
 * 两条路都通过派生普通子进程调用 `memrelay hook --flavor dsh`（payload 与官方
 * hooks 桥同形：session_id + cwd + hook_event_name；桥的 transcript_path 恒空，
 * memrelay 按 session_id + cwd 回推会话文件）。不经过 dsh 的沙箱通道，因此不受
 * 受限令牌 0xC0000142 / 写限制影响。失败一律静默：漏掉的更新由各工具 SessionStart
 * 补扫兜底（hook 命令自身也是"永不打扰宿主"的约定）。
 *
 * 本文件零依赖（只用 node 内置模块）：插件从 profile 的 node_modules 加载，
 * 解析不到 harness 包，所有能力都从 ctx 事件拿。
 */

export const name = "memrelay-dsh";

const SPAWN_TIMEOUT_MS = 20_000;

/** memrelay 数据目录：与 CLI 的 memrelayDir 保持同一套规则（含测试覆盖点）。 */
function memrelayDirFromEnv() {
  const override = String(process.env.MEMRELAY_HOME ?? "").trim();
  if (override) return override;
  const home = String(process.env.USERPROFILE ?? process.env.HOME ?? "").trim();
  return home ? path.join(home, ".memrelay") : "";
}

/** 读 runtime.json（node / cli 路径）；memrelay 没装好时返回 undefined。 */
function readRuntime() {
  const dir = memrelayDirFromEnv();
  if (!dir) return undefined;
  try {
    const rt = JSON.parse(fs.readFileSync(path.join(dir, "runtime.json"), "utf8"));
    if (!rt || typeof rt !== "object") return undefined;
    if (typeof rt.cli !== "string" || !rt.cli) return undefined;
    return rt;
  } catch {
    return undefined;
  }
}

/** 真实路径的 node 优先（nvm 当前版本路径可能被切走）；都不可用就放弃。 */
function pickNode(rt) {
  for (const candidate of [rt.nodeReal, rt.node, process.execPath]) {
    if (typeof candidate !== "string" || !candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 继续下一个候选 */
    }
  }
  return undefined;
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** 与 hooks 桥相同的 payload 形状（stop_hook_active 之类字段 hook 端不读）。 */
function payloadFor(event, ctxPayload) {
  const header = ctxPayload?.agent?.session?.header;
  return JSON.stringify({
    hook_event_name: event,
    session_id: typeof header?.id === "string" ? header.id : "",
    transcript_path: "",
    cwd: typeof header?.cwd === "string" && header.cwd ? header.cwd : process.cwd(),
  });
}

/** 派生 `memrelay hook --flavor dsh`，stdin 送 payload。永不 reject。 */
function runHook(event, ctxPayload) {
  return new Promise((resolve) => {
    const rt = readRuntime();
    const node = rt ? pickNode(rt) : undefined;
    if (!rt || !node || !isFile(rt.cli)) {
      resolve({ ok: false, detail: "memrelay runtime.json / cli 不可用" });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(node, [rt.cli, "hook", "--flavor", "dsh"], {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, detail: String(error) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      finish({ ok: false, detail: "超时" });
    }, SPAWN_TIMEOUT_MS);
    child.on("error", (error) => finish({ ok: false, detail: String(error?.message ?? error) }));
    child.on("exit", (code) => finish({ ok: code === 0, detail: code === 0 ? undefined : `exit ${code}` }));
    try {
      child.stdin.end(payloadFor(event, ctxPayload));
    } catch (error) {
      finish({ ok: false, detail: String(error) });
    }
  });
}

export function apply(ctx) {
  ctx.on("agent/turn-stopping", async (ctxPayload) => {
    try {
      await runHook("Stop", ctxPayload);
    } catch {
      /* 静默：漏掉的更新由补扫兜底 */
    }
  });
  ctx.on("agent/created", (ctxPayload) => {
    // 补扫可能卷过全部工具，别阻塞会话创建；子进程独立完成即可
    runHook("SessionStart", ctxPayload).catch(() => {});
  });
}
