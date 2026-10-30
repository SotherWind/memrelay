import type { DatabaseSync } from "node:sqlite";

import type { Env, SessionStatus } from "../core/types.js";
import {
  isDirExcluded,
  isSessionDeleted,
  loadFilters,
  manualStatusFor,
  type Filters,
} from "../core/filters.js";
import {
  computeSessionStats,
  MtimeResolver,
  statusFromSignals,
  type StoredSignals,
} from "../store/session-stats.js";
import { getSessionSummaries } from "../store/summaries-store.js";
import { getSessionNames, type SessionName } from "../store/names-store.js";
import { displayTitle } from "../store/titles.js";

export interface TaskLegDto {
  tool: string;
  startedAt: number;
  endedAt: number;
  messageCount: number;
  fileCount: number;
}

export interface TaskLegDetailDto extends TaskLegDto {
  sessionId: string;
  title: string | null;
  gitBranch: string | null;
}

export interface TaskDto {
  id: string;
  project: string;
  title: string;
  status: SessionStatus;
  lastActiveAt: number;
  legs: TaskLegDto[];
  /** 最新一腿的会话摘要（AI 摘要，未开启/未生成时 null） */
  summary: string | null;
}

export interface TaskDetailDto extends Omit<TaskDto, "legs"> {
  legs: TaskLegDetailDto[];
  /** 是否有手动标记的状态覆盖 */
  manual: boolean;
  /** 任务名是否被手动改过 */
  manualName: boolean;
  /** 接力链是否是手动整理的 */
  manualChain: boolean;
}

export interface TaskProjectDto {
  project: string;
  count: number;
  lastActiveAt: number;
}

export interface TaskSummaryDto {
  total: number;
  counts: Record<SessionStatus, number>;
  projects: TaskProjectDto[];
}

export interface TaskPageDto {
  tasks: TaskDto[];
  total: number;
}

interface SessionRow {
  id: string;
  agent: string;
  project: string;
  title: string | null;
  firstUser: string | null;
  startedAt: string;
  endedAt: string;
  gitBranch: string | null;
  storedStatus: SessionStatus;
  signals: StoredSignals;
  mtimeMs: number;
  sourcePath: string | null;
  messageCount: number;
  fileCount: number;
}

function parseIsoMs(iso: string | null): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

function titleOf(row: SessionRow, names?: Map<string, SessionName>): string {
  const generated = names?.get(row.id)?.name;
  return (
    displayTitle({
      agent: row.agent,
      title: row.title,
      firstUser: row.firstUser,
      generated,
    }) ?? row.id
  );
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(",");
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 会话行（去掉空壳、被删的、没有项目归属的）；统计与状态信号来自索引时落库的列。 */
function loadSessions(
  db: DatabaseSync,
  env: Env,
  filters: Filters,
  ids?: string[],
): Map<string, SessionRow> {
  const where = ids ? `AND s.id IN (${placeholders(ids.length)})` : "";
  const sql = `SELECT s.id, s.agent, s.project_root, s.title, s.first_user_message, s.started_at, s.ended_at,
              s.git_branch, s.status, s.source_path, s.cwd, COALESCE(src.mtime_ms, 0) AS mtime_ms,
              s.message_count, s.file_count,
              s.sig_pending, s.sig_quota, s.sig_error, s.sig_unanswered, s.sig_todos_open,
              s.sig_last_real, s.sig_reply_len
       FROM sessions s
       LEFT JOIN sources src ON src.path = s.source_path
       WHERE s.deleted_at IS NULL AND s.project_root IS NOT NULL AND s.project_root <> '' ${where}`;
  const raw = (ids ? db.prepare(sql).all(...ids) : db.prepare(sql).all()) as Array<
    Record<string, unknown>
  >;
  const out = new Map<string, SessionRow>();
  for (const r of raw) {
    const id = String(r["id"]);
    const messageCount = num(r["message_count"], -1);
    if (messageCount === 0) continue; // 空壳会话（没有任何消息）不展示
    if (isSessionDeleted(id, filters)) continue;
    const cwd = typeof r["cwd"] === "string" ? r["cwd"] : "";
    if (cwd && isDirExcluded(cwd, filters, env.platform)) continue;
    const lastReal = r["sig_last_real"];
    out.set(id, {
      id,
      agent: String(r["agent"]),
      project: String(r["project_root"]),
      title: typeof r["title"] === "string" ? r["title"] : null,
      firstUser: typeof r["first_user_message"] === "string" ? r["first_user_message"] : null,
      startedAt: typeof r["started_at"] === "string" ? r["started_at"] : "",
      endedAt: typeof r["ended_at"] === "string" ? r["ended_at"] : "",
      gitBranch: typeof r["git_branch"] === "string" ? r["git_branch"] : null,
      storedStatus: String(r["status"]) as SessionStatus,
      signals: {
        pending: num(r["sig_pending"]) === 1,
        quota: num(r["sig_quota"]) === 1,
        error: num(r["sig_error"]) === 1,
        unanswered: num(r["sig_unanswered"]) === 1,
        todosOpen: num(r["sig_todos_open"]) === 1,
        lastReal:
          lastReal === "user" || lastReal === "assistant" || lastReal === "system"
            ? lastReal
            : null,
        replyLen: num(r["sig_reply_len"]),
      },
      mtimeMs: num(r["mtime_ms"]),
      sourcePath: typeof r["source_path"] === "string" ? r["source_path"] : null,
      messageCount,
      fileCount: num(r["file_count"], -1),
    });
  }
  return out;
}

/** 实时状态：手动标记优先；否则用"库里的信号 + 查询时刻"重算（进行中会随时间自然降级）。 */
function liveStatusOf(row: SessionRow, filters: Filters, mtimeMs: number, now: number): SessionStatus {
  const manual = manualStatusFor(row.id, filters);
  if (manual) return manual;
  if (row.messageCount < 0) return row.storedStatus; // 还没回填信号：退回索引时的快照
  return statusFromSignals(row.signals, mtimeMs, now);
}

interface TaskGroup {
  id: string;
  title: string;
  project: string;
  members: SessionRow[];
}

/**
 * 任务分组：
 * - 有接力链的会话串成一个任务（标题优先 AI 任务名，其次 tasks.name，腿按 position 排序）；
 * - 其余会话各自成一个任务（标题用会话标题或首条指令）；
 * - 手动整理的链接管被它覆盖的会话（自动链与单会话投影都要让位）。
 */
function buildTaskGroups(
  db: DatabaseSync,
  sessions: Map<string, SessionRow>,
  filters: Filters,
  names: Map<string, SessionName> = new Map(),
): TaskGroup[] {
  const manualChains = filters.manualChains ?? [];
  const manualPlaced = new Set(manualChains.flat());

  const chains = new Map<number, { name: string | null; members: SessionRow[] }>();
  const placed = new Set<string>();
  for (const r of db
    .prepare(
      `SELECT ts.task_id AS task_id, ts.session_id AS sid, t.name AS name
       FROM task_sessions ts JOIN tasks t ON t.id = ts.task_id
       ORDER BY ts.task_id, ts.position`,
    )
    .all() as Array<{ task_id: number; sid: string; name: string | null }>) {
    const session = sessions.get(r.sid);
    if (!session) continue;
    if (manualPlaced.has(r.sid)) continue; // 这条会话由手动链接管
    placed.add(r.sid);
    let chain = chains.get(r.task_id);
    if (!chain) {
      chain = { name: r.name, members: [] };
      chains.set(r.task_id, chain);
    }
    chain.members.push(session);
  }

  const generatedOf = (members: SessionRow[]): string | undefined =>
    members.map((member) => names.get(member.id)?.name?.trim()).find(Boolean);

  const groups: TaskGroup[] = [];
  for (const chain of chains.values()) {
    const first = chain.members[0]!;
    if (chain.members.length >= 2) {
      // 任务身份用"根会话 id"而不是 tasks 表的自增行号：
      // 会话被重新索引时链接行会重建（行号漂移），根会话 id 始终稳定。
      groups.push({
        id: `task:${first.id}`,
        title: generatedOf(chain.members) || chain.name?.trim() || titleOf(first, names),
        project: first.project,
        members: chain.members,
      });
    } else {
      for (const member of chain.members) {
        groups.push({
          id: member.id,
          title: names.get(member.id)?.name?.trim() || titleOf(member, names),
          project: member.project,
          members: [member],
        });
      }
    }
  }
  for (const session of sessions.values()) {
    if (placed.has(session.id) || manualPlaced.has(session.id)) continue;
    groups.push({
      id: session.id,
      title: names.get(session.id)?.name?.trim() || titleOf(session, names),
      project: session.project,
      members: [session],
    });
  }
  // 手动链：按链上顺序取成员（被删/被排除的成员自动缺席）
  for (const chain of manualChains) {
    const members = chain
      .map((id) => sessions.get(id))
      .filter((member): member is SessionRow => member !== undefined);
    if (members.length === 0) continue;
    groups.push({
      id: `task:${members[0]!.id}`,
      title: generatedOf(members) || titleOf(members[0]!, names),
      project: members[0]!.project,
      members,
    });
  }

  for (const group of groups) {
    const renamed = filters.manualNames[group.id];
    if (renamed !== undefined) group.title = renamed;
  }
  return groups;
}

interface ResolvedHead {
  status: SessionStatus;
  lastActiveAt: number;
}

function resolveHead(
  group: TaskGroup,
  filters: Filters,
  resolver: MtimeResolver,
  now: number,
  alwaysStat: boolean,
): ResolvedHead {
  const head = group.members[group.members.length - 1]!;
  const mtimeMs = resolver.resolve(head.sourcePath, head.mtimeMs, alwaysStat);
  return {
    status: liveStatusOf(head, filters, mtimeMs, now),
    lastActiveAt: mtimeMs || parseIsoMs(head.endedAt) || parseIsoMs(head.startedAt) || 0,
  };
}

/** 补统计：老库还没回填（message_count < 0）的会话，在这里按需算一遍（量 = 当前展示的页）。 */
function ensureStats(db: DatabaseSync, rows: SessionRow[]): void {
  const missing = rows.filter((r) => r.messageCount < 0).map((r) => r.id);
  if (missing.length === 0) return;
  const stats = computeSessionStats(db, missing);
  for (const row of rows) {
    if (row.messageCount >= 0) continue;
    const s = stats.get(row.id);
    row.messageCount = s?.messageCount ?? 0;
    row.fileCount = s?.fileCount ?? 0;
    if (s) {
      row.signals = {
        pending: s.pending,
        quota: s.quota,
        error: s.error,
        unanswered: s.unanswered,
        todosOpen: s.todosOpen,
        lastReal: s.lastReal,
        replyLen: s.replyLen,
      };
    }
  }
}

function legOf(member: SessionRow): TaskLegDto {
  return {
    tool: member.agent,
    startedAt: parseIsoMs(member.startedAt) ?? member.mtimeMs,
    endedAt: parseIsoMs(member.endedAt) ?? member.mtimeMs,
    messageCount: Math.max(0, member.messageCount),
    fileCount: Math.max(0, member.fileCount),
  };
}

function taskOf(
  group: TaskGroup,
  head: ResolvedHead,
  forcedStatus?: SessionStatus,
  summary: string | null = null,
): TaskDto {
  const first = group.members[0]!;
  return {
    id: group.id,
    project: first.project,
    title: group.title,
    status: forcedStatus ?? head.status,
    lastActiveAt: head.lastActiveAt,
    legs: group.members.map(legOf),
    summary,
  };
}

/** 最新一腿（摘要投影用）：按 startedAt（缺省 mtime）取最新的成员。 */
function latestMember(members: SessionRow[]): SessionRow {
  return members.reduce((a, b) =>
    (parseIsoMs(b.startedAt) ?? b.mtimeMs) >= (parseIsoMs(a.startedAt) ?? a.mtimeMs) ? b : a,
  );
}

function emptyCounts(): Record<SessionStatus, number> {
  return { in_progress: 0, interrupted: 0, done: 0, abandoned: 0, unknown: 0 };
}

export interface TaskSummaryOptions {
  /** 只统计某个状态的目录（按筛选标签过滤时用）；counts 始终是全局的。 */
  status?: SessionStatus;
  /** 任务名 / 目录路径的子串匹配；counts 仍按全量统计。 */
  query?: string;
  now?: number;
}

function matchesQuery(group: TaskGroup, query: string): boolean {
  const needle = query.toLowerCase();
  return (
    group.title.toLowerCase().includes(needle) || group.project.toLowerCase().includes(needle)
  );
}

/** 任务总览：状态计数 + 目录列表（按目录内最新活动倒序）。 */
export function listTaskSummary(
  db: DatabaseSync,
  env: Env,
  opts: TaskSummaryOptions = {},
): TaskSummaryDto {
  const now = opts.now ?? Date.now();
  const filters = loadFilters(env);
  const sessions = loadSessions(db, env, filters);
  // 列表显示的是 AI 任务名（与 /api/tasks 一致）；摘要与搜索也必须用同一套名字。
  const names = getSessionNames(db, [...sessions.keys()]);
  const groups = buildTaskGroups(db, sessions, filters, names);
  const resolver = new MtimeResolver(now);

  const counts = emptyCounts();
  const projects = new Map<string, TaskProjectDto>();
  let total = 0;
  for (const group of groups) {
    const head = resolveHead(group, filters, resolver, now, false);
    counts[head.status] += 1;
    if (opts.query && !matchesQuery(group, opts.query)) continue;
    total += 1;
    if (opts.status && head.status !== opts.status) continue;
    const entry = projects.get(group.project) ?? {
      project: group.project,
      count: 0,
      lastActiveAt: 0,
    };
    entry.count += 1;
    entry.lastActiveAt = Math.max(entry.lastActiveAt, head.lastActiveAt);
    projects.set(group.project, entry);
  }

  const list = [...projects.values()].sort(
    (a, b) => b.lastActiveAt - a.lastActiveAt || (a.project < b.project ? -1 : 1),
  );
  return { total, counts, projects: list };
}

export interface TaskPageOptions {
  project: string;
  status?: SessionStatus;
  /** 任务名 / 目录路径的子串匹配。 */
  query?: string;
  offset?: number;
  limit?: number;
  now?: number;
}

/** 单个目录下的任务分页：按最近活动倒序。 */
export function listProjectTasks(
  db: DatabaseSync,
  env: Env,
  opts: TaskPageOptions,
): TaskPageDto {
  const now = opts.now ?? Date.now();
  const filters = loadFilters(env);
  const sessions = loadSessions(db, env, filters);
  const names = getSessionNames(db, [...sessions.keys()]);
  const groups = buildTaskGroups(db, sessions, filters, names);
  const resolver = new MtimeResolver(now);

  const matched: TaskDto[] = [];
  const latestSessionId = new Map<string, string>();
  for (const group of groups) {
    if (group.project !== opts.project) continue;
    if (opts.query && !matchesQuery(group, opts.query)) continue;
    ensureStats(db, group.members);
    const head = resolveHead(group, filters, resolver, now, true);
    if (opts.status && head.status !== opts.status) continue;
    latestSessionId.set(group.id, latestMember(group.members).id);
    matched.push(taskOf(group, head));
  }
  matched.sort((a, b) => b.lastActiveAt - a.lastActiveAt || (a.id < b.id ? -1 : 1));

  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 200);
  const page = matched.slice(offset, offset + limit);
  // 摘要只给当前页取（任务列表行显示"最新一腿"的 AI 摘要）
  const summaries = getSessionSummaries(
    db,
    page.map((task) => latestSessionId.get(task.id)!),
  );
  for (const task of page) {
    task.summary = summaries.get(latestSessionId.get(task.id)!) ?? null;
  }
  return { tasks: page, total: matched.length };
}

export interface DashboardTaskDto {
  id: string;
  project: string;
  title: string;
  status: SessionStatus;
  lastActiveAt: number;
  /** 这条任务经过的工具（去重、按腿顺序）；跨工具接力时长度 ≥ 2 */
  tools: string[];
  messageCount: number;
  fileCount: number;
  summary: string | null;
}

export interface DashboardToolDto {
  tool: string;
  sessions: number;
}

export interface DashboardDayDto {
  /** 本地日期 YYYY-MM-DD */
  date: string;
  sessions: number;
}

export interface DashboardDto {
  total: number;
  counts: Record<SessionStatus, number>;
  /** 回收站里的会话数（点击卡片进入回收站） */
  trash: number;
  projects: { total: number; top: TaskProjectDto[] };
  tools: DashboardToolDto[];
  /** 最近 N 天每天有写入的会话数（含今天；按本地日期分桶） */
  activity: DashboardDayDto[];
  recent: DashboardTaskDto[];
  /** 中断、等待接手的任务（按最近活动倒序） */
  attention: DashboardTaskDto[];
  /** 最近一次会话写入时间（毫秒）；索引为空时为 null */
  lastWriteAt: number | null;
}

export interface DashboardOptions {
  now?: number;
  days?: number;
  recentLimit?: number;
  attentionLimit?: number;
}

function localDayKey(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function distinctTools(group: TaskGroup): string[] {
  const tools: string[] = [];
  for (const member of group.members) {
    if (!tools.includes(member.agent)) tools.push(member.agent);
  }
  return tools;
}

/**
 * 仪表盘总览：一次扫描给出状态计数、接力概况、工具/目录分布、近期活动与需要接手的中断任务。
 * 任务分组与状态口径与任务列表完全一致（同一套 loadSessions / buildTaskGroups / liveStatusOf）。
 */
export function getDashboard(
  db: DatabaseSync,
  env: Env,
  opts: DashboardOptions = {},
): DashboardDto {
  const now = opts.now ?? Date.now();
  const days = Math.max(1, opts.days ?? 14);
  const recentLimit = Math.max(1, opts.recentLimit ?? 6);
  const attentionLimit = Math.max(0, opts.attentionLimit ?? 5);
  const filters = loadFilters(env);
  const sessions = loadSessions(db, env, filters);
  const names = getSessionNames(db, [...sessions.keys()]);
  const groups = buildTaskGroups(db, sessions, filters, names);
  const resolver = new MtimeResolver(now);

  const toolSessions = new Map<string, number>();
  const daily = new Map<string, number>();
  let lastWriteAt = 0;
  for (const session of sessions.values()) {
    lastWriteAt = Math.max(lastWriteAt, session.mtimeMs);
    toolSessions.set(session.agent, (toolSessions.get(session.agent) ?? 0) + 1);
    if (session.mtimeMs > 0) {
      const key = localDayKey(session.mtimeMs);
      daily.set(key, (daily.get(key) ?? 0) + 1);
    }
  }

  const counts = emptyCounts();
  const projects = new Map<string, TaskProjectDto>();
  const entries: Array<{ group: TaskGroup; head: ResolvedHead }> = [];
  for (const group of groups) {
    const head = resolveHead(group, filters, resolver, now, false);
    counts[head.status] += 1;
    const project = projects.get(group.project) ?? {
      project: group.project,
      count: 0,
      lastActiveAt: 0,
    };
    project.count += 1;
    project.lastActiveAt = Math.max(project.lastActiveAt, head.lastActiveAt);
    projects.set(group.project, project);
    entries.push({ group, head });
  }

  entries.sort(
    (a, b) => b.head.lastActiveAt - a.head.lastActiveAt || (a.group.id < b.group.id ? -1 : 1),
  );

  const recent = entries.slice(0, recentLimit);
  const attention = entries
    .filter((entry) => entry.head.status === "interrupted")
    .slice(0, attentionLimit);
  const picked = [...recent, ...attention.filter((entry) => !recent.includes(entry))];

  const latestOf = new Map<string, string>();
  for (const entry of picked) {
    // 展示态用 stat 校验后的最新 mtime，时间和状态与详情页一致
    entry.head = resolveHead(entry.group, filters, resolver, now, true);
    ensureStats(db, entry.group.members);
    latestOf.set(entry.group.id, latestMember(entry.group.members).id);
  }
  const summaries = getSessionSummaries(db, [...latestOf.values()]);
  const summariesFor = new Map<string, string>();
  for (const [groupId, sessionId] of latestOf) {
    const summary = summaries.get(sessionId);
    if (summary) summariesFor.set(groupId, summary);
  }

  const toTask = (entry: { group: TaskGroup; head: ResolvedHead }): DashboardTaskDto => {
    const members = entry.group.members;
    return {
      id: entry.group.id,
      project: entry.group.project,
      title: entry.group.title,
      status: entry.head.status,
      lastActiveAt: entry.head.lastActiveAt,
      tools: distinctTools(entry.group),
      messageCount: members.reduce((sum, member) => sum + Math.max(0, member.messageCount), 0),
      fileCount: members.reduce((sum, member) => sum + Math.max(0, member.fileCount), 0),
      summary: summariesFor.get(entry.group.id) ?? null,
    };
  };

  const activity: DashboardDayDto[] = [];
  const cursor = new Date(now);
  cursor.setHours(12, 0, 0, 0);
  for (let offset = days - 1; offset >= 0; offset--) {
    const day = new Date(cursor);
    day.setDate(cursor.getDate() - offset);
    const key = localDayKey(day.getTime());
    activity.push({ date: key, sessions: daily.get(key) ?? 0 });
  }

  return {
    total: groups.length,
    counts,
    trash: filters.deletedSessions.length,
    projects: {
      total: projects.size,
      top: [...projects.values()]
        .sort(
          (a, b) =>
            b.lastActiveAt - a.lastActiveAt || (a.project < b.project ? -1 : 1),
        )
        .slice(0, 8),
    },
    tools: [...toolSessions.entries()]
      .map(([tool, sessions]) => ({ tool, sessions }))
      .sort((a, b) => b.sessions - a.sessions || (a.tool < b.tool ? -1 : 1)),
    activity,
    recent: recent.map(toTask),
    attention: attention.map(toTask),
    lastWriteAt: lastWriteAt > 0 ? lastWriteAt : null,
  };
}

/** 链任务按"根会话 id"找成员：先定位根会话所在的链，再按 position 排序。 */
function chainTaskIdOf(db: DatabaseSync, rootSessionId: string): number | undefined {
  const link = db
    .prepare("SELECT task_id AS tid FROM task_sessions WHERE session_id = ? ORDER BY task_id LIMIT 1")
    .get(rootSessionId) as { tid?: number } | undefined;
  return link?.tid;
}

/** 单个任务详情：手动链优先；自动链按 position 排腿；单会话任务只有一条腿。 */
export function getTaskDetail(
  db: DatabaseSync,
  env: Env,
  taskId: string,
  opts: { now?: number } = {},
): TaskDetailDto | undefined {
  const now = opts.now ?? Date.now();
  const filters = loadFilters(env);
  const manualChains = filters.manualChains ?? [];

  let sessionIds: string[];
  let chainName: string | null = null;
  let fromManual = false;
  if (taskId.startsWith("task:")) {
    const root = taskId.slice("task:".length);
    const manual = root ? manualChains.find((chain) => chain.includes(root)) : undefined;
    if (manual) {
      sessionIds = manual;
      fromManual = true;
    } else {
      const numeric = root ? chainTaskIdOf(db, root) : undefined;
      if (numeric === undefined) return undefined;
      const links = db
        .prepare("SELECT session_id AS sid FROM task_sessions WHERE task_id = ? ORDER BY position")
        .all(numeric) as Array<{ sid: string }>;
      if (links.length === 0) return undefined;
      const task = db.prepare("SELECT name FROM tasks WHERE id = ?").get(numeric) as
        | { name?: string | null }
        | undefined;
      chainName = task?.name ?? null;
      sessionIds = links.map((link) => link.sid);
    }
  } else {
    const manual = manualChains.find((chain) => chain.includes(taskId));
    if (manual) {
      sessionIds = manual;
      fromManual = true;
    } else {
      sessionIds = [taskId];
    }
  }

  const sessions = loadSessions(db, env, filters, sessionIds);
  const members = sessionIds
    .map((id) => sessions.get(id))
    .filter((member): member is SessionRow => member !== undefined);
  if (members.length === 0) return undefined;
  ensureStats(db, members);

  const canonicalId = fromManual || members.length >= 2 ? `task:${members[0]!.id}` : members[0]!.id;
  const names = getSessionNames(db, members.map((member) => member.id));
  const generated = members
    .map((member) => names.get(member.id)?.name?.trim())
    .find(Boolean);
  const group: TaskGroup = {
    id: canonicalId,
    title:
      filters.manualNames[canonicalId] ??
      generated ??
      chainName?.trim() ??
      titleOf(members[0]!, names),
    project: members[0]!.project,
    members,
  };
  const head = resolveHead(group, filters, new MtimeResolver(now), now, true);
  const latestId = latestMember(members).id;
  const summary = getSessionSummaries(db, [latestId]).get(latestId) ?? null;
  const base = taskOf(group, head, undefined, summary);
  return {
    ...base,
    manual: members.some((member) => manualStatusFor(member.id, filters) !== undefined),
    manualName: filters.manualNames[canonicalId] !== undefined,
    manualChain: fromManual,
    legs: members.map((member) => ({
      ...legOf(member),
      sessionId: member.id,
      title: titleOf(member, names),
      gitBranch: member.gitBranch,
    })),
  };
}

/** 任务续接预览要用：接力棒现在停在哪一段会话、它属于哪个项目（手动链取链尾）。 */
export function resolveTaskHead(
  db: DatabaseSync,
  env: Env,
  taskId: string,
): { sessionId: string; project: string } | undefined {
  const manualChains = loadFilters(env).manualChains ?? [];
  let headId: string | undefined;
  if (taskId.startsWith("task:")) {
    const root = taskId.slice("task:".length);
    const manual = root ? manualChains.find((chain) => chain.includes(root)) : undefined;
    if (manual) {
      headId = manual[manual.length - 1];
    } else {
      const numeric = root ? chainTaskIdOf(db, root) : undefined;
      if (numeric === undefined) return undefined;
      const row = db
        .prepare("SELECT session_id AS sid FROM task_sessions WHERE task_id = ? ORDER BY position DESC LIMIT 1")
        .get(numeric) as { sid?: string } | undefined;
      if (!row?.sid) return undefined;
      headId = row.sid;
    }
  } else {
    const manual = manualChains.find((chain) => chain.includes(taskId));
    headId = manual ? manual[manual.length - 1] : taskId;
  }
  if (!headId) return undefined;

  const session = db
    .prepare(
      `SELECT project_root FROM sessions
       WHERE id = ? AND deleted_at IS NULL AND project_root IS NOT NULL AND project_root <> ''`,
    )
    .get(headId) as { project_root?: string } | undefined;
  if (!session?.project_root) return undefined;
  return { sessionId: headId, project: session.project_root };
}
