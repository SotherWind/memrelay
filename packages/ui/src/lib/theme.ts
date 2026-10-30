import { useSyncExternalStore } from "react";

export type StyleId = "minimal" | "comic" | "pixel";
export type ThemeMode = "light" | "dark" | "system";
export type Theme = "light" | "dark";
export type MotionMode = "system" | "on" | "off";

const STYLE_KEY = "memrelay-style";
const MODE_KEY = "memrelay-mode";
const MOTION_KEY = "memrelay-motion";
/** 旧版本只存了 light/dark，升级后第一次读到时迁移成固定模式。 */
const LEGACY_KEY = "memrelay-theme";

export const STYLES: StyleId[] = ["minimal", "comic", "pixel"];
export const MOTIONS: MotionMode[] = ["on", "off", "system"];

function isStyle(value: string | null): value is StyleId {
  return value === "minimal" || value === "comic" || value === "pixel";
}

function isMode(value: string | null): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

function isMotion(value: string | null): value is MotionMode {
  return value === "system" || value === "on" || value === "off";
}

function readStyle(): StyleId {
  const saved = localStorage.getItem(STYLE_KEY);
  return isStyle(saved) ? saved : "minimal";
}

function readMode(): ThemeMode {
  const saved = localStorage.getItem(MODE_KEY);
  if (isMode(saved)) return saved;
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy === "light" || legacy === "dark") return legacy;
  return "light";
}

function readMotion(): MotionMode {
  const saved = localStorage.getItem(MOTION_KEY);
  return isMotion(saved) ? saved : "on";
}

const media = typeof window === "undefined" ? null : window.matchMedia("(prefers-color-scheme: dark)");
const reduceMedia =
  typeof window === "undefined" ? null : window.matchMedia("(prefers-reduced-motion: reduce)");

function resolveTheme(mode: ThemeMode): Theme {
  if (mode === "system") return media?.matches ? "dark" : "light";
  return mode;
}

function resolveAnimations(mode: MotionMode): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return !(reduceMedia?.matches ?? false);
}

interface Appearance {
  style: StyleId;
  mode: ThemeMode;
  theme: Theme;
  motion: MotionMode;
  animations: boolean;
}

let current: Appearance = {
  style: readStyle(),
  mode: readMode(),
  theme: "light",
  motion: readMotion(),
  animations: true,
};
current.theme = resolveTheme(current.mode);
current.animations = resolveAnimations(current.motion);

const listeners = new Set<() => void>();

function apply(): void {
  document.documentElement.dataset.style = current.style;
  document.documentElement.dataset.theme = current.theme;
  document.documentElement.dataset.motion = current.motion;
  document.documentElement.style.colorScheme = current.theme;
}

function emit(): void {
  current = {
    ...current,
    theme: resolveTheme(current.mode),
    animations: resolveAnimations(current.motion),
  };
  apply();
  for (const listener of listeners) listener();
}

let initialized = false;

/** 首帧后同步一次，并挂上系统深浅色 / 动效偏好监听（仅对应 mode=system 时生效）。 */
export function initAppearance(): void {
  if (initialized) return;
  initialized = true;
  apply();
  media?.addEventListener("change", () => {
    if (current.mode === "system") emit();
  });
  reduceMedia?.addEventListener("change", () => {
    if (current.motion === "system") emit();
  });
}

export function setStyle(style: StyleId): void {
  current = { ...current, style };
  localStorage.setItem(STYLE_KEY, style);
  emit();
}

export function setMode(mode: ThemeMode): void {
  current = { ...current, mode };
  localStorage.setItem(MODE_KEY, mode);
  emit();
}

export function setMotion(mode: MotionMode): void {
  current = { ...current, motion: mode };
  localStorage.setItem(MOTION_KEY, mode);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): Appearance {
  return current;
}

export function useAppearance(): Appearance & {
  setStyle: (style: StyleId) => void;
  setMode: (mode: ThemeMode) => void;
  setMotion: (mode: MotionMode) => void;
} {
  const appearance = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { ...appearance, setStyle, setMode, setMotion };
}

/** 页面内动效是否启用：跟随系统，或用户在主题弹层里显式开启/关闭。 */
export function useMotionEnabled(): boolean {
  const appearance = useSyncExternalStore(subscribe, snapshot, snapshot);
  return appearance.animations;
}
