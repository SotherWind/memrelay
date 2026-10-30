import type { SerializedJsonlAdapter } from "../jsonl-family/jsonl-adapter.js";
import { createCodebuddyCliAdapter } from "../codebuddy/cli.js";

/**
 * WorkBuddy 适配器（CodeBuddy 系）：会话是逐行 JSONL，
 * `~/.workbuddy/projects/<项目 slug>/<sessionId>.jsonl`；元数据（cwd/title/状态/时间）
 * 额外可从 `~/.workbuddy/workbuddy.db` 的 sessions 表核对。
 */
export const WORKBUDDY_AGENT = "workbuddy";

export function workbuddyAdapter(): SerializedJsonlAdapter {
  return createCodebuddyCliAdapter({
    agent: WORKBUDDY_AGENT,
    homeDir: ".workbuddy",
    dbFile: "workbuddy.db",
  });
}
