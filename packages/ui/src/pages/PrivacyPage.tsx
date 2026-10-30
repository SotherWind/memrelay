import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchPrivacy, saveExclusions } from "../api/client";
import type { PrivacyResponse, SecretFinding } from "../api/types";
import { Icon } from "../components/icons";
import { useI18n, type MsgKey } from "../lib/i18n";
import { cn } from "../lib/cn";

type Category = "openai" | "aws" | "github" | "other";

const RULES: Record<string, { key: MsgKey; category: Category }> = {
  "openai-key": { key: "priv.rule.openai", category: "openai" },
  "anthropic-key": { key: "priv.rule.anthropic", category: "other" },
  "github-token": { key: "priv.rule.github", category: "github" },
  "aws-access-key": { key: "priv.rule.aws", category: "aws" },
  "slack-token": { key: "priv.rule.slack", category: "other" },
  "npm-token": { key: "priv.rule.npm", category: "other" },
  "bearer-token": { key: "priv.rule.bearer", category: "other" },
  jwt: { key: "priv.rule.jwt", category: "other" },
  "connection-string": { key: "priv.rule.connection", category: "other" },
  "private-key": { key: "priv.rule.privateKey", category: "other" },
  "password-assignment": { key: "priv.rule.password", category: "other" },
};

interface RuleGroup {
  ruleId: string;
  key: MsgKey | null;
  category: Category;
  findings: SecretFinding[];
  sessions: number;
}

export function PrivacyPage() {
  const { t } = useI18n();
  const [data, setData] = useState<PrivacyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirInput, setDirInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [category, setCategory] = useState<"all" | Category>("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = () => {
    fetchPrivacy()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(() => {
    let live = true;
    fetchPrivacy()
      .then((response) => {
        if (live) setData(response);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, []);

  const update = async (dirs: string[]) => {
    setSaving(true);
    try {
      const excludedDirs = await saveExclusions(dirs);
      setData((current) => (current ? { ...current, excludedDirs } : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const addDir = () => {
    const dir = dirInput.trim();
    if (!dir || !data || data.excludedDirs.includes(dir)) return;
    void update([...data.excludedDirs, dir]);
    setDirInput("");
  };

  const groups: RuleGroup[] = [];
  const byRule = new Map<string, SecretFinding[]>();
  for (const secret of data?.secrets ?? []) {
    const bucket = byRule.get(secret.ruleId) ?? [];
    bucket.push(secret);
    byRule.set(secret.ruleId, bucket);
  }
  for (const [ruleId, findings] of byRule) {
    const rule = RULES[ruleId];
    groups.push({
      ruleId,
      key: rule?.key ?? null,
      category: rule?.category ?? "other",
      findings,
      sessions: new Set(findings.map((finding) => finding.sessionId)).size,
    });
  }
  groups.sort((a, b) => b.findings.length - a.findings.length);

  const categoryCounts: Record<Category, number> = { openai: 0, aws: 0, github: 0, other: 0 };
  for (const group of groups) categoryCounts[group.category] += group.findings.length;
  const totalSecrets = data?.secrets.length ?? 0;
  const totalSessions = new Set((data?.secrets ?? []).map((secret) => secret.sessionId)).size;
  const visibleGroups = groups.filter((group) => category === "all" || group.category === category);
  const samples = groups.slice(0, 2);

  const ruleName = (group: RuleGroup): string =>
    group.key ? t(group.key) : group.ruleId;

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("nav.privacy")}</h1>
          <p className="page-sub">{t("priv.subtitle")}</p>
        </div>
        <div className="head-actions">
          <button type="button" className="btn btn-secondary" onClick={load}>
            <Icon name="refresh" />
            {t("priv.refresh")}
          </button>
        </div>
      </header>

      {error && (
        <div className="card state-card">
          <p className="title">{t("tasks.error")}</p>
          <p className="detail">{error}</p>
        </div>
      )}
      {!data ? (
        error ? null : <p className="loading-note">{t("tasks.loading")}</p>
      ) : (
        <>
          <div className="stat-row">
            <div className="card stat-card">
              <div className="stat-icon si-gray">
                <Icon name="folder-x" />
              </div>
              <div>
                <div className="stat-label">{t("priv.stat.excluded")}</div>
                <div className="stat-value">
                  {data.excludedDirs.length} <small>{t("priv.unitCount")}</small>
                </div>
                <div className="stat-foot">{t("priv.stat.excludedFoot")}</div>
              </div>
            </div>
            <div className="card stat-card">
              <div className="stat-icon si-amber">
                <Icon name="lock" />
              </div>
              <div>
                <div className="stat-label">{t("priv.stat.secrets")}</div>
                <div className="stat-value">
                  {totalSecrets} <small>{t("priv.unitSecrets")}</small>
                </div>
                <div className="stat-foot">
                  {t("priv.stat.secretsFoot", { sessions: totalSessions, rules: groups.length })}
                </div>
              </div>
            </div>
            <div className="card stat-card">
              <div className="stat-icon si-green">
                <Icon name="shield-check" />
              </div>
              <div>
                <div className="stat-label">{t("priv.stat.redact")}</div>
                <div className="stat-value is-on">{t("priv.stat.redactOn")}</div>
                <div className="stat-foot">{t("priv.stat.redactFoot")}</div>
              </div>
            </div>
          </div>

          <div className="privacy-grid">
            <section className="card privacy-card">
              <div className="privacy-title">
                {t("priv.excludeTitle")} <span className="count-badge">{data.excludedDirs.length}</span>
              </div>
              <p className="privacy-desc">{t("priv.excludeDesc")}</p>

              {data.excludedDirs.length === 0 ? (
                <div className="exclude-empty">
                  <div className="empty-icon">
                    <Icon name="folder-x" />
                  </div>
                  <div className="empty-title">{t("priv.emptyTitle")}</div>
                  <div className="empty-text">{t("priv.emptyText")}</div>
                </div>
              ) : (
                <div className="secret-list flex-1">
                  {data.excludedDirs.map((dir, index) => (
                    <div
                      key={dir}
                      className={cn(
                        "flex items-center justify-between gap-3 py-3",
                        index > 0 && "border-t border-[var(--border)]",
                      )}
                    >
                      <span className="truncate mono text-[11px] text-[var(--text-2)]">{dir}</span>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void update(data.excludedDirs.filter((item) => item !== dir))}
                        className="action-link shrink-0"
                      >
                        {t("priv.remove")}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="exclude-add">
                <label className="field-label" htmlFor="exclude-dir">
                  {t("priv.addDir")}
                </label>
                <div className="input-row">
                  <div className="input">
                    <Icon name="folder" className="ico-sm" />
                    <input
                      id="exclude-dir"
                      value={dirInput}
                      onChange={(event) => setDirInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") addDir();
                      }}
                      placeholder={t("priv.addPlaceholder")}
                      className="mono"
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={saving || !dirInput.trim()}
                    onClick={addDir}
                  >
                    {t("priv.add")}
                  </button>
                </div>
                <div className="field-hint">{t("priv.addHint")}</div>
              </div>
            </section>

            <section className="card privacy-card">
              <div className="privacy-title">
                {t("priv.secretsTitle")}{" "}
                <span className="count-badge amber">{t("priv.secretCount", { n: totalSecrets })}</span>
              </div>
              <p className="privacy-desc">{t("priv.secretsDesc")}</p>

              {totalSecrets === 0 ? (
                <div className="exclude-empty">
                  <div className="empty-icon">
                    <Icon name="shield-check" />
                  </div>
                  <div className="empty-title">{t("priv.noSecretsTitle")}</div>
                  <div className="empty-text">{t("priv.noSecretsText")}</div>
                </div>
              ) : (
                <>
                  <div className="chips">
                    <button
                      type="button"
                      className={cn("chip", category === "all" && "active")}
                      onClick={() => setCategory("all")}
                    >
                      {t("priv.all")} <span>{totalSecrets}</span>
                    </button>
                    {categoryCounts.openai > 0 && (
                      <button
                        type="button"
                        className={cn("chip", category === "openai" && "active")}
                        onClick={() => setCategory("openai")}
                      >
                        OpenAI <span>{categoryCounts.openai}</span>
                      </button>
                    )}
                    {categoryCounts.aws > 0 && (
                      <button
                        type="button"
                        className={cn("chip", category === "aws" && "active")}
                        onClick={() => setCategory("aws")}
                      >
                        AWS <span>{categoryCounts.aws}</span>
                      </button>
                    )}
                    {categoryCounts.github > 0 && (
                      <button
                        type="button"
                        className={cn("chip", category === "github" && "active")}
                        onClick={() => setCategory("github")}
                      >
                        GitHub <span>{categoryCounts.github}</span>
                      </button>
                    )}
                    {categoryCounts.other > 0 && (
                      <button
                        type="button"
                        className={cn("chip", category === "other" && "active")}
                        onClick={() => setCategory("other")}
                      >
                        {t("priv.other")} <span>{categoryCounts.other}</span>
                      </button>
                    )}
                  </div>

                  <div className="secret-list">
                    {visibleGroups.map((group) => (
                      <div key={group.ruleId}>
                        <button
                          type="button"
                          className="secret-row"
                          aria-expanded={expanded === group.ruleId}
                          onClick={() => setExpanded((current) => (current === group.ruleId ? null : group.ruleId))}
                        >
                          <span className="secret-icon">
                            <Icon name="lock" />
                          </span>
                          <span className="secret-main">
                            <span className="secret-name">
                              {ruleName(group)}
                              <span className="secret-count">{t("priv.findingsCount", { n: group.findings.length })}</span>
                            </span>
                            <span className="secret-sample mono block">{group.findings[0]?.preview}</span>
                            <span className="secret-meta block">
                              {t("priv.sessionsCount", { n: group.sessions })}
                            </span>
                          </span>
                          <Icon name={expanded === group.ruleId ? "chevron-down" : "chevron-right"} className="ico-sm" />
                        </button>
                        {expanded === group.ruleId && (
                          <div className="secret-findings">
                            {group.findings.map((finding, index) => (
                              <Link
                                key={`${finding.sessionId}-${finding.ordinal ?? index}`}
                                to={`/conversations/${encodeURIComponent(finding.sessionId)}${
                                  finding.ordinal !== null ? `?at=${finding.ordinal}` : ""
                                }`}
                                className="secret-finding"
                              >
                                <span className="mono">{finding.preview}</span>
                                <span className="ml-auto truncate">
                                  {finding.sessionTitle ?? finding.sessionId}
                                </span>
                              </Link>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="redact-preview">
                    <div className="redact-preview-head">
                      <span>{t("priv.redactHead")}</span>
                      <span className="mono">{t("priv.redactCount", { n: totalSecrets })}</span>
                    </div>
                    <div className="redact-preview-body mono">
                      {samples.map((group) => (
                        <div key={group.ruleId}>
                          <span className="tok">{ruleName(group)}</span>=
                          <span className="mask">{group.findings[0]?.preview}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="redact-note">
                    <Icon name="shield-check" />
                    <div>
                      <div className="redact-title">{t("priv.redactTitle")}</div>
                      <div className="redact-text">{t("priv.redactText")}</div>
                    </div>
                  </div>
                </>
              )}
            </section>
          </div>

          <div className="card privacy-strip">
            <Icon name="lock" className="ico-sm" />
            <span>{t("priv.strip")}</span>
          </div>
        </>
      )}
    </>
  );
}
