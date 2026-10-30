import type { ReactNode } from "react";
import { motion } from "motion/react";
import { toolLabel, type TaskLegDetail, type TaskStatus } from "../api/types";
import { Lamp } from "./Lamp";
import { useI18n } from "../lib/i18n";
import { formatRange } from "../lib/format";
import { cn } from "../lib/cn";
import { useMotionEnabled } from "../lib/theme";

function headTone(status: TaskStatus): "amber" | "green" | "blue" | "plain" {
  if (status === "interrupted") return "amber";
  if (status === "in_progress") return "green";
  if (status === "done") return "blue";
  return "plain";
}

/** 完整接力轨（任务详情用）：竖向排列，每棒带分段数据；中断时向"下一棒"延伸虚线。 */
export function RelayRail({
  legs,
  status,
  nextAction,
  onSplit,
  replayKey = 0,
}: {
  legs: TaskLegDetail[];
  status: TaskStatus;
  nextAction?: ReactNode;
  onSplit?: (sessionId: string) => void;
  replayKey?: number;
}) {
  const { t } = useI18n();
  const animations = useMotionEnabled();
  const head = legs.length - 1;

  return (
    <div>
      {legs.map((leg, index) => {
        const isHead = index === head;
        const hasNextLine = index < head || (isHead && status === "interrupted");
        return (
          <motion.div
            key={leg.sessionId}
            initial={animations ? { opacity: 0, y: 8 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: animations ? Math.min(index, 8) * 0.1 : 0, duration: 0.24, ease: "easeOut" }}
            className={cn("rail-leg", hasNextLine && "has-next")}
          >
            {isHead && animations && (
              <span
                key={`halo-${replayKey}`}
                className="rail-lamp-halo"
                style={{ animationDelay: "0.2s" }}
              />
            )}
            <div className="rail-lamp">
              {index < head && (
                <motion.span
                  key={`${leg.sessionId}-line-${replayKey}`}
                  className="rail-line"
                  initial={animations ? { scaleY: 0 } : false}
                  animate={{ scaleY: 1 }}
                  transition={{
                    duration: 0.36,
                    delay: animations ? Math.min(index, 8) * 0.1 + 0.05 : 0,
                    ease: "easeOut",
                  }}
                  style={{ transformOrigin: "top" }}
                >
                  {animations && (
                    <span
                      key={`${leg.sessionId}-spark-${replayKey}`}
                      className="rail-spark"
                      style={{ animationDelay: `${Math.min(index, 8) * 0.1 + 0.25}s` }}
                    />
                  )}
                </motion.span>
              )}
              {isHead && status === "interrupted" && (
                <motion.span
                  key={`${leg.sessionId}-dash-${replayKey}`}
                  className="rail-line dashed"
                  initial={animations ? { scaleY: 0 } : false}
                  animate={{ scaleY: 1 }}
                  transition={{
                    duration: 0.36,
                    delay: animations ? Math.min(index, 8) * 0.1 + 0.05 : 0,
                    ease: "easeOut",
                  }}
                  style={{ transformOrigin: "top" }}
                >
                  {animations && (
                    <span
                      key={`${leg.sessionId}-spark-${replayKey}`}
                      className="rail-spark amber"
                      style={{ animationDelay: `${Math.min(index, 8) * 0.1 + 0.25}s` }}
                    />
                  )}
                </motion.span>
              )}
              <Lamp
                tone={isHead ? headTone(status) : "plain"}
                size={9}
                breathe={isHead && status === "interrupted"}
                className="relative mt-1"
              />
            </div>
            <div className="rail-leg-body">
              <div className="rail-leg-head">
                <span className="rail-tool">{toolLabel(leg.tool)}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {onSplit && index > 0 && (
                    <button
                      type="button"
                      title={t("manual.splitHint")}
                      onClick={() => onSplit(leg.sessionId)}
                      className="action-link"
                    >
                      {t("manual.split")}
                    </button>
                  )}
                  <span className="rail-meta">{formatRange(leg.startedAt, leg.endedAt)}</span>
                </span>
              </div>
              <div className="rail-sub">
                <span className="rail-subtitle">{leg.title ?? leg.sessionId}</span>
                <span className="rail-meta">
                  {t("tasks.messages", { n: leg.messageCount })} · {t("tasks.files", { n: leg.fileCount })}
                </span>
              </div>
            </div>
          </motion.div>
        );
      })}
      {status === "interrupted" && (
        <motion.div
          className="rail-next items-center"
          initial={animations ? { opacity: 0, y: 4 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, delay: animations ? 0.12 : 0, ease: "easeOut" }}
        >
          <div className="flex w-3 shrink-0 justify-center">
            <span className="rail-next-dot" />
          </div>
          <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
            <span className="rail-next-label">{t("detail.nextLeg")}</span>
            {nextAction}
          </div>
        </motion.div>
      )}
    </div>
  );
}
