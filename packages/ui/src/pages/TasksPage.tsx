import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { fetchProjectTasks, fetchTaskSummary, reindexTasks } from "../api/client";
import { toolLabel, type TaskListSummary, type TaskRow, type TaskStatus } from "../api/types";
import { Icon } from "../components/icons";
import { StatusBadge } from "../components/StatusBadge";
import { useI18n } from "../lib/i18n";
import { formatRelative } from "../lib/format";
import { cn } from "../lib/cn";

type Filter = "all" | TaskStatus;

const FILTERS: Filter[] = ["all", "interrupted", "in_progress", "done", "abandoned", "unknown"];

function readFilter(value: string | null): Filter {
  return FILTERS.find((item) => item === value) ?? "all";
}

/** 每个目录一次加载多少条任务 */
const PAGE_SIZE = 6;
/** 目录折叠栏默认露出的数量 */
const PROJECTS_STEP = 10;
/** 状态实时刷新：页面可见时每隔多久对一次表 */
const POLL_INTERVAL_MS = 30_000;
/** 轮询时最多把用户已加载的多少条任务重新对齐 */
const REFRESH_CAP = 1000;

interface ProjectState {
  tasks: TaskRow[];
  total: number;
  loading: boolean;
}

function total(task: TaskRow, key: "messageCount" | "fileCount"): number {
  return task.legs.reduce((sum, leg) => sum + leg[key], 0);
}

function headTool(task: TaskRow): string {
  return task.legs[task.legs.length - 1]?.tool ?? "";
}

export function TasksPage() {
  const { t, lang } = useI18n();
  const [summary, setSummary] = useState<TaskListSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  // 状态筛选由 URL 驱动：仪表盘的状态卡可以直接深链到对应筛选
  const filter = readFilter(searchParams.get("status"));
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const [reindexing, setReindexing] = useState(false);
  const [revealed, setRevealed] = useState(PROJECTS_STEP);
  const [open, setOpen] = useState<string[]>([]);
  const [pages, setPages] = useState<Record<string, ProjectState>>({});

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  const viewRef = useRef({ filter, query, open, pages });
  useEffect(() => {
    viewRef.current = { filter, query, open, pages };
  }, [filter, query, open, pages]);

  const loadPage = useCallback(
    async (project: string, opts: { offset?: number; append?: boolean; quiet?: boolean } = {}) => {
      const { filter: currentFilter, query: currentQuery } = viewRef.current;
      const status = currentFilter === "all" ? undefined : currentFilter;
      if (!opts.quiet) {
        setPages((prev) => ({
          ...prev,
          [project]: { ...(prev[project] ?? { tasks: [], total: 0 }), loading: true },
        }));
      }
      try {
        const page = await fetchProjectTasks(project, {
          status,
          query: currentQuery || undefined,
          offset: opts.offset ?? 0,
          limit: PAGE_SIZE,
        });
        // 筛选/搜索已切走：旧请求的结果不能覆盖新视图
        if (viewRef.current.filter !== currentFilter || viewRef.current.query !== currentQuery) return;
        setPages((prev) => {
          const existing = prev[project]?.tasks ?? [];
          return {
            ...prev,
            [project]: {
              tasks: opts.append ? [...existing, ...page.tasks] : page.tasks,
              total: page.total,
              loading: false,
            },
          };
        });
      } catch (err) {
        setPages((prev) => ({
          ...prev,
          [project]: { ...(prev[project] ?? { tasks: [], total: 0 }), loading: false },
        }));
        if (!opts.quiet) setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  const loadMore = useCallback(
    (project: string) => {
      const state = viewRef.current.pages[project];
      if (!state || state.loading || state.tasks.length >= state.total) return;
      void loadPage(project, { offset: state.tasks.length, append: true });
    },
    [loadPage],
  );

  const toggleProject = useCallback((project: string) => {
    setOpen((prev) => (prev.includes(project) ? prev.filter((item) => item !== project) : [...prev, project]));
  }, []);

  const applyFilter = (next: Filter) => {
    if (next === filter) return;
    const params = new URLSearchParams(searchParams);
    if (next === "all") params.delete("status");
    else params.set("status", next);
    setSearchParams(params, { replace: true });
  };

  // 首屏、切换筛选/搜索、手动重新索引：摘要和展开目录的第一页一起拿到后再整体替换，
  // 旧列表保持到新内容就绪，避免切 tab 时页面先塌成一行 loading 再撑开。
  useEffect(() => {
    let live = true;
    setError(null);
    const status = filter === "all" ? undefined : filter;
    const keyword = query || undefined;

    void (async () => {
      try {
        const next = await fetchTaskSummary(status, keyword);
        if (!live) return;
        const visible = new Set(next.projects.map((item) => item.project));
        const kept = viewRef.current.open.filter((project) => visible.has(project));
        const nextOpen =
          kept.length > 0 ? kept : next.projects.slice(0, 2).map((item) => item.project);
        const loaded = await Promise.all(
          nextOpen.map(async (project) => {
            try {
              const page = await fetchProjectTasks(project, {
                status,
                query: keyword,
                offset: 0,
                limit: PAGE_SIZE,
              });
              return [project, { tasks: page.tasks, total: page.total, loading: false }] as const;
            } catch {
              return null; // 单个目录失败降级：交给 pages effect 按需重试
            }
          }),
        );
        if (!live) return;
        setSummary(next);
        setPages(Object.fromEntries(loaded.filter((entry) => entry !== null)));
        setOpen(nextOpen);
        setRevealed(PROJECTS_STEP);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      live = false;
    };
  }, [filter, query, reloadTick]);

  // 展开的目录按需取第一页
  useEffect(() => {
    if (!summary) return;
    for (const project of open) {
      if (pages[project] === undefined) void loadPage(project);
    }
  }, [summary, open, pages, loadPage]);

  // 状态实时刷新：摘要 + 已展开目录的已加载区段，静默替换（失败保留旧值）
  const quietRefresh = useCallback(async () => {
    const { filter: currentFilter, query: currentQuery, open: openList, pages: pagesMap } =
      viewRef.current;
    const status = currentFilter === "all" ? undefined : currentFilter;
    try {
      const next = await fetchTaskSummary(status, currentQuery || undefined);
      if (viewRef.current.filter !== currentFilter || viewRef.current.query !== currentQuery) return;
      setSummary(next);
    } catch {
      /* 静默：保留旧数据 */
    }
    for (const project of openList) {
      const loaded = pagesMap[project];
      if (!loaded || loaded.loading || loaded.tasks.length === 0) continue;
      if (loaded.tasks.length > REFRESH_CAP) continue;
      try {
        const wanted = loaded.tasks.length;
        const tasks: TaskRow[] = [];
        let offset = 0;
        let pageTotal = loaded.total;
        while (tasks.length < wanted) {
          const limit = Math.min(200, wanted - tasks.length);
          const page = await fetchProjectTasks(project, {
            status,
            query: currentQuery || undefined,
            offset,
            limit,
          });
          tasks.push(...page.tasks);
          pageTotal = page.total;
          if (page.tasks.length < limit) break;
          offset += page.tasks.length;
        }
        if (viewRef.current.filter !== currentFilter || viewRef.current.query !== currentQuery) return;
        setPages((prev) => ({ ...prev, [project]: { tasks, total: pageTotal, loading: false } }));
      } catch {
        /* 静默 */
      }
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void quietRefresh();
    }, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (!document.hidden) void quietRefresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [quietRefresh]);

  const runReindex = async () => {
    setReindexing(true);
    setError(null);
    try {
      await reindexTasks();
      setReloadTick((tick) => tick + 1);
    } catch (err) {
      setError(t("tasks.reindexFailed", { err: err instanceof Error ? err.message : String(err) }));
    } finally {
      setReindexing(false);
    }
  };

  const projects = summary?.projects ?? [];
  const shown = projects.slice(0, revealed);
  const queryActive = query.length > 0;
  const activeCount = queryActive ? 0 : (summary?.counts.in_progress ?? 0);
  const allCount = summary
    ? queryActive
      ? summary.total
      : Object.values(summary.counts).reduce((sum, value) => sum + value, 0)
    : undefined;

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("tasks.title")}</h1>
          {summary && (
            <p className="page-sub">
              {t("tasks.dirs", { n: projects.length })}
              <span className="dot-sep" />
              {t("tasks.total", { n: summary.total })}
              {activeCount > 0 && (
                <>
                  <span className="dot-sep" />
                  <span className="strong-green">{t("tasks.active", { n: activeCount })}</span>
                </>
              )}
            </p>
          )}
        </div>
        <div className="head-actions">
          <label className="search-box">
            <Icon name="search" />
            <input
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              placeholder={t("tasks.searchPlaceholder")}
            />
          </label>
          <button type="button" className="btn btn-secondary" disabled={reindexing} onClick={() => void runReindex()}>
            <Icon name="refresh" className={reindexing ? "spin" : undefined} />
            {reindexing ? t("tasks.reindexing") : t("tasks.reindex")}
          </button>
        </div>
      </header>

      <div className="filter-row">
        <div className="filters">
          {FILTERS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => applyFilter(item)}
              className={cn("pill", filter === item && "active")}
            >
              {t(`tasks.filter.${item}`)}
              <span className="num">
                {summary
                  ? item === "all"
                    ? allCount
                    : queryActive
                      ? "–"
                      : summary.counts[item]
                  : "–"}
              </span>
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="card state-card">
          <p className="title">{t("tasks.error")}</p>
          <p className="detail">{error}</p>
        </div>
      ) : !summary ? (
        <p className="loading-note">{t("tasks.loading")}</p>
      ) : projects.length === 0 ? (
        <div className="card state-card">
          <p className="title">{query ? t("tasks.searchEmpty") : t("tasks.empty")}</p>
        </div>
      ) : (
        <div className="flex flex-col">
          {shown.map((project) => {
            const isOpen = open.includes(project.project);
            const page = pages[project.project];
            const tasks = page?.tasks ?? [];
            const hasMore = page !== undefined && tasks.length < page.total;
            return (
              <section key={project.project} className="card group-card">
                <button
                  type="button"
                  onClick={() => toggleProject(project.project)}
                  aria-expanded={isOpen}
                  className="group-head"
                >
                  <span className="group-icon">
                    <Icon name="folder" />
                  </span>
                  <span className="min-w-0">
                    <span className="group-path block">{project.project}</span>
                    <span className="group-meta block">
                      {t("tasks.groupMeta", {
                        n: project.count,
                        time: formatRelative(project.lastActiveAt, lang),
                      })}
                    </span>
                  </span>
                  <Icon name="chevron-down" className={cn("chevron", !isOpen && "closed")} />
                </button>

                {isOpen && (
                  <>
                    {page === undefined || (page.loading && tasks.length === 0) ? (
                      <p className="group-loading">{t("tasks.loading")}</p>
                    ) : tasks.length === 0 ? (
                      <p className="group-loading">{t("tasks.projectEmpty")}</p>
                    ) : (
                      tasks.map((task) => {
                        const tool = headTool(task);
                        return (
                          <Link
                            key={task.id}
                            to={`/tasks/${encodeURIComponent(task.id)}`}
                            className="task-row"
                          >
                            <div className="task-main">
                              <div dir="auto" className={cn("task-title", task.status === "abandoned" && "is-abandoned")}>
                                {task.title}
                              </div>
                              {task.summary && <div className="task-snippet">{task.summary}</div>}
                              <div className="task-meta">
                                <span className="tool-dot" data-tool={tool} />
                                {toolLabel(tool)}
                              </div>
                            </div>
                            <div className="task-side">
                              <StatusBadge status={task.status} />
                              <span className="time">{formatRelative(task.lastActiveAt, lang)}</span>
                              <span className="counts">
                                {t("tasks.messages", { n: total(task, "messageCount") })} ·{" "}
                                {t("tasks.files", { n: total(task, "fileCount") })}
                              </span>
                            </div>
                            <span className="row-chevron">
                              <Icon name="chevron-right" className="ico-sm" />
                            </span>
                          </Link>
                        );
                      })
                    )}

                    {hasMore && (
                      <button type="button" className="group-foot" onClick={() => loadMore(project.project)}>
                        {page.loading
                          ? t("tasks.loadingMore")
                          : t("tasks.viewAll", { n: page.total })}
                        <Icon name="chevron-right" className="ico-sm" />
                      </button>
                    )}
                  </>
                )}
              </section>
            );
          })}

          {projects.length > revealed && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setRevealed((n) => n + PROJECTS_STEP)}
            >
              {t("tasks.moreProjects", { n: projects.length - revealed })}
            </button>
          )}
        </div>
      )}
    </>
  );
}
