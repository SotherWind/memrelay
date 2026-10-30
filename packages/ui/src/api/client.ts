import type {
  ApplyResponse,
  DashboardData,
  EmbeddingStatus,
  SummaryStatus,
  IntegrationsResponse,
  PrivacyResponse,
  ResumePreview,
  SessionMessagesResponse,
  SessionSummary,
  TaskDetail,
  TaskListSummary,
  TaskPage,
  TaskStatus,
  TerminalTestResult,
  TidyStatus,
  TrashItem,
  UiSettings,
  UiSettingsPatch,
} from "./types";

export class NotFoundError extends Error {}

async function sendJson<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${method} ${path} -> HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* 保持默认信息 */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export async function fetchHealth(): Promise<{ name: string; version: string }> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`GET /api/health -> HTTP ${res.status}`);
  return (await res.json()) as { name: string; version: string };
}

export async function fetchDashboard(): Promise<DashboardData> {
  const res = await fetch("/api/dashboard");
  if (!res.ok) throw new Error(`GET /api/dashboard -> HTTP ${res.status}`);
  return (await res.json()) as DashboardData;
}

export async function fetchTaskSummary(status?: TaskStatus, query?: string): Promise<TaskListSummary> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (query) params.set("q", query);
  const url = params.size > 0 ? `/api/tasks/summary?${params.toString()}` : "/api/tasks/summary";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET /api/tasks/summary -> HTTP ${res.status}`);
  return (await res.json()) as TaskListSummary;
}

export async function fetchProjectTasks(
  project: string,
  opts: { status?: TaskStatus; query?: string; offset?: number; limit?: number } = {},
): Promise<TaskPage> {
  const params = new URLSearchParams({ project });
  if (opts.status) params.set("status", opts.status);
  if (opts.query) params.set("q", opts.query);
  if (opts.offset) params.set("offset", String(opts.offset));
  if (opts.limit) params.set("limit", String(opts.limit));
  const res = await fetch(`/api/tasks?${params.toString()}`);
  if (!res.ok) throw new Error(`GET /api/tasks -> HTTP ${res.status}`);
  return (await res.json()) as TaskPage;
}

export async function reindexTasks(): Promise<{
  updated: number;
  skipped: number;
  durationMs: number;
}> {
  return await sendJson("POST", "/api/reindex", {});
}

export async function fetchTaskDetail(id: string): Promise<TaskDetail> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`);
  if (res.status === 404) throw new NotFoundError(id);
  if (!res.ok) throw new Error(`GET /api/tasks/${id} -> HTTP ${res.status}`);
  const data = (await res.json()) as { task: TaskDetail };
  return data.task;
}

export async function fetchResumePreview(id: string): Promise<ResumePreview> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}/resume-preview`);
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* 保持默认信息 */
    }
    throw new Error(message);
  }
  return (await res.json()) as ResumePreview;
}

export async function fetchSessions(query?: string): Promise<SessionSummary[]> {
  const url = query ? `/api/sessions?q=${encodeURIComponent(query)}` : "/api/sessions";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET /api/sessions -> HTTP ${res.status}`);
  const data = (await res.json()) as { sessions?: SessionSummary[] };
  return data.sessions ?? [];
}

export async function fetchSessionMessages(
  id: string,
  from: number,
  limit = 40,
): Promise<SessionMessagesResponse> {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(id)}/messages?from=${from}&limit=${limit}`,
  );
  if (res.status === 404) throw new NotFoundError(id);
  if (!res.ok) throw new Error(`GET /api/sessions/${id}/messages -> HTTP ${res.status}`);
  return (await res.json()) as SessionMessagesResponse;
}

export async function setTaskStatus(id: string, status: "done" | "abandoned" | null): Promise<TaskDetail> {
  const data = await sendJson<{ task: TaskDetail }>(
    "PUT",
    `/api/tasks/${encodeURIComponent(id)}/status`,
    { status },
  );
  return data.task;
}

export async function renameTask(id: string, title: string): Promise<TaskDetail> {
  const data = await sendJson<{ task: TaskDetail }>("PUT", `/api/tasks/${encodeURIComponent(id)}`, {
    title,
  });
  return data.task;
}

export async function splitTask(id: string, from: string): Promise<TaskDetail> {
  const data = await sendJson<{ task: TaskDetail }>(
    "POST",
    `/api/tasks/${encodeURIComponent(id)}/split`,
    { from },
  );
  return data.task;
}

export async function mergeTask(id: string, withId: string): Promise<TaskDetail> {
  const data = await sendJson<{ task: TaskDetail }>(
    "POST",
    `/api/tasks/${encodeURIComponent(id)}/merge`,
    { with: withId },
  );
  return data.task;
}

export async function resetTaskChain(id: string): Promise<TaskDetail> {
  const data = await sendJson<{ task: TaskDetail }>(
    "POST",
    `/api/tasks/${encodeURIComponent(id)}/reset-chain`,
    {},
  );
  return data.task;
}

export async function fetchTrash(): Promise<TrashItem[]> {
  const res = await fetch("/api/trash");
  if (!res.ok) throw new Error(`GET /api/trash -> HTTP ${res.status}`);
  const data = (await res.json()) as { items?: TrashItem[] };
  return data.items ?? [];
}

export async function deleteSessions(ids: string[]): Promise<TrashItem[]> {
  const data = await sendJson<{ items: TrashItem[] }>("POST", "/api/trash/delete", { ids });
  return data.items;
}

export async function restoreSessions(ids: string[]): Promise<TrashItem[]> {
  const data = await sendJson<{ items: TrashItem[] }>("POST", "/api/trash/restore", { ids });
  return data.items;
}

export async function fetchIntegrations(): Promise<IntegrationsResponse> {
  const res = await fetch("/api/integrations");
  if (!res.ok) throw new Error(`GET /api/integrations -> HTTP ${res.status}`);
  return (await res.json()) as IntegrationsResponse;
}

export async function applyIntegrations(enabled: Record<string, boolean>): Promise<ApplyResponse> {
  return await sendJson<ApplyResponse>("POST", "/api/integrations/apply", { enabled });
}

export async function runSelfTest(): Promise<TerminalTestResult[]> {
  const data = await sendJson<{ tests: TerminalTestResult[] }>("POST", "/api/integrations/selftest", {});
  return data.tests;
}

export async function fetchPrivacy(): Promise<PrivacyResponse> {
  const res = await fetch("/api/privacy");
  if (!res.ok) throw new Error(`GET /api/privacy -> HTTP ${res.status}`);
  return (await res.json()) as PrivacyResponse;
}

export async function saveExclusions(excludedDirs: string[]): Promise<string[]> {
  const data = await sendJson<{ excludedDirs: string[] }>("PUT", "/api/privacy/exclusions", { excludedDirs });
  return data.excludedDirs;
}

export async function fetchSettings(): Promise<UiSettings> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error(`GET /api/settings -> HTTP ${res.status}`);
  return (await res.json()) as UiSettings;
}

export async function saveSettings(patch: UiSettingsPatch): Promise<UiSettings> {
  return await sendJson<UiSettings>("PUT", "/api/settings", patch);
}

export async function fetchEmbeddingStatus(): Promise<EmbeddingStatus> {
  const res = await fetch("/api/embeddings/status");
  if (!res.ok) throw new Error(`GET /api/embeddings/status -> HTTP ${res.status}`);
  return (await res.json()) as EmbeddingStatus;
}

/** 立即回填；rebuild=true 时先删旧指纹的向量再全量重嵌（换模型/主机后的确认路径）。 */
export async function backfillEmbeddings(
  rebuild = false,
): Promise<{ started: boolean; status: EmbeddingStatus }> {
  return await sendJson<{ started: boolean; status: EmbeddingStatus }>(
    "POST",
    "/api/embeddings/backfill",
    { rebuild },
  );
}

/** 删除全部向量（唯一清除路径；停用只保留不删）。 */
export async function clearEmbeddings(): Promise<EmbeddingStatus> {
  const data = await sendJson<{ status: EmbeddingStatus }>("POST", "/api/embeddings/clear", {});
  return data.status;
}

export async function fetchSummaryStatus(): Promise<SummaryStatus> {
  const res = await fetch("/api/summaries/status");
  if (!res.ok) throw new Error(`GET /api/summaries/status -> HTTP ${res.status}`);
  return (await res.json()) as SummaryStatus;
}

/** 立即生成摘要；rebuild=true 时先删旧模型/主机的摘要再全量重生成。 */
export async function backfillSummaries(
  rebuild = false,
): Promise<{ started: boolean; status: SummaryStatus }> {
  return await sendJson<{ started: boolean; status: SummaryStatus }>(
    "POST",
    "/api/summaries/backfill",
    { rebuild },
  );
}

/** 删除全部摘要（唯一清除路径；停用只保留不删）。 */
export async function clearSummaries(): Promise<SummaryStatus> {
  const data = await sendJson<{ status: SummaryStatus }>("POST", "/api/summaries/clear", {});
  return data.status;
}

export async function fetchTidyStatus(): Promise<TidyStatus> {
  const res = await fetch("/api/tidy/status");
  if (!res.ok) throw new Error(`GET /api/tidy/status -> HTTP ${res.status}`);
  return (await res.json()) as TidyStatus;
}

export async function runTidyNow(): Promise<{ started: boolean; status: TidyStatus }> {
  return await sendJson<{ started: boolean; status: TidyStatus }>("POST", "/api/tidy/run", {});
}

export async function applyTidyPlan(): Promise<{ written: number; error?: string; status: TidyStatus }> {
  return await sendJson<{ written: number; error?: string; status: TidyStatus }>(
    "POST",
    "/api/tidy/apply",
    {},
  );
}

export async function undoTidy(): Promise<{ removed: string[]; status: TidyStatus }> {
  return await sendJson<{ removed: string[]; status: TidyStatus }>("POST", "/api/tidy/undo", {});
}
