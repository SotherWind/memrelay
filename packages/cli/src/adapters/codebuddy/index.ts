import { codebuddyProjectsRoot } from "../../core/codebuddy-paths.js";
import type { SerializedJsonlAdapter } from "../jsonl-family/jsonl-adapter.js";
import { createCodebuddyCliAdapter } from "./cli.js";

export { CODECBUDDY_AGENT, codebuddyIdeAdapter } from "./ide.js";

/** CodeBuddy Code CLI：~/.codebuddy/projects/<slug>/<sessionId>.jsonl（无元数据库）。 */
export function codebuddyCliAdapter(): SerializedJsonlAdapter {
  return createCodebuddyCliAdapter({
    agent: "codebuddy",
    homeDir: ".codebuddy",
    rootOf: codebuddyProjectsRoot,
  });
}
