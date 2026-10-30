import type { Env, SessionStatus } from "../core/types.js";
import { mutateFilters } from "../core/filters.js";

/** 手动修正任务状态：写 filters.json 的 manualStatus；status=null 表示恢复自动判定。 */
export function setSessionsStatus(env: Env, ids: string[], status: SessionStatus | null): void {
  const wanted = [...new Set(ids.filter((id) => typeof id === "string" && id.trim().length > 0))];
  if (wanted.length === 0) return;
  mutateFilters(env, (filters) => {
    const manualStatus = { ...filters.manualStatus };
    for (const id of wanted) {
      if (status === null) delete manualStatus[id];
      else manualStatus[id] = status;
    }
    return { ...filters, manualStatus };
  });
}

/** 手动改任务名：写 filters.json 的 manualNames；name=null 表示恢复原名。 */
export function setTaskName(env: Env, taskId: string, name: string | null): void {
  if (!taskId) return;
  mutateFilters(env, (filters) => {
    const manualNames = { ...filters.manualNames };
    const trimmed = name?.trim() ?? "";
    if (!trimmed) delete manualNames[taskId];
    else manualNames[taskId] = trimmed;
    return { ...filters, manualNames };
  });
}

/**
 * 手动整理接力链：清掉所有覆盖到 touched 会话的链，再追加新链（add 为空即恢复自动）。
 * 链里的会话不再参与自动接力链（见 task-list 投影），所以拆开的两半都要登记。
 */
export function updateManualChains(env: Env, touched: string[], add: string[][] = []): void {
  const wanted = new Set(touched.filter((id) => typeof id === "string" && id.length > 0));
  if (wanted.size === 0) return;
  mutateFilters(env, (filters) => {
    const kept = (filters.manualChains ?? []).filter(
      (chain) => !chain.some((id) => wanted.has(id)),
    );
    const cleaned = add
      .map((chain) => [...new Set(chain)].filter((id) => id.length > 0))
      .filter((chain) => chain.length > 0);
    return { ...filters, manualChains: [...kept, ...cleaned] };
  });
}
