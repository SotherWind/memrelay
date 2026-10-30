import { useState, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { Icon } from "./icons";

export function Collapsible({
  label,
  defaultOpen = false,
  tone,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  tone?: "error";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="collapsible">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn("collapsible-head", tone === "error" && "error")}
      >
        <span className="truncate">{label}</span>
        <Icon name={open ? "chevron-down" : "chevron-right"} className="ico-sm" />
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}

export function MonoBlock({ children, maxHeight }: { children: string; maxHeight?: string }) {
  return (
    <pre className="mono-block" dir="ltr" style={maxHeight ? { maxHeight } : undefined}>
      {children}
    </pre>
  );
}
