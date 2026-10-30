import type { ToolDefinition } from "../core/tool-registry.js";
import { TOOL_REGISTRY } from "../core/tool-registry.js";
import { estimateTokens, truncateByTokens } from "../core/tokens.js";
import { redactSecrets } from "../core/secrets.js";
import type { AgentId } from "../core/types.js";
import type { GitWorkingState } from "../core/project.js";
import {
  extractTodos,
  filesRead,
  filesTouched,
  lastAssistantText,
  lastErrorText,
  userInstructions,
  type TodoItem,
} from "./extract.js";
import {
  formatLocalTime,
  minutesSince,
  statusLabel,
  type SessionDetail,
} from "./session-reader.js";
import { flattenText } from "../adapters/jsonl-family/records.js";
import type { RankedSession } from "./select.js";

export const TOKEN_BUDGET = 8000;

export function agentName(id: AgentId | string): string {
  return TOOL_REGISTRY.find((t) => t.id === id)?.name ?? id;
}

export interface ChainEntry {
  agent: string;
  id: string;
  startedAt: string;
  instructions: string[];
  lastText?: string;
}

export interface ChainInfo {
  /** 从最早到最新排列的前几段会话（不含当前接的这段） */
  entries: ChainEntry[];
  /** 链根（最深的那一段），用于第二行的机器可读标记 */
  root: { agent: string; nativeId: string; sessionCount: number; startedAt: string };
}

export interface RenderInput {
  detail: SessionDetail;
  ranked: RankedSession;
  git: GitWorkingState;
  callerTool?: ToolDefinition;
  chain?: ChainInfo;
  /** AI 摘要（可选增强；缺省 = 未开启/未生成，输出与现状逐字一致） */
  summary?: string;
  now?: number;
}

const STATUS_ICON: Record<string, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  done: "[x]",
  unknown: "[?]",
};

function section(title: string, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return `## ${title}\n（无）\n`;
  return `## ${title}\n${trimmed}\n`;
}

function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return "（旧会话没有留下待办清单）";
  const lines = todos.map((t) => `- ${STATUS_ICON[t.status] ?? "[?]"} ${t.content}`);
  const done = todos.filter((t) => t.status === "done").length;
  lines.push("");
  lines.push(`（${done}/${todos.length} 已完成）`);
  return lines.join("\n");
}

function renderUserInstructions(instructions: string[]): string {
  if (instructions.length === 0) return "（没有记录到用户指令）";
  return instructions.map((text, i) => `${i + 1}. ${text}`).join("\n\n");
}

function renderFiles(files: string[], readFiles: string[], git: GitWorkingState): string {
  const lines: string[] = [];
  const gitFiles = [...git.changedFiles, ...git.untrackedFiles.map((f) => `${f}（新文件）`)];
  if (gitFiles.length > 0) {
    lines.push("当前 git 工作区：");
    for (const f of gitFiles) lines.push(`- ${f}`);
    if (git.diffStat) {
      const stat = git.diffStat.split(/\r?\n/).filter((l) => l.trim()).slice(-1)[0];
      if (stat) lines.push(`- 变更规模：${stat}`);
    }
  } else {
    lines.push("当前 git 工作区：干净（会话里改过的文件可能已被提交或丢弃）");
  }
  if (files.length > 0) {
    lines.push("");
    lines.push("旧会话里动过的文件：");
    for (const f of files.slice(0, 40)) lines.push(`- ${f}`);
    if (files.length > 40) lines.push(`- …另有 ${files.length - 40} 个文件`);
  }
  if (readFiles.length > 0) {
    lines.push("");
    lines.push("旧会话读过、可以顺带了解的文件：");
    for (const f of readFiles.slice(0, 15)) lines.push(`- ${f}`);
    if (readFiles.length > 15) lines.push(`- …另有 ${readFiles.length - 15} 个文件`);
  }
  return lines.join("\n");
}

function renderProgress(detail: SessionDetail): string {
  const parts: string[] = [];
  const text = lastAssistantText(detail.branchMessages);
  if (text) parts.push(text);
  const error = lastErrorText(detail.branchMessages);
  if (error) {
    parts.push("");
    parts.push(`最后一次报错：${error.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  if (parts.length === 0) return "（没有记录到最后进展）";
  return parts.join("\n");
}

function renderChainHistory(chain: ChainInfo): string {
  if (chain.entries.length === 0) return "";
  const lines: string[] = [];
  for (const e of chain.entries) {
    const who = `${agentName(e.agent)}（${formatLocalTime(e.startedAt)} · ${e.id}）`;
    const asks = e.instructions
      .slice(0, 2)
      .map((t) => flattenText(t, 90))
      .join("；");
    const did = e.lastText ? flattenText(e.lastText, 160) : "";
    lines.push(`- ${who}：用户说「${asks || "（无记录）"}」${did ? `；做到：${did}` : ""}`);
  }
  return lines.join("\n");
}

export function renderResume(input: RenderInput): string {
  const { detail, ranked, git } = input;
  const now = input.now ?? Date.now();
  const scan = ranked.scan;
  const agent = agentName(scan.agent);
  const minutes = minutesSince(scan.mtimeMs, now);

  const chain = input.chain;
  const chainNames = chain && chain.entries.length > 0
    ? [...chain.entries.map((e) => agentName(e.agent)), agent]
    : [];

  const headerLines = [
    "【MemRelay 续接】",
  ];
  if (chain) {
    headerLines.push(
      `续接自 ${agentName(chain.root.agent)}:${chain.root.nativeId} · 会话数 ${chain.root.sessionCount} · ${formatLocalTime(chain.root.startedAt)} · ${scan.cwd ?? ""} · 会话 ${scan.id}`,
    );
  } else {
    const nativeId = scan.id.slice(scan.id.indexOf(":") + 1);
    headerLines.push(
      `续接自 ${agent}:${nativeId} · 会话数 1 · ${formatLocalTime(scan.startedAt ?? scan.tail.lastTimestamp)} · ${scan.cwd ?? ""} · 会话 ${scan.id}`,
    );
  }
  if (chainNames.length >= 2) headerLines.push(`接力链：${chainNames.join(" → ")}`);
  const header = `${headerLines.join("\n")}\n`;

  const todos = extractTodos(detail.branchMessages);
  const instructions = userInstructions(detail.branchMessages);
  const files = filesTouched(detail.branchMessages);
  const readFiles = filesRead(detail.branchMessages);

  const brief = [
    "## 接手须知",
    `- 先用一两句话告诉用户：接的是哪个会话（${agent} · ${formatLocalTime(scan.startedAt ?? scan.tail.lastTimestamp)}）、进度如何、接下来做什么，然后直接开工。`,
    "- 以磁盘上的文件为准：旧 agent 可能写到一半就被打断了。先运行 git status 与 git diff 确认现状。",
    "- 把旧会话的待办搬进你自己的待办工具。",
    `- 需要细节时运行：memrelay show ${scan.id} --from 0`,
  ];
  if (minutes < 5) {
    const when = minutes <= 0 ? "刚刚" : `${minutes} 分钟前`;
    brief.push(`- 注意：这个会话 ${when}还有写入，旧 agent 可能还在运行。动手前先跟用户确认。`);
  }

  const secProgress = section("最后进展", renderProgress(detail));
  const secChain = chain && chain.entries.length > 0 ? section("接力历史（前几段）", renderChainHistory(chain)) : "";
  const secPlan = section("计划和待办", renderTodos(todos));
  const secInstructions = section("你的原始指令", renderUserInstructions(instructions));
  const secFiles = section("改过的文件与当前 git 状态", renderFiles(files, readFiles, git));
  const secSummary = input.summary ? section("任务摘要（AI 生成）", input.summary) : "";

  const reserved = estimateTokens(header) + estimateTokens(brief.join("\n")) + 120;
  const available = Math.max(1500, TOKEN_BUDGET - reserved);
  // 有摘要时给它一小份预算、其余按比例让出；没有摘要时份额与现状完全一致（未开启逐字不变）
  const order: Array<{ text: string; share: number }> = secSummary
    ? [
        { text: secSummary, share: 0.08 },
        { text: secProgress, share: 0.28 },
        { text: secChain, share: 0.16 },
        { text: secPlan, share: 0.18 },
        { text: secInstructions, share: 0.2 },
        { text: secFiles, share: 0.1 },
      ]
    : [
        { text: secProgress, share: 0.3 },
        { text: secChain, share: 0.18 },
        { text: secPlan, share: 0.2 },
        { text: secInstructions, share: 0.22 },
        { text: secFiles, share: 0.1 },
      ];
  const rendered = order.map(({ text, share }) => {
    const budget = Math.floor(available * share);
    return truncateByTokens(text, budget);
  });
  const omitted = rendered.reduce((acc, r) => acc + r.truncatedTokens, 0);

  const body = rendered.map((r) => r.text).join("\n");
  const omittedNote =
    omitted > 0
      ? `\n（部分内容超出长度预算已省略约 ${omitted} tokens；完整内容见：memrelay show ${scan.id} --from 0）\n`
      : "";

  const raw = `${header}\n${brief.join("\n")}\n\n${body}${omittedNote}`;
  return redactSecrets(raw).text;
}
