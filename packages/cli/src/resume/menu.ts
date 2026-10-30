import { flattenText } from "../adapters/jsonl-family/records.js";
import { formatLocalTime, statusLabel } from "./session-reader.js";
import { agentName } from "./render.js";
import type { RankedSession } from "./select.js";

export function renderMenu(
  ranked: RankedSession[],
  opts: {
    keyword?: string;
    reason?: "ambiguous-keyword" | "multi-recent";
    note?: string;
    currentCwd?: string;
    /** 当前目录没有会话，候选来自其它项目（全局兜底） */
    crossProject?: boolean;
    limit?: number;
    /** 会话摘要（AI，可选增强）：有现成的就附一行；缺省 = 不显示 */
    summaries?: Map<string, string>;
  },
): string {
  const limit = opts.limit ?? 15;
  const head: string[] = [];
  const reason = opts.reason ?? (opts.keyword ? "ambiguous-keyword" : "multi-recent");
  if (opts.crossProject && opts.keyword) {
    head.push(
      `当前目录没有可续接的会话。以下是其他项目里与「${opts.keyword}」相关的会话（按匹配度排序），供 agent 判断；能确定就直接接，拿不准再问用户，继续之前先 cd 到对应目录。`,
    );
  } else if (reason === "multi-recent") {
    head.push(
      "用户只说「继续 / 接着做」，但项目里有多个都在最近中断的任务，分不出主次。先把下面几个列给用户，让他挑一个再继续；如果用户说「就最近那个」，接最上面的。",
    );
  } else if (opts.keyword) {
    head.push(
      `没有唯一命中「${opts.keyword}」的任务。以下是本项目最近的会话（按匹配度排序），供 agent 判断；能确定就直接接，拿不准再问用户。`,
    );
  } else {
    head.push("当前项目没有找到中断的任务。以下是最近的会话，供 agent 判断。");
  }
  if (opts.note) head.push(opts.note);
  head.push("");
  head.push(`候选会话（共 ${ranked.length} 个，列出前 ${Math.min(limit, ranked.length)} 个）：`);

  const lines = ranked.slice(0, limit).map((r, i) => {
    const scan = r.scan;
    const parts: string[] = [];
    parts.push(`${i + 1}. ${scan.id}`);
    parts.push(`   ${agentName(scan.agent)} · ${statusLabel(r.status)} · ${formatLocalTime(scan.startedAt ?? scan.tail.lastTimestamp)}`);
    const title = scan.tail.lastTitle ?? scan.tail.statusInfo.lastAssistantText;
    if (title) parts.push(`   ${flattenText(title, 80)}`);
    const summary = opts.summaries?.get(scan.id);
    if (summary) parts.push(`   摘要：${flattenText(summary, 100)}`);
    if (scan.cwd) {
      const sameDir = opts.currentCwd && normalize(scan.cwd) === normalize(opts.currentCwd);
      if (!sameDir) parts.push(`   目录：${scan.cwd}`);
    }
    if (r.chainFrom) {
      parts.push(`   接力自 ${agentName(r.chainFrom.agent)}:${r.chainFrom.nativeId.slice(0, 8)}…`);
    }
    return parts.join("\n");
  });

  const tail = [
    "",
    opts.crossProject
      ? "用法：memrelay show <会话 id> 查看细节；选定后运行 memrelay resume <会话 id> 正式续接（会落链），先 cd 到对应目录再开工；拿不准就先问用户。"
      : "用法：memrelay show <会话 id> 查看细节；选定后运行 memrelay resume <会话 id> 正式续接（会落链）；都不像时换关键词 memrelay search <关键词> 再搜一轮；拿不准就先问用户。",
  ];
  return `${head.join("\n")}\n${lines.join("\n")}\n${tail.join("\n")}\n`;
}

function normalize(p: string): string {
  return p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}
