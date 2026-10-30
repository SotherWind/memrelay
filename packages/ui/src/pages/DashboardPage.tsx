import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { fetchDashboard } from "../api/client";
import { toolLabel, type DashboardData, type DashboardTask } from "../api/types";
import { Icon, type IconName } from "../components/icons";
import { StatusBadge } from "../components/StatusBadge";
import { useI18n } from "../lib/i18n";
import { formatRelative } from "../lib/format";
import { cn } from "../lib/cn";

/** 与任务列表一致：页面可见时每 30 秒静默对一次表 */
const REFRESH_MS = 30_000;

interface Kpi {
  key: string;
  icon: IconName;
  tone: string;
  label: string;
  value: number;
  to: string;
}

export function DashboardPage() {
  const { t, lang } = useI18n();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const requestId = useRef(0);

  const load = useCallback(async (quiet: boolean) => {
    const id = ++requestId.current;
    if (!quiet) setBusy(true);
    try {
      const next = await fetchDashboard();
      if (id !== requestId.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (id !== requestId.current) return;
      if (!quiet) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(true);
    }, REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) void load(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const kpis: Kpi[] = data
    ? [
        {
          key: "in_progress",
          icon: "zap",
          tone: "si-green",
          label: t("status.in_progress"),
          value: data.counts.in_progress,
          to: "/tasks?status=in_progress",
        },
        {
          key: "interrupted",
          icon: "clock",
          tone: "si-amber",
          label: t("status.interrupted"),
          value: data.counts.interrupted,
          to: "/tasks?status=interrupted",
        },
        {
          key: "done",
          icon: "check",
          tone: "si-blue",
          label: t("status.done"),
          value: data.counts.done,
          to: "/tasks?status=done",
        },
        {
          key: "abandoned",
          icon: "folder-x",
          tone: "si-gray",
          label: t("status.abandoned"),
          value: data.counts.abandoned,
          to: "/tasks?status=abandoned",
        },
        {
          key: "unknown",
          icon: "info",
          tone: "si-gray",
          label: t("status.unknown"),
          value: data.counts.unknown,
          to: "/tasks?status=unknown",
        },
        {
          key: "trash",
          icon: "trash",
          tone: "si-gray",
          label: t("nav.trash"),
          value: data.trash,
          to: "/trash",
        },
      ]
    : [];

  const activityTotal = data?.activity.reduce((sum, day) => sum + day.sessions, 0) ?? 0;
  const activityPeak = Math.max(...(data?.activity.map((day) => day.sessions) ?? [0]), 1);
  const maxToolSessions = Math.max(...(data?.tools.map((tool) => tool.sessions) ?? [0]), 1);
  const dayLabel = (date: string): string => {
    const value = new Date(`${date}T00:00:00`);
    if (Number.isNaN(value.getTime())) return date;
    return new Intl.DateTimeFormat(lang === "zh-Hant" ? "zh-TW" : lang, {
      month: "short",
      day: "numeric",
    }).format(value);
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("nav.dashboard")}</h1>
          {data && data.total > 0 && (
            <p className="page-sub">
              {t("tasks.total", { n: data.total })}
              <span className="dot-sep" />
              {t("tasks.dirs", { n: data.projects.total })}
              {data.lastWriteAt !== null && (
                <>
                  <span className="dot-sep" />
                  {t("dash.lastWrite", {
                    time: formatRelative(data.lastWriteAt, lang),
                  })}
                </>
              )}
            </p>
          )}
        </div>
        <div className="head-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void load(false)}
          >
            <Icon name="refresh" className={busy ? "spin" : undefined} />
            {t("dash.refresh")}
          </button>
        </div>
      </header>

      {error && !data ? (
        <div className="card state-card">
          <p className="title">{t("tasks.error")}</p>
          <p className="detail">{error}</p>
        </div>
      ) : !data ? (
        <p className="loading-note">{t("tasks.loading")}</p>
      ) : data.total === 0 ? (
        <div className="card state-card">
          <p className="title">{t("dash.emptyTitle")}</p>
          <p className="detail">
            {t("dash.emptyText")}{" "}
            <Link to="/integrations" className="dash-inline-link">
              {t("dash.goIntegrations")}
            </Link>
          </p>
        </div>
      ) : (
        <>
          {kpis.length > 0 && (
            <div className="dash-kpis">
              {kpis.map((kpi) => (
                <Link key={kpi.key} to={kpi.to} className="card stat-card dash-kpi-card">
                  <div className={cn("stat-icon", kpi.tone)}>
                    <Icon name={kpi.icon} />
                  </div>
                  <div>
                    <div className="stat-label">{kpi.label}</div>
                    <div className="stat-value">{kpi.value}</div>
                  </div>
                  <Icon name="chevron-right" className="ico-sm dash-kpi-arrow" />
                </Link>
              ))}
            </div>
          )}

          {activityTotal > 0 && (
            <section className="card dash-card dash-activity">
              <div className="dash-card-head">
                <span className="dash-card-title">
                  {t("dash.activity", { n: data.activity.length })}
                </span>
                <span className="dash-card-note">
                  {t("dash.activityTotal", { n: activityTotal })}
                </span>
              </div>
              <div className="dash-chart">
                {data.activity.map((day) => {
                  const tip = t("dash.activityDay", {
                    date: dayLabel(day.date),
                    n: day.sessions,
                  });
                  const height = Math.round((day.sessions / activityPeak) * 100);
                  return (
                    <div
                      key={day.date}
                      className="dash-chart-col"
                      tabIndex={0}
                      aria-label={tip}
                    >
                      <span
                        className="dash-chart-tip"
                        style={{ bottom: `calc(${Math.max(height, 4)}% + 7px)` }}
                      >
                        {tip}
                      </span>
                      <span
                        className={cn("dash-chart-bar", day.sessions === 0 && "is-empty")}
                        style={{ height: `${height}%` }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="dash-chart-axis">
                <span>{t("dash.activityStart", { n: data.activity.length })}</span>
                <span>{t("dash.activityEnd")}</span>
              </div>
            </section>
          )}

          <div className="dash-grid">
            <section className="card dash-panel dash-attention">
              <div className="dash-panel-head">
                <span className="dash-panel-title">{t("dash.attention")}</span>
                {data.attention.length > 0 && (
                  <span className="count-badge amber">{data.attention.length}</span>
                )}
              </div>
              {data.attention.length > 0 ? (
                <>
                  <p className="dash-panel-desc">{t("dash.attentionDesc")}</p>
                  {data.attention.map((task) => (
                    <DashboardTaskRow key={task.id} task={task} showStatus={false} />
                  ))}
                </>
              ) : (
                <div className="dash-attention-empty">
                  <span className="dash-attention-icon">
                    <Icon name="check" />
                  </span>
                  <p>{t("dash.attentionEmpty")}</p>
                </div>
              )}
            </section>

            <section className="card dash-panel dash-recent">
              <div className="dash-panel-head">
                <span className="dash-panel-title">{t("dash.recent")}</span>
                <Link to="/tasks" className="dash-link">
                  {t("dash.viewAll")}
                  <Icon name="chevron-right" className="ico-sm" />
                </Link>
              </div>
              {data.recent.map((task) => (
                <DashboardTaskRow key={task.id} task={task} showStatus />
              ))}
            </section>

            {data.tools.length > 0 && (
              <section className="card dash-card dash-tools">
                <div className="dash-card-head">
                  <span className="dash-card-title">{t("dash.tools")}</span>
                  <span className="dash-card-note">{t("dash.bySessions")}</span>
                </div>
                <div className="dash-bars">
                  {data.tools.map((tool) => (
                    <div key={tool.tool} className="dash-bar-row">
                      <div className="dash-bar-head">
                        <span className="dash-bar-name">
                          <span className="tool-dot" data-tool={tool.tool} />
                          {toolLabel(tool.tool)}
                        </span>
                        <span className="dash-bar-value">{tool.sessions}</span>
                      </div>
                      <div className="dash-bar-track">
                        <span
                          className="dash-bar-fill"
                          style={{
                            width: `${Math.max(
                              6,
                              Math.round((tool.sessions / maxToolSessions) * 100),
                            )}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {data.projects.top.length > 0 && (
              <section className="card dash-card dash-projects-card">
                <div className="dash-card-head">
                  <span className="dash-card-title">{t("dash.projects")}</span>
                </div>
                <div className="dash-projects">
                  {data.projects.top.map((project) => (
                    <div key={project.project} className="dash-project">
                      <span className="dash-project-path mono">{project.project}</span>
                      <span className="dash-project-meta">
                        {t("tasks.count", { n: project.count })}
                        <span className="dot-sep" />
                        {formatRelative(project.lastActiveAt, lang)}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        </>
      )}
    </>
  );
}

function DashboardTaskRow({ task, showStatus }: { task: DashboardTask; showStatus: boolean }) {
  const { t, lang } = useI18n();
  return (
    <Link to={`/tasks/${encodeURIComponent(task.id)}`} className="dash-task">
      <div className="dash-task-main">
        <div dir="auto" className={cn("task-title", task.status === "abandoned" && "is-abandoned")}>
          {task.title}
        </div>
        {task.summary && <div className="task-snippet">{task.summary}</div>}
        <div className="dash-task-meta">
          <span className="dash-chain">
            {task.tools.map((tool, index) => (
              <span key={tool} className="dash-chain-tool">
                {index > 0 && (
                  <span className="dash-chain-arrow" aria-hidden="true">
                    →
                  </span>
                )}
                <span className="tool-dot" data-tool={tool} />
                {toolLabel(tool)}
              </span>
            ))}
          </span>
          <span className="dot-sep" />
          <span className="mono dash-task-project">{task.project}</span>
        </div>
      </div>
      <div className="dash-task-side">
        {showStatus && <StatusBadge status={task.status} />}
        <span className="time">{formatRelative(task.lastActiveAt, lang)}</span>
        <span className="counts">
          {t("tasks.messages", { n: task.messageCount })} ·{" "}
          {t("tasks.files", { n: task.fileCount })}
        </span>
      </div>
      <span className="row-chevron">
        <Icon name="chevron-right" className="ico-sm" />
      </span>
    </Link>
  );
}
