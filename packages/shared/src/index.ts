// Types shared by the server and the web client.

export type Role = "admin" | "member";

export interface UserInfo {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  disabled: boolean;
  createdAt: number;
}

/** GET /api/auth/me. `needsSetup` = no account exists yet: the first visitor creates the admin. */
export interface MeResponse {
  user: UserInfo | null;
  needsSetup: boolean;
}

/** Header every state-changing API request must carry (blocks cross-site form posts). */
export const CSRF_HEADER = "x-tuban";

export type ProviderId = "claude" | "cursor" | "copilot" | "mock";
export type CharacterId = "manager" | "researcher" | "writer" | "cursor" | "copilot";

/** What the agent is visibly doing — drives the animation, emote and where it walks. */
export type Activity =
  | "idle"
  | "thinking"
  | "search"
  | "code"
  | "write"
  | "handoff"
  | "approval"
  | "remote"
  | "error"
  | "done";

export type AgentStatus = "idle" | "working" | "waiting_approval" | "error";

export interface Usage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  role: string;
  provider: ProviderId;
  /** Provider actually used for runs (falls back to "mock" in demo mode). */
  runtime: ProviderId;
  model?: string;
  character: CharacterId;
  /** Index of the desk the agent owns in the office map. */
  desk: number;
  status: AgentStatus;
  activity: Activity;
  /** Short line shown in the speech bubble and on the dashboard card. */
  summary: string;
  currentTaskId?: string;
  usage: Usage;
  /** Number of runs (Cursor / Copilot bill per request, not per token). */
  requests: number;
  /** A disabled agent takes no new work and is hidden from the office. */
  enabled: boolean;
}

/** Claude models offered in the agent settings (any other model id can be typed in). */
export const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
] as const;

/** How an agent may use a group of tools: not at all, after the human approves, or on its own. */
export type ToolMode = "off" | "ask" | "auto";

/** Built-in Claude Agent SDK tools, grouped the way they are shown in the agent settings. */
export const TOOL_GROUPS = [
  { id: "read", label: "Đọc file", description: "Đọc và tìm trong file của thư mục làm việc", tools: ["Read", "Glob", "Grep", "LS", "NotebookRead"] },
  { id: "web", label: "Tìm trên web", description: "Tìm kiếm và đọc trang web", tools: ["WebSearch", "WebFetch"] },
  { id: "write", label: "Ghi / sửa file", description: "Tạo, ghi đè và sửa file", tools: ["Write", "Edit", "MultiEdit", "NotebookEdit"] },
  { id: "shell", label: "Chạy lệnh", description: "Chạy lệnh terminal (cài đặt, test, git…)", tools: ["Bash", "BashOutput", "KillShell", "KillBash"] },
] as const;

export type ToolGroupId = (typeof TOOL_GROUPS)[number]["id"];
export type ToolPolicy = Record<ToolGroupId, ToolMode>;

export const DEFAULT_TOOL_POLICY: ToolPolicy = { read: "auto", web: "auto", write: "ask", shell: "ask" };

/** Which settings group a tool belongs to (undefined = not configurable, e.g. internal or team tools). */
export function toolGroupOf(tool: string): ToolGroupId | undefined {
  return TOOL_GROUPS.find((g) => (g.tools as readonly string[]).includes(tool))?.id;
}

/** A skill in the shared library (workspace/.claude/skills/<name>/SKILL.md). */
export interface SkillSummary {
  name: string;
  description: string;
  /** Other files in the skill folder (scripts, templates…), relative paths. */
  files: string[];
  /** Agents that have this skill enabled. */
  usedBy: string[];
}

export interface SkillDetail extends SkillSummary {
  /** SKILL.md content after the front matter. */
  body: string;
}

export const SKILL_NAME_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";

/** The editable part of an agent's configuration. */
export interface AgentSettings {
  name: string;
  role: string;
  provider: Exclude<ProviderId, "mock">;
  /** Claude model id (only used by the claude provider). */
  model: string;
  systemPrompt: string;
  enabled: boolean;
  /** Skills from the shared library this agent may use (Claude agents only). */
  skills: string[];
  /** Tool permissions per group (Claude agents only). */
  tools: ToolPolicy;
}

/** Settings are compared by value (they hold arrays and objects). */
export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface AgentConfigView extends AgentSettings {
  id: string;
  character: CharacterId;
  desk: number;
  /** Values shipped with the app, for "reset to default". */
  defaults: AgentSettings;
  /** true when nothing differs from the defaults. */
  isDefault: boolean;
  /** Text the server adds after the prompt at run time (the Manager's team list and limits). */
  generatedPrompt?: string;
  /** The agent cannot be disabled (the Manager receives every request). */
  required: boolean;
  /** Why the chosen provider runs on the demo script instead (live mode only). */
  runtimeNote?: string;
}

/** "review" = a check of another task's result, created by the Manager. */
export type TaskKind = "task" | "review";

export type TaskStatus = "queued" | "running" | "waiting_approval" | "done" | "error" | "cancelled";

export interface Task {
  id: string;
  title: string;
  prompt: string;
  agentId: string;
  /** Task that delegated this one (Manager hand-off). */
  parentId?: string;
  kind: TaskKind;
  status: TaskStatus;
  createdAt: number;
  /** Display name of the user who created the request (sub-tasks inherit it). */
  createdBy?: string;
  /** User id of the creator (lets members cancel their own tasks). */
  createdById?: string;
  /** The finished task this one continues (a hand-off from the overview board). */
  followUpOf?: string;
  startedAt?: number;
  finishedAt?: number;
  result?: string;
  error?: string;
  usage: Usage;
}

export type AgentEventType =
  | "task_start"
  | "thinking"
  | "message"
  | "tool_start"
  | "tool_end"
  | "handoff"
  | "approval_request"
  | "approval_resolved"
  | "meeting"
  | "config"
  | "done"
  | "error";

export interface AgentEvent {
  id: string;
  ts: number;
  agentId: string;
  taskId?: string;
  type: AgentEventType;
  activity: Activity;
  /** One short human-readable line. */
  summary: string;
  tool?: string;
  /** Longer text (tool input/output excerpt, final answer...). */
  detail?: string;
  /** For hand-offs: the agent receiving the work. */
  targetAgentId?: string;
  /** For meetings: the agents taking part. */
  participants?: string[];
  /** The person behind the event (approvals, config changes, cancellations). */
  actor?: string;
  usage?: Usage;
}

export type ApprovalStatus = "pending" | "approved" | "denied";

export interface Approval {
  id: string;
  agentId: string;
  taskId: string;
  tool: string;
  summary: string;
  input: string;
  status: ApprovalStatus;
  createdAt: number;
  decidedBy?: string;
}

/** Spending and teamwork limits, editable by admins in "Thống kê & ngân sách". */
export interface BudgetSettings {
  /** Hard ceiling per task for Claude agents (USD). */
  maxTaskUsd: number;
  /** Ceiling for one user request and everything the Manager delegates for it (USD). */
  maxRequestUsd: number;
  /** Ceiling for all spending in one day (USD). 0 = no daily limit. */
  dailyUsd: number;
  maxSubtasks: number;
  maxReviewRounds: number;
  /** Max agent turns per task. */
  maxTurns: number;
}

export interface DayStats {
  /** YYYY-MM-DD in the server's time zone */
  date: string;
  /** Requests created that day (sub-tasks not counted). */
  requests: number;
  done: number;
  errors: number;
  /** All spending that day, sub-tasks included. */
  costUsd: number;
  tokens: number;
}

export interface AgentStats {
  agentId: string;
  tasks: number;
  done: number;
  errors: number;
  costUsd: number;
  tokens: number;
  /** Average run time of finished tasks, null when none finished. */
  avgDurationMs: number | null;
}

export interface StatsResponse {
  timeZone: string;
  days: DayStats[];
  agents: AgentStats[];
  today: { costUsd: number; requests: number; done: number; errors: number };
  budget: BudgetSettings;
}

/** Which events send a notification (admins switch them on and off). */
export interface NotificationEvents {
  /** An agent waits for approval. */
  approval: boolean;
  /** A request finished. */
  done: boolean;
  /** A request failed. */
  error: boolean;
  /** The daily budget reached 80% / 100%. */
  budget: boolean;
}

export interface NotificationStatus {
  events: NotificationEvents;
  channels: Record<"telegram" | "slack", { configured: boolean; lastError?: string }>;
  publicUrl: string;
  lastSentAt?: number;
}

export interface Snapshot {
  mode: "demo" | "live";
  agents: AgentInfo[];
  tasks: Task[];
  events: AgentEvent[];
  approvals: Approval[];
}

/** Filters for GET /api/tasks (task history). "active" = queued, running or waiting for approval. */
export interface TaskQuery {
  limit?: number;
  /** Cursor: only tasks created before this timestamp (ms). */
  before?: number;
  agentId?: string;
  status?: TaskStatus | "active";
  /** Text search in the title and prompt. */
  q?: string;
  /** Only the sub-tasks of this task. */
  parentId?: string;
  /** Only tasks the user created (no sub-tasks). */
  rootsOnly?: boolean;
}

export const ACTIVE_STATUSES: TaskStatus[] = ["queued", "running", "waiting_approval"];

/** Same filter as the database query, for the in-memory fallback. */
export function matchesTaskQuery(t: Task, f: TaskQuery): boolean {
  if (f.before !== undefined && t.createdAt >= f.before) return false;
  if (f.agentId && t.agentId !== f.agentId) return false;
  if (f.parentId && t.parentId !== f.parentId) return false;
  if (f.rootsOnly && t.parentId) return false;
  if (f.status === "active" ? !ACTIVE_STATUSES.includes(t.status) : f.status && t.status !== f.status) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    if (!t.title.toLowerCase().includes(q) && !t.prompt.toLowerCase().includes(q)) return false;
  }
  return true;
}

/** Who usually takes over after an agent's work (the overview board shows the first enabled one as the suggestion). */
export const NEXT_AGENT_HINTS: Record<string, string[]> = {
  researcher: ["writer", "manager"],
  writer: ["researcher", "manager"],
  cursor: ["researcher", "copilot"],
  copilot: ["researcher", "cursor"],
  manager: ["writer", "researcher"],
};

export interface CreateTaskInput {
  prompt: string;
  /** Omit to let the Manager route the task. */
  agentId?: string;
}

export interface ServerToClient {
  snapshot: (s: Snapshot) => void;
  agent: (a: AgentInfo) => void;
  task: (t: Task) => void;
  event: (e: AgentEvent) => void;
  approval: (a: Approval) => void;
}

export interface ClientToServer {
  "task:create": (input: CreateTaskInput, ack?: (res: { ok: boolean; taskId?: string; error?: string }) => void) => void;
  "task:cancel": (taskId: string) => void;
  "approval:decide": (input: { id: string; approve: boolean }) => void;
}

/** Map a tool name (Claude Agent SDK / Cursor / Copilot) to a visible activity. */
export function toolActivity(tool: string): Activity {
  const t = tool.toLowerCase();
  if (/(search|fetch|read|grep|glob|ls|find|view|browse|skill)/.test(t)) return "search";
  if (/(bash|shell|terminal|run|exec|edit|write|patch|notebook|commit|git)/.test(t)) return "code";
  if (/(task|agent|delegate)/.test(t)) return "handoff";
  return "code";
}

export const emptyUsage = (): Usage => ({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
