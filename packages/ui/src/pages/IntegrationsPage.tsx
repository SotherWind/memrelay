import { useEffect, useState } from "react";
import { applyIntegrations, fetchIntegrations, runSelfTest } from "../api/client";
import type { IntegrationsResponse, TerminalTestResult } from "../api/types";
import { MonoBlock } from "../components/Collapsible";
import { Icon } from "../components/icons";
import { useI18n, type MsgKey } from "../lib/i18n";
import { cn } from "../lib/cn";

const TOOL_PATHS: Record<string, string> = {
  "claude-code": "~/.claude/projects",
  qoder: "~/.qoder/projects",
  "qoder-ide": "~/.qoder",
  codex: "~/.codex/sessions",
  cursor: "%APPDATA%\\Cursor\\state.vscdb",
  codebuddy: "~/.codebuddy/projects · IDE history",
  workbuddy: "~/.workbuddy/projects",
  zcode: "~/.zcode/cli/db.sqlite",
  opencode: "~/.local/share/opencode",
  trae: "~/.trae/cli",
  "trae-cn": "~/.trae-cn",
  dsh: "~/.dsh/sessions",
  hermes: "~/.hermes",
};

const DESC_IDS = new Set([
  "claude-code",
  "qoder",
  "qoder-ide",
  "codex",
  "cursor",
  "codebuddy",
  "workbuddy",
  "zcode",
  "opencode",
  "trae",
  "trae-cn",
  "dsh",
  "hermes",
]);

function initialsOf(tool: string): string {
  const map: Record<string, string> = {
    qoder: "Q",
    "qoder-ide": "QI",
    "claude-code": "CC",
    codex: "CX",
    cursor: "C",
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

export function IntegrationsPage() {
  const { t } = useI18n();
  const [data, setData] = useState<IntegrationsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [applying, setApplying] = useState(false);
  const [applyLog, setApplyLog] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [tests, setTests] = useState<TerminalTestResult[] | null>(null);

  const adopt = (response: IntegrationsResponse) => {
    setData(response);
    setChecked(
      Object.fromEntries(response.tools.filter((tool) => tool.installed).map((tool) => [tool.id, tool.integrated])),
    );
  };

  useEffect(() => {
    let live = true;
    fetchIntegrations()
      .then((response) => {
        if (live) adopt(response);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, []);

  const recheck = () => {
    setError(null);
    fetchIntegrations()
      .then(adopt)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  const apply = async () => {
    setApplying(true);
    setApplyLog(null);
    try {
      const result = await applyIntegrations(checked);
      setApplyLog(result.log);
      adopt(result.integrations);
    } catch (err) {
      setApplyLog(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  };

  const selftest = async () => {
    setTesting(true);
    try {
      setTests(await runSelfTest());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  if (error && !data) {
    return (
      <>
        <header className="page-head">
          <div>
            <h1 className="page-title">{t("nav.integrations")}</h1>
          </div>
        </header>
        <div className="card state-card">
          <p className="title">{t("tasks.error")}</p>
          <p className="detail">{error}</p>
        </div>
      </>
    );
  }
  if (!data) {
    return (
      <>
        <header className="page-head">
          <div>
            <h1 className="page-title">{t("nav.integrations")}</h1>
          </div>
        </header>
        <p className="loading-note">{t("tasks.loading")}</p>
      </>
    );
  }

  const integrated = data.tools.filter((tool) => tool.integrated).length;
  const live = data.tools.filter((tool) => tool.integrated && tool.liveIndex).length;
  const pending = data.tools.filter(
    (tool) => tool.installed && (checked[tool.id] ?? false) !== tool.integrated,
  ).length;

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("nav.integrations")}</h1>
          <p className="page-sub">
            {t("integ.subtitle", { total: data.tools.length, n: integrated, m: live })}
          </p>
        </div>
        <div className="head-actions">
          <button type="button" className="btn btn-secondary" onClick={recheck}>
            <Icon name="refresh" />
            {t("integ.recheck")}
          </button>
        </div>
      </header>

      <div className="card tip-bar">
        <Icon name="info" />
        <span>{t("integ.tip")}</span>
      </div>

      <div className="tool-grid">
        {data.tools.map((tool) => {
          const selected = checked[tool.id] ?? false;
          const desc = DESC_IDS.has(tool.id)
            ? t(`integ.desc.${tool.id}` as MsgKey)
            : t("integ.desc.default");
          return (
            <article
              key={tool.id}
              className={cn(
                "card tool-card",
                !tool.installed && "off",
              )}
              onClick={() => {
                if (!tool.installed) return;
                setChecked((current) => ({ ...current, [tool.id]: !selected }));
              }}
              role="button"
              aria-pressed={tool.installed ? selected : undefined}
              aria-disabled={!tool.installed}
              tabIndex={tool.installed ? 0 : -1}
              onKeyDown={(event) => {
                if (!tool.installed) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setChecked((current) => ({ ...current, [tool.id]: !selected }));
                }
              }}
            >
              <div className="tool-top">
                <span className="tool-icon" data-tool={tool.id}>
                  {initialsOf(tool.id)}
                </span>
                <div className="tool-info">
                  <div className="tool-name">{tool.name}</div>
                  <div className="tool-path mono">
                    {TOOL_PATHS[tool.id] ?? tool.skillDirs[0] ?? ""}
                  </div>
                </div>
                <span
                  className={cn(
                    "status",
                    !tool.installed ? "st-gray" : tool.integrated ? "st-green" : "st-gray",
                  )}
                >
                  <i />
                  {!tool.installed
                    ? t("integ.notInstalled")
                    : tool.integrated
                      ? t("integ.status.integrated")
                      : t("integ.status.notIntegrated")}
                </span>
              </div>
              <div className="tool-desc">{desc}</div>
              <div className="tool-bottom">
                {tool.installed && selected !== tool.integrated && (
                  <span className="tag tag-accent">{t("integ.pendingTag")}</span>
                )}
                {tool.startupHint && (
                  <span className="tag tag-blue">{t("integ.startupHint")}</span>
                )}
                {tool.liveIndex && (
                  <span className="tag tag-green">{t("integ.liveIndex")}</span>
                )}
                {!tool.liveIndex && tool.canBeSource && (
                  <span className="tag tag-amber">{t("integ.scanIndex")}</span>
                )}
                {tool.encrypted && <span className="tag tag-gray">{t("integ.encrypted")}</span>}
                {tool.installed && !tool.canBeSource && (
                  <span className="tag tag-gray">{t("integ.receiverOnly")}</span>
                )}
                {tool.installed ? (
                  <span
                    className={cn(
                      "check-box tool-check",
                      selected && "on",
                    )}
                  >
                    {selected && <Icon name="check" className="ico-sm" />}
                  </span>
                ) : (
                  <span className="tool-chevron">
                    <Icon name="plus" className="ico-sm" />
                  </span>
                )}
              </div>
            </article>
          );
        })}
      </div>

      <div className="card action-bar">
        <div className="action-state">
          <span className="pulse-dot" />
          {pending === 0 ? t("integ.applied") : t("integ.pending", { n: pending })}
          <span className="muted">·</span>
          <span className="muted">{t("integ.selectHint")}</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-secondary" disabled={testing} onClick={() => void selftest()}>
            <Icon name="zap" />
            {testing ? t("integ.selftesting") : t("integ.selftest")}
          </button>
          <button type="button" className="btn btn-primary" disabled={applying || pending === 0} onClick={() => void apply()}>
            {applying ? t("integ.applying") : t("integ.applyChanges")}
          </button>
        </div>
      </div>

      {error && <div className="card state-card mt-3"><p className="detail">{error}</p></div>}

      {applyLog !== null && (
        <section className="mt-4">
          <h2 className="panel-title pb-2">{t("integ.output")}</h2>
          <div className="card panel">
            <MonoBlock maxHeight="320px">{applyLog || "（无输出）"}</MonoBlock>
          </div>
        </section>
      )}

      {tests && (
        <section className="mt-4">
          <h2 className="panel-title pb-2">{t("integ.selftestTitle")}</h2>
          <div className="card overflow-hidden">
            {tests.map((test, index) => (
              <div
                key={test.terminal}
                className={cn(
                  "flex items-center justify-between gap-3 px-4 py-2.5",
                  index > 0 && "border-t border-[var(--border)]",
                )}
              >
                <span className="mono text-xs text-[var(--text-2)]">{test.terminal}</span>
                <div className="flex items-center gap-2.5">
                  {test.detail && <span className="truncate mono text-[11px] text-[var(--text-3)]">{test.detail}</span>}
                  <span
                    className={cn(
                      "tag",
                      test.passed === true ? "tag-green" : test.passed === false ? "tag-gray" : "tag-blue",
                    )}
                  >
                    {test.passed === true ? t("integ.pass") : test.passed === false ? t("integ.fail") : t("integ.skip")}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
