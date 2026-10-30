export const SECRET_RULES_VERSION = 2;

function preview(secret: string, keepStart = 3, keepEnd = 2): string {
  const len = secret.length;
  if (len <= keepStart + keepEnd + 1) return "***";
  let start = keepStart;
  // 分隔符（如 ghp_ 的下划线）保留在预览里，便于识别类型
  if (secret[start] === "_") start += 1;
  else if (start > 0 && secret[start - 1] === "_") start += 1;
  const head = secret.slice(0, start);
  const end = secret.slice(len - keepEnd);
  return `${head}…${end}`;
}

const BUILDERS: Array<{
  id: string;
  re: RegExp;
  format: (m: string, ...groups: string[]) => string;
}> = [
  {
    id: "private-key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    format: () => "[REDACTED PRIVATE KEY]",
  },
  {
    id: "openai-key",
    re: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    format: (m) => preview(m, 3, 4),
  },
  {
    id: "anthropic-key",
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    format: (m) => preview(m, 7, 4),
  },
  {
    id: "github-token",
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
    format: (m) => preview(m, 4, 4),
  },
  {
    id: "aws-access-key",
    re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    format: (m) => preview(m, 4, 4),
  },
  {
    id: "slack-token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    format: (m) => preview(m, 4, 4),
  },
  {
    id: "npm-token",
    re: /\bnpm_[A-Za-z0-9]{36}\b/g,
    format: (m) => preview(m, 4, 4),
  },
  {
    id: "bearer-token",
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
    format: (m) => `Bearer ${preview(m.slice(7), 3, 3)}`,
  },
  {
    id: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
    format: (m) => preview(m, 6, 4),
  },
  {
    id: "connection-string",
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql|sqlserver):\/\/[^:\s/@]+:[^@\s/]+@/gi,
    format: (m) => {
      const i = m.indexOf("://");
      const rest = m.slice(i + 3);
      const colon = rest.indexOf(":");
      const user = rest.slice(0, colon);
      const scheme = m.slice(0, i + 3);
      return `${scheme}${user}:***@`;
    },
  },
  {
    id: "stripe-key",
    re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    format: (m) => preview(m, 8, 4),
  },
  {
    id: "google-api-key",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    format: (m) => preview(m, 4, 4),
  },
  {
    id: "basic-auth",
    re: /\bBasic\s+[A-Za-z0-9+/=]{16,}/g,
    format: (m) => `Basic ${preview(m.slice(6), 3, 3)}`,
  },
  {
    id: "url-userinfo",
    re: /\b(https?:\/\/[^/\s:@]+):[^@\s/]+@/gi,
    format: (_m, schemeUser) => `${schemeUser}:***@`,
  },
  {
    id: "password-assignment",
    re: /(^|[^\w.-])([\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[\w.-]*)\s*[=:]\s*["']?([^\s"'&;]{6,})["']?/gi,
    format: (m, _prefix, key, value) => {
      // PWD/OLDPWD 是工作目录，不是口令；只挡这一种常见误报
      if (/^(old)?pwd$/i.test(String(key))) return m;
      return String(value).includes("…") ? m : m.replace(value as string, preview(String(value), 2, 0));
    },
  },
];

export interface RedactionResult {
  text: string;
  findings: Array<{ ruleId: string; preview: string }>;
}

export function redactSecrets(text: string): RedactionResult {
  let out = text;
  const findings: RedactionResult["findings"] = [];
  for (const rule of BUILDERS) {
    out = out.replace(rule.re, (m: string, ...args: unknown[]) => {
      const groups = args.slice(0, -2).map(String);
      const masked = rule.format(m, ...groups);
      findings.push({ ruleId: rule.id, preview: masked });
      return masked;
    });
  }
  return { text: out, findings };
}

export function containsSecrets(text: string): boolean {
  for (const rule of BUILDERS) {
    rule.re.lastIndex = 0;
    if (rule.re.test(text)) {
      rule.re.lastIndex = 0;
      return true;
    }
    rule.re.lastIndex = 0;
  }
  return false;
}
