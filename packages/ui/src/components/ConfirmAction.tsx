import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../lib/i18n";
import { cn } from "../lib/cn";

/** 两步确认的危险动作按钮：第一次点击进入确认态，5 秒未操作自动收回。 */
export function ConfirmAction({
  children,
  onConfirm,
  onError,
  idleClassName,
  className,
  confirmText,
  yesText,
  idleTitle,
}: {
  children: ReactNode;
  onConfirm: () => void | Promise<void>;
  onError?: (err: unknown) => void;
  idleClassName?: string;
  className?: string;
  confirmText?: string;
  yesText?: string;
  idleTitle?: string;
}) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    },
    [],
  );

  if (!armed) {
    return (
      <button
        type="button"
        title={idleTitle ?? t("del.hint")}
        onClick={() => {
          setArmed(true);
          timer.current = window.setTimeout(() => setArmed(false), 5000);
        }}
        className={idleClassName ?? "action-link"}
      >
        {children}
      </button>
    );
  }

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className="text-[11px] text-[var(--text-3)]">{confirmText ?? t("del.confirm")}</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void Promise.resolve(onConfirm())
            .catch((err: unknown) => {
              onError?.(err);
            })
            .finally(() => {
              setBusy(false);
              setArmed(false);
            });
        }}
        className="confirm-yes"
      >
        {yesText ?? t("del.yes")}
      </button>
      <button type="button" onClick={() => setArmed(false)} className="action-link">
        {t("del.cancel")}
      </button>
    </span>
  );
}
