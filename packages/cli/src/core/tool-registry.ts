import path from "node:path";

import { codebuddyIdeHistoryRoots } from "./codebuddy-paths.js";
import type { AgentId, Env } from "./types.js";

export interface ToolDefinition {
  id: AgentId;
  name: string;
  /** 作为来源工具时的会话目录（相对 home），不存在则该工具不能作为来源 */
  sessionsRoot?: string;
  /** 同一工具的其他会话根（绝对路径），如 CodeBuddy IDE 的 genie-history */
  extraSourceRoots?: (env: Env) => string[];
  /** 作为接手工具时的 Skill 目录（相对 home），可以有多个 */
  skillDirs: string[];
  /** 会话文件是否加密，加密时只能作为接手工具 */
  encryptedSessions?: boolean;
}

export const TOOL_REGISTRY: ToolDefinition[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    sessionsRoot: ".claude/projects",
    skillDirs: [".claude/skills"],
  },
  {
    id: "qoder",
    name: "Qoder",
    sessionsRoot: ".qoder/projects",
    skillDirs: [".qoder/skills"],
  },
  {
    id: "codex",
    name: "Codex",
    sessionsRoot: ".codex/sessions",
    skillDirs: [".agents/skills", ".codex/skills"],
  },
  {
    id: "cursor",
    name: "Cursor",
    // 真实会话在 %APPDATA%/Cursor/User/globalStorage/state.vscdb（见 adapters/cursor）；这里只是探测锚点
    sessionsRoot: ".cursor",
    skillDirs: [".cursor/skills"],
  },
  {
    id: "codebuddy",
    name: "CodeBuddy",
    // CLI：~/.codebuddy/projects/<slug>/<sessionId>.jsonl；IDE：genie-history/<工作区>/conversations/<id>
    sessionsRoot: ".codebuddy/projects",
    extraSourceRoots: codebuddyIdeHistoryRoots,
    skillDirs: [".codebuddy/skills"],
  },
  {
    id: "workbuddy",
    name: "WorkBuddy",
    // 会话在 ~/.workbuddy/projects/<slug>/<sessionId>.jsonl（逐行 JSON），元数据在 workbuddy.db
    sessionsRoot: ".workbuddy/projects",
    skillDirs: [".workbuddy/skills"],
  },
  {
    id: "zcode",
    name: "ZCode",
    // 会话在 ~/.zcode/cli/db/db.sqlite（OpenCode 家族 schema）
    sessionsRoot: ".zcode",
    skillDirs: [],
  },
  {
    id: "opencode",
    name: "OpenCode",
    // 会话在 ~/.local/share/opencode/opencode.db（session_v2 + session_message）
    sessionsRoot: ".local/share/opencode",
    skillDirs: [],
  },
  {
    id: "trae",
    name: "Trae",
    // Trae CLI 2.0：Codex 兼容的 rollout JSONL（.trae/cli 下的 sessions 与 archived_sessions）
    sessionsRoot: ".trae/cli",
    skillDirs: [".trae/skills"],
  },
  {
    id: "trae-cn",
    name: "Trae CN",
    // IDE 会话库加密不可读；已接入的 hooks 会事件重建会话（hook --flavor trae-cn → relay-events）
    sessionsRoot: ".trae-cn",
    skillDirs: [".trae-cn/skills"],
  },
  {
    id: "dsh",
    name: "DeepSeek Harness",
    // 会话在 ~/.dsh/sessions/<编码项目目录>/session-<id>/session.v4.jsonl.zstd（多帧 zstd JSONL）
    sessionsRoot: ".dsh/sessions",
    // 技能体系兼容 Claude 格式（SKILL.md + frontmatter），用户级根目录会被热加载
    skillDirs: [".dsh/skills"],
  },
];

export function toolById(id: AgentId): ToolDefinition | undefined {
  return TOOL_REGISTRY.find((t) => t.id === id);
}

export function sessionsRootFor(id: AgentId, env: Env): string | undefined {
  const tool = toolById(id);
  if (!tool?.sessionsRoot) return undefined;
  return path.join(env.home, ...tool.sessionsRoot.split("/"));
}
