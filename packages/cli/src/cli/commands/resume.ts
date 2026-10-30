import { parseArgs } from "node:util";

import { redactSecrets } from "../../core/secrets.js";
import { collectGitState } from "../../core/project.js";
import { TOOL_REGISTRY } from "../../core/tool-registry.js";
import { isPathInside } from "../../adapters/jsonl-family/parser.js";
import type { SessionScan } from "../../adapters/jsonl-family/jsonl-adapter.js";
import { collectChain } from "../../resume/chain.js";
import {
  resolveContext,
  scanAll,
  adapterForScan,
  resolveSessionRef,
  type ResumeContext,
} from "../../resume/context.js";
import { decideStatus } from "../../resume/extract.js";
import { renderMenu } from "../../resume/menu.js";
import { renderResume } from "../../resume/render.js";
import {
  buildAllRanked,
  fuseRankedSemantics,
  rankFromSignals,
  selectSession,
  signalsFromMessages,
} from "../../resume/select.js";
import { readSessionDetail, type SessionDetail } from "../../resume/session-reader.js";
import { tryRankFromStore, tryRankGloballyFromStore } from "../../resume/store-rank.js";
import { semanticScoresForResume } from "../../store/semantic.js";
import { readSummaries, resumeSummary } from "../../store/summarizer.js";
import { helpText } from "../help.js";
import { writeOut } from "../output.js";

interface ResumeOptions {
  keyword: string;
  out?: string;
}

/** `agent:会话id`（菜单里显示的完整 id）视为精确指定；普通关键词即使带冒号也照常搜索。 */
function asSessionIdQuery(query: string): string | undefined {
  const sep = query.indexOf(":");
  if (sep <= 0) return undefined;
  const agent = query.slice(0, sep).toLowerCase();
  const native = query.slice(sep + 1);
  if (!native || /\s/.test(native)) return undefined;
  if (!TOOL_REGISTRY.some((tool) => tool.id === agent)) return undefined;
  return `${agent}${query.slice(sep)}`;
}

/**
 * 精确续接：按 id 强制选中会话，跳过打分/菜单/状态过滤，
 * 输出与关键字接续完全一致的完整内容（首行标记 + 接力历史），
 * 这样 agent 从候选菜单选定后再跑一次就能把当前会话落到接力链上。
 */
async function runResumeById(
  ctx: ResumeContext,
  id: string,
  out: string | undefined,
): Promise<number> {
  const resolved = await resolveSessionRef(ctx, id);
  if (!resolved) {
    writeOut(
      [
        `没有找到会话 ${id}（可能已删除、被工具清理，或被目录排除）。`,
        "请确认会话 id（菜单里显示的是完整 id，如 claude-code:3f2a1b…）；也可以运行 memrelay resume 查看当前项目的候选菜单。",
      ].join("\n"),
      out,
    );
    return 0;
  }

  const { adapter, ref } = resolved;
  let detail: SessionDetail;
  try {
    detail = await readSessionDetail(adapter, ref);
  } catch {
    writeOut(
      `会话 ${ref.id} 的原始记录已不可读（文件可能已被工具清理）。换一个会话，或直接当新任务处理。`,
      out,
    );
    return 0;
  }
  const timestamps = detail.branchMessages.map((m) => m.timestamp).filter((t): t is string => !!t);
  // 标记行需要可解析的时间；三者都没有时用文件 mtime 兜底，保证新会话能落链。
  const startedAt =
    ref.startedAt ?? timestamps[0] ?? new Date(ref.mtimeMs || Date.now()).toISOString();
  const lastTimestamp = timestamps[timestamps.length - 1];
  const scan: SessionScan = {
    ...ref,
    startedAt,
    tail: {
      statusInfo: detail.statusInfo,
      hasActiveLeaf: false,
      lastTimestamp,
      memrelayCalledRecently: false,
    },
  };

  const signals = signalsFromMessages(detail.statusInfo, detail.branchMessages);
  if (!signals.hasContent) {
    writeOut(
      `会话 ${scan.id} 只是开了个头、没有实际产出（没有可续接的进展）。换一个会话，或直接当新任务处理。`,
      out,
    );
    return 0;
  }

  const now = Date.now();
  const status = decideStatus(detail.statusInfo, detail.branchMessages, ref.mtimeMs, now);
  const ranked = rankFromSignals(
    scan,
    { ...signals, status },
    {
      keyword: "",
      gitChangedFiles: ctx.git.changedFiles,
      now,
      callerAgent: ctx.callerTool?.id,
    },
  );

  const chain = await collectChain(ctx, scan.id, detail);
  const summary = await resumeSummary(ctx.env, scan.id);
  const crossProject =
    !!scan.cwd &&
    !!ctx.project.projectRoot &&
    !isPathInside(scan.cwd, ctx.project.projectRoot, ctx.env.platform);
  const git = crossProject && scan.cwd ? collectGitState(scan.cwd) : ctx.git;
  const scopeNote = crossProject
    ? `注意：指定的会话在其它项目（${scan.cwd ?? "未知目录"}），继续之前先 cd 到该目录。\n\n`
    : "";
  writeOut(
    scopeNote +
      renderResume({
        detail,
        ranked,
        git,
        callerTool: ctx.callerTool,
        chain,
        summary,
      }),
    out,
  );
  return 0;
}

export async function runResume(rest: string[], stdout: (text: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    stdout(helpText());
    return 0;
  }
  const opts: ResumeOptions = { keyword: positionals.join(" ").trim(), out: values.out };

  const ctx = resolveContext();
  const idQuery = asSessionIdQuery(opts.keyword);
  if (idQuery) return runResumeById(ctx, idQuery, opts.out);
  const now = Date.now();
  const manualStatus = (id: string) => ctx.filters.manualStatus[id];
  const rankOptions = {
    keyword: opts.keyword,
    gitChangedFiles: ctx.git.changedFiles,
    now,
    callerAgent: ctx.callerTool?.id,
  };
  let crossProject = false;

  // 快路径：先按索引库排序（毫秒级），只有校验不过的文件才现场重读；
  // 库缺失 / 大面积过期时返回 undefined，落回下面的全量扫盘（结果口径不变）。
  let ranked = await tryRankFromStore({
    env: ctx.env,
    projectRoot: ctx.project.projectRoot,
    filters: ctx.filters,
    adapters: ctx.adapters,
    rank: rankOptions,
    manualStatus,
  });

  if (!ranked) {
    const scans = await scanAll(ctx);
    if (scans.length === 0) {
      // 当前目录不是项目（典型：从 C:\Windows\System32 启动的 Codex 桌面端）：
      // 带关键词时按全库兜底，避免明明有任务却只能手工去磁盘里找项目。
      let globalUnavailable = false;
      if (opts.keyword) {
        const global = await tryRankGloballyFromStore({
          env: ctx.env,
          filters: ctx.filters,
          rank: rankOptions,
          manualStatus,
          excludeProjectRoot: ctx.project.projectRoot,
        });
        if (global && global.length > 0) {
          ranked = global;
          crossProject = true;
        } else if (global === undefined) {
          globalUnavailable = true;
        }
      }
      if (!ranked) {
        writeOut(
          [
            "当前目录没有找到 MemRelay 能读取的会话。",
            `当前目录：${ctx.cwd}`,
            opts.keyword
              ? globalUnavailable
                ? "全库索引不可用；先运行 memrelay setup 建立索引，或 cd 到项目目录再运行 resume。"
                : "全库也没有找到与关键词匹配的会话；可以换关键词，或先 cd 到项目目录再运行 resume。"
              : "如果任务在其它项目里，先 cd 到项目目录再运行 resume；也可以运行 memrelay doctor 检查接入情况。",
          ].join("\n"),
          opts.out,
        );
        return 0;
      }
    } else {
      ranked = await buildAllRanked(ctx.adapters, scans, {
        keyword: opts.keyword,
        cwd: ctx.cwd,
        gitChangedFiles: ctx.git.changedFiles,
        manualStatus,
        callerAgent: ctx.callerTool?.id,
        env: ctx.env,
      });
    }
  }

  // 语义通道（opt-in，设计文档 §2.1）：候选会话定向排空 + 查询词嵌入 + 余弦融合。
  // 未启用、接口失败、超时都静默跳过——结果与未开启时一致。
  const semanticScores = await semanticScoresForResume(
    ctx.env,
    opts.keyword,
    ranked.map((r) => r.scan.id),
  );
  if (semanticScores.size > 0) fuseRankedSemantics(ranked, semanticScores);

  const selection = selectSession(ranked, opts.keyword);
  const scope = crossProject ? "其他项目" : "当前项目";
  if (selection.mode === "empty") {
    if (selection.onlyCaller) {
      writeOut(`${scope}里只有调用方自己的会话（没有可续接的旧任务）。请照常处理用户的请求。`, opts.out);
      return 0;
    }
    if (selection.onlyEmpty) {
      writeOut(
        `${scope}里的旧会话都只是开了个头、没有实际产出（没有可续接的进展）。让用户确认一下要接哪个工具里的任务，或直接当新任务处理。`,
        opts.out,
      );
      return 0;
    }
    writeOut(`${scope}没有找到中断的任务。`, opts.out);
    return 0;
  }

  if (selection.mode === "menu" || !selection.chosen) {
    // 菜单附上现成摘要（AI 增强，只读不生成）——"选哪个"的判断依据更清楚
    const menuCandidates = selection.ranked.slice(0, 15);
    const menu = renderMenu(selection.ranked, {
      keyword: opts.keyword || undefined,
      reason: selection.menuReason,
      note:
        selection.menuReason === "multi-recent"
          ? undefined
          : "这份菜单是给 agent 的判断材料，不是给人直接操作的表单：先按标题、摘要、目录和接力关系自己选；多个候选都同样合理时，只把 2–3 个最可能的转述给用户，不要原样贴长列表。",
      currentCwd: ctx.cwd,
      crossProject,
      limit: 15,
      summaries: readSummaries(
        ctx.env,
        menuCandidates.map((r) => r.scan.id),
      ),
    });
    const { text } = redactSecrets(menu);
    writeOut(text, opts.out);
    return 0;
  }

  const chosen = selection.chosen;
  const adapter = adapterForScan(ctx, chosen.scan);
  if (!adapter) {
    writeOut("内部错误：找不到会话所属的适配器。", opts.out);
    return 2;
  }
  const { tail: _tail, ...ref } = chosen.scan;
  const detail = await readSessionDetail(adapter, ref);
  const chain = await collectChain(ctx, chosen.scan.id, detail);

  // AI 摘要（opt-in，设计文档 §4）：已有零成本读；缺失时定向生成（≤1 会话 / ≤6s）；
  // 任何失败静默——渲染与未开启时逐字一致。
  const summary = await resumeSummary(ctx.env, chosen.scan.id);

  const scopeNote = crossProject
    ? `注意：当前目录（${ctx.cwd}）没有可续接的会话；下面接的是其他项目里的任务（${chosen.scan.cwd ?? "未知目录"}），继续之前先 cd 到该目录。\n\n`
    : "";
  const git = crossProject && chosen.scan.cwd ? collectGitState(chosen.scan.cwd) : ctx.git;
  const text = scopeNote + renderResume({
    detail,
    ranked: chosen,
    git,
    callerTool: ctx.callerTool,
    chain,
    summary,
  });

  if (selection.ranked.length > 1) {
    const alternatives = selection.ranked
      .filter((r) => r !== chosen)
      .slice(0, 2)
      .map((r) => `${r.scan.id}（${r.status === "interrupted" ? "中断" : "其他"}）`)
      .join("、");
    if (alternatives) {
      writeOut(`${text}\n备选任务：${alternatives}。如果接错了，用户纠正后换一个即可。`, opts.out);
      return 0;
    }
  }

  writeOut(text, opts.out);
  return 0;
}
