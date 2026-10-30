import { useEffect, useState } from "react";
import { fetchTrash, restoreSessions } from "../api/client";
import { toolLabel, type TrashItem } from "../api/types";
import { Icon } from "../components/icons";
import { useI18n } from "../lib/i18n";
import { formatRelative } from "../lib/format";
import { cn } from "../lib/cn";

export function TrashPage() {
  const { t, lang } = useI18n();
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    fetchTrash()
      .then((rows) => {
        if (live) setItems(rows);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, []);

  const restore = async (ids: string[]) => {
    setBusy(true);
    setError(null);
    try {
      setItems(await restoreSessions(ids));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const needle = query.trim().toLowerCase();
  const filtered = (items ?? []).filter((item) => {
    if (!needle) return true;
    return (
      (item.title ?? item.id).toLowerCase().includes(needle) ||
      (item.project ?? "").toLowerCase().includes(needle)
    );
  });

  const groups = new Map<string, TrashItem[]>();
  for (const item of filtered) {
    const key = item.project ?? "";
    const bucket = groups.get(key) ?? [];
    bucket.push(item);
    groups.set(key, bucket);
  }
  for (const rows of groups.values()) {
    rows.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }
  const ordered = [...groups.entries()].sort(
    (a, b) => Math.max(...b[1].map((item) => item.lastActiveAt)) - Math.max(...a[1].map((item) => item.lastActiveAt)),
  );
  const dirCount = new Set((items ?? []).map((item) => item.project ?? "")).size;

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("nav.trash")}</h1>
          {items && (
            <p className="page-sub">
              {t("tasks.count", { n: items.length })}
              <span className="dot-sep" />
              {t("tasks.dirs", { n: dirCount })}
            </p>
          )}
        </div>
        <div className="head-actions">
          <label className="search-box">
            <Icon name="search" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("trash.search")}
            />
          </label>
          {filtered.length > 0 && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void restore(filtered.map((item) => item.id))}
            >
              <Icon name="undo" />
              {t("trash.restoreAll")}
            </button>
          )}
        </div>
      </header>

      {error ? (
        <div className="card state-card">
          <p className="title">{t("tasks.error")}</p>
          <p className="detail">{error}</p>
        </div>
      ) : !items ? (
        <p className="loading-note">{t("tasks.loading")}</p>
      ) : items.length === 0 ? (
        <div className="card state-card">
          <p className="title">{t("trash.empty")}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card state-card">
          <p className="title">{t("trash.noMatch")}</p>
        </div>
      ) : (
        <>
          <div className="card tip-bar">
            <Icon name="info" />
            <span>{t("trash.desc")}</span>
          </div>

          {ordered.map(([project, rows]) => (
            <section key={project || "__unknown__"} className="card group-card">
              <div className="group-head static-head">
                <span className="group-icon">
                  <Icon name="folder" />
                </span>
                <span className="min-w-0">
                  <span className="group-path block">{project || "—"}</span>
                  <span className="group-meta block">
                    {t("trash.groupMeta", {
                      n: rows.length,
                      time: formatRelative(Math.max(...rows.map((row) => row.lastActiveAt)), lang),
                    })}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => void restore(rows.map((row) => row.id))}
                >
                  <Icon name="undo" />
                  {t("trash.restoreAll")}
                </button>
              </div>

              {rows.map((item) => (
                <div key={item.id} className="deleted-row">
                  <div className="task-main">
                    <div dir="auto" className={cn("task-title", !item.inIndex && "is-abandoned")}>
                      {item.title ?? item.id}
                    </div>
                    <div className="task-meta">
                      {item.tool && (
                        <>
                          <span className="tool-dot" data-tool={item.tool} />
                          {toolLabel(item.tool)}
                          <span className="dot-sep" />
                        </>
                      )}
                      {item.inIndex ? (
                        <>
                          {formatRelative(item.lastActiveAt, lang)}
                          <span className="dot-sep" />
                          {t("tasks.messages", { n: item.messageCount })}
                        </>
                      ) : (
                        t("trash.notInIndex")
                      )}
                    </div>
                  </div>
                  <span />
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy}
                    onClick={() => void restore([item.id])}
                  >
                    <Icon name="undo" />
                    {t("trash.restore")}
                  </button>
                </div>
              ))}
            </section>
          ))}
        </>
      )}
    </>
  );
}
