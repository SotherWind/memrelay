import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  NotFoundError,
  deleteSessions,
  fetchProjectTasks,
  fetchResumePreview,
  fetchTaskDetail,
  mergeTask,
  renameTask,
  resetTaskChain,
  setTaskStatus,
  splitTask,
} from "../api/client";
import type { ResumePreview, TaskDetail, TaskRow } from "../api/types";
import { ConfirmAction } from "../components/ConfirmAction";
import { Icon } from "../components/icons";
import { RelayRail } from "../components/RelayRail";
import { StatusBadge } from "../components/StatusBadge";
import { useI18n } from "../lib/i18n";
import { formatRelative } from "../lib/format";
import { cn } from "../lib/cn";

export function TaskDetailPage() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const taskId = params.id ?? "";

  const [task, setTask] = useState<TaskDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ResumePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [handoffTick, setHandoffTick] = useState(0);
  const [handoffActive, setHandoffActive] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [merging, setMerging] = useState(false);
  const [mergeables, setMergeables] = useState<TaskRow[] | null>(null);
  const [chainBusy, setChainBusy] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);
  const handoffTimer = useRef<number | undefined>(undefined);

  const applyStatus = async (status: "done" | "abandoned" | null) => {
    setStatusBusy(true);
    try {
      setTask(await setTaskStatus(taskId, status));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatusBusy(false);
    }
  };

  const startRename = () => {
    if (!task) return;
    setNameDraft(task.title);
    setRenaming(true);
  };

  const saveRename = async () => {
    setRenaming(false);
    try {
      setTask(await renameTask(taskId, nameDraft));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const doSplit = async (sessionId: string) => {
    setChainBusy(true);
    try {
      setTask(await splitTask(taskId, sessionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChainBusy(false);
    }
  };

  const openMerge = async () => {
    if (!task) return;
    setMerging(true);
    setMergeables(null);
    try {
      const page = await fetchProjectTasks(task.project, { limit: 20 });
      setMergeables(page.tasks.filter((row) => row.id !== task.id).slice(0, 20));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const doMerge = async (withId: string) => {
    setChainBusy(true);
    try {
      const updated = await mergeTask(taskId, withId);
      setMerging(false);
      setTask(updated);
      if (updated.id !== taskId) navigate(`/tasks/${encodeURIComponent(updated.id)}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChainBusy(false);
    }
  };

  const doResetChain = async () => {
    setChainBusy(true);
    try {
      const updated = await resetTaskChain(taskId);
      if (!updated) {
        setError(t("tasks.error"));
        return;
      }
      setTask(updated);
      if (updated.id !== taskId) navigate(`/tasks/${encodeURIComponent(updated.id)}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChainBusy(false);
    }
  };

  useEffect(() => {
    let live = true;
    setTask(null);
    setNotFound(false);
    setError(null);
    setPreview(null);
    setPreviewError(null);
    setCopied(false);
    fetchTaskDetail(taskId)
      .then((data) => {
        if (live) setTask(data);
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (err instanceof NotFoundError) setNotFound(true);
        else setError(err instanceof Error ? err.message : String(err));
      });
    fetchResumePreview(taskId)
      .then((data) => {
        if (live) setPreview(data);
      })
      .catch((err: unknown) => {
        if (live) setPreviewError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [taskId]);

  useEffect(
    () => () => {
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
      if (handoffTimer.current !== undefined) window.clearTimeout(handoffTimer.current);
    },
    [],
  );

  const copyPrompt = async () => {
    if (!preview) return;
    try {
      await navigator.clipboard.writeText(preview.text);
    } catch {
      const area = document.createElement("textarea");
      area.value = preview.text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
    setHandoffTick((tick) => tick + 1);
    setHandoffActive(true);
    if (handoffTimer.current !== undefined) window.clearTimeout(handoffTimer.current);
    handoffTimer.current = window.setTimeout(() => setHandoffActive(false), 1200);
  };

  const copyButton = (primary: boolean) => (
    <button
      type="button"
      onClick={() => void copyPrompt()}
      disabled={!preview}
      className={cn("btn btn-sm", primary ? "btn-primary" : "btn-secondary", copied && "copied")}
    >
      {copied && <Icon name="check" className="ico-sm" />}
      {copied ? t("detail.copied") : t("detail.copy")}
    </button>
  );

  return (
    <>
      <Link to="/tasks" className="detail-back">
        <Icon name="chevron-right" className="ico-sm rotate-180" />
        {t("detail.back")}
      </Link>

      {error && (
        <div className="card state-card mt-3">
          <p className="title">{t("tasks.error")}</p>
          <p className="detail">{error}</p>
        </div>
      )}

      {notFound ? (
        <div className="card state-card mt-3">
          <p className="title">{t("detail.notFound")}</p>
        </div>
      ) : !task ? (
        error ? null : <p className="loading-note">{t("tasks.loading")}</p>
      ) : (
        <>
          <header className="detail-head">
            <div className="detail-title-row">
              {renaming ? (
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <input
                    autoFocus
                    value={nameDraft}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void saveRename();
                      if (event.key === "Escape") setRenaming(false);
                    }}
                    placeholder={t("manual.renamePlaceholder")}
                    className="rename-input"
                  />
                  <button type="button" onClick={() => void saveRename()} className="btn btn-primary btn-sm">
                    {t("manual.save")}
                  </button>
                  <button type="button" onClick={() => setRenaming(false)} className="btn btn-ghost btn-sm">
                    {t("del.cancel")}
                  </button>
                </div>
              ) : (
                <h1 dir="auto" className="detail-title">
                  {task.title}
                </h1>
              )}
              <div className="flex shrink-0 items-center gap-3">
                <StatusBadge status={task.status} />
                <ConfirmAction
                  idleClassName="action-link"
                  onConfirm={async () => {
                    await deleteSessions(task.legs.map((leg) => leg.sessionId));
                    navigate("/tasks");
                  }}
                  onError={(err) => setError(err instanceof Error ? err.message : String(err))}
                >
                  {t("del.task")}
                </ConfirmAction>
              </div>
            </div>
            <div className="detail-meta">
              <span className="mono">{task.project}</span>
              <span className="dot-sep" />
              <span>{formatRelative(task.lastActiveAt, lang)}</span>
            </div>
            <div className="detail-actions">
              <button type="button" disabled={chainBusy} onClick={startRename} className="action-link">
                {t("manual.rename")}
              </button>
              <button type="button" disabled={chainBusy} onClick={() => void openMerge()} className="action-link">
                {t("manual.merge")}
              </button>
              {task.manualChain && (
                <>
                  <button
                    type="button"
                    disabled={chainBusy}
                    onClick={() => void doResetChain()}
                    className="action-link"
                  >
                    {t("manual.resetChain")}
                  </button>
                  <span className="text-[11px] text-[var(--text-3)]">{t("manual.chainBadge")}</span>
                </>
              )}
              <button
                type="button"
                disabled={statusBusy}
                title={t("manual.note")}
                onClick={() => void applyStatus("done")}
                className="action-link"
              >
                {t("manual.markDone")}
              </button>
              <button
                type="button"
                disabled={statusBusy}
                title={t("manual.note")}
                onClick={() => void applyStatus("abandoned")}
                className="action-link"
              >
                {t("manual.markAbandoned")}
              </button>
              {task.manual && (
                <>
                  <button
                    type="button"
                    disabled={statusBusy}
                    onClick={() => void applyStatus(null)}
                    className="action-link"
                  >
                    {t("manual.reset")}
                  </button>
                  <span className="text-[11px] text-[var(--text-3)]">{t("manual.manualBadge")}</span>
                </>
              )}
            </div>
          </header>

          {task.summary && (
            <section className="card panel summary-panel">
              <p className="panel-title">{t("task.summaryTitle")}</p>
              <p className="summary-text">{task.summary}</p>
            </section>
          )}

          {merging && (
            <section className="card panel summary-panel">
              <div className="flex items-center justify-between gap-3">
                <span className="panel-title">{t("manual.mergeTitle")}</span>
                <button type="button" onClick={() => setMerging(false)} className="action-link">
                  {t("del.cancel")}
                </button>
              </div>
              {!mergeables ? (
                <p className="py-3 mono text-xs text-[var(--text-3)]">{t("tasks.loading")}</p>
              ) : mergeables.length === 0 ? (
                <p className="py-3 text-xs text-[var(--text-3)]">{t("conv.empty")}</p>
              ) : (
                <div className="merge-list">
                  {mergeables.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      disabled={chainBusy}
                      onClick={() => void doMerge(row.id)}
                      className="merge-row"
                    >
                      <span className="title">{row.title}</span>
                      <span className="flex shrink-0 items-center gap-2.5">
                        <span className="mono text-[11px] text-[var(--text-3)]">
                          {formatRelative(row.lastActiveAt, lang)}
                        </span>
                        <StatusBadge status={row.status} />
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          <section className="card panel">
            <div className="flex items-center justify-between pb-3">
              <h2 className="panel-title">{t("detail.legs")}</h2>
            </div>
            <RelayRail
              legs={task.legs}
              status={task.status}
              replayKey={handoffTick}
              nextAction={task.status === "interrupted" ? copyButton(true) : undefined}
              onSplit={task.legs.length > 1 ? (sessionId) => void doSplit(sessionId) : undefined}
            />
          </section>

          <section className={cn("preview-panel", handoffActive && "handoff")}>
            <div className="flex items-center justify-between pb-2">
              <h2 className="panel-title">{t("detail.preview")}</h2>
              {task.status !== "interrupted" && preview ? copyButton(false) : null}
            </div>
            <div className="card overflow-hidden">
              {previewError ? (
                <p className="px-4 py-6 text-[13px] text-[var(--text-3)]">{previewError}</p>
              ) : !preview ? (
                <p className="px-4 py-6 mono text-xs text-[var(--text-3)]">{t("detail.previewLoading")}</p>
              ) : (
                <pre className="preview-body" dir="auto">
                  {preview.text}
                </pre>
              )}
            </div>
          </section>
        </>
      )}
    </>
  );
}
