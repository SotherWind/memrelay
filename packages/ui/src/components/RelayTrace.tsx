import { toolLabel, type TaskStatus, type ToolLeg } from "../api/types";
import { Lamp, type LampTone } from "./Lamp";
import { cn } from "../lib/cn";

function headTone(status: TaskStatus): LampTone {
  if (status === "interrupted") return "amber";
  if (status === "in_progress") return "green";
  if (status === "done") return "blue";
  return "plain";
}

export function RelayTrace({
  legs,
  status,
  size = "sm",
  className,
}: {
  legs: ToolLeg[];
  status: TaskStatus;
  size?: "sm" | "md";
  className?: string;
}) {
  const head = legs.length - 1;
  return (
    <div className={cn("rail-trace", className)}>
      {legs.map((leg, index) => {
        const isHead = index === head;
        return (
          <span key={`${leg.tool}-${leg.startedAt}`} className="inline-flex items-center">
            {index > 0 && <span className="rail-trace-link" />}
            <span className={cn("rail-trace-tool", isHead && "head")}>
              <Lamp
                tone={isHead ? headTone(status) : "plain"}
                size={size === "sm" ? 7 : 8}
                breathe={isHead && status === "interrupted"}
              />
              {toolLabel(leg.tool)}
            </span>
          </span>
        );
      })}
    </div>
  );
}
