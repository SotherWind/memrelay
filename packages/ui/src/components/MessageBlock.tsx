import type { MessageDto, MessagePart } from "../api/types";
import { Collapsible, MonoBlock } from "./Collapsible";
import { useI18n } from "../lib/i18n";
import { formatStamp } from "../lib/format";
import { cn } from "../lib/cn";

function stampOf(iso: string | null, lang: ReturnType<typeof useI18n>["lang"]): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : formatStamp(ms, lang);
}

function JsonBlock({ json, fallback }: { json: string | null; fallback?: string | null }) {
  let text = fallback ?? "";
  if (json) {
    try {
      text = JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      text = json;
    }
  }
  if (!text) return null;
  return <MonoBlock maxHeight="320px">{text}</MonoBlock>;
}

function PartView({ part }: { part: MessagePart }) {
  const { t } = useI18n();
  switch (part.kind) {
    case "text":
      return (
        <p className="message-text" dir="auto">
          {part.text}
        </p>
      );
    case "reasoning":
      return (
        <Collapsible label={t("conv.part.reasoning")}>
          <MonoBlock maxHeight="240px">{part.text ?? ""}</MonoBlock>
        </Collapsible>
      );
    case "tool_call":
      return (
        <Collapsible label={`${t("conv.part.toolCall")} · ${part.toolName ?? "?"}`}>
          <JsonBlock json={part.json} fallback={part.text} />
        </Collapsible>
      );
    case "plan":
      return (
        <Collapsible label={t("conv.part.plan")}>
          <JsonBlock json={part.json} fallback={part.text} />
        </Collapsible>
      );
    case "tool_result": {
      const error = part.status === "error";
      return (
        <Collapsible
          tone={error ? "error" : undefined}
          label={`${error ? t("conv.part.toolResultError") : t("conv.part.toolResult")} · ${t("conv.part.chars", { n: (part.text ?? "").length })}`}
        >
          <MonoBlock maxHeight="360px">{part.text ?? ""}</MonoBlock>
        </Collapsible>
      );
    }
    case "file_edit": {
      const files = (part.text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
      return (
        <Collapsible label={`${t("conv.part.fileEdit")} · ${files.length}`}>
          <ul className="flex flex-col gap-0.5">
            {files.map((file) => (
              <li key={file} dir="ltr" className="truncate font-mono text-[11px] text-[var(--text-2)]">
                {file}
              </li>
            ))}
          </ul>
        </Collapsible>
      );
    }
    case "compaction_summary":
      return (
        <div className="compaction">
          <span className="compaction-chip">{t("conv.part.compaction")}</span>
          {part.text && <p className="text-xs leading-relaxed text-[var(--text-3)]">{part.text}</p>}
        </div>
      );
    case "image":
      return <span className="compaction-chip">{t("conv.part.image")}</span>;
    default:
      return part.text ? (
        <Collapsible label={part.kind}>
          <MonoBlock maxHeight="240px">{part.text}</MonoBlock>
        </Collapsible>
      ) : null;
  }
}

const ROLE_KEYS: Record<MessageDto["role"], "conv.role.user" | "conv.role.assistant" | "conv.role.tool" | "conv.role.system"> = {
  user: "conv.role.user",
  assistant: "conv.role.assistant",
  tool: "conv.role.tool",
  system: "conv.role.system",
};

export function MessageBlock({ message, isTarget }: { message: MessageDto; isTarget: boolean }) {
  const { t, lang } = useI18n();
  const visibleParts = message.parts.filter(
    (part) => part.text !== null || part.json !== null || part.kind === "image",
  );
  if (visibleParts.length === 0) return null;
  return (
    <article id={`msg-${message.ordinal}`} className={cn("message", isTarget && "target")}>
      <div className="message-head">
        <span className="role-chip">{t(ROLE_KEYS[message.role])}</span>
        <span className="message-index">#{message.ordinal}</span>
        <span className="message-index">{stampOf(message.createdAt, lang)}</span>
      </div>
      <div className="message-body">
        {visibleParts.map((part, index) => (
          <PartView key={index} part={part} />
        ))}
      </div>
    </article>
  );
}
