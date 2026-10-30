import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { zh, type LocaleDict, type MsgKey } from "./locales/zh";
import { en } from "./locales/en";
import { zhHant } from "./locales/zh-Hant";
import { ja } from "./locales/ja";
import { ko } from "./locales/ko";
import { es } from "./locales/es";
import { fr } from "./locales/fr";
import { de } from "./locales/de";
import { fa } from "./locales/fa";
import { ptBr } from "./locales/pt-BR";
import { id } from "./locales/id";

export type { MsgKey } from "./locales/zh";

export type Lang =
  | "zh"
  | "en"
  | "zh-Hant"
  | "ja"
  | "ko"
  | "es"
  | "fr"
  | "de"
  | "fa"
  | "pt-BR"
  | "id";

interface LanguageMeta {
  code: Lang;
  native: string;
  nameKey: MsgKey;
  htmlLang: string;
  dir: "ltr" | "rtl";
}

export const LANGUAGES: LanguageMeta[] = [
  { code: "zh", native: "简体中文", nameKey: "lang.name.zh", htmlLang: "zh-CN", dir: "ltr" },
  { code: "en", native: "English", nameKey: "lang.name.en", htmlLang: "en", dir: "ltr" },
  { code: "zh-Hant", native: "繁體中文", nameKey: "lang.name.zh-Hant", htmlLang: "zh-TW", dir: "ltr" },
  { code: "ja", native: "日本語", nameKey: "lang.name.ja", htmlLang: "ja", dir: "ltr" },
  { code: "ko", native: "한국어", nameKey: "lang.name.ko", htmlLang: "ko", dir: "ltr" },
  { code: "es", native: "Español", nameKey: "lang.name.es", htmlLang: "es", dir: "ltr" },
  { code: "fr", native: "Français", nameKey: "lang.name.fr", htmlLang: "fr", dir: "ltr" },
  { code: "de", native: "Deutsch", nameKey: "lang.name.de", htmlLang: "de", dir: "ltr" },
  { code: "fa", native: "فارسی", nameKey: "lang.name.fa", htmlLang: "fa", dir: "rtl" },
  { code: "pt-BR", native: "Português (BR)", nameKey: "lang.name.pt-BR", htmlLang: "pt-BR", dir: "ltr" },
  { code: "id", native: "Bahasa Indonesia", nameKey: "lang.name.id", htmlLang: "id", dir: "ltr" },
];

const MESSAGES: Record<Lang, LocaleDict> = {
  zh,
  en,
  "zh-Hant": zhHant,
  ja,
  ko,
  es,
  fr,
  de,
  fa,
  "pt-BR": ptBr,
  id,
};

const LANGUAGE_BY_CODE = new Map<Lang, LanguageMeta>(LANGUAGES.map((item) => [item.code, item]));

const KEY = "memrelay-lang";

function fill(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  let text = template;
  for (const [name, value] of Object.entries(vars)) {
    text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}

export function translate(lang: Lang, key: MsgKey, vars?: Record<string, string | number>): string {
  return fill(MESSAGES[lang][key], vars);
}

export function detectLang(preferred: readonly string[]): Lang {
  for (const raw of preferred) {
    const tag = raw.toLowerCase();
    if (tag.startsWith("zh")) return /hant|tw|hk|mo/.test(tag) ? "zh-Hant" : "zh";
    if (tag.startsWith("en")) return "en";
    if (tag.startsWith("ja")) return "ja";
    if (tag.startsWith("ko")) return "ko";
    if (tag.startsWith("es")) return "es";
    if (tag.startsWith("fr")) return "fr";
    if (tag.startsWith("de")) return "de";
    if (tag.startsWith("fa")) return "fa";
    if (tag.startsWith("pt")) return "pt-BR";
    if (tag.startsWith("id") || tag.startsWith("in-") || tag === "in") return "id";
  }
  return "en";
}

function readLang(): Lang {
  const saved = localStorage.getItem(KEY);
  if (saved && LANGUAGES.some((item) => item.code === saved)) return saved as Lang;
  return detectLang(navigator.languages ?? [navigator.language]);
}

interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: MsgKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18n | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readLang);

  useEffect(() => {
    const meta = LANGUAGE_BY_CODE.get(lang);
    if (!meta) return;
    document.documentElement.lang = meta.htmlLang;
    document.documentElement.dir = meta.dir;
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    localStorage.setItem(KEY, next);
  }, []);

  const t = useCallback(
    (key: MsgKey, vars?: Record<string, string | number>) => translate(lang, key, vars),
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within LangProvider");
  return ctx;
}
