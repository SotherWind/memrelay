import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { NotFoundError, deleteSessions, fetchSessionMessages } from "../api/client";
import { toolLabel, type MessageDto, type SessionSummary } from "../api/types";
import { ConfirmAction } from "../components/ConfirmAction";
import { Icon } from "../components/icons";
import { MessageBlock } from "../components/MessageBlock";
import { StatusBadge } from "../components/StatusBadge";
import { useI18n } from "../lib/i18n";

const PAGE_SIZE = 40;

export function ConversationViewPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const sessionId = params.id ?? "";
  const targetRaw = Number.parseInt(searchParams.get("at") ?? "", 10);
  const targetOrdinal = Number.isInteger(targetRaw) && targetRaw > 0 ? targetRaw : undefined;
  const initialFrom = targetOrdinal !== undefined ? Math.max(0, targetOrdinal - 12) : 0;

  const [session, setSession] = useState<SessionSummary | null>(null);
  const [total, setTotal] = useState(0);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [earliestFrom, setEarliestFrom] = useState(initialFrom);
  const [hasLater, setHasLater] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"earlier" | "later" | null>(null);
  const scrolledRef = useRef(false);

  useEffect(() => {
    let live = true;
    scrolledRef.current = false;
    setSession(null);
    setMessages([]);
    setEarliestFrom(initialFrom);
    setHasLater(false);
    setNotFound(false);
    setError(null);
    fetchSessionMessages(sessionId, initialFrom, PAGE_SIZE)
      .then((response) => {
        if (!live) return;
        setSession(response.session);
        setTotal(response.total);
        setMessages(response.messages);
        setEarliestFrom(response.from);
        setHasLater(response.hasMore);
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (err instanceof NotFoundError) setNotFound(true);
        else setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [sessionId, initialFrom]);

  useEffect(() => {
    if (!session || scrolledRef.current) return;
    scrolledRef.current = true;
    if (targetOrdinal !== undefined) {
      const element = document.getElementById(`msg-${targetOrdinal}`);
      if (element) element.scrollIntoView({ block: "center" });
    }
  }, [session, targetOrdinal]);

  const loadEarlier = useCallback(async () => {
    if (busy !== null || earliestFrom <= 0) return;
    setBusy("earlier");
    const main = document.querySelector(".main");
    const before = main ? { top: main.scrollTop, height: main.scrollHeight } : null;
    try {
      const from = Math.max(0, earliestFrom - PAGE_SIZE);
      const limit = earliestFrom - from;
      const response = await fetchSessionMessages(sessionId, from, limit);
      setMessages((current) => {
        const seen = new Set(current.map((message) => message.ordinal));
        return [...response.messages.filter((message) => !seen.has(message.ordinal)), ...current];
      });
      setEarliestFrom(response.from);
      requestAnimationFrame(() => {
        if (main && before) main.scrollTop = before.top + (main.scrollHeight - before.height);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [busy, earliestFrom, sessionId]);

  const loadLater = useCallback(async () => {
    if (busy !== null || !hasLater) return;
    setBusy("later");
    try {
      const response = await fetchSessionMessages(sessionId, earliestFrom + messages.length, PAGE_SIZE);
      setMessages((current) => [...current, ...response.messages]);
      setHasLater(response.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [busy, earliestFrom, hasLater, messages.length, sessionId]);

  return (
    <>
      <Link to="/conversations" className="detail-back">
        <Icon name="chevron-right" className="ico-sm rotate-180" />
        {t("conv.back")}
      </Link>

      {error && (
        <div className="card state-card mt-3">
          <p className="title">{t("tasks.error")}</p>
          <p className="detail">{error}</p>
        </div>
      )}

      {notFound ? (
        <div className="card state-card mt-3">
          <p className="title">{t("conv.notFound")}</p>
        </div>
      ) : !session ? (
        error ? null : <p className="loading-note">{t("tasks.loading")}</p>
      ) : messages.length === 0 ? (
        <div className="card state-card mt-3">
          <p className="title">{t("conv.noMessages")}</p>
        </div>
      ) : (
        <>
          <header className="detail-head pt-3">
            <div className="detail-title-row">
              <h1 dir="auto" className="detail-title">
                {session.title ?? session.id}
              </h1>
              <div className="flex shrink-0 items-center gap-3">
                <StatusBadge status={session.status} />
                <ConfirmAction
                  idleClassName="action-link"
                  onConfirm={async () => {
                    await deleteSessions([session.id]);
                    navigate("/conversations");
                  }}
                  onError={(err) => setError(err instanceof Error ? err.message : String(err))}
                >
                  {t("del.session")}
                </ConfirmAction>
              </div>
            </div>
            <div className="detail-meta">
              <span className="mono">{toolLabel(session.tool)}</span>
              <span className="dot-sep" />
              <span className="mono">{session.project}</span>
              <span className="dot-sep" />
              <span className="mono">{session.id}</span>
              <span className="dot-sep" />
              <span>{t("conv.total", { n: total })}</span>
            </div>
          </header>

          {earliestFrom > 0 && (
            <div className="flex justify-center pb-3">
              <button
                type="button"
                onClick={() => void loadEarlier()}
                disabled={busy !== null}
                className="btn btn-secondary btn-sm"
              >
                {busy === "earlier" ? t("conv.loadingMore") : t("conv.loadEarlier")}
              </button>
            </div>
          )}

          <div className="card overflow-hidden">
            {messages.map((message) => (
              <MessageBlock
                key={message.ordinal}
                message={message}
                isTarget={targetOrdinal !== undefined && message.ordinal === targetOrdinal}
              />
            ))}
          </div>

          {hasLater && (
            <div className="flex justify-center pt-4">
              <button
                type="button"
                onClick={() => void loadLater()}
                disabled={busy !== null}
                className="btn btn-secondary btn-sm"
              >
                {busy === "later" ? t("conv.loadingMore") : t("conv.loadMore")}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
