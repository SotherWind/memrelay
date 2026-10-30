import { parseArgs } from "node:util";

import type { LocalMessage } from "../../adapters/jsonl-family/records.js";
import { redactSecrets } from "../../core/secrets.js";
import { resolveContext, resolveSessionRef } from "../../resume/context.js";
import { lastAssistantText } from "../../resume/extract.js";
import { findChainMarker, formatLocalTime, readSessionDetail } from "../../resume/session-reader.js";
import { helpText } from "../help.js";
import { writeOut } from "../output.js";

const PAGE_SIZE = 60;

export async function runShow(rest: string[], stdout: (text: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      from: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    stdout(helpText());
    return 0;
  }
  const id = positionals[0];
  if (!id) {
    stdout('用法：memrelay show <会话 id> [--from N]\n先运行 memrelay resume 获取会话 id。');
    return 1;
  }
  const fromRaw = values.from;
  const from = fromRaw === undefined ? 0 : Number(fromRaw);
  if (!Number.isInteger(from) || from < 0) {
    stdout("--from 需要一个非负整数。");
    return 1;
  }

  const ctx = resolveContext();
  const resolved = await resolveSessionRef(ctx, id);
  if (!resolved) {
    stdout(
      `没有找到会话 ${id}。会话语 id 形如 qoder:<id> 或 claude-code:<id>，可以用 memrelay resume 查看候选。`,
    );
    return 1;
  }
  const { adapter, ref } = resolved;
  const detail = await readSessionDetail(adapter, ref);
  const messages = detail.branchMessages;
  const page = messages.slice(from, from + PAGE_SIZE);

  const lines: string[] = [];
  lines.push(`会话 ${ref.id} · ${formatLocalTime(ref.startedAt)} · 目录 ${detail.ref.cwd ?? ref.cwd ?? ""}`);
  lines.push(`文件 ${ref.sourcePath}`);
  lines.push(`消息 ${messages.length} 条（当前分支）；本页从第 ${from} 条起，共 ${page.length} 条`);
  const latest = lastAssistantText(messages, 300)?.replace(/\s+/g, " ").trim();
  if (latest) lines.push(`最后进展：${latest.length > 200 ? `${latest.slice(0, 200)}…` : latest}`);
  const marker = findChainMarker(messages);
  if (marker) {
    lines.push(`接力来源：${marker.agent}:${marker.nativeId}（只是背景；当前任务以本会话最后进展为准）`);
  }
  lines.push("");

  for (let i = 0; i < page.length; i++) {
    const m = page[i]!;
    const ordinal = from + i;
    lines.push(`── [${ordinal}] ${m.role} · ${formatLocalTime(m.timestamp)} ──`);
    for (let j = 0; j < m.parts.length; j++) {
      const text = formatPart(m, j).trim();
      if (text) lines.push(text);
    }
    lines.push("");
  }

  const end = from + page.length;
  if (end < messages.length) {
    lines.push(`—— 还有 ${messages.length - end} 条，用 memrelay show ${ref.id} --from ${end} 继续 ——`);
  }

  const { text } = redactSecrets(lines.join("\n"));
  writeOut(text, values.out);
  return 0;
}

function formatPart(message: LocalMessage, partIndex: number): string {
  const p = message.parts[partIndex]!;
  switch (p.kind) {
    case "text":
      return p.text ?? "";
    case "reasoning": {
      const text = p.text ?? "";
      return text === "[redacted reasoning]"
        ? "[思考] （内容已加密，不可读）"
        : `[思考] ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`;
    }
    case "tool_call":
    case "plan": {
      const name = p.toolName ?? "unknown";
      const input = typeof p.json === "string" ? p.json : JSON.stringify(p.json ?? {}, null, 0);
      const brief = input && input.length > 220 ? `${input.slice(0, 220)}…` : input;
      return `[工具调用] ${name} ${brief}`;
    }
    case "tool_result": {
      const status = p.status === "error" ? "错误" : "完成";
      const text = (p.text ?? "").replace(/\s+/g, " ").trim();
      const brief = text.length > 300 ? `${text.slice(0, 300)}…` : text;
      return `[工具结果·${status}] ${brief}`;
    }
    case "file_edit": {
      const text = (p.text ?? "").replace(/\n/g, ", ");
      return `[文件改动] ${p.toolName ?? ""} ${text.slice(0, 240)}`;
    }
    case "image":
      return "[图片]";
    case "compaction_summary":
      return `[上下文压缩] ${(p.text ?? "").slice(0, 200)}`;
    default:
      return `[${p.kind}] ${(p.text ?? "").slice(0, 200)}`;
  }
}
