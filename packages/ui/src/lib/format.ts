import { translate, type Lang } from "./i18n";

function localeOf(lang: Lang): string {
  return lang === "zh-Hant" ? "zh-TW" : lang;
}

function dateTimeFormat(lang: Lang): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(localeOf(lang), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatRelative(ts: number, lang: Lang, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - ts) / 60_000);
  if (minutes < 1) return translate(lang, "time.justNow");
  if (minutes < 60) return translate(lang, "time.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return translate(lang, "time.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  if (days === 1) return translate(lang, "time.yesterday");
  if (days < 30) return translate(lang, "time.daysAgo", { n: days });
  return new Intl.DateTimeFormat(localeOf(lang), { month: "short", day: "numeric" }).format(new Date(ts));
}

export function formatStamp(ms: number, lang?: Lang): string {
  if (!ms) return "";
  if (lang) return dateTimeFormat(lang).format(new Date(ms));
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatRange(startMs: number, endMs: number, lang?: Lang): string {
  if (!startMs && !endMs) return "";
  if (!endMs || endMs <= startMs) return formatStamp(startMs || endMs, lang);
  return `${formatStamp(startMs, lang)} → ${formatStamp(endMs, lang)}`;
}
