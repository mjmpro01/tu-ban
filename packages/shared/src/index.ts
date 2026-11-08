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

export type TaskSource = "web" | "schedule" | "telegram" | "slack" | "github";

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
  /** Where the request came from (unset = the dashboard). */
  source?: TaskSource;
  /** For schedules: the schedule id. For chats: the chat the answer goes back to. */
  sourceRef?: string;
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
  | "memory"
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
  /** Two-way Telegram (requests and approvals from the chat). */
  telegramBot?: { enabled: boolean; ok: boolean; username?: string; lastError?: string; allowedChats: number; adminChats: number };
  /** Two-way Slack (Socket Mode). */
  slackBot?: { enabled: boolean; ok: boolean; lastError?: string; allowedChannels: number };
}

// ---------------------------------------------------------------- shared memory
/**
 * office: everyone shares it. agent: one agent's own notes. request: notes for one user request
 * (the Manager's task and everything it delegated), so team members can pass context to each other.
 */
export type MemoryScope = "office" | "agent" | "request";
export const MEMORY_SCOPES: MemoryScope[] = ["office", "agent", "request"];

export interface MemoryItem {
  id: string;
  text: string;
  scope: MemoryScope;
  /** For agent memories: whose they are. Otherwise the agent that saved it, if any. */
  agentId?: string;
  /** For request memories: the root task id. */
  runId?: string;
  /** Who added it: an agent id, a person's name, or "auto" for automatic saves. */
  createdBy?: string;
  taskId?: string;
  createdAt?: number;
  updatedAt?: number;
  /** Relevance (0..1) in search results. */
  score?: number;
}

export interface MemorySettings {
  /** Put the most relevant memories into every task's prompt. */
  autoRecall: boolean;
  /** Save what finished user requests produced into the office memory. */
  autoSave: boolean;
  /** How many memories auto-recall adds at most. */
  recallLimit: number;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = { autoRecall: true, autoSave: true, recallLimit: 5 };

export interface MemoryStatus {
  /** mem0: a Mem0 server (vector search). local: keyword search in this server's database. */
  backend: "mem0" | "local";
  ok: boolean;
  lastError?: string;
  settings: MemorySettings;
  /** Models Mem0 uses (through 9router or the embedding server), for display. */
  llmModel?: string;
  embedModel?: string;
}

export interface MemoryQuery {
  q?: string;
  scope?: MemoryScope;
  agentId?: string;
  runId?: string;
  limit?: number;
}

// ---------------------------------------------------------------- schedules
/** A request that runs again and again (cron in the server's time zone). */
export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  /** Unset = the Manager (who can delegate to the team). */
  agentId?: string;
  /** Five fields: minute hour day-of-month month day-of-week. */
  cron: string;
  enabled: boolean;
  createdBy?: string;
  createdById?: string;
  createdAt: number;
  updatedAt: number;
  nextRunAt?: number;
  lastRunAt?: number;
  lastTaskId?: string;
  /** Why the last run did not start (previous run still busy, budget, agent off…). */
  lastSkip?: string;
}

export interface ScheduleInput {
  name?: string;
  prompt?: string;
  agentId?: string | null;
  cron?: string;
  enabled?: boolean;
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

// ---------------------------------------------------------------- cron
export interface CronFields {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  /** 0 = Sunday. */
  dow: number[];
  domAny: boolean;
  dowAny: boolean;
}

const CRON_ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

/** Parse a five-field cron expression ("*", lists, ranges and steps). Throws a readable error. */
export function parseCron(expr: string): CronFields {
  const text = CRON_ALIASES[expr.trim()] ?? expr.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new Error("Lịch cần đúng 5 phần: phút giờ ngày tháng thứ");
  const limits: [string, number, number][] = [
    ["phút", 0, 59],
    ["giờ", 0, 23],
    ["ngày", 1, 31],
    ["tháng", 1, 12],
    ["thứ", 0, 7],
  ];
  const sets = parts.map((part, i) => {
    const [label, lo, hi] = limits[i];
    const out = new Set<number>();
    for (const item of part.split(",")) {
      const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
      if (!m) throw new Error(`Phần ${label} không hợp lệ: "${item}"`);
      const step = m[2] ? Number(m[2]) : 1;
      if (step < 1) throw new Error(`Bước nhảy của ${label} phải lớn hơn 0`);
      let from = lo;
      let to = hi;
      if (m[1] !== "*") {
        const [a, b] = m[1].split("-").map(Number);
        from = a;
        to = b ?? (m[2] ? hi : a);
      }
      if (from < lo || to > hi || from > to) throw new Error(`${label} phải trong khoảng ${lo}–${hi}`);
      for (let v = from; v <= to; v += step) out.add(i === 4 && v === 7 ? 0 : v);
    }
    return [...out].sort((a, b) => a - b);
  });
  return {
    minute: sets[0],
    hour: sets[1],
    dom: sets[2],
    month: sets[3],
    dow: sets[4],
    domAny: parts[2] === "*",
    dowAny: parts[4] === "*",
  };
}

const DOW_NAME = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/** A short Vietnamese description of a cron expression ("Thứ 2–6 lúc 08:00"). */
export function describeCron(expr: string): string {
  let c: CronFields;
  try {
    c = parseCron(expr);
  } catch {
    return expr;
  }
  const everyMinute = c.minute.length === 60;
  const everyHour = c.hour.length === 24;
  let time: string;
  if (everyMinute && everyHour) time = "mỗi phút";
  else if (everyHour && c.minute.length > 1 && c.minute[0] === 0 && 60 % c.minute[1] === 0 && c.minute.length === 60 / c.minute[1])
    time = `mỗi ${c.minute[1]} phút`;
  else if (everyHour && c.minute.length === 1) time = `mỗi giờ vào phút ${c.minute[0]}`;
  else if (c.minute.length === 1 && c.hour.length <= 4) time = `lúc ${c.hour.map((h) => `${pad2(h)}:${pad2(c.minute[0])}`).join(", ")}`;
  else return expr;
  let days = "";
  if (!c.dowAny && c.domAny) {
    const d = c.dow.join(",");
    days = d === "1,2,3,4,5" ? "Thứ 2–6" : d === "0,6" ? "Cuối tuần" : c.dow.map((x) => DOW_NAME[x]).join(", ");
  } else if (!c.domAny && c.dowAny) days = `Ngày ${c.dom.join(", ")} hằng tháng`;
  else if (!c.domAny || !c.dowAny) return expr;
  if (c.month.length !== 12) return expr;
  const text = days ? `${days} ${time}` : time.startsWith("mỗi") ? time : `Mỗi ngày ${time}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
