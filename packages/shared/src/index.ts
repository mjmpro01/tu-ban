// Types shared by the server and the web client.

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
}

export type TaskStatus = "queued" | "running" | "waiting_approval" | "done" | "error" | "cancelled";

export interface Task {
  id: string;
  title: string;
  prompt: string;
  agentId: string;
  /** Task that delegated this one (Manager hand-off). */
  parentId?: string;
  status: TaskStatus;
  createdAt: number;
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
}

export interface Snapshot {
  mode: "demo" | "live";
  agents: AgentInfo[];
  tasks: Task[];
  events: AgentEvent[];
  approvals: Approval[];
}

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
  if (/(search|fetch|read|grep|glob|ls|find|view|browse)/.test(t)) return "search";
  if (/(bash|shell|terminal|run|exec|edit|write|patch|notebook|commit|git)/.test(t)) return "code";
  if (/(task|agent|delegate)/.test(t)) return "handoff";
  return "code";
}

export const emptyUsage = (): Usage => ({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
