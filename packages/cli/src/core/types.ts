export type AgentId =
  | "claude-code"
  | "qoder"
  | "codex"
  | "cursor"
  | "qoder-ide"
  | "codebuddy"
  | "workbuddy"
  | "trae"
  | "trae-cn"
  | "hermes"
  | "zcode"
  | "opencode"
  | "dsh"
  | (string & {});

export type PartKind =
  | "text"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "file_edit"
  | "plan"
  | "image"
  | "compaction_summary"
  | "system_event";

export type ToolCategory =
  | "read"
  | "write"
  | "search"
  | "shell"
  | "task"
  | "web"
  | "other";

export type SessionStatus =
  | "in_progress"
  | "interrupted"
  | "done"
  | "abandoned"
  | "unknown";

export type MessageRole = "user" | "assistant" | "tool" | "system";

export interface Part {
  kind: PartKind;
  text?: string;
  json?: unknown;
  toolName?: string;
  toolCategory?: ToolCategory;
  toolCallId?: string;
  status?: "ok" | "error";
}

export interface Message {
  sessionId: string;
  ordinal: number;
  nativeId?: string;
  nativeParentId?: string;
  role: MessageRole;
  createdAt: string;
  isSidechain: boolean;
  isCompactBoundary: boolean;
  parts: Part[];
}

export interface Session {
  id: string;
  agent: AgentId;
  sourcePath: string;
  cwd: string;
  projectRoot: string;
  gitBranch?: string;
  title?: string;
  firstUserMessage?: string;
  startedAt: string;
  endedAt: string;
  status: SessionStatus;
  parentSessionId?: string;
  /** 原始记录条数（含被跳过的噪声记录），供解析完整性检查用 */
  rawRecords?: number;
}

export interface SessionRef {
  id: string;
  agent: AgentId;
  sourcePath: string;
  cwd?: string;
  gitBranch?: string;
  startedAt?: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface Detection {
  installed: boolean;
  sessionsRoot?: string;
}

export interface ProjectScope {
  projectRoot: string;
  cwd: string;
}

export interface Env {
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}

export type NormalizedEvent =
  | { kind: "session"; session: Session }
  | { kind: "active-leaf"; leafUuid: string }
  | { kind: "message"; message: Message };

export interface Adapter {
  agent: AgentId;
  version: number;
  detect(env: Env): Promise<Detection>;
  listSessions(scope: ProjectScope, env: Env): Promise<SessionRef[]>;
  readSession(
    ref: SessionRef,
    opts?: { fromOffset?: number },
  ): AsyncIterable<NormalizedEvent>;
}
