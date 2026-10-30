import { claudeCodeAdapter } from "./claude-code/index.js";
import { qoderAdapter } from "./qoder/index.js";
import { codexAdapter, traeCliAdapter } from "./codex/index.js";
import { cursorAdapter } from "./cursor/index.js";
import { codebuddyCliAdapter, codebuddyIdeAdapter } from "./codebuddy/index.js";
import { dshAdapter } from "./dsh/index.js";
import { workbuddyAdapter } from "./workbuddy/index.js";
import { opencodeAdapter, zcodeAdapter } from "./opencode-family/index.js";
import { traeEventsAdapter } from "./trae-events/index.js";
import type { SerializedJsonlAdapter } from "./jsonl-family/jsonl-adapter.js";

/** 所有已支持来源的适配器；新增来源只在这里加一行。 */
export function allAdapters(): SerializedJsonlAdapter[] {
  return [
    claudeCodeAdapter(),
    qoderAdapter(),
    codexAdapter(),
    traeCliAdapter(),
    cursorAdapter(),
    codebuddyCliAdapter(),
    codebuddyIdeAdapter(),
    workbuddyAdapter(),
    opencodeAdapter(),
    zcodeAdapter(),
    traeEventsAdapter(),
    dshAdapter(),
  ];
}
