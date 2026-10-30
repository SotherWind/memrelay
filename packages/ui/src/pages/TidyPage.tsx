import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { applyTidyPlan, fetchTidyStatus, runTidyNow, undoTidy } from "../api/client";
import { toolLabel, type TidyStatus } from "../api/types";
import { Icon } from "../components/icons";
import { useI18n } from "../lib/i18n";
import { cn } from "../lib/cn";

function fingerprintShort(value: string): string {
  return value.slice(0, 10);
}

export function TidyPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<TidyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"run" | "apply" | "undo" | null>(null);
  const statusSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++statusSeq.current;
    fetchTidyStatus()
      .then((data) => {
        if (seq === statusSeq.current) setStatus(data);
      })
      .catch(() => {
        /* 轮询失败保留旧值 */
      });
  }, []);

  useEffect(() => {
    let live = true;
    fetchTidyStatus()
      .then((data) => {
        if (live) setStatus(data);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    const timer = window.setInterval(load, 5000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [load]);

  const run = async () => {
    setBusy("run");
    setError(null);
    try {
      const result = await runTidyNow();
      statusSeq.current++;
      setStatus(result.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    setBusy("apply");
    setError(null);
    try {
      const result = await applyTidyPlan();
      statusSeq.current++;
      setStatus(result.status);
      if (result.error) setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const undo = async () => {
    setBusy("undo");
    setError(null);
    try {
      const result = await undoTidy();
      statusSeq.current++;
      setStatus(result.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const configured = Boolean(status?.enabled && status.configured);
  const planLines = status?.plan?.content.split("\n").filter(Boolean) ?? [];
  const planStatus = status?.plan?.status;
  const conflictCount = status?.plan?.conflicts.length ?? 0;
  const written = planStatus === "applied";
  const planBadge =
    planStatus === "conflict"
      ? { text: t("tidy.conflictsTitle"), className: "st-gray" }
      : written
        ? { text: t("tidy.entriesWritten", { n: planLines.length }), className: "st-green" }
        : planStatus === "ready"
          ? { text: t("tidy.planReady"), className: "st-gray" }
          : planStatus === "error"
            ? { text: t("tasks.error"), className: "st-amber" }
            : { text: t("tidy.planEmpty"), className: "st-gray" };

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("nav.tidy")}</h1>
          <p className="page-sub">{t("tidy.subtitle")}</p>
        </div>
        <div className="head-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!configured || status?.running === true || busy !== null}
            onClick={() => void run()}
          >
            {status?.running || busy === "run" ? t("tidy.running") : t("tidy.run")}
          </button>
          {status && status.exports.length > 0 && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy !== null || status?.running === true}
              onClick={() => void undo()}
            >
              {busy === "undo" ? t("tidy.undoing") : t("tidy.undo")}
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="card state-card">
          <p className="title">{t("tasks.error")}</p>
          <p className="detail">{error}</p>
        </div>
      )}

      {!status ? (
        <p className="loading-note">{t("tasks.loading")}</p>
      ) : (
        <div className="settings-grid tidy-grid">
          <div className="settings-col">
            {!configured && (
              <section className="card set-card">
                <div className="set-head">
                  <div className="set-icon">
                    <Icon name="sparkles" />
                  </div>
                  <div className="set-title-wrap">
                    <div className="set-title">{t("tidy.notConfiguredTitle")}</div>
                    <div className="set-desc">{t("tidy.notConfiguredDesc")}</div>
                  </div>
                </div>
                <div className="set-foot">
                  <Link className="action-link" to="/settings">
                    {t("tidy.goSettings")} →
                  </Link>
                </div>
              </section>
            )}

            <section className="card set-card">
              <div className="set-head">
                <div className="set-icon si-blue">
                  <Icon name="database" />
                </div>
                <div className="set-title-wrap">
                  <div className="set-title">{t("tidy.sourcesTitle")}</div>
                  <div className="set-desc">{t("tidy.sourcesDesc")}</div>
                </div>
                <span className="status st-gray">
                  <i />
                  {t("tidy.sourcesCount", { files: status.sources.length, items: status.items })}
                </span>
              </div>
              {status.sources.length === 0 ? (
                <p className="text-[11px] text-[var(--text-3)]">{t("tidy.sourcesEmpty")}</p>
              ) : (
                <div className="tidy-list">
                  {status.sources.map((source) => (
                    <div className="tidy-row" key={source.path}>
                      <span className="tidy-tool">{toolLabel(source.tool)}</span>
                      <span className="tidy-path mono" title={source.path}>
                        {source.path}
                      </span>
                      <span className="tidy-meta">
                        {t("tidy.sourceItems", { n: source.items })}
                        <span className="dot-sep" />
                        <span className="mono">{fingerprintShort(source.fingerprint)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="card set-card">
              <div className="set-head">
                <div className="set-icon">
                  <Icon name="file" />
                </div>
                <div className="set-title-wrap">
                  <div className="set-title">{t("tidy.resultTitle")}</div>
                  <div className="set-desc">{t("tidy.resultDesc")}</div>
                </div>
                <span className={cn("status", planBadge.className)}>
                  <i />
                  {planBadge.text}
                </span>
              </div>

              {status.plan ? (
                <>
                  <div className="index-meta">
                    {status.plan.updatedAt}
                    <span className="dot-sep" />
                    <span className="mono">
                      {status.plan.model ?? status.model}@{status.plan.host ?? status.host ?? "?"}
                    </span>
                  </div>
                  <ul className="tidy-plan">
                    {planLines.map((line) => (
                      <li key={line}>{line.replace(/^-\s*/, "")}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-[11px] text-[var(--text-3)]">{t("tidy.resultEmpty")}</p>
              )}

              {status.plan && (status.exports.length === 0 || status.plan.status === "error") && (
                <div className="rail-actions">
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null || status?.running === true} onClick={() => void apply()}>
                    {busy === "apply" ? t("tidy.applying") : t("tidy.apply")}
                  </button>
                </div>
              )}
              {status.lastError && (
                <p className="mt-2 mono text-[11px] text-[var(--amber)]">
                  {t("tidy.lastError", { err: status.lastError })}
                </p>
              )}
            </section>

            {status.plan && conflictCount > 0 && (
              <section className="card set-card">
                <div className="set-head">
                  <div className="set-icon si-amber">
                    <Icon name="info" />
                  </div>
                  <div className="set-title-wrap">
                    <div className="set-title">{t("tidy.conflictsTitle")}</div>
                    <div className="set-desc">{t("tidy.conflictsDesc")}</div>
                  </div>
                  <span className="status st-amber">
                    <i />
                    {t("tidy.conflictsBadge", { n: conflictCount })}
                  </span>
                </div>
                <div className="tidy-conflicts standalone">
                  {status.plan.conflicts.map((conflict) => (
                    <div className="tidy-conflict" key={`${conflict.topic}-${conflict.question}`}>
                      <div className="tidy-conflict-topic">{conflict.topic || t("tidy.conflictUntitled")}</div>
                      {conflict.options.length > 0 && (
                        <div className="tidy-conflict-options">
                          {conflict.options.map((option) => (
                            <span className="tidy-chip" key={option}>
                              {option}
                            </span>
                          ))}
                        </div>
                      )}
                      {conflict.question && <div className="tidy-conflict-question">{conflict.question}</div>}
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--text-3)]">
                  {t("tidy.conflictsHint")}
                </p>
              </section>
            )}
          </div>

          <aside className="settings-col">
            <section className="card rail-card">
              <div className="rail-head">
                <div className="rail-title">{t("tidy.statusTitle")}</div>
                <span className={cn("status", configured ? "st-green" : status.enabled ? "st-amber" : "st-gray")}>
                  <i />
                  {configured ? t("set.enabled") : status.enabled ? t("set.tidyNotConfigured") : t("set.tidyDisabled")}
                </span>
              </div>
              <div className="kv">
                <span className="k">{t("tidy.modelLabel")}</span>
                <span className="v mono">
                  {configured ? `${status.model}@${status.host ?? "?"}` : "—"}
                </span>
              </div>
              <div className="kv">
                <span className="k">{t("tidy.lastRun")}</span>
                <span className="v">{status.lastRunAt ?? "—"}</span>
              </div>
              <div className="kv">
                <span className="k">{t("tidy.exportsCount")}</span>
                <span className="v">{status.exports.length}</span>
              </div>
              {conflictCount > 0 && (
                <div className="kv">
                  <span className="k">{t("tidy.pendingLabel")}</span>
                  <span className="v">{conflictCount}</span>
                </div>
              )}
              {configured && (
                <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--text-3)]">
                  {t("tidy.privacy", { host: status.host ?? "…" })}
                </p>
              )}
            </section>

            <section className="card rail-card">
              <div className="rail-head">
                <div className="rail-title">{t("tidy.exportsTitle")}</div>
              </div>
              {status.exports.length === 0 ? (
                <p className="text-[10.5px] leading-relaxed text-[var(--text-3)]">{t("tidy.exportsEmpty")}</p>
              ) : (
                <div className="tidy-list">
                  {status.exports.map((entry) => (
                    <div className="tidy-row compact" key={entry.path}>
                      <span className="tidy-tool">{toolLabel(entry.tool)}</span>
                      <span className="tidy-path mono" title={entry.path}>
                        {entry.path}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--text-3)]">{t("tidy.blockNote")}</p>
            </section>
          </aside>
        </div>
      )}
    </>
  );
}
