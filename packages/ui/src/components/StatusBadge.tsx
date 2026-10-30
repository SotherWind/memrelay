import { useEffect, useRef, useState } from "react";
import type { TaskStatus } from "../api/types";
import { useI18n } from "../lib/i18n";
import { cn } from "../lib/cn";

const TONE: Record<TaskStatus, string> = {
  in_progress: "st-green",
  interrupted: "st-amber",
  done: "st-blue",
  abandoned: "st-gray",
  unknown: "st-gray",
};

export function StatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  const { t } = useI18n();
  const [flash, setFlash] = useState(false);
  const previous = useRef(status);

  useEffect(() => {
    if (previous.current === status) return;
    previous.current = status;
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), 780);
    return () => window.clearTimeout(timer);
  }, [status]);

  return (
    <span className={cn("status", TONE[status], flash && "status-flash", className)}>
      <i />
      {t(`status.${status}`)}
    </span>
  );
}
