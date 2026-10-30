export type ToolId = string;

export type TaskStatus = "in_progress" | "interrupted" | "done" | "abandoned" | "unknown";

export interface ToolLeg {
  tool: ToolId;
  startedAt: number;
  endedAt: number;
  messageCount: number;
  fileCount: number;
}

export interface TaskRow {
  id: string;
  project: string;
  title: string;
  status: TaskStatus;
  lastActiveAt: number;
  legs: ToolLeg[];
  summary: string | null;
}

export interface TaskProjectSummary {
  project: string;
  count: number;
  lastActiveAt: number;
}

export interface TaskListSummary {
  total: number;
  counts: Record<TaskStatus, number>;
  projects: TaskProjectSummary[];
}

export interface TaskPage {
  tasks: TaskRow[];
  total: number;
}

export interface TaskLegDetail extends ToolLeg {
  sessionId: string;
  title: string | null;
  gitBranch: string | null;
}

export interface DashboardTask {
  id: string;
  project: string;
  title: string;
  status: TaskStatus;
  lastActiveAt: number;
  tools: ToolId[];
  messageCount: number;
  fileCount: number;
  summary: string | null;
}

export interface DashboardTool {
  tool: ToolId;
  sessions: number;
}

export interface DashboardDay {
  date: string;
  sessions: number;
}

export interface DashboardData {
  total: number;
  counts: Record<TaskStatus, number>;
  trash: number;
  projects: { total: number; top: TaskProjectSummary[] };
  tools: DashboardTool[];
  activity: DashboardDay[];
  recent: DashboardTask[];
  attention: DashboardTask[];
  lastWriteAt: number | null;
}

export interface TaskDetail {
  id: string;
  project: string;
  title: string;
  status: TaskStatus;
  lastActiveAt: number;
  legs: TaskLegDetail[];
  manual: boolean;
  manualName: boolean;
  manualChain: boolean;
  summary: string | null;
}

export interface ResumePreview {
  sessionId: string;
  text: string;
}

export interface SessionSummary {
  id: string;
  tool: ToolId;
  title: string | null;
  project: string;
  status: TaskStatus;
  startedAt: string | null;
  lastActiveAt: number;
  messageCount: number;
  snippets: Array<{ ordinal: number; snippet: string }>;
  summary: string | null;
}

export interface MessagePart {
  kind: string;
  text: string | null;
  json: string | null;
  toolName: string | null;
  toolCategory: string | null;
  toolCallId: string | null;
  status: string | null;
  truncated: boolean;
}

export interface MessageDto {
  ordinal: number;
  role: "user" | "assistant" | "tool" | "system";
  createdAt: string | null;
  isCompactBoundary: boolean;
  parts: MessagePart[];
}

export interface SessionMessagesResponse {
  session: SessionSummary;
  messages: MessageDto[];
  total: number;
  from: number;
  hasMore: boolean;
}

export interface TrashItem {
  id: string;
  inIndex: boolean;
  title: string | null;
  project: string | null;
  tool: string | null;
  lastActiveAt: number;
  messageCount: number;
}

export interface IntegrationTool {
  id: string;
  name: string;
  installed: boolean;
  canBeSource: boolean;
  encrypted: boolean;
  sessionFileCount: number;
  skillDirs: string[];
  integrated: boolean;
  hooks: boolean;
  startupHint: boolean;
  liveIndex: boolean;
}

export interface IntegrationsResponse {
  dataDir: string;
  version: string;
  tools: IntegrationTool[];
}

export interface ApplyResponse {
  ok: boolean;
  log: string;
  integrations: IntegrationsResponse;
}

export interface TerminalTestResult {
  terminal: string;
  passed: boolean | null;
  detail?: string;
}

export interface SecretFinding {
  sessionId: string;
  ordinal: number | null;
  ruleId: string;
  preview: string;
  sessionTitle: string | null;
}

export interface PrivacyResponse {
  excludedDirs: string[];
  secrets: SecretFinding[];
}

export interface UiSettings {
  embedding: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    apiKeySet: boolean;
  };
  autoIntegrate: boolean;
  summary: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    apiKeySet: boolean;
  };
  tidy: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    apiKeySet: boolean;
  };
}

export interface UiSettingsPatch {
  embedding?: { enabled?: boolean; baseUrl?: string; model?: string; apiKey?: string };
  autoIntegrate?: boolean;
  summary?: { enabled?: boolean; baseUrl?: string; model?: string; apiKey?: string };
  tidy?: { enabled?: boolean; baseUrl?: string; model?: string; apiKey?: string };
}

export interface SummaryStatus {
  enabled: boolean;
  configured: boolean;
  model: string;
  host: string | null;
  summarizedSessions: number;
  pendingSessions: number;
  staleSessions: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface EmbeddingStatus {
  enabled: boolean;
  configured: boolean;
  model: string;
  host: string | null;
  embeddedSessions: number;
  embeddedChunks: number;
  staleChunks: number;
  pendingSessions: number;
  lastError: string | null;
  lastErrorAt: string | null;
  rulesOutdated: boolean;
  estimate: { chars: number; chunks: number; tokens: number; usd: number } | null;
}

export interface TidySourceStatus {
  path: string;
  tool: string;
  items: number;
  fingerprint: string;
  importedAt: string;
}

export interface TidyConflict {
  topic: string;
  options: string[];
  question: string;
}

export interface TidyPlan {
  status: "ready" | "conflict" | "applied" | "error";
  content: string;
  conflicts: TidyConflict[];
  inputs: Record<string, string>;
  model: string | null;
  host: string | null;
  updatedAt: string;
}

export interface TidyExport {
  path: string;
  tool: string;
  kind: "block" | "own-file" | "index";
  blockHash: string;
  writtenAt: string;
  backupPath: string | null;
  created: boolean;
}

export interface TidyStatus {
  enabled: boolean;
  configured: boolean;
  model: string;
  host: string | null;
  items: number;
  sources: TidySourceStatus[];
  plan: TidyPlan | null;
  exports: TidyExport[];
  lastRunAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  running: boolean;
}

const TOOL_LABELS: Record<string, string> = {
  qoder: "Qoder",
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  "qoder-ide": "Qoder IDE",
  trae: "Trae",
  "trae-cn": "Trae CN",
  codebuddy: "CodeBuddy",
  workbuddy: "WorkBuddy",
  zcode: "ZCode",
  opencode: "OpenCode",
  hermes: "Hermes",
  dsh: "DeepSeek Harness",
};

export function toolLabel(id: ToolId): string {
  return TOOL_LABELS[id] ?? id;
}
