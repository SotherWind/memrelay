import { useCallback, useEffect, useRef, useState } from "react";
import {
  backfillEmbeddings,
  backfillSummaries,
  clearEmbeddings,
  clearSummaries,
  fetchEmbeddingStatus,
  fetchIntegrations,
  fetchSettings,
  fetchSummaryStatus,
  fetchTaskSummary,
  saveSettings,
} from "../api/client";
import type { EmbeddingStatus, IntegrationsResponse, SummaryStatus, UiSettings } from "../api/types";
import { ConfirmAction } from "../components/ConfirmAction";
import { Icon } from "../components/icons";
import { LANGUAGES, useI18n, type MsgKey } from "../lib/i18n";
import {
  MOTIONS,
  STYLES,
  useAppearance,
  type MotionMode,
  type StyleId,
  type ThemeMode,
} from "../lib/theme";
import { cn } from "../lib/cn";

const STYLE_LABELS: Record<StyleId, MsgKey> = {
  minimal: "theme.style.minimal",
  comic: "theme.style.comic",
  pixel: "theme.style.pixel",
};

const MODE_OPTIONS: ThemeMode[] = ["light", "dark", "system"];
const MODE_LABELS: Record<ThemeMode, MsgKey> = {
  light: "theme.mode.light",
  dark: "theme.mode.dark",
  system: "theme.mode.system",
};

const MOTION_LABELS: Record<MotionMode, MsgKey> = {
  system: "theme.motion.system",
  on: "theme.motion.on",
  off: "theme.motion.off",
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function SettingsPage() {
  const { t, lang, setLang } = useI18n();
  const appearance = useAppearance();
  const [settings, setSettings] = useState<UiSettings | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationsResponse | null>(null);
  const [taskTotal, setTaskTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [autoIntegrate, setAutoIntegrate] = useState(false);
  const [embEnabled, setEmbEnabled] = useState(false);
  const [embBaseUrl, setEmbBaseUrl] = useState("");
  const [embModel, setEmbModel] = useState("");
  const [embApiKey, setEmbApiKey] = useState("");
  const [embStatus, setEmbStatus] = useState<EmbeddingStatus | null>(null);
  const [embBusy, setEmbBusy] = useState(false);
  const [sumEnabled, setSumEnabled] = useState(false);
  const [sumBaseUrl, setSumBaseUrl] = useState("");
  const [sumModel, setSumModel] = useState("");
  const [sumApiKey, setSumApiKey] = useState("");
  const [sumStatus, setSumStatus] = useState<SummaryStatus | null>(null);
  const [sumBusy, setSumBusy] = useState(false);
  const [tidEnabled, setTidEnabled] = useState(false);
  const [tidBaseUrl, setTidBaseUrl] = useState("");
  const [tidModel, setTidModel] = useState("");
  const [tidApiKey, setTidApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | undefined>(undefined);

  const adopt = (data: UiSettings) => {
    setSettings(data);
    setAutoIntegrate(data.autoIntegrate);
    setEmbEnabled(data.embedding.enabled);
    setEmbBaseUrl(data.embedding.baseUrl);
    setEmbModel(data.embedding.model);
    setSumEnabled(data.summary.enabled);
    setSumBaseUrl(data.summary.baseUrl);
    setSumModel(data.summary.model);
    setTidEnabled(data.tidy.enabled);
    setTidBaseUrl(data.tidy.baseUrl);
    setTidModel(data.tidy.model);
  };

  const loadStatus = useCallback(() => {
    fetchEmbeddingStatus()
      .then(setEmbStatus)
      .catch(() => {
        /* 状态区拿不到就保持旧值 */
      });
    fetchSummaryStatus()
      .then(setSumStatus)
      .catch(() => {
        /* 同上 */
      });
  }, []);

  useEffect(() => {
    let live = true;
    fetchSettings()
      .then((data) => {
        if (live) adopt(data);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    fetchIntegrations()
      .then((data) => {
        if (live) setIntegrations(data);
      })
      .catch(() => {
        /* 关于区拿不到就算了 */
      });
    fetchTaskSummary()
      .then((summary) => {
        if (live) setTaskTotal(summary.total);
      })
      .catch(() => {
        /* 运行状态少一行 */
      });
    loadStatus();
    const timer = window.setInterval(loadStatus, 5000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [loadStatus]);

  useEffect(
    () => () => {
      if (savedTimer.current !== undefined) window.clearTimeout(savedTimer.current);
    },
    [],
  );

  const discard = () => {
    if (settings) adopt(settings);
    setEmbApiKey("");
    setSumApiKey("");
    setTidApiKey("");
  };

  const save = async () => {
    setSaving(true);
    try {
      const next = await saveSettings({
        embedding: {
          enabled: embEnabled,
          baseUrl: embBaseUrl,
          model: embModel,
          ...(embApiKey.length > 0 ? { apiKey: embApiKey } : {}),
        },
        autoIntegrate,
        summary: {
          enabled: sumEnabled,
          baseUrl: sumBaseUrl,
          model: sumModel,
          ...(sumApiKey.length > 0 ? { apiKey: sumApiKey } : {}),
        },
        tidy: {
          enabled: tidEnabled,
          baseUrl: tidBaseUrl,
          model: tidModel,
          ...(tidApiKey.length > 0 ? { apiKey: tidApiKey } : {}),
        },
      });
      adopt(next);
      setEmbApiKey("");
      setSumApiKey("");
      setTidApiKey("");
      loadStatus();
      setSaved(true);
      if (savedTimer.current !== undefined) window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const runBackfill = async (rebuild: boolean) => {
    setEmbBusy(true);
    try {
      await backfillEmbeddings(rebuild);
      loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEmbBusy(false);
    }
  };

  const runClear = async () => {
    setEmbBusy(true);
    try {
      setEmbStatus(await clearEmbeddings());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEmbBusy(false);
    }
  };

  const runSummaryBackfill = async (rebuild: boolean) => {
    setSumBusy(true);
    try {
      await backfillSummaries(rebuild);
      loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSumBusy(false);
    }
  };

  const runSummaryClear = async () => {
    setSumBusy(true);
    try {
      setSumStatus(await clearSummaries());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSumBusy(false);
    }
  };

  const effectiveHost = embStatus?.host ?? hostOf(embBaseUrl);
  const embDirty =
    settings !== null &&
    (embEnabled !== settings.embedding.enabled ||
      embBaseUrl !== settings.embedding.baseUrl ||
      embModel !== settings.embedding.model ||
      embApiKey.length > 0);
  const backfillActive =
    embBusy ||
    (embStatus?.enabled === true && embStatus?.configured === true && embStatus.pendingSessions > 0);
  const sumDirty =
    settings !== null &&
    (sumEnabled !== settings.summary.enabled ||
      sumBaseUrl !== settings.summary.baseUrl ||
      sumModel !== settings.summary.model ||
      sumApiKey.length > 0);
  const summaryActive =
    sumBusy ||
    (sumStatus?.enabled === true && sumStatus?.configured === true && sumStatus.pendingSessions > 0);
  const summaryHost = sumStatus?.host ?? hostOf(sumBaseUrl);
  const tidDirty =
    settings !== null &&
    (tidEnabled !== settings.tidy.enabled ||
      tidBaseUrl !== settings.tidy.baseUrl ||
      tidModel !== settings.tidy.model ||
      tidApiKey.length > 0);
  const tidyConfigured = Boolean(tidBaseUrl.trim() && tidModel.trim() && settings?.tidy.apiKeySet);
  const tidyHost = hostOf(tidBaseUrl);
  const dirty =
    settings !== null &&
    (embDirty || sumDirty || tidDirty || autoIntegrate !== settings.autoIntegrate);
  const queueTotal = (sumStatus?.summarizedSessions ?? 0) + (sumStatus?.pendingSessions ?? 0);
  const queueRatio = queueTotal > 0 ? ((sumStatus?.summarizedSessions ?? 0) / queueTotal) * 100 : 0;

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("nav.settings")}</h1>
          <p className="page-sub">{t("set.subtitle")}</p>
        </div>
        <div className="head-actions">
          {saved && (
            <span className="save-pill">
              <Icon name="check" className="ico-sm" />
              {t("set.saved")}
            </span>
          )}
        </div>
      </header>

      {error && (
        <div className="card state-card">
          <p className="title">{t("tasks.error")}</p>
          <p className="detail">{error}</p>
        </div>
      )}
      {!settings ? (
        error ? null : <p className="loading-note">{t("tasks.loading")}</p>
      ) : (
        <>
          <section className="card set-card settings-appearance">
            <div className="set-head">
              <div className="set-icon">
                <Icon name="palette" />
              </div>
              <div className="set-title-wrap">
                <div className="set-title">{t("theme.title")}</div>
                <div className="set-desc">{t("lang.title")}</div>
              </div>
            </div>
            <div className="set-form">
              <div className="field span-2">
                <label>{t("theme.style")}</label>
                <div className="filters">
                  {STYLES.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={cn("pill", appearance.style === value && "active")}
                      onClick={() => appearance.setStyle(value)}
                    >
                      {t(STYLE_LABELS[value])}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field span-2">
                <label>{t("theme.mode")}</label>
                <div className="filters">
                  {MODE_OPTIONS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={cn("pill", appearance.mode === value && "active")}
                      onClick={() => appearance.setMode(value)}
                    >
                      {t(MODE_LABELS[value])}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field span-2">
                <label>{t("theme.motion")}</label>
                <div className="filters">
                  {MOTIONS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={cn("pill", appearance.motion === value && "active")}
                      onClick={() => appearance.setMotion(value)}
                    >
                      {t(MOTION_LABELS[value])}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field span-2">
                <label>{t("lang.title")}</label>
                <div className="filters">
                  {LANGUAGES.map((item) => (
                    <button
                      key={item.code}
                      type="button"
                      className={cn("pill", lang === item.code && "active")}
                      onClick={() => setLang(item.code)}
                    >
                      {item.native}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field span-2">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => window.dispatchEvent(new Event("memrelay:start-tour"))}
                >
                  <Icon name="compass" className="ico-sm" />
                  {t("nav.tour")}
                </button>
              </div>
            </div>
          </section>
          <div className="settings-grid">
            <div className="settings-col">
              <section className="card set-card">
                <div className="set-head">
                  <div className="set-icon">
                    <Icon name="file" />
                  </div>
                  <div className="set-title-wrap">
                    <div className="set-title">{t("set.summaryTitle")}</div>
                    <div className="set-desc">{t("set.summaryDesc")}</div>
                  </div>
                  <button
                    type="button"
                    className={cn("toggle", !sumEnabled && "off")}
                    aria-pressed={sumEnabled}
                    aria-label={t("set.summaryEnabled")}
                    onClick={() => setSumEnabled((value) => !value)}
                  />
                </div>

                {sumEnabled && (
                  <div className="set-form">
                    <div className="field span-2">
                      <label htmlFor="sum-base">{t("set.baseUrl")}</label>
                      <div className="input">
                        <input
                          id="sum-base"
                          value={sumBaseUrl}
                          onChange={(event) => setSumBaseUrl(event.target.value)}
                          placeholder="https://api.example.com/v1"
                          className="mono"
                        />
                        <span className="suffix">{t("set.openAiCompat")}</span>
                      </div>
                    </div>
                    <div className="field">
                      <label htmlFor="sum-model">{t("set.modelName")}</label>
                      <div className="input">
                        <input
                          id="sum-model"
                          value={sumModel}
                          onChange={(event) => setSumModel(event.target.value)}
                          placeholder={t("set.modelNamePlaceholder")}
                          className="mono"
                        />
                      </div>
                    </div>
                    <div className="field">
                      <label htmlFor="sum-key">{t("set.apiKey")}</label>
                      <div className="input secure">
                        <Icon name="lock" className="ico-sm" />
                        <input
                          id="sum-key"
                          type="password"
                          value={sumApiKey}
                          onChange={(event) => setSumApiKey(event.target.value)}
                          placeholder={settings.summary.apiKeySet ? t("set.apiKeyKeep") : ""}
                          className="mono"
                        />
                        {settings.summary.apiKeySet && <span className="suffix">{t("set.apiKeyHidden")}</span>}
                      </div>
                    </div>
                  </div>
                )}

                <div className="index-status">
                  {sumDirty && <p className="text-[11px] leading-relaxed text-[var(--amber)]">{t("set.embedUnsaved")}</p>}
                  <div className="index-top">
                    {!sumStatus || !sumStatus.enabled ? (
                      <span className="status st-gray">
                        <i />
                        {t("set.summaryDisabled")}
                      </span>
                    ) : !sumStatus.configured ? (
                      <span className="status st-amber">
                        <i />
                        {t("set.summaryNotConfigured")}
                      </span>
                    ) : (
                      <span className="status st-green">
                        <i />
                        {t("set.enabled")}
                      </span>
                    )}
                    {sumStatus?.enabled && sumStatus.configured && (
                      <span className="index-meta">
                        {t("set.summarySummarized", { n: sumStatus.summarizedSessions })}
                        <span className="dot-sep" />
                        {t("set.summaryPending", { n: sumStatus.pendingSessions })}
                        <span className="dot-sep" />
                        <span className="mono">{`${sumStatus.model}@${summaryHost || "?"}`}</span>
                      </span>
                    )}
                    {sumEnabled && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={sumBusy || !sumStatus?.configured}
                        onClick={() => void runSummaryBackfill(false)}
                      >
                        {summaryActive ? t("set.summaryBackfilling") : t("set.summaryBackfill")}
                      </button>
                    )}
                  </div>
                  {sumStatus?.lastError && (
                    <p className="mt-1 mono text-[11px] text-[var(--amber)]">
                      {t("set.summaryLastError", { err: sumStatus.lastError })}
                    </p>
                  )}
                  {sumEnabled && (
                    <div className="rail-actions">
                      {(sumStatus?.staleSessions ?? 0) > 0 && (
                        <ConfirmAction
                          onConfirm={() => runSummaryBackfill(true)}
                          confirmText={t("set.summaryRebuildConfirm")}
                          yesText={t("set.summaryRebuildYes")}
                          idleTitle={t("set.summaryRebuildHint")}
                          idleClassName="btn btn-secondary btn-sm"
                        >
                          {t("set.summaryRebuild")}
                        </ConfirmAction>
                      )}
                      {(sumStatus?.summarizedSessions ?? 0) > 0 && (
                        <ConfirmAction
                          onConfirm={runSummaryClear}
                          confirmText={t("set.summaryClearConfirm")}
                          yesText={t("set.summaryClearYes")}
                          idleTitle={t("set.summaryClearHint")}
                          idleClassName="action-link"
                        >
                          {t("set.summaryClear")}
                        </ConfirmAction>
                      )}
                    </div>
                  )}
                  {sumEnabled && summaryHost && (
                    <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--text-3)]">
                      {t("set.summaryPrivacy", { host: summaryHost })}
                    </p>
                  )}
                </div>
              </section>

              <section className="card set-card">
                <div className="set-head">
                  <div className="set-icon si-blue">
                    <Icon name="sparkles" />
                  </div>
                  <div className="set-title-wrap">
                    <div className="set-title">{t("set.tidyTitle")}</div>
                    <div className="set-desc">{t("set.tidyDesc")}</div>
                  </div>
                  <button
                    type="button"
                    className={cn("toggle", !tidEnabled && "off")}
                    aria-pressed={tidEnabled}
                    aria-label={t("set.tidyEnabled")}
                    onClick={() => setTidEnabled((value) => !value)}
                  />
                </div>

                {tidEnabled && (
                  <div className="set-form">
                    <div className="field span-2">
                      <label htmlFor="tid-base">{t("set.baseUrl")}</label>
                      <div className="input">
                        <input
                          id="tid-base"
                          value={tidBaseUrl}
                          onChange={(event) => setTidBaseUrl(event.target.value)}
                          placeholder="https://api.example.com/v1"
                          className="mono"
                        />
                        <span className="suffix">{t("set.openAiCompat")}</span>
                      </div>
                    </div>
                    <div className="field">
                      <label htmlFor="tid-model">{t("set.modelName")}</label>
                      <div className="input">
                        <input
                          id="tid-model"
                          value={tidModel}
                          onChange={(event) => setTidModel(event.target.value)}
                          placeholder={t("set.modelNamePlaceholder")}
                          className="mono"
                        />
                      </div>
                    </div>
                    <div className="field">
                      <label htmlFor="tid-key">{t("set.apiKey")}</label>
                      <div className="input secure">
                        <Icon name="lock" className="ico-sm" />
                        <input
                          id="tid-key"
                          type="password"
                          value={tidApiKey}
                          onChange={(event) => setTidApiKey(event.target.value)}
                          placeholder={settings.tidy.apiKeySet ? t("set.apiKeyKeep") : ""}
                          className="mono"
                        />
                        {settings.tidy.apiKeySet && <span className="suffix">{t("set.apiKeyHidden")}</span>}
                      </div>
                    </div>
                  </div>
                )}

                <div className="index-status">
                  {tidDirty && <p className="text-[11px] leading-relaxed text-[var(--amber)]">{t("set.embedUnsaved")}</p>}
                  <div className="index-top">
                    {!tidEnabled ? (
                      <span className="status st-gray">
                        <i />
                        {t("set.tidyDisabled")}
                      </span>
                    ) : !tidyConfigured ? (
                      <span className="status st-amber">
                        <i />
                        {t("set.tidyNotConfigured")}
                      </span>
                    ) : (
                      <span className="status st-green">
                        <i />
                        {t("set.enabled")}
                      </span>
                    )}
                    {tidEnabled && tidyConfigured && (
                      <span className="index-meta">
                        <span className="mono">{`${tidModel}@${tidyHost || "?"}`}</span>
                        <span className="dot-sep" />
                        {t("set.tidyAutoNote")}
                      </span>
                    )}
                  </div>
                  {tidEnabled && tidyHost && (
                    <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--text-3)]">
                      {t("set.tidyPrivacy", { host: tidyHost })}
                    </p>
                  )}
                </div>
              </section>

              <section className="card set-card">
                <div className="set-head">
                  <div className="set-icon si-blue">
                    <Icon name="database" />
                  </div>
                  <div className="set-title-wrap">
                    <div className="set-title">{t("set.embedTitle")}</div>
                    <div className="set-desc">{t("set.embedDesc")}</div>
                  </div>
                  <button
                    type="button"
                    className={cn("toggle", !embEnabled && "off")}
                    aria-pressed={embEnabled}
                    aria-label={t("set.embedEnabled")}
                    onClick={() => setEmbEnabled((value) => !value)}
                  />
                </div>

                {embEnabled && (
                  <div className="set-form">
                    <div className="field span-2">
                      <label htmlFor="emb-base">{t("set.embedBaseUrl")}</label>
                      <div className="input">
                        <input
                          id="emb-base"
                          value={embBaseUrl}
                          onChange={(event) => setEmbBaseUrl(event.target.value)}
                          placeholder="https://api.example.com/v1"
                          className="mono"
                        />
                        <span className="suffix">{t("set.openAiCompat")}</span>
                      </div>
                    </div>
                    <div className="field">
                      <label htmlFor="emb-model">{t("set.embedModel")}</label>
                      <div className="input">
                        <input
                          id="emb-model"
                          value={embModel}
                          onChange={(event) => setEmbModel(event.target.value)}
                          placeholder={t("set.embedModelPlaceholder")}
                          className="mono"
                        />
                      </div>
                    </div>
                    <div className="field">
                      <label htmlFor="emb-key">{t("set.embedApiKey")}</label>
                      <div className="input secure">
                        <Icon name="lock" className="ico-sm" />
                        <input
                          id="emb-key"
                          type="password"
                          value={embApiKey}
                          onChange={(event) => setEmbApiKey(event.target.value)}
                          placeholder={settings.embedding.apiKeySet ? t("set.apiKeyKeep") : ""}
                          className="mono"
                        />
                      </div>
                    </div>
                  </div>
                )}

                <div className="index-status">
                  {embDirty && <p className="text-[11px] leading-relaxed text-[var(--amber)]">{t("set.embedUnsaved")}</p>}
                  <div className="index-top">
                    {!embStatus || !embStatus.enabled ? (
                      <span className="status st-gray">
                        <i />
                        {t("set.embedDisabled")}
                      </span>
                    ) : !embStatus.configured ? (
                      <span className="status st-amber">
                        <i />
                        {t("set.embedNotConfigured")}
                      </span>
                    ) : (
                      <span className="status st-green">
                        <i />
                        {t("set.indexReady")}
                      </span>
                    )}
                    {embStatus?.enabled && embStatus.configured && (
                      <span className="index-meta">
                        {t("set.embedEmbedded", {
                          sessions: embStatus.embeddedSessions,
                          chunks: embStatus.embeddedChunks,
                        })}
                        <span className="dot-sep" />
                        {t("set.embedPending", { n: embStatus.pendingSessions })}
                        <span className="dot-sep" />
                        <span className="mono">{`${embStatus.model}@${effectiveHost || "?"}`}</span>
                      </span>
                    )}
                    {embEnabled && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={embBusy || !embStatus?.configured}
                        onClick={() => void runBackfill(false)}
                      >
                        {backfillActive ? t("set.embedBackfilling") : t("set.embedBackfill")}
                      </button>
                    )}
                  </div>
                  {(embStatus?.staleChunks ?? 0) > 0 && embStatus?.estimate && (
                    <p className="mt-2 text-[11px] leading-relaxed text-[var(--amber)]">
                      {t("set.embedStale", {
                        n: embStatus.staleChunks,
                        tokens: new Intl.NumberFormat(lang === "zh-Hant" ? "zh-TW" : lang).format(embStatus.estimate.tokens),
                        usd: embStatus.estimate.usd.toFixed(3),
                      })}
                    </p>
                  )}
                  {embStatus?.rulesOutdated && (
                    <p className="mt-1 text-[11px] text-[var(--text-3)]">{t("set.embedRulesOutdated")}</p>
                  )}
                  {embStatus?.lastError && (
                    <p className="mt-1 mono text-[11px] text-[var(--amber)]">
                      {t("set.embedLastError", { err: embStatus.lastError })}
                    </p>
                  )}
                  {embEnabled && (
                    <div className="rail-actions">
                      {(embStatus?.staleChunks ?? 0) > 0 && (
                        <ConfirmAction
                          onConfirm={() => runBackfill(true)}
                          confirmText={t("set.embedRebuildConfirm")}
                          yesText={t("set.embedRebuildYes")}
                          idleTitle={t("set.embedRebuildHint")}
                          idleClassName="btn btn-secondary btn-sm"
                        >
                          {t("set.embedRebuild")}
                        </ConfirmAction>
                      )}
                      {(embStatus?.embeddedChunks ?? 0) > 0 && (
                        <ConfirmAction
                          onConfirm={runClear}
                          confirmText={t("set.embedClearConfirm")}
                          yesText={t("set.embedClearYes")}
                          idleTitle={t("set.embedClearHint")}
                          idleClassName="action-link"
                        >
                          {t("set.embedClear")}
                        </ConfirmAction>
                      )}
                    </div>
                  )}
                  {embEnabled && (
                    <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--text-3)]">
                      {t("set.embedPrivacy", { host: effectiveHost || "…" })}
                    </p>
                  )}
                </div>
              </section>

              <section className="card set-card">
                <div className="set-head">
                  <div className="set-title-wrap">
                    <div className="set-title">{t("set.autoIntegrate")}</div>
                    <div className="set-desc">{t("set.autoIntegrateDesc")}</div>
                  </div>
                  <button
                    type="button"
                    className={cn("toggle", !autoIntegrate && "off")}
                    aria-pressed={autoIntegrate}
                    aria-label={t("set.autoIntegrate")}
                    onClick={() => setAutoIntegrate((value) => !value)}
                  />
                </div>
              </section>
            </div>

            <aside className="settings-col">
              <section className="card rail-card">
                <div className="rail-head">
                  <div className="rail-title">{t("set.runtimeTitle")}</div>
                  <span className="status st-green">
                    <i />
                    {t("set.running")}
                  </span>
                </div>
                <div className="kv">
                  <span className="k">{t("set.version")}</span>
                  <span className="v mono">v{integrations?.version ?? "?"}</span>
                </div>
                <div className="kv">
                  <span className="k">{t("set.dataDirLabel")}</span>
                  <span className="v mono path">{integrations?.dataDir ?? "…"}</span>
                </div>
                <div className="kv">
                  <span className="k">{t("set.indexed")}</span>
                  <span className="v">{taskTotal === null ? "…" : t("set.indexedTasks", { n: taskTotal })}</span>
                </div>
                <div className="kv">
                  <span className="k">{t("set.embedStatusTitle")}</span>
                  <span className="v">
                    {embStatus?.enabled
                      ? t("set.embedRuntime", {
                          chunks: embStatus.embeddedChunks,
                          pending: embStatus.pendingSessions,
                        })
                      : t("set.embedDisabled")}
                  </span>
                </div>
              </section>

              <section className="card rail-card">
                <div className="rail-head">
                  <div className="rail-title">{t("set.summaryQueue")}</div>
                  <span className={cn("status", summaryActive ? "st-green" : "st-gray")}>
                    <i />
                    {summaryActive ? t("set.queueActive") : t("set.queueIdle")}
                  </span>
                </div>
                <div className="kv">
                  <span className="k">{t("set.queuePending")}</span>
                  <span className="v">{sumStatus?.pendingSessions ?? 0}</span>
                </div>
                <div className="kv">
                  <span className="k">{t("set.queueDone")}</span>
                  <span className="v">{sumStatus?.summarizedSessions ?? 0}</span>
                </div>
                <div className="kv">
                  <span className="k">{t("set.queueStale")}</span>
                  <span className="v">{sumStatus?.staleSessions ?? 0}</span>
                </div>
                <div className="queue-line">
                  <span>{summaryActive ? t("set.queueActive") : t("set.queueIdle")}</span>
                  <span className="mono">{t("set.queueProgress", { done: sumStatus?.summarizedSessions ?? 0, total: queueTotal })}</span>
                </div>
                <div className="progress">
                  <span style={{ width: `${Math.min(100, Math.max(0, queueRatio))}%` }} />
                </div>
                {sumStatus?.lastError && (
                  <p className="mt-2 mono text-[10px] text-[var(--amber)]">
                    {t("set.summaryLastError", { err: sumStatus.lastError })}
                  </p>
                )}
              </section>

              <section className="card rail-card privacy-note">
                <Icon name="shield-check" />
                <div>
                  <div className="privacy-note-title">{t("set.dataLocal")}</div>
                  <div className="privacy-note-text">{t("set.dataLocalText")}</div>
                </div>
              </section>

              <div className="card rail-card">
                <div className="rail-head">
                  <div className="rail-title">{t("set.about")}</div>
                </div>
                <p className="text-[10.5px] leading-relaxed text-[var(--text-3)]">{t("set.privacyNote")}</p>
              </div>
            </aside>
          </div>

          <div className="card save-bar">
            <span className="saved-state">
              <Icon name="check" className="ico-sm" />
              {dirty ? t("set.saveBarDirty") : t("set.saveBarSaved")}
            </span>
            <div className="save-actions">
              <button type="button" className="btn btn-ghost" onClick={discard} disabled={!dirty || saving}>
                {t("set.discard")}
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving || !dirty}>
                {saving ? t("set.saving") : t("set.saveChanges")}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
