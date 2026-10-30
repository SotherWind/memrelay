import { createJsonlAdapter } from "../jsonl-family/jsonl-adapter.js";

export const ADAPTER_VERSION = 3; // v3：支持 IDE 侧 transcript 格式（无 parentUuid 的线性流水账）

export function qoderAdapter() {
  return createJsonlAdapter({
    agent: "qoder",
    version: ADAPTER_VERSION,
    sessionsRootRel: ".qoder/projects",
    nestedSessionFiles: true,
    extractMetadata(record, state) {
      if (record["type"] === "workspace-directories") {
        const dirs = record["directories"];
        if (Array.isArray(dirs) && typeof dirs[0] === "string" && dirs[0]) {
          state.cwd = state.cwd ?? dirs[0];
        }
      }
    },
  });
}
