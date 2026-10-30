import { resolveSessionRef, type ResumeContext } from "./context.js";
import type { ChainEntry, ChainInfo } from "./render.js";
import { findChainMarker, looksLikeContinuation, readSessionDetail, type SessionDetail } from "./session-reader.js";
import { lastAssistantText, userInstructions } from "./extract.js";
import { isPathInside } from "../adapters/jsonl-family/parser.js";

const MAX_CHAIN_HOPS = 5;

/**
 * 沿续接标记往上游走，收集前几段会话的指令与进展。
 * 验收要求：三段接力后，接手工具能拿到整条链的进展。
 * 导出供管理界面复用（续接预览）。
 */
export async function collectChain(
  ctx: ResumeContext,
  chosenId: string,
  chosenDetail: SessionDetail,
): Promise<ChainInfo | undefined> {
  const entries: ChainEntry[] = [];
  const seen = new Set<string>([chosenId]);
  let marker = findChainMarker(chosenDetail.branchMessages);
  if (!marker) return undefined;
  // 跨项目链只允许当前会话首条指令明确是续接；否则项目 A 里测试 resume 留下的标记
  // 会把项目 B 的会话错误拼进来。
  const allowCrossProject = looksLikeContinuation(userInstructions(chosenDetail.branchMessages)[0] ?? "");

  let root: ChainInfo["root"] = {
    agent: marker.agent,
    nativeId: marker.nativeId,
    sessionCount: marker.sessionCount,
    startedAt: marker.startedAt,
  };

  let hops = 0;
  while (marker && hops < MAX_CHAIN_HOPS) {
    const parentId = `${marker.agent}:${marker.nativeId}`;
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const resolved = await resolveSessionRef(ctx, parentId);
    if (!resolved) {
      // 找不到上一段（工具被卸载等）：保留标记里的信息，链到此为止
      maybeUpgradeRoot(root, marker);
      break;
    }
    if (
      !allowCrossProject &&
      resolved.ref.cwd &&
      ctx.project.projectRoot &&
      !isPathInside(resolved.ref.cwd, ctx.project.projectRoot, ctx.env.platform)
    ) {
      break;
    }
    const parentDetail = await readSessionDetail(resolved.adapter, resolved.ref);
    entries.unshift({
      agent: resolved.ref.agent,
      id: resolved.ref.id,
      startedAt: resolved.ref.startedAt ?? "",
      instructions: userInstructions(parentDetail.branchMessages),
      lastText: lastAssistantText(parentDetail.branchMessages, 600),
    });
    const parentMarker = findChainMarker(parentDetail.branchMessages);
    if (parentMarker) {
      marker = parentMarker;
      root = {
        agent: parentMarker.agent,
        nativeId: parentMarker.nativeId,
        sessionCount: parentMarker.sessionCount,
        startedAt: parentMarker.startedAt,
      };
      hops++;
    } else {
      // 这一段就是链根：根的时间用它的开始时间
      root = {
        agent: resolved.ref.agent,
        nativeId: resolved.ref.id.slice(resolved.ref.id.indexOf(":") + 1),
        sessionCount: entries.length + 1,
        startedAt: resolved.ref.startedAt ?? "",
      };
      break;
    }
  }

  if (entries.length === 0) {
    // 上一段没找到，但标记还在：至少把它当根报出来
    root.sessionCount = Math.max(root.sessionCount, 1);
  } else {
    root.sessionCount = Math.max(root.sessionCount, entries.length + 1);
  }
  return { entries, root };
}

function maybeUpgradeRoot(root: ChainInfo["root"], marker: { agent: string; nativeId: string; startedAt: string }): void {
  root.agent = marker.agent;
  root.nativeId = marker.nativeId;
  if (marker.startedAt) root.startedAt = marker.startedAt;
}
