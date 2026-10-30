import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { fetchSessions } from "../api/client";
import { toolLabel, type SessionSummary } from "../api/types";
import { Icon } from "../components/icons";
import { StatusBadge } from "../components/StatusBadge";
import { useI18n } from "../lib/i18n";
import { formatRelative, formatStamp } from "../lib/format";
import { cn } from "../lib/cn";

const POLL_INTERVAL_MS = 30_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function Highlight({ text, query }: { text: string; query: string }) {
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return <>{text}</>;
  const lowered = new Set(terms.map((term) => term.toLowerCase()));
  const parts = text.split(new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi"));
  return (
    <>
      {parts.map((part, index) =>
        lowered.has(part.toLowerCase()) ? (
          <mark key={index}>{part}</mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

function initialsOf(tool: string): string {
  const map: Record<string, string> = {
    qoder: "Q",
    "qoder-ide": "QI",
    "claude-code": "C",
    codex: "CX",
    cursor: "CU",
    codebuddy: "CB",
    workbuddy: "WB",
    zcode: "Z",
    opencode: "OC",
    trae: "T",
    "trae-cn": "TC",
    dsh: "DS",
    hermes: "H",
  };
  return map[tool] ?? tool.slice(0, 2).toUpperCase();
}

function activeMs(session: SessionSummary): number {
  if (session.lastActiveAt > 0) return session.lastActiveAt;
  return session.startedAt ? Date.parse(session.startedAt) || 0 : 0;
}

function dayStart(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

type DateBucket = "today" | "yesterday" | "earlier";

function bucketOf(ms: number, now: number): DateBucket {
  const today = dayStart(now);
  const day = dayStart(ms);
  if (day === today) return "today";
  if (day === today - 86_400_000) return "yesterday";
  return "earlier";
}

export function ConversationsPage() {
  const { t, lang } = useI18n();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [source, setSource] = useState<string>("all");
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  // 换了搜索词就回到"全部来源"，避免旧来源筛选把新结果清空。
  useEffect(() => {
    setSource("all");
  }, [debounced]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const seqRef = useRef(0);
  const load = useCallback(async (q: string, opts: { quiet?: boolean } = {}) => {
    const seq = ++seqRef.current;
    if (!opts.quiet) {
      setSessions(null);
      setError(null);
    }
    try {
      const rows = await fetchSessions(q || undefined);
      if (seqRef.current !== seq) return;
      setSessions(rows);
    } catch (err) {
      if (seqRef.current !== seq || opts.quiet) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load(debounced);
  }, [debounced, load]);

  const queryRef = useRef(debounced);
  useEffect(() => {
    queryRef.current = debounced;
  }, [debounced]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(queryRef.current, { quiet: true });
    }, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (!document.hidden) void load(queryRef.current, { quiet: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const whenOf = (session: SessionSummary): string =>
    session.lastActiveAt > 0
      ? formatRelative(session.lastActiveAt, lang)
      : session.startedAt
        ? formatStamp(Date.parse(session.startedAt), lang)
        : "";

  const sources = new Map<string, number>();
  for (const session of sessions ?? []) {
    sources.set(session.tool, (sources.get(session.tool) ?? 0) + 1);
  }
  const sourceList = [...sources.entries()].sort((a, b) => b[1] - a[1]);
  const visible = (sessions ?? []).filter((session) => source === "all" || session.tool === source);

  const now = Date.now();
  const groups: Array<{ key: DateBucket; rows: SessionSummary[] }> = [
    { key: "today", rows: [] },
    { key: "yesterday", rows: [] },
    { key: "earlier", rows: [] },
  ];
  for (const session of visible) {
    groups.find((group) => group.key === bucketOf(activeMs(session) || now, now))!.rows.push(session);
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("conv.title")}</h1>
          {sessions && (
            <p className="page-sub">
              {t("conv.subtitle", { n: sessions.length, m: sources.size })}
            </p>
          )}
        </div>
        <div className="head-actions">
          <button type="button" className="btn btn-secondary" onClick={() => void load(debounced)}>
            <Icon name="refresh" />
            {t("conv.refresh")}
          </button>
        </div>
      </header>

      <div className="card search-hero">
        <Icon name="search" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("conv.searchPlaceholder")}
        />
        <span className="kbd">{t("conv.ctrlK")}</span>
      </div>

      <div className="filter-row" style={{ marginTop: 0 }}>
        <div className="filters source-filters">
          <button
            type="button"
            className={cn("pill", source === "all" && "active")}
            onClick={() => setSource("all")}
          >
            {t("conv.allSources")} <span className="num">{sessions?.length ?? "–"}</span>
          </button>
          {sourceList.map(([tool, count]) => (
            <button
              key={tool}
              type="button"
              className={cn("pill", source === tool && "active")}
              onClick={() => setSource(tool)}
            >
              {toolLabel(tool)} <span className="num">{count}</span>
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="card state-card">
          <p className="title">{t("tasks.error")}</p>
          <p className="detail">{error}</p>
        </div>
      ) : !sessions ? (
        <p className="loading-note">{t("conv.searching")}</p>
      ) : visible.length === 0 ? (
        <div className="card state-card">
          <p className="title">{debounced ? t("conv.noResults") : t("conv.empty")}</p>
        </div>
      ) : (
        <div>
          {groups.map((group) =>
            group.rows.length === 0 ? null : (
              <section key={group.key}>
                <div className="date-label">
                  {t(`conv.${group.key}`)} <span className="count">{t("conv.count", { n: group.rows.length })}</span>
                </div>
                <div className="card conv-card">
                  {group.rows.map((session) => {
                    const snippet = debounced && session.snippets[0] ? session.snippets[0].snippet : null;
                    return (
                      <Link
                        key={session.id}
                        to={`/conversations/${encodeURIComponent(session.id)}${
                          session.snippets[0] ? `?at=${session.snippets[0].ordinal}` : ""
                        }`}
                        className="conv-row"
                      >
                        <span className="source-avatar" data-tool={session.tool}>
                          {initialsOf(session.tool)}
                        </span>
                        <span className="conv-main">
                          <span dir="auto" className="conv-title block">
                            {session.title ?? session.id}
                          </span>
                          {snippet ? (
                            <span dir="auto" className="conv-snippet block">
                              <Highlight text={snippet} query={debounced} />
                            </span>
                          ) : session.summary ? (
                            <span dir="auto" className="conv-snippet block">
                              {session.summary}
                            </span>
                          ) : null}
                          <span className="conv-meta">
                            <span className="mono">{session.project}</span>
                            <span className="dot-sep" />
                            {toolLabel(session.tool)}
                            {session.messageCount > 0 && (
                              <>
                                <span className="dot-sep" />
                                <span>{t("conv.count", { n: session.messageCount })}</span>
                              </>
                            )}
                          </span>
                        </span>
                        <span className="conv-side">
                          <StatusBadge status={session.status} />
                          <span className="time">{whenOf(session)}</span>
                        </span>
                        <span className="conv-chevron">
                          <Icon name="chevron-right" className="ico-sm" />
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </section>
            ),
          )}
        </div>
      )}
    </>
  );
}
