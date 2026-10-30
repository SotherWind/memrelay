import fs from "node:fs";

import { currentEnv } from "../core/env.js";
import type { Env } from "../core/types.js";
import { isPathInside } from "../adapters/jsonl-family/parser.js";
import { allAdapters } from "../adapters/all.js";
import { dshSessionFile } from "../adapters/dsh/index.js";
import { familySessionFile } from "../adapters/opencode-family/index.js";
import { buildIndex, indexOneScan, storeExists } from "../store/indexer.js";
import { interruptedHint } from "../resume/hint.js";
import { recordTraeEvent } from "./relay-events.js";
import type { SerializedJsonlAdapter } from "../adapters/jsonl-family/jsonl-adapter.js";

/**
 * hook 事件入口（架构 4.1）：静默、幂等、永不阻塞宿主。
 * 由各工具的 hook 配置调用（Claude Code / Qoder CLI），stdin 收 JSON payload：
 *   - Stop / SessionEnd：按 payload 里的 transcript_path 精准增量索引那一个会话文件
 *   - SessionStart：增量补扫（只重解析变更过的文件），然后输出现有的接力提示
 * 任何失败都静默退出 0，绝不影响宿主；漏掉的更新由下一次 SessionStart 补扫兜住。
 */

export interface HookPayload {
  hook_event_name?: string;
  transcript_path?: string;
  cwd?: string;
  session_id?: string;
  [key: string]: unknown;
}

/** 这些事件表示"一个回合/一次会话刚写完记录"，按 transcript 文件增量索引。 */
const STOP_EVENTS = new Set(["Stop", "SessionEnd", "StopFailure", "SubagentStop"]);

/** 读 stdin 的最长时间：宿主异常不关闭管道时也不能卡住。 */
const STDIN_TIMEOUT_MS = 1500;

export async function readStdinWithTimeout(timeoutMs = STDIN_TIMEOUT_MS): Promise<string> {
  if (process.stdin.isTTY) return "";
  return await new Promise<string>((resolve) => {
    let data = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", finish);
      process.stdin.off("error", finish);
      try {
        process.stdin.pause();
      } catch {
        /* ignore */
      }
      resolve(data);
    };
    const onData = (chunk: Buffer | string) => {
      data += chunk.toString();
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on("data", onData);
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    process.stdin.resume();
  });
}

export function parseHookPayload(raw: string): HookPayload | undefined {
  if (!raw.trim()) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    return v as HookPayload;
  } catch {
    return undefined;
  }
}

function adaptersFor(): SerializedJsonlAdapter[] {
  return allAdapters();
}

/** 按会话文件路径归属到适配器；多来源工具可用 acceptsPath 自己判断。 */
function adapterForPath(env: Env, filePath: string): SerializedJsonlAdapter | undefined {
  for (const adapter of adaptersFor()) {
    if (adapter.acceptsPath) {
      if (adapter.acceptsPath(filePath, env)) return adapter;
    } else if (isPathInside(filePath, adapter.basePath(env), env.platform)) {
      return adapter;
    }
  }
  return undefined;
}

/** SessionStart 的接力提示：有中断任务时向 stdout 打一行。 */
async function emitHint(stdout: (text: string) => void): Promise<void> {
  const line = await interruptedHint();
  if (line) stdout(line);
}

export async function runHookCommand(
  stdout: (text: string) => void,
  rawPayload?: string,
  opts?: { flavor?: string },
): Promise<number> {
  try {
    const raw = rawPayload ?? (await readStdinWithTimeout());
    const payload = parseHookPayload(raw);
    const env = currentEnv();

    // 事件型来源（如 Trae CN IDE）：会话库加密不可读，把钩子事件落成 relay-events，
    // 由 trae-events 适配器重建会话；SessionStart 仍然输出接力提示。
    if (opts?.flavor === "trae-cn") {
      if (payload) recordTraeEvent(env, payload);
      const event = typeof payload?.hook_event_name === "string" ? payload.hook_event_name : "";
      if (event === "SessionStart") {
        await rescan(env);
        await emitHint(stdout);
      }
      return 0;
    }

    // 数据库型工具（OpenCode 插件 / ZCode 用户级 hook）：会话在 SQLite 库里明文可读，
    // payload 带 session_id，直接精准增量索引那一次会话；SessionStart 再补扫并输出提示；
    // 拿不到会话号就退回增量补扫。
    if (opts?.flavor === "opencode" || opts?.flavor === "zcode") {
      const sessionId = pickPayloadString(payload, ["session_id", "sessionId", "sessionID"]);
      if (sessionId) await indexDbSession(env, opts.flavor, sessionId);
      const event = typeof payload?.hook_event_name === "string" ? payload.hook_event_name : "";
      if (event === "SessionStart") {
        await rescan(env);
        await emitHint(stdout);
      } else if (!sessionId) {
        await rescan(env);
      }
      return 0;
    }

    // DeepSeek Harness（桌面端）：Claude 兼容桥转发 payload，但 transcript_path 恒为空——
    // 按 session_id + cwd 回推会话文件；进程在沙箱里（只可写工作区），写库失败一律静默。
    if (opts?.flavor === "dsh") {
      const event = typeof payload?.hook_event_name === "string" ? payload.hook_event_name : "";
      if (event === "SessionStart") {
        try {
          await rescan(env);
        } catch {
          /* 沙箱拒绝写库：提示照发 */
        }
        await emitDshHint(stdout);
      } else if (STOP_EVENTS.has(event)) {
        const sessionId = pickPayloadString(payload, ["session_id", "sessionId"]);
        const cwd = pickPayloadString(payload, ["cwd"]);
        if (sessionId) await indexDshSession(env, sessionId, cwd);
      }
      return 0;
    }

    // 提示要按调用方所在的项目输出：hook 的 cwd 以 payload 为准
    if (payload?.cwd && typeof payload.cwd === "string") {
      try {
        if (fs.statSync(payload.cwd).isDirectory()) process.chdir(payload.cwd);
      } catch {
        /* 目录不存在就保持原 cwd */
      }
    }

    const event = typeof payload?.hook_event_name === "string" ? payload.hook_event_name : "";
    const transcriptPath =
      typeof payload?.transcript_path === "string" ? payload.transcript_path : undefined;

    if (STOP_EVENTS.has(event)) {
      await indexTranscript(env, transcriptPath);
      return 0;
    }
    if (event === "SessionStart") {
      await rescan(env);
      await emitHint(stdout);
      return 0;
    }
    return 0; // 没配其它事件；未知事件静默
  } catch {
    return 0; // hook 永不打扰宿主
  }
}

async function indexTranscript(env: Env, transcriptPath?: string): Promise<void> {
  if (transcriptPath) {
    // 宿主给的路径大小写/分隔符可能和扫盘看到的不一样（Windows 常见）：
    // 统一成磁盘上的真实路径，避免同一文件在 sources 里出现两行
    const realPath = canonicalPath(transcriptPath);
    const adapter = adapterForPath(env, realPath);
    if (adapter) {
      try {
        if (fs.statSync(realPath).isFile()) {
          const scan = await adapter.scanFile(realPath, env);
          // 空文件 / 还读不出内容的文件：不建记录，等下一次事件
          if (scan) await indexOneScan(env, adapter, scan);
          return;
        }
      } catch {
        return;
      }
    }
  }
  // 拿不到路径或路径不认识（将来改了格式）：退回增量全扫，慢一点但不会漏
  await rescan(env);
}

function canonicalPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  }
}

function pickPayloadString(payload: HookPayload | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** 单会话增量索引（opencode-family 的伪路径 <db>#<sessionId>）。失败静默，由后续补扫兜底。 */
async function indexDbSession(env: Env, agent: string, sessionId: string): Promise<void> {
  const file = familySessionFile(agent, env, sessionId);
  if (!file) return;
  const adapter = adaptersFor().find((a) => a.agent === agent);
  if (!adapter) return;
  try {
    const scan = await adapter.scanFile(file, env);
    if (scan) await indexOneScan(env, adapter, scan);
  } catch {
    /* 静默：漏掉的更新由下一次补扫兜住 */
  }
}

/**
 * dsh 桥只把"exit 0 且 stdout 为 JSON"的输出注入上下文（纯文本 stdout 不会），
 * 提示必须包成 hookSpecificOutput 结构。
 */
async function emitDshHint(stdout: (text: string) => void): Promise<void> {
  const line = await interruptedHint();
  if (!line) return;
  stdout(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: line } }));
}

/** dsh 单会话增量索引：payload 只有 session_id + cwd，按项目目录编码回推文件。失败静默，由后续补扫兜底。 */
async function indexDshSession(env: Env, sessionId: string, cwd?: string): Promise<void> {
  const file = dshSessionFile(env, sessionId, cwd);
  if (!file) return;
  const adapter = adaptersFor().find((a) => a.agent === "dsh");
  if (!adapter) return;
  try {
    const scan = await adapter.scanFile(canonicalPath(file), env);
    if (scan) await indexOneScan(env, adapter, scan);
  } catch {
    /* 静默：沙箱拒绝写库或文件半写状态，都等下一次补扫 */
  }
}

/** 增量补扫：现有 indexer 的全量 stat + 只重解析变更文件。库没建过就跳过（由 setup / doctor 负责）。 */
async function rescan(env: Env): Promise<void> {
  if (!storeExists(env)) return;
  await buildIndex(env, { adapters: adaptersFor() });
}
