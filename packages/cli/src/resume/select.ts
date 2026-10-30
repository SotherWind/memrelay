import type { SessionScan } from "../adapters/jsonl-family/jsonl-adapter.js";
import type { Env, SessionStatus } from "../core/types.js";
import { keywordScore } from "../core/cjk.js";
import { semanticToKeyword } from "../core/embeddings.js";
import { pickAdapter } from "./context.js";
import { minutesSince, readSessionDetail, findChainMarker, containsMemrelayCall, type ChainMarker } from "./session-reader.js";
import { decideStatus, extractTodos, userInstructions, lastAssistantText, summarizeMessagesWith } from "./extract.js";
import { analyzeStatus, type LocalMessage, type StatusInfo } from "../adapters/jsonl-family/records.js";
import type { SerializedJsonlAdapter } from "../adapters/jsonl-family/jsonl-adapter.js";

export interface RankedSession {
  scan: SessionScan;
  keyword: number;
  timeScore: number;
  fileOverlap: number;
  interruptedBonus: number;
  total: number;
  status: SessionStatus;
  /** 旧 agent 是否真的干过活（有助手文本或工具调用）；空壳会话没东西可接 */
  hasContent: boolean;
  chainFrom?: { agent: string; nativeId: string; sessionCount: number };
  isCaller: boolean;
  /** 语义通道给出的余弦（融合后回填；调试与测试用） */
  semantic?: number;
}

/** 路径比较按末尾文件名匹配，容忍绝对/相对路径的写法差异。 */
function normalizeFile(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

export interface BuildOptions {
  keyword: string;
  cwd: string;
  gitChangedFiles: string[];
  now?: number;
  manualStatus?: (sessionId: string) => SessionStatus | undefined;
  callerAgent?: string;
  /** 提供后按 sourcePath 归属选适配器（CodeBuddy CLI/IDE 共用一个 agent id） */
  env?: Env;
}

/** 排序所需的全部信号。读文件的路径与查库的快路径各自构造它，共用同一套打分。 */
export interface RankSignals {
  statusInfo: StatusInfo;
  status: SessionStatus;
  /** 关键词匹配用的文本（标题 + 最后进展 + 用户指令 + 最后几段助手回复） */
  keywordText: string;
  /** 会话改过的文件（file_edit 的路径） */
  touchedFiles: string[];
  marker?: ChainMarker;
  /** 记录末尾有 memrelay 调用痕迹（识别调用方自己的会话） */
  memrelayCall: boolean;
  hasContent: boolean;
}

export interface RankOptions {
  keyword: string;
  gitChangedFiles: string[];
  now: number;
  callerAgent?: string;
}

export function rankFromSignals(
  scan: SessionScan,
  signals: RankSignals,
  opts: RankOptions,
): RankedSession {
  const keyword = opts.keyword ? keywordScore(opts.keyword, signals.keywordText.slice(0, 20000)) : 0;

  const minutes = minutesSince(scan.mtimeMs, opts.now);
  const timeScore = 1 / (1 + minutes / 60);

  const touched = new Set(signals.touchedFiles.map(normalizeFile));
  let overlap = 0;
  for (const f of opts.gitChangedFiles) {
    if (touched.has(normalizeFile(f))) overlap++;
  }
  const fileOverlap = Math.min(overlap, 5) / 5;

  const interruptedBonus =
    signals.status === "interrupted" ? 0.15 : signals.status === "in_progress" ? 0.05 : 0;

  // "自己"这个会话：记录里出现 memrelay 调用痕迹，且文件正在被写（10 分钟内）；
  // 或者调用方工具刚在写这个文件（Qoder 等工具写入有滞后，环境变量兜底）。
  const recentlyTouched = opts.now - scan.mtimeMs < 10 * 60 * 1000;
  const isCaller =
    (signals.memrelayCall && recentlyTouched) ||
    (!!opts.callerAgent && scan.agent === opts.callerAgent && opts.now - scan.mtimeMs < 90 * 1000);

  const total = timeScore + keyword * 1.2 + fileOverlap * 0.4 + interruptedBonus;

  return {
    scan,
    keyword,
    timeScore,
    fileOverlap,
    interruptedBonus,
    total,
    status: signals.status,
    hasContent: signals.hasContent,
    chainFrom: signals.marker
      ? {
          agent: signals.marker.agent,
          nativeId: signals.marker.nativeId,
          sessionCount: signals.marker.sessionCount,
        }
      : undefined,
    isCaller,
  };
}

/**
 * 语义分融合（设计文档 §2.1）：两个通道进同一分数位，
 * keyword 分量 = max(keywordScore, clamp((cos−0.35)/(0.75−0.35)))；total 其余项与
 * decisive / menu 阈值语义不变。后置执行是因为余弦要等候选集齐后统一算。
 */
export function fuseRankedSemantics(ranked: RankedSession[], semanticCos: Map<string, number>): void {
  for (const r of ranked) {
    const cos = semanticCos.get(r.scan.id);
    if (cos === undefined) continue;
    r.semantic = cos;
    const fused = Math.max(r.keyword, semanticToKeyword(cos));
    if (fused === r.keyword) continue;
    r.keyword = fused;
    r.total = r.timeScore + fused * 1.2 + r.fileOverlap * 0.4 + r.interruptedBonus;
  }
}

/** 从已读出的消息构造排序信号（文件路径）。 */
export function signalsFromMessages(
  statusInfo: StatusInfo,
  messages: LocalMessage[],
  title?: string,
): Omit<RankSignals, "status"> {
  const keywordText = [
    title ?? "",
    statusInfo.lastAssistantText ?? "",
    ...userInstructions(messages),
    messages
      .filter((m) => m.role === "assistant")
      .slice(-6)
      .map((m) => m.parts.map((p) => p.text ?? "").join(" ")),
  ].join("\n");

  const touchedFiles: string[] = [];
  for (const m of messages) {
    for (const c of m.toolCalls) {
      for (const f of c.files) touchedFiles.push(f);
    }
  }

  // 空壳会话（比如开了个头就被关掉的）：只有用户提问、没有任何助手产出，没有东西可接
  const hasContent = messages.some(
    (m) =>
      m.role === "assistant" &&
      m.parts.some(
        (p) =>
          (p.kind === "text" && (p.text ?? "").trim().length > 0) ||
          p.kind === "tool_call" ||
          p.kind === "file_edit" ||
          p.kind === "plan",
      ),
  );

  return {
    statusInfo,
    keywordText,
    touchedFiles,
    marker: findChainMarker(messages),
    memrelayCall: containsMemrelayCall(messages),
    hasContent,
  };
}

export async function buildRankedSession(
  adapter: SerializedJsonlAdapter,
  scan: SessionScan,
  opts: {
    keyword: string;
    gitChangedFiles: string[];
    now: number;
    manualStatus?: (sessionId: string) => SessionStatus | undefined;
    callerAgent?: string;
  },
): Promise<RankedSession> {
  const detail = await readSessionDetail(adapter, scan);
  const messages = detail.branchMessages;

  const status =
    opts.manualStatus?.(scan.id) ??
    decideStatus(detail.statusInfo, messages, scan.mtimeMs, opts.now);

  const signals = signalsFromMessages(detail.statusInfo, messages, scan.tail.lastTitle);
  // 文件末尾的记录里也有 memrelay 痕迹时同样算（scan 的快速尾巴分析）
  signals.memrelayCall = scan.tail.memrelayCalledRecently || signals.memrelayCall;

  return rankFromSignals(scan, { ...signals, status }, opts);
}

export interface SelectionResult {
  ranked: RankedSession[];
  chosen?: RankedSession;
  /** 全部候选都被过滤（只有调用方自己的会话） */
  onlyCaller: boolean;
  /** 有会话但都没有实质产出（空壳） */
  onlyEmpty: boolean;
  /** 出菜单的原因：关键词不唯一 / 无关键词但多个都很近分不出主次 */
  menuReason?: "ambiguous-keyword" | "multi-recent";
  /** 无关键词时接"最近一个中断的会话"；关键词命中不唯一时给候选菜单 */
  mode: "single" | "confident" | "menu" | "empty";
}

/** 多个中断会话都落在这个窗口内时，认为"最近"分不出主次，先让用户挑。 */
export const MULTI_RECENT_WINDOW_MS = 2 * 60 * 60 * 1000;

export function selectSession(
  ranked: RankedSession[],
  keyword: string,
  now = Date.now(),
): SelectionResult {
  // 空壳会话（被关掉的空记录）不参与选择：接过去也没进展可看
  // 手动标记为"放弃"的也不参与：状态只会由用户手动设成 abandoned（自动判定不会产出它）
  const meaningful = ranked.filter((r) => r.hasContent);
  const candidates = meaningful.filter((r) => !r.isCaller && r.status !== "abandoned");
  if (candidates.length === 0) {
    return {
      ranked: [],
      onlyCaller: candidates.length === 0 && meaningful.length === 0 && ranked.length > 0,
      onlyEmpty: ranked.length > 0 && meaningful.length === 0,
      mode: "empty",
    };
  }

  if (!keyword) {
    const interrupted = candidates.filter(
      (r) => r.status === "interrupted" || r.status === "in_progress",
    );
    const pool = interrupted.length > 0 ? interrupted : candidates;
    const byRecency = [...pool].sort((a, b) => b.scan.mtimeMs - a.scan.mtimeMs);
    const top = byRecency[0]!;
    const second = byRecency[1];
    // 第二个中断任务也在最近 2 小时内：两个都像"刚做到一半"，分不出主次 → 让 agent 先问
    if (
      interrupted.length > 0 &&
      second &&
      now - second.scan.mtimeMs < MULTI_RECENT_WINDOW_MS
    ) {
      const ordered = [...candidates].sort((a, b) => b.scan.mtimeMs - a.scan.mtimeMs);
      return {
        ranked: ordered,
        onlyCaller: false,
        onlyEmpty: false,
        menuReason: "multi-recent",
        mode: "menu",
      };
    }
    return { ranked: candidates, chosen: top, onlyCaller: false, onlyEmpty: false, mode: "single" };
  }

  const sorted = [...candidates].sort((a, b) => b.total - a.total);
  const top = sorted[0]!;
  const second = sorted[1];
  const decisive =
    top.keyword >= 0.6 && (!second || top.total >= second.total * 1.3 || second.keyword < top.keyword * 0.6);
  return {
    ranked: sorted,
    chosen: decisive ? top : undefined,
    onlyCaller: false,
    onlyEmpty: false,
    menuReason: decisive ? undefined : "ambiguous-keyword",
    mode: decisive ? "confident" : "menu",
  };
}

export async function buildAllRanked(
  adapters: SerializedJsonlAdapter[],
  scans: SessionScan[],
  opts: BuildOptions,
): Promise<RankedSession[]> {
  const now = opts.now ?? Date.now();
  const ranked: RankedSession[] = [];
  for (const scan of scans) {
    const candidates = adapters.filter((a) => a.agent === scan.agent);
    const adapter = opts.env ? pickAdapter(candidates, scan.sourcePath, opts.env) : candidates[0];
    if (!adapter) continue;
    ranked.push(
      await buildRankedSession(adapter, scan, {
        keyword: opts.keyword,
        gitChangedFiles: opts.gitChangedFiles,
        now,
        manualStatus: opts.manualStatus,
        callerAgent: opts.callerAgent,
      }),
    );
  }
  return ranked;
}
