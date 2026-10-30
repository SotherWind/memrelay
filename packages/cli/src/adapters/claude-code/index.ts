import { createJsonlAdapter } from "../jsonl-family/jsonl-adapter.js";

export const ADAPTER_VERSION = 2; // v2：分支回溯支持链上的"空档"记录（walkBranch links）

export function claudeCodeAdapter() {
  return createJsonlAdapter({
    agent: "claude-code",
    version: ADAPTER_VERSION,
    sessionsRootRel: ".claude/projects",
  });
}
