import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import type { DatabaseSync } from "node:sqlite";

import { VERSION } from "../core/version.js";
import type { Env, SessionStatus } from "../core/types.js";
import {
  getDashboard,
  getTaskDetail,
  listProjectTasks,
  listTaskSummary,
  resolveTaskHead,
} from "./task-list.js";
import { getSessionMessages, listRecentSessions, searchAllSessions } from "./conversations.js";
import { enqueueNamesForSessions } from "../store/names-store.js";
import { deleteSessions, listTrash, restoreSessions } from "./deletions.js";
import { applyIntegrations, listIntegrations, runIntegrationSelfTest } from "./integrations.js";
import { getExclusions, listSecrets, setExclusions } from "./privacy.js";
import { SessionFileMissingError, buildResumePreview } from "./resume-preview.js";
import { readUiSettings, writeUiSettings, type UiSettingsPatch } from "./settings-store.js";
import { applyExistingTidyPlan, runTidy, undoTidy } from "../store/tidy-runner.js";
import { tidyStatus } from "../store/tidy-store.js";
import { createRemoteEmbeddingProvider } from "../core/embeddings.js";
import {
  deleteAllEmbeddings,
  drainEmbedQueue,
  embeddingStatus,
  rebuildEmbeddings,
  resolveEmbeddingConfig,
} from "../store/embeddings-store.js";
import { enqueueAll } from "../store/queue.js";
import {
  deleteAllSummaries,
  drainSummaryQueue,
  rebuildSummaries,
  resolveSummaryRuntimeConfig,
  summaryStatus,
} from "../store/summaries-store.js";
import { createChatProvider } from "../core/llm.js";
import { semanticHitsForSearch } from "../store/semantic.js";
import { setSessionsStatus, setTaskName, updateManualChains } from "./task-status.js";
import { TOKEN_COOKIE_NAME, TOKEN_HEADER_NAME, hostAllowed, originAllowed, tokenFromCookie, tokensEqual } from "./security.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export interface ServerOptions {
  db: DatabaseSync;
  webRoot: string;
  token: string;
  env: Env;
  port?: number;
  /** 界面「重新索引」按钮：与后台定时索引共用同一份在跑任务。 */
  reindex?: () => Promise<{ updated: number; skipped: number; durationMs: number }>;
}

export interface RunningServer {
  port: number;
  baseUrl: string;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const server = http.createServer((req, res) => {
    try {
      handleRequest(req, res, opts);
    } catch {
      sendText(res, 500, "内部错误");
    }
  });
  server.listen(opts.port ?? 0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      }),
  };
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, opts: ServerOptions): void {
  if (!hostAllowed(req.headers.host)) {
    sendText(res, 403, "非法 Host 头：只接受 127.0.0.1 / localhost。");
    return;
  }
  if (
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    !originAllowed(req.headers.origin, req.headers.host)
  ) {
    sendJson(res, 403, { error: "cross-origin request rejected" });
    return;
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");

  let authorized = false;
  const queryToken = url.searchParams.get("token");
  if (queryToken !== null && tokensEqual(queryToken, opts.token)) {
    authorized = true;
    res.setHeader(
      "Set-Cookie",
      `${TOKEN_COOKIE_NAME}=${encodeURIComponent(opts.token)}; HttpOnly; SameSite=Strict; Path=/`,
    );
    if (!isApi) {
      // 令牌从地址栏传到 cookie 后，跳转到干净地址
      url.searchParams.delete("token");
      const qs = url.searchParams.toString();
      res.statusCode = 302;
      res.setHeader("Location", `${url.pathname}${qs ? `?${qs}` : ""}`);
      res.end();
      return;
    }
  }
  if (!authorized) {
    const headerToken = req.headers[TOKEN_HEADER_NAME];
    if (typeof headerToken === "string" && tokensEqual(headerToken, opts.token)) authorized = true;
  }
  if (!authorized) {
    const cookieToken = tokenFromCookie(req.headers.cookie);
    if (cookieToken !== undefined && tokensEqual(cookieToken, opts.token)) authorized = true;
  }
  if (!authorized) {
    if (isApi) sendJson(res, 401, { error: "unauthorized" });
    else sendText(res, 401, "未授权：请用 memrelay ui 打印的地址打开管理界面。");
    return;
  }

  if (isApi) {
    void handleApi(req, res, url, opts).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
    return;
  }
  serveStatic(req, res, url, opts);
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  opts: ServerOptions,
): Promise<void> {
  const method = req.method ?? "GET";
  const pathname = url.pathname;
  const PREVIEW_SUFFIX = "/resume-preview";

  // ---- 读接口 ----
  if (method === "GET") {
    if (pathname === "/api/health") {
      sendJson(res, 200, { name: "memrelay", version: VERSION });
      return;
    }
    if (pathname === "/api/tasks/summary") {
      const parsed = parseStatusParam(url.searchParams.get("status"));
      if (!parsed.ok) {
        sendJson(res, 400, { error: "status 取值不合法" });
        return;
      }
      const query = url.searchParams.get("q")?.trim() || undefined;
      sendJson(res, 200, listTaskSummary(opts.db, opts.env, { status: parsed.status, query }));
      return;
    }
    if (pathname === "/api/tasks") {
      // 按目录分页取任务（列表页一个目录一段，按需加载）
      const project = url.searchParams.get("project") ?? "";
      if (!project) {
        sendJson(res, 400, { error: "缺少 project 参数" });
        return;
      }
      const parsed = parseStatusParam(url.searchParams.get("status"));
      if (!parsed.ok) {
        sendJson(res, 400, { error: "status 取值不合法" });
        return;
      }
      const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const page = listProjectTasks(opts.db, opts.env, {
        project,
        status: parsed.status,
        query: url.searchParams.get("q")?.trim() || undefined,
        offset: Number.isInteger(offset) ? offset : 0,
        limit: Number.isInteger(limit) ? limit : undefined,
      });
      // 只给当前页真正要显示的会话补任务名（后台 drain 生成，列表先出启发式标题）
      enqueueNamesForSessions(
        opts.db,
        page.tasks.map((task) => (task.id.startsWith("task:") ? task.id.slice("task:".length) : task.id)),
      );
      sendJson(res, 200, page);
      return;
    }
    if (pathname.startsWith("/api/tasks/")) {
      const rest = pathname.slice("/api/tasks/".length);
      if (rest.endsWith(PREVIEW_SUFFIX)) {
        const id = safeDecode(rest.slice(0, -PREVIEW_SUFFIX.length));
        const head = id ? resolveTaskHead(opts.db, opts.env, id) : undefined;
        if (!head) {
          sendJson(res, 404, { error: "task not found" });
          return;
        }
        try {
          const preview = await buildResumePreview(opts.env, head.project, head.sessionId);
          sendJson(res, 200, preview);
        } catch (err) {
          if (err instanceof SessionFileMissingError) {
            sendJson(res, 404, { error: err.message });
          } else {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        return;
      }
      const id = safeDecode(rest);
      const detail = id ? getTaskDetail(opts.db, opts.env, id) : undefined;
      if (!detail) {
        sendJson(res, 404, { error: "task not found" });
        return;
      }
      enqueueNamesForSessions(opts.db, detail.legs.map((leg) => leg.sessionId));
      sendJson(res, 200, { task: detail });
      return;
    }
    if (pathname === "/api/sessions") {
      const query = url.searchParams.get("q")?.trim() ?? "";
      let sessions;
      if (query) {
        // 语义通道（opt-in）：查询词嵌入失败 / 未启用时为空数组 → 纯 FTS。
        // 不在这里做定向排空——ui 后台循环在跑，搜索结果不该被回填阻塞。
        const semantic = await semanticHitsForSearch(opts.env, query, {
          projectRoot: "",
          limit: 30,
          drain: false,
        });
        sessions = searchAllSessions(opts.db, opts.env, query, 30, semantic);
      } else {
        sessions = listRecentSessions(opts.db, opts.env);
      }
      enqueueNamesForSessions(opts.db, sessions.map((session) => session.id));
      sendJson(res, 200, { query, sessions });
      return;
    }
    if (pathname.startsWith("/api/sessions/")) {
      const rest = pathname.slice("/api/sessions/".length);
      const MESSAGES_SUFFIX = "/messages";
      if (rest.endsWith(MESSAGES_SUFFIX)) {
        const id = safeDecode(rest.slice(0, -MESSAGES_SUFFIX.length));
        const from = Number.parseInt(url.searchParams.get("from") ?? "0", 10);
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
        const result = id
          ? getSessionMessages(opts.db, opts.env, id, {
              from: Number.isInteger(from) ? from : 0,
              limit: Number.isInteger(limit) ? limit : undefined,
            })
          : undefined;
        if (!result) {
          sendJson(res, 404, { error: "session not found" });
          return;
        }
        enqueueNamesForSessions(opts.db, [result.session.id]);
        sendJson(res, 200, result);
        return;
      }
    }
    if (pathname === "/api/integrations") {
      sendJson(res, 200, listIntegrations(opts.env));
      return;
    }
    if (pathname === "/api/trash") {
      sendJson(res, 200, { items: listTrash(opts.db, opts.env) });
      return;
    }
    if (pathname === "/api/privacy") {
      sendJson(res, 200, {
        excludedDirs: getExclusions(opts.env),
        secrets: listSecrets(opts.db, opts.env),
      });
      return;
    }
    if (pathname === "/api/dashboard") {
      sendJson(res, 200, getDashboard(opts.db, opts.env));
      return;
    }
    if (pathname === "/api/settings") {
      sendJson(res, 200, readUiSettings(opts.db));
      return;
    }
    if (pathname === "/api/embeddings/status") {
      sendJson(res, 200, embeddingStatus(opts.db));
      return;
    }
    if (pathname === "/api/summaries/status") {
      sendJson(res, 200, summaryStatus(opts.db));
      return;
    }
    if (pathname === "/api/tidy/status") {
      sendJson(res, 200, { ...tidyStatus(opts.db), running: tidyRun !== undefined });
      return;
    }
    sendJson(res, 404, { error: "not found" });
    return;
  }

  // ---- 写接口 ----
  if (method === "POST" || method === "PUT") {
    let body: unknown = {};
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "请求体不是合法的 JSON" });
      return;
    }

    if (pathname === "/api/trash/delete") {
      const ids = stringArrayField(body, "ids");
      if (!ids) {
        sendJson(res, 400, { error: "ids 必须是字符串数组" });
        return;
      }
      const changed = deleteSessions(opts.env, ids, opts.db);
      sendJson(res, 200, { changed, items: listTrash(opts.db, opts.env) });
      return;
    }
    if (pathname === "/api/trash/restore") {
      const ids = stringArrayField(body, "ids");
      if (!ids) {
        sendJson(res, 400, { error: "ids 必须是字符串数组" });
        return;
      }
      const changed = restoreSessions(opts.env, ids, opts.db);
      sendJson(res, 200, { changed, items: listTrash(opts.db, opts.env) });
      return;
    }
    if (pathname === "/api/privacy/exclusions") {
      const dirs = stringArrayField(body, "excludedDirs");
      if (!dirs) {
        sendJson(res, 400, { error: "excludedDirs 必须是字符串数组" });
        return;
      }
      sendJson(res, 200, { excludedDirs: setExclusions(opts.env, dirs) });
      return;
    }
    if (pathname === "/api/settings") {
      const patch = settingsPatch(body);
      if (!patch) {
        sendJson(res, 400, { error: "设置内容不合法" });
        return;
      }
      sendJson(res, 200, writeUiSettings(opts.db, patch));
      return;
    }
    // 界面手动触发一次增量索引；与后台 30s 循环共用同一个在跑 Promise。
    if (pathname === "/api/reindex") {
      if (!opts.reindex) {
        sendJson(res, 503, { error: "reindex unavailable" });
        return;
      }
      const stats = await opts.reindex();
      sendJson(res, 200, { ok: true, ...stats });
      return;
    }
    // 立即回填：全量入队（或换指纹重建：先删旧、再入队）+ 后台 drain；界面轮询状态看进度。
    if (pathname === "/api/embeddings/backfill") {
      const rebuild =
        body !== null && typeof body === "object"
          ? (body as Record<string, unknown>)["rebuild"] === true
          : false;
      const started = startEmbeddingBackfill(opts, rebuild);
      sendJson(res, 200, { started, status: embeddingStatus(opts.db) });
      return;
    }
    // 显式"删除全部向量"：唯一清除路径（停用只保留不删）
    if (pathname === "/api/embeddings/clear") {
      deleteAllEmbeddings(opts.db);
      sendJson(res, 200, { status: embeddingStatus(opts.db) });
      return;
    }
    // 摘要生成：全量入队（或换指纹重建：先删旧、再入队）+ 后台 drain；界面轮询状态看进度
    if (pathname === "/api/summaries/backfill") {
      const rebuild =
        body !== null && typeof body === "object"
          ? (body as Record<string, unknown>)["rebuild"] === true
          : false;
      const started = startSummaryBackfill(opts, rebuild);
      sendJson(res, 200, { started, status: summaryStatus(opts.db) });
      return;
    }
    // 显式"删除全部摘要"：唯一清除路径
    if (pathname === "/api/summaries/clear") {
      deleteAllSummaries(opts.db);
      sendJson(res, 200, { status: summaryStatus(opts.db) });
      return;
    }
    if (pathname === "/api/tidy/run") {
      const started = startTidyRun(opts);
      sendJson(res, 200, { started, status: { ...tidyStatus(opts.db), running: tidyRun !== undefined } });
      return;
    }
    if (pathname === "/api/tidy/apply") {
      if (tidyRun) {
        sendJson(res, 409, { error: "整理正在运行，请稍后再试" });
        return;
      }
      const result = applyExistingTidyPlan(opts.db, opts.env);
      sendJson(res, result.error ? 400 : 200, {
        ...result,
        status: { ...tidyStatus(opts.db), running: tidyRun !== undefined },
      });
      return;
    }
    if (pathname === "/api/tidy/undo") {
      if (tidyRun) {
        sendJson(res, 409, { error: "整理正在运行，请稍后再试" });
        return;
      }
      const result = undoTidy(opts.db, opts.env);
      sendJson(res, 200, { ...result, status: { ...tidyStatus(opts.db), running: tidyRun !== undefined } });
      return;
    }
    const STATUS_SUFFIX = "/status";
    if (pathname === "/api/tasks/summary") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (pathname.startsWith("/api/tasks/") && pathname.endsWith(STATUS_SUFFIX)) {
      const id = safeDecode(pathname.slice("/api/tasks/".length, -STATUS_SUFFIX.length));
      const detail = id ? getTaskDetail(opts.db, opts.env, id) : undefined;
      if (!detail) {
        sendJson(res, 404, { error: "task not found" });
        return;
      }
      const raw = body && typeof body === "object" ? (body as Record<string, unknown>)["status"] : undefined;
      if (raw !== "done" && raw !== "abandoned" && raw !== null) {
        sendJson(res, 400, { error: "status 只能是 done、abandoned 或 null" });
        return;
      }
      setSessionsStatus(
        opts.env,
        detail.legs.map((leg) => leg.sessionId),
        raw,
      );
      sendJson(res, 200, { task: getTaskDetail(opts.db, opts.env, id) });
      return;
    }
    if (pathname.startsWith("/api/tasks/")) {
      const rest = pathname.slice("/api/tasks/".length);
      const bodyField = (field: string): unknown =>
        body && typeof body === "object" ? (body as Record<string, unknown>)[field] : undefined;

      const SPLIT_SUFFIX = "/split";
      if (rest.endsWith(SPLIT_SUFFIX)) {
        const id = safeDecode(rest.slice(0, -SPLIT_SUFFIX.length));
        const detail = id ? getTaskDetail(opts.db, opts.env, id) : undefined;
        if (!detail) {
          sendJson(res, 404, { error: "task not found" });
          return;
        }
        const from = bodyField("from");
        if (typeof from !== "string") {
          sendJson(res, 400, { error: "from 必须是会话 id" });
          return;
        }
        const ids = detail.legs.map((leg) => leg.sessionId);
        const index = ids.indexOf(from);
        if (index <= 0) {
          sendJson(res, 400, { error: "from 必须是链上第二段起的会话 id" });
          return;
        }
        updateManualChains(opts.env, ids, [ids.slice(0, index), ids.slice(index)]);
        sendJson(res, 200, { task: getTaskDetail(opts.db, opts.env, `task:${ids[0]!}`) });
        return;
      }
      const MERGE_SUFFIX = "/merge";
      if (rest.endsWith(MERGE_SUFFIX)) {
        const id = safeDecode(rest.slice(0, -MERGE_SUFFIX.length));
        const detail = id ? getTaskDetail(opts.db, opts.env, id) : undefined;
        if (!detail) {
          sendJson(res, 404, { error: "task not found" });
          return;
        }
        const otherId = bodyField("with");
        const other = typeof otherId === "string" ? getTaskDetail(opts.db, opts.env, otherId) : undefined;
        if (!other) {
          sendJson(res, 404, { error: "目标任务不存在" });
          return;
        }
        if (other.id === detail.id) {
          sendJson(res, 400, { error: "不能和自己合并" });
          return;
        }
        const merged = [...detail.legs, ...other.legs].sort((a, b) => a.startedAt - b.startedAt);
        const ids = merged.map((leg) => leg.sessionId);
        updateManualChains(opts.env, ids, [ids]);
        sendJson(res, 200, { task: getTaskDetail(opts.db, opts.env, `task:${ids[0]!}`) });
        return;
      }
      const RESET_CHAIN_SUFFIX = "/reset-chain";
      if (rest.endsWith(RESET_CHAIN_SUFFIX)) {
        const id = safeDecode(rest.slice(0, -RESET_CHAIN_SUFFIX.length));
        const detail = id ? getTaskDetail(opts.db, opts.env, id) : undefined;
        if (!detail) {
          sendJson(res, 404, { error: "task not found" });
          return;
        }
        const ids = detail.legs.map((leg) => leg.sessionId);
        updateManualChains(opts.env, ids);
        sendJson(res, 200, {
          task:
            getTaskDetail(opts.db, opts.env, id) ??
            getTaskDetail(opts.db, opts.env, ids[0]!),
        });
        return;
      }

      // 纯任务 id：改任务名（空字符串恢复原名）
      if (!rest.includes("/")) {
        const id = safeDecode(rest);
        const detail = id ? getTaskDetail(opts.db, opts.env, id) : undefined;
        if (!detail) {
          sendJson(res, 404, { error: "task not found" });
          return;
        }
        const title = bodyField("title");
        if (typeof title !== "string") {
          sendJson(res, 400, { error: "title 必须是字符串（空字符串恢复原名）" });
          return;
        }
        setTaskName(opts.env, detail.id, title);
        sendJson(res, 200, { task: getTaskDetail(opts.db, opts.env, detail.id) });
        return;
      }
    }
    if (pathname === "/api/integrations/apply") {
      const enabled = booleanMapField(body, "enabled");
      if (!enabled) {
        sendJson(res, 400, { error: "enabled 必须是布尔值映射" });
        return;
      }
      const result = await applyIntegrations(enabled);
      sendJson(res, 200, { ok: result.ok, log: result.log, integrations: listIntegrations(opts.env) });
      return;
    }
    if (pathname === "/api/integrations/selftest") {
      sendJson(res, 200, { tests: runIntegrationSelfTest(opts.env) });
      return;
    }
    // 对只读资源用写方法：405 而不是 404
    const GET_ONLY_PREFIXES = ["/api/health", "/api/tasks", "/api/sessions"];
    if (GET_ONLY_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    sendJson(res, 404, { error: "not found" });
    return;
  }

  sendJson(res, 405, { error: "method not allowed" });
}

/**
 * 后台回填（不阻塞 HTTP）：同一时刻只跑一份（防重入）；进度通过
 * GET /api/embeddings/status 观察（待嵌数 / lastError）。claim 租约与 ui 后台循环互不重复烧 API。
 */
let embeddingBackfill: Promise<void> | undefined;

function startEmbeddingBackfill(opts: ServerOptions, rebuild: boolean): boolean {
  if (embeddingBackfill) return false;
  embeddingBackfill = (async () => {
    try {
      const config = resolveEmbeddingConfig(opts.db);
      if (!config) return;
      if (rebuild) {
        rebuildEmbeddings(opts.db, { model: config.model, host: config.host });
      } else {
        enqueueAll(opts.db, "embed_queue");
      }
      const provider = createRemoteEmbeddingProvider({ config });
      await drainEmbedQueue(opts.db, provider, {
        fingerprint: { model: config.model, host: config.host },
        env: opts.env,
      });
    } catch {
      /* 失败写进 embed.lastError，状态接口可见 */
    } finally {
      embeddingBackfill = undefined;
    }
  })();
  return true;
}

/** 后台摘要生成（不阻塞 HTTP）：同一时刻只跑一份；进度看 /api/summaries/status。 */
let summaryBackfill: Promise<void> | undefined;

/** 后台偏好整理：同一时刻只跑一份；自动模式由 ui 的定时 tick 触发。 */
let tidyRun: Promise<void> | undefined;

function startTidyRun(opts: ServerOptions): boolean {
  if (tidyRun) return false;
  tidyRun = (async () => {
    try {
      await runTidy(opts.db, opts.env);
    } catch {
      /* 失败写进 tidy.lastError，状态接口可见 */
    } finally {
      tidyRun = undefined;
    }
  })();
  return true;
}

function startSummaryBackfill(opts: ServerOptions, rebuild: boolean): boolean {
  if (summaryBackfill) return false;
  summaryBackfill = (async () => {
    try {
      const config = resolveSummaryRuntimeConfig(opts.db);
      if (!config) return;
      if (rebuild) {
        rebuildSummaries(opts.db, { model: config.model, host: config.host });
      } else {
        enqueueAll(opts.db, "summary_queue");
      }
      const provider = createChatProvider({ config });
      await drainSummaryQueue(opts.db, provider, {
        config: { model: config.model, host: config.host },
        env: opts.env,
      });
    } catch {
      /* 失败写进 summary.lastError，状态接口可见 */
    } finally {
      summaryBackfill = undefined;
    }
  })();
  return true;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(buf);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function stringArrayField(body: unknown, field: string): string[] | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[field];
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item): item is string => typeof item === "string")) return undefined;
  return value;
}

function booleanMapField(body: unknown, field: string): Record<string, boolean> | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, boolean> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "boolean") return undefined;
    out[key] = item;
  }
  return out;
}

function settingsPatch(body: unknown): UiSettingsPatch | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const patch: UiSettingsPatch = {};
  if (record["autoIntegrate"] !== undefined) {
    if (typeof record["autoIntegrate"] !== "boolean") return undefined;
    patch.autoIntegrate = record["autoIntegrate"];
  }
  if (record["summary"] !== undefined) {
    const summary = record["summary"];
    if (!summary || typeof summary !== "object") return undefined;
    const raw = summary as Record<string, unknown>;
    const parsed: NonNullable<UiSettingsPatch["summary"]> = {};
    if (raw["enabled"] !== undefined) {
      if (typeof raw["enabled"] !== "boolean") return undefined;
      parsed.enabled = raw["enabled"];
    }
    for (const key of ["baseUrl", "model", "apiKey"] as const) {
      if (raw[key] !== undefined) {
        if (typeof raw[key] !== "string") return undefined;
        parsed[key] = raw[key] as string;
      }
    }
    patch.summary = parsed;
  }
  if (record["embedding"] !== undefined) {
    const embedding = record["embedding"];
    if (!embedding || typeof embedding !== "object") return undefined;
    const raw = embedding as Record<string, unknown>;
    const parsed: NonNullable<UiSettingsPatch["embedding"]> = {};
    if (raw["enabled"] !== undefined) {
      if (typeof raw["enabled"] !== "boolean") return undefined;
      parsed.enabled = raw["enabled"];
    }
    for (const key of ["baseUrl", "model", "apiKey"] as const) {
      if (raw[key] !== undefined) {
        if (typeof raw[key] !== "string") return undefined;
        parsed[key] = raw[key] as string;
      }
    }
    patch.embedding = parsed;
  }
  if (record["tidy"] !== undefined) {
    const tidy = record["tidy"];
    if (!tidy || typeof tidy !== "object") return undefined;
    const raw = tidy as Record<string, unknown>;
    const parsed: NonNullable<UiSettingsPatch["tidy"]> = {};
    if (raw["enabled"] !== undefined) {
      if (typeof raw["enabled"] !== "boolean") return undefined;
      parsed.enabled = raw["enabled"];
    }
    for (const key of ["baseUrl", "model", "apiKey"] as const) {
      if (raw[key] !== undefined) {
        if (typeof raw[key] !== "string") return undefined;
        parsed[key] = raw[key] as string;
      }
    }
    patch.tidy = parsed;
  }
  return patch;
}

function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  opts: ServerOptions,
): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "只支持 GET");
    return;
  }
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    sendText(res, 400, "请求路径无效");
    return;
  }
  const target = path.resolve(opts.webRoot, `.${rel}`);
  const inside = target === opts.webRoot || target.startsWith(opts.webRoot + path.sep);
  if (inside && fs.existsSync(target) && fs.statSync(target).isFile()) {
    sendFile(req, res, target);
    return;
  }
  // 前端路由回退到 index.html；带点的会话/任务 id 也算路由，只有确实存在的静态扩展名才 404
  const ext = path.extname(rel).toLowerCase();
  if (ext === "" || MIME[ext] === undefined) {
    sendFile(req, res, path.join(opts.webRoot, "index.html"));
    return;
  }
  sendText(res, 404, "Not found");
}

function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string): void {
  const ext = path.extname(file).toLowerCase();
  res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (file.includes(`${path.sep}assets${path.sep}`) && ext !== ".html") {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("Cache-Control", "no-store");
  }
  if (req.method === "HEAD") {
    res.statusCode = 200;
    res.end();
    return;
  }
  res.statusCode = 200;
  const stream = fs.createReadStream(file);
  stream.on("error", () => {
    res.destroy();
  });
  stream.pipe(res);
}

function sendText(res: http.ServerResponse, status: number, text: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.end(text);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

const SESSION_STATUSES: SessionStatus[] = [
  "in_progress",
  "interrupted",
  "done",
  "abandoned",
  "unknown",
];

function parseStatusParam(
  raw: string | null,
): { ok: true; status?: SessionStatus } | { ok: false } {
  if (raw === null || raw === "") return { ok: true };
  return SESSION_STATUSES.includes(raw as SessionStatus)
    ? { ok: true, status: raw as SessionStatus }
    : { ok: false };
}
