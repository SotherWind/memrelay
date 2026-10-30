import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { Icon } from "./icons";
import { useI18n, type MsgKey } from "../lib/i18n";
import { useMotionEnabled } from "../lib/theme";
import { cn } from "../lib/cn";

interface TourStep {
  to: string;
  title: MsgKey;
  body: MsgKey;
  hint?: MsgKey;
}

const STEPS: TourStep[] = [
  {
    to: "/integrations",
    title: "tour.step.integrations.title",
    body: "tour.step.integrations.body",
  },
  {
    to: "/dashboard",
    title: "tour.step.dashboard.title",
    body: "tour.step.dashboard.body",
  },
  {
    to: "/tasks",
    title: "tour.step.tasks.title",
    body: "tour.step.tasks.body",
  },
  {
    to: "/conversations",
    title: "tour.step.conversations.title",
    body: "tour.step.conversations.body",
  },
  {
    to: "/tidy",
    title: "tour.step.tidy.title",
    body: "tour.step.tidy.body",
    hint: "tour.step.tidy.hint",
  },
];

const CARD_W = 396;
const CARD_GAP = 64;
const SPOT_PAD = 6;
const EDGE = 24;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Viewport {
  w: number;
  h: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));

export function QuickTour({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const animations = useMotionEnabled();
  const navigate = useNavigate();
  const location = useLocation();
  const [index, setIndex] = useState(0);
  const [target, setTarget] = useState<Box | null>(null);
  const [cardHeight, setCardHeight] = useState(300);
  const [viewport, setViewport] = useState<Viewport>(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  const cardRef = useRef<HTMLDivElement | null>(null);
  const entry = useRef(location.pathname + location.search + location.hash);
  const entryScroll = useRef(document.querySelector<HTMLElement>(".main")?.scrollTop ?? 0);
  const navigatedFor = useRef<number | null>(null);
  const step = STEPS[index]!;
  const last = index === STEPS.length - 1;

  useEffect(() => {
    if (navigatedFor.current === index) return;
    navigatedFor.current = index;
    navigate(step.to, { replace: true });
    document.querySelector<HTMLElement>(".main")?.scrollTo({ top: 0 });
  }, [index, navigate, step.to]);

  const measure = useCallback(() => {
    const el = document.querySelector<HTMLElement>(`[data-tour-nav="${step.to}"]`);
    if (!el) {
      setTarget(null);
      return;
    }
    if (window.innerWidth <= 820) {
      el.scrollIntoView({ block: "nearest", inline: "center" });
    }
    const rect = el.getBoundingClientRect();
    setTarget({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  }, [step.to]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const onResize = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
      measure();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure]);

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const sync = () => setCardHeight(el.offsetHeight);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cardRef.current?.focus();
    return () => previous?.focus();
  }, []);

  const close = useCallback(() => {
    navigate(entry.current, { replace: true });
    requestAnimationFrame(() => {
      const main = document.querySelector<HTMLElement>(".main");
      if (main) main.scrollTop = entryScroll.current;
    });
    onClose();
  }, [navigate, onClose]);

  const next = useCallback(() => {
    if (index < STEPS.length - 1) setIndex(index + 1);
    else close();
  }, [close, index]);

  const prev = useCallback(() => {
    if (index > 0) setIndex(index - 1);
  }, [index]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      next();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      prev();
      return;
    }
    if (event.key !== "Tab") return;
    const nodes = cardRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!nodes || nodes.length === 0) return;
    const list = Array.from(nodes);
    const first = list[0]!;
    const final = list[list.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === cardRef.current)) {
      event.preventDefault();
      final.focus();
    } else if (!event.shiftKey && document.activeElement === final) {
      event.preventDefault();
      first.focus();
    }
  };

  const spot = target
    ? {
        left: target.left - SPOT_PAD,
        top: target.top - SPOT_PAD,
        width: target.width + SPOT_PAD * 2,
        height: target.height + SPOT_PAD * 2,
      }
    : null;
  const cardW = Math.min(CARD_W, Math.max(240, viewport.w - 32));
  const docked = viewport.w <= 820 || !spot;
  const isRtl = document.documentElement.dir === "rtl";
  const left = docked
    ? clamp(
        (viewport.w - cardW) / 2,
        Math.min(EDGE, viewport.w - cardW - EDGE),
        viewport.w - cardW - EDGE,
      )
    : isRtl
      ? clamp(spot.left - cardW - CARD_GAP, EDGE, viewport.w - cardW - EDGE)
      : Math.min(spot.left + spot.width + CARD_GAP, viewport.w - cardW - EDGE);
  const top = docked
    ? clamp(viewport.h - cardHeight - EDGE, EDGE, viewport.h - cardHeight - EDGE)
    : clamp(
        spot.top + spot.height / 2 - cardHeight / 2,
        EDGE,
        viewport.h - cardHeight - EDGE,
      );
  const linkLeft = spot ? (isRtl ? left + cardW + 10 : spot.left + spot.width + 6) : 0;
  const linkWidth = spot ? (isRtl ? spot.left - linkLeft - 6 : left - linkLeft - 10) : 0;
  const showLink = !docked && linkWidth > 18;
  const liveText = `${t("tour.count", { n: index + 1, total: STEPS.length })} · ${t(step.title)}`;

  return (
    <motion.div
      className="tour-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-title"
      aria-describedby="tour-body"
      initial={animations ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      exit={animations ? { opacity: 0 } : undefined}
      transition={{ duration: 0.18, ease: "easeOut" }}
      onKeyDown={onKeyDown}
    >
      {spot ? (
        <>
          <div className="tour-dim" style={{ left: 0, top: 0, right: 0, height: spot.top }} />
          <div
            className="tour-dim"
            style={{ left: 0, right: 0, top: spot.top + spot.height, bottom: 0 }}
          />
          <div
            className="tour-dim"
            style={{ left: 0, top: spot.top, width: spot.left, height: spot.height }}
          />
          <div
            className="tour-dim"
            style={{
              left: spot.left + spot.width,
              right: 0,
              top: spot.top,
              height: spot.height,
            }}
          />
          <div
            className="tour-spot"
            style={{ left: spot.left, top: spot.top, width: spot.width, height: spot.height }}
          />
          {showLink && (
            <div
              className="tour-link"
              style={{ left: linkLeft, width: linkWidth, top: spot.top + spot.height / 2 }}
              aria-hidden="true"
            >
              <i key={index} />
            </div>
          )}
        </>
      ) : (
        <div className="tour-dim" style={{ inset: 0 }} />
      )}

      <motion.div
        ref={cardRef}
        className="tour-card"
        style={{ left, top, width: cardW }}
        tabIndex={-1}
        initial={animations ? { opacity: 0, y: 8 } : false}
        animate={{ opacity: 1, y: 0 }}
        exit={animations ? { opacity: 0, y: 6 } : undefined}
        transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
      >
        <p className="tour-live" aria-live="polite">
          {liveText}
        </p>
        <div className="tour-top">
          <span className="tour-kicker">
            <Icon name="compass" />
            {t("nav.tour")}
          </span>
          <span className="tour-count">{t("tour.count", { n: index + 1, total: STEPS.length })}</span>
        </div>
        <div className="tour-progress" aria-hidden="true">
          {STEPS.map((item, stepIndex) => (
            <span
              key={item.to}
              className={cn("tour-tick", stepIndex < index && "done", stepIndex === index && "on")}
            />
          ))}
        </div>
        <h2 id="tour-title" className="tour-title">
          {t(step.title)}
        </h2>
        <p id="tour-body" className="tour-body">
          {t(step.body)}
        </p>
        {step.hint && <p className="tour-hint">{t(step.hint)}</p>}
        <div className="tour-actions">
          <button type="button" className="tour-skip" onClick={close}>
            {t("tour.skip")}
          </button>
          <div className="tour-buttons">
            {index > 0 && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={prev}>
                {t("tour.prev")}
              </button>
            )}
            <button type="button" className="btn btn-primary btn-sm" onClick={next}>
              {last ? t("tour.done") : t("tour.next")}
              <Icon name="chevron-right" />
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
