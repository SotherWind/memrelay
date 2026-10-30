import { flushSync } from "react-dom";

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> };
};

export type ViewTransitionAnimation = "mr-vt-minimal" | "mr-vt-comic" | "mr-vt-pixel";

interface ViewTransitionOptions {
  animation: ViewTransitionAnimation;
  duration?: string;
  ease?: string;
  origin?: { x: number; y: number };
}

/** View Transitions 不可用时返回 false，调用方按普通更新处理。 */
export function startViewTransition(update: () => void, opts: ViewTransitionOptions): boolean {
  const doc = document as ViewTransitionDocument;
  if (typeof doc.startViewTransition !== "function") return false;
  const root = document.documentElement;
  const cleanup = (): void => {
    for (const key of ["--vt-anim", "--vt-dur", "--vt-ease", "--vt-x", "--vt-y"]) {
      root.style.removeProperty(key);
    }
  };
  root.style.setProperty("--vt-anim", opts.animation);
  root.style.setProperty("--vt-dur", opts.duration ?? "520ms");
  root.style.setProperty("--vt-ease", opts.ease ?? "cubic-bezier(0.22, 1, 0.36, 1)");
  if (opts.origin) {
    root.style.setProperty("--vt-x", `${opts.origin.x}px`);
    root.style.setProperty("--vt-y", `${opts.origin.y}px`);
  }
  let transition: { finished: Promise<void> };
  try {
    transition = doc.startViewTransition(() => {
      flushSync(update);
    });
  } catch {
    cleanup();
    return false;
  }
  void transition.finished.finally(cleanup);
  return true;
}
