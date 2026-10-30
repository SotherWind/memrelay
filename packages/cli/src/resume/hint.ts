import { currentEnv } from "../core/env.js";
import { loadFilters, isDirExcluded, isSessionDeleted, manualStatusFor } from "../core/filters.js";
import { redactSecrets } from "../core/secrets.js";
import { openReadOnly } from "../store/db.js";
import { statusFromSignals, type StoredSignals } from "../store/session-stats.js";
import { readSummary } from "../store/summarizer.js";
import { resolveContext, scanAll } from "./context.js";
import { decideStatusCore, FRESH_WINDOW_MS } from "./extract.js";
import { agentName } from "./render.js";
import { formatLocalTime } from "./session-reader.js";

interface StoredStatus {
  status: string;
  mtimeMs: number;
  manual: boolean;
}

/**
 * 索引里有新鲜状态时优先用库里的（Cursor/OpenCode 等扫描尾不带状态）。
 * 状态必须按"现在"重算：索引时刻可能落在文件的新鲜窗口内（Stop hook 刚写完就索引），
 * 直接信任那行 status 会让窗口过后的中断会话永远不提示。
 */
function loadStoredStatuses(
  env: ReturnType<typeof currentEnv>,
  scans: Array<{ id: string }>,
  now: number,
): Map<string, StoredStatus> {
  const out = new Map<string, StoredStatus>();
  if (scans.length === 0) return out;
  let db;
  try {
    db = openReadOnly(env);
  } catch {
    return out;
  }
  try {
    const ids = [...new Set(scans.map((scan) => scan.id))];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = db
        .prepare(
          `SELECT s.id AS id, s.status AS status, s.status_source AS status_source,
                  s.sig_pending AS sig_pending, s.sig_quota AS sig_quota,
                  s.sig_error AS sig_error, s.sig_unanswered AS sig_unanswered,
                  s.sig_todos_open AS sig_todos_open, s.sig_last_real AS sig_last_real,
                  s.sig_reply_len AS sig_reply_len,
                  COALESCE(src.mtime_ms, 0) AS mtime_ms
           FROM sessions s LEFT JOIN sources src ON src.path = s.source_path
           WHERE s.id IN (${chunk.map(() => "?").join(",")})`,
        )
        .all(...chunk) as Array<{
        id: string;
        status: string;
        status_source: string;
        sig_pending: number;
        sig_quota: number;
        sig_error: number;
        sig_unanswered: number;
        sig_todos_open: number;
        sig_last_real: string | null;
        sig_reply_len: number;
        mtime_ms: number;
      }>;
      for (const row of rows) {
        const mtimeMs = Number(row.mtime_ms);
        const signals: StoredSignals = {
          pending: Number(row.sig_pending) === 1,
          quota: Number(row.sig_quota) === 1,
          error: Number(row.sig_error) === 1,
          unanswered: Number(row.sig_unanswered) === 1,
          todosOpen: Number(row.sig_todos_open) === 1,
          lastReal: (row.sig_last_real as StoredSignals["lastReal"]) ?? null,
          replyLen: Number(row.sig_reply_len) || 0,
        };
        out.set(String(row.id), {
          status:
            row.status_source === "manual"
              ? String(row.status)
              : statusFromSignals(signals, mtimeMs, now),
          mtimeMs,
          manual: row.status_source === "manual",
        });
      }
    }
  } catch {
    /* 库不可读就退回扫描尾状态 */
  } finally {
    db.close();
  }
  return out;
}

/**
 * hint 引擎（hint 命令与 hook 的 SessionStart 共用）：
 * 只读、极快（只看文件头尾，不整读），找出本项目最近一个中断任务，返回一行提示；没有则返回 undefined。
 */
export async function interruptedHint(): Promise<string | undefined> {
  const env = currentEnv();
  const ctx = resolveContext();
  const scans = await scanAll(ctx);
  const now = Date.now();

  const filters = loadFilters(env);
  const candidates = scans.filter((scan) => {
    if (isSessionDeleted(scan.id, filters)) return false;
    if (scan.cwd && isDirExcluded(scan.cwd, filters, env.platform)) return false;
    // 排除调用方自己：文件里刚有 memrelay 调用痕迹且正在被写
    if (scan.tail.memrelayCalledRecently && now - scan.mtimeMs < 10 * 60 * 1000) return false;
    if (ctx.callerTool && scan.agent === ctx.callerTool.id && now - scan.mtimeMs < 90 * 1000) {
      return false;
    }
    return true;
  });

  const stored = loadStoredStatuses(ctx.env, candidates, now);

  const interrupted = candidates
    .filter((scan) => {
      const manual = manualStatusFor(scan.id, filters);
      if (manual) return manual === "interrupted";
      const fromDb = stored.get(scan.id);
      if (fromDb?.manual) return fromDb.status === "interrupted";
      if (fromDb && fromDb.mtimeMs > 0 && Math.round(scan.mtimeMs) === fromDb.mtimeMs) {
        return fromDb.status === "interrupted";
      }
      const info = scan.tail.statusInfo;
      const status = decideStatusCore({
        fresh: now - scan.mtimeMs < FRESH_WINDOW_MS,
        pendingToolCall: info.pendingToolCallIds.length > 0,
        quotaOrLimit: info.quotaOrLimitDetected,
        errorSeen: info.errorDetected,
        lastUserUnanswered: info.lastUserMessageUnanswered,
        lastReal: info.lastAssistantFinal
          ? "assistant"
          : info.lastUserMessageUnanswered
            ? "user"
            : null,
        unfinishedTodos: false,
        lastAssistantFinal: info.lastAssistantFinal === true,
      });
      return status === "interrupted";
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const best = interrupted[0];
  if (!best) return undefined;
  const more = interrupted.length > 1 ? `，另有 ${interrupted.length - 1} 个` : "";
  // 有现成摘要（AI 增强，只读不生成——hook 无网络）就用它，更能说清"卡在哪"；没有回退标题片段
  const summary = readSummary(env, best.id);
  const label = summary
    ? summary.replace(/\s+/g, " ").slice(0, 80)
    : best.tail.lastTitle
      ? best.tail.lastTitle.slice(0, 40)
      : "";
  const title = label ? `：${label}` : "";
  return redactSecrets(
    `本项目有 1 个在 ${agentName(best.agent)} 中断的任务（${formatLocalTime(best.startedAt ?? best.tail.lastTimestamp)}）${title}${more}；要续接可以运行 memrelay resume。`,
  ).text;
}
