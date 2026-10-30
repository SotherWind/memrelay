import { cn } from "../lib/cn";

export type LampTone = "amber" | "green" | "blue" | "plain";

export function Lamp({
  tone,
  size = 8,
  breathe = false,
  className,
}: {
  tone: LampTone;
  size?: number;
  breathe?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("lamp", tone, breathe && "breathe", className)}
      style={{ width: size, height: size }}
    />
  );
}
