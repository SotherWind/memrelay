import type { Env } from "../core/types.js";
import { loadFilters } from "../core/filters.js";
import { collectGitState } from "../core/project.js";
import { allAdapters } from "../adapters/all.js";
import type { SessionScan } from "../adapters/jsonl-family/jsonl-adapter.js";
import { resolveSessionRef, type ResumeContext } from "../resume/context.js";
import { readSessionDetail, type SessionDetail } from "../resume/session-reader.js";
import { collectChain } from "../resume/chain.js";
import { renderResume, type ChainInfo } from "../resume/render.js";
import type { RankedSession } from "../resume/select.js";

export class SessionFileMissingError extends Error {}

export interface ResumePreviewResult {
  sessionId: string;
  text: string;
  chain?: ChainInfo;
}

/**
 * 管理界面的"续接预览/复制续接提示词"：
 * 不走 resume 的"选会话"流程——会话由界面指定，其余（读文件、沿标记追链、提炼、渲染、密钥遮盖）
 * 与 memrelay resume 共用同一条管线，保证复制出来的内容和终端里拿到的一致。
 */
export async function buildResumePreview(
  env: Env,
  projectRoot: string,
  sessionId: string,
): Promise<ResumePreviewResult> {
  const adapters = allAdapters();
  const ctx: ResumeContext = {
    env,
    cwd: projectRoot,
    project: { projectRoot, isGitRepo: false, differentDir: false },
    git: collectGitState(projectRoot),
    adapters,
    callerTool: undefined,
    filters: loadFilters(env),
  };

  const resolved = await resolveSessionRef(ctx, sessionId);
  if (!resolved) {
    throw new SessionFileMissingError(`找不到会话文件（${sessionId}）；可能已被原工具清理。`);
  }

  const detail = await readSessionDetail(resolved.adapter, resolved.ref);
  const chain = await collectChain(ctx, resolved.ref.id, detail);

  // 打分字段只有排序用得上，renderResume 只读 scan 上的展示字段
  const scan: SessionScan = {
    ...resolved.ref,
    tail: {
      statusInfo: detail.statusInfo,
      hasActiveLeaf: false,
      lastTimestamp: lastTimestampOf(detail),
      memrelayCalledRecently: false,
    },
  };
  const ranked: RankedSession = {
    scan,
    keyword: 0,
    timeScore: 0,
    fileOverlap: 0,
    interruptedBonus: 0,
    total: 0,
    status: "unknown",
    hasContent: true,
    isCaller: false,
  };

  const text = renderResume({ detail, ranked, git: ctx.git, chain });
  return { sessionId: resolved.ref.id, text, chain };
}

function lastTimestampOf(detail: SessionDetail): string | undefined {
  for (let i = detail.branchMessages.length - 1; i >= 0; i--) {
    const timestamp = detail.branchMessages[i]!.timestamp;
    if (timestamp) return timestamp;
  }
  return undefined;
}
