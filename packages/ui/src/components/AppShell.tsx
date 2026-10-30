import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { fetchHealth } from "../api/client";
import { Icon } from "./icons";
import { QuickTour } from "./QuickTour";
import { LANGUAGES, useI18n, type MsgKey } from "../lib/i18n";
import { STYLES, MOTIONS, useAppearance, useMotionEnabled, type MotionMode, type StyleId, type ThemeMode } from "../lib/theme";
import { startViewTransition } from "../lib/view-transition";
import { cn } from "../lib/cn";
import markMinimalLight from "../assets/logo/memrelay-mark-minimal-light.png";
import markMinimalDark from "../assets/logo/memrelay-mark-minimal-dark.png";
import markComicLight from "../assets/logo/memrelay-mark-comic-light.png";
import markComicDark from "../assets/logo/memrelay-mark-comic-dark.png";
import markPixelLight from "../assets/logo/memrelay-mark-pixel-light.png";
import markPixelDark from "../assets/logo/memrelay-mark-pixel-dark.png";

const MARKS: Record<StyleId, { light: string; dark: string }> = {
  minimal: { light: markMinimalLight, dark: markMinimalDark },
  comic: { light: markComicLight, dark: markComicDark },
  pixel: { light: markPixelLight, dark: markPixelDark },
};

const NAV_PRIMARY = [
  { to: "/dashboard", key: "nav.dashboard", icon: "dashboard" },
  { to: "/tasks", key: "nav.tasks", icon: "folder" },
  { to: "/conversations", key: "nav.conversations", icon: "chat" },
  { to: "/tidy", key: "nav.tidy", icon: "sparkles" },
  { to: "/integrations", key: "nav.integrations", icon: "plug" },
] as const;

const NAV_SECONDARY = [
  { to: "/privacy", key: "nav.privacy", icon: "shield" },
  { to: "/trash", key: "nav.trash", icon: "trash" },
  { to: "/settings", key: "nav.settings", icon: "settings" },
] as const;

const STYLE_LABELS: Record<StyleId, MsgKey> = {
  minimal: "theme.style.minimal",
  comic: "theme.style.comic",
  pixel: "theme.style.pixel",
};

const MODE_LABELS: Record<ThemeMode, MsgKey> = {
  light: "theme.mode.light",
  dark: "theme.mode.dark",
  system: "theme.mode.system",
};

const MODES: ThemeMode[] = ["light", "dark", "system"];

const MOTION_LABELS: Record<MotionMode, MsgKey> = {
  system: "theme.motion.system",
  on: "theme.motion.on",
  off: "theme.motion.off",
};

export function AppShell() {
  const { t, lang, setLang } = useI18n();
  const { style, mode, motion: motionMode, theme, setStyle, setMode, setMotion } = useAppearance();
  const { pathname } = useLocation();
  const animations = useMotionEnabled();
  const [popover, setPopover] = useState<"theme" | "language" | null>(null);
  const [popoverBottom, setPopoverBottom] = useState(172);
  const [tourOpen, setTourOpen] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const footRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetchHealth()
      .then((health) => setVersion(health.version))
      .catch(() => {
        /* 版本号拿不到就不显示 */
      });
  }, []);

  useEffect(() => {
    const start = () => setTourOpen(true);
    window.addEventListener("memrelay:start-tour", start);
    return () => window.removeEventListener("memrelay:start-tour", start);
  }, []);

  useEffect(() => {
    setPopover(null);
  }, [pathname]);

  useEffect(() => {
    if (!popover) return;
    const onPointerDown = (event: MouseEvent) => {
      if (footRef.current && event.target instanceof Node && footRef.current.contains(event.target)) return;
      setPopover(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPopover(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [popover]);

  const mark = MARKS[style][theme];
  const popoverOrigin = LANGUAGES.find((item) => item.code === lang)?.dir === "rtl" ? "bottom right" : "bottom left";

  /** 弹层贴在被点的菜单项上方，而不是固定按“主题”那一行的位置。 */
  const togglePopover = (
    kind: "theme" | "language",
    event: ReactMouseEvent<HTMLButtonElement>,
  ): void => {
    const sidebar = event.currentTarget.closest(".sidebar");
    if (sidebar) {
      const sideRect = sidebar.getBoundingClientRect();
      const buttonRect = event.currentTarget.getBoundingClientRect();
      setPopoverBottom(Math.max(8, sideRect.bottom - buttonRect.top + 8));
    }
    setPopover((current) => (current === kind ? null : kind));
  };

  const switchStyle = (event: ReactMouseEvent<HTMLButtonElement>, next: StyleId): void => {
    if (next === style) return;
    if (!animations) {
      setStyle(next);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const started = startViewTransition(() => setStyle(next), {
      animation:
        next === "comic" ? "mr-vt-comic" : next === "pixel" ? "mr-vt-pixel" : "mr-vt-minimal",
      duration: next === "comic" ? "680ms" : next === "pixel" ? "560ms" : "440ms",
      ease:
        next === "pixel"
          ? "steps(12, end)"
          : next === "comic"
            ? "cubic-bezier(0.33, 0, 0.2, 1)"
            : "cubic-bezier(0.4, 0, 0.2, 1)",
      origin: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    });
    if (!started) setStyle(next);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src={mark} alt="" />
          <span className="brand-name">
            Mem<span className="relay">Relay</span>
          </span>
          {version && <span className="brand-version">v{version}</span>}
        </div>

        <nav className="nav nav-primary">
          {NAV_PRIMARY.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              data-tour-nav={item.to}
              className={({ isActive }) => cn("nav-item", isActive && "active")}
            >
              <Icon name={item.icon} />
              {t(item.key)}
            </NavLink>
          ))}
        </nav>
        <div className="nav-divider" />
        <nav className="nav">
          {NAV_SECONDARY.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              data-tour-nav={item.to}
              className={({ isActive }) => cn("nav-item", isActive && "active")}
            >
              <Icon name={item.icon} />
              {t(item.key)}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot" ref={footRef}>
          <div className="foot-divider" />
          <button
            type="button"
            className={cn("foot-item", popover === "theme" && "open")}
            aria-expanded={popover === "theme"}
            onClick={(event) => togglePopover("theme", event)}
          >
            <Icon name="palette" />
            {t("theme.title")}
          </button>
          <button
            type="button"
            className={cn("foot-item", popover === "language" && "open")}
            aria-expanded={popover === "language"}
            onClick={(event) => togglePopover("language", event)}
          >
            <Icon name="languages" />
            {t("lang.title")}
          </button>
          <button
            type="button"
            className="foot-item"
            aria-haspopup="dialog"
            onClick={() => {
              setPopover(null);
              setTourOpen(true);
            }}
          >
            <Icon name="compass" />
            {t("nav.tour")}
          </button>

          <AnimatePresence mode="wait">
            {popover === "theme" && (
              <motion.div
                key="theme"
                className="popover theme-popover"
                role="dialog"
                aria-label={t("theme.title")}
                initial={animations ? { opacity: 0, y: 6, scale: 0.98 } : false}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={animations ? { opacity: 0, y: 4, scale: 0.99 } : undefined}
                transition={{ duration: 0.16, ease: "easeOut" }}
                style={{ bottom: popoverBottom, transformOrigin: popoverOrigin }}
              >
                <div className="section-label">{t("theme.style")}</div>
                <div className="segmented">
                  {STYLES.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={cn("seg", style === item && "on")}
                      onClick={(event) => switchStyle(event, item)}
                    >
                      {t(STYLE_LABELS[item])}
                    </button>
                  ))}
                </div>
                <div className="section-label">{t("theme.mode")}</div>
                <div className="segmented">
                  {MODES.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={cn("seg", mode === item && "on")}
                      onClick={() => setMode(item)}
                    >
                      {t(MODE_LABELS[item])}
                    </button>
                  ))}
                </div>
                <div className="section-label">{t("theme.motion")}</div>
                <div className="segmented">
                  {MOTIONS.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={cn("seg", motionMode === item && "on")}
                      onClick={() => setMotion(item)}
                    >
                      {t(MOTION_LABELS[item])}
                    </button>
                  ))}
                </div>
              </motion.div>
            )}

            {popover === "language" && (
              <motion.div
                key="language"
                className="popover language-popover"
                role="dialog"
                aria-label={t("lang.title")}
                initial={animations ? { opacity: 0, y: 6, scale: 0.98 } : false}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={animations ? { opacity: 0, y: 4, scale: 0.99 } : undefined}
                transition={{ duration: 0.16, ease: "easeOut" }}
                style={{ bottom: popoverBottom, transformOrigin: popoverOrigin }}
              >
                <div className="language-list">
                  {LANGUAGES.map((item) => (
                    <button
                      key={item.code}
                      type="button"
                      className={cn("lang-row", lang === item.code && "on")}
                      lang={item.htmlLang}
                      onClick={() => setLang(item.code)}
                    >
                      <span>
                        <bdi dir={item.dir}>{item.native}</bdi>
                      </span>
                      <span>{t(item.nameKey)}</span>
                    </button>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </aside>

      <main className="main">
        <div key={pathname} className="page">
          <Outlet />
        </div>
      </main>

      <AnimatePresence>
        {tourOpen && <QuickTour key="quick-tour" onClose={() => setTourOpen(false)} />}
      </AnimatePresence>
    </div>
  );
}
