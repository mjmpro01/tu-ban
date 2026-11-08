import type { AgentEvent, AgentInfo, MemoryItem, MemoryScope, Task, ToolMode, Usage } from "@tu-ban/shared";
import type { AgentConfig } from "../agents.ts";

export type EmitInput = Omit<AgentEvent, "id" | "ts" | "agentId" | "taskId">;

export interface TeamMember {
  id: string;
  name: string;
  role: string;
  busy: boolean;
}

export interface SubtaskOutcome {
  taskId: string;
  agentId: string;
  status: "done" | "error" | "cancelled";
  result?: string;
  error?: string;
}

/**
 * Coordination API given to the Manager when it works on a user request.
 * Sub-tasks run on the other agents' queues like any task (with approvals, usage...).
 */
export interface TeamApi {
  members(): TeamMember[];
  /** Hand work to another agent. Returns the new task id at once (the work runs in the background). */
  delegate(agentId: string, instructions: string, contextTaskIds?: string[]): string;
  /** Wait until all the given sub-tasks finish. */
  waitFor(taskIds: string[]): Promise<SubtaskOutcome[]>;
  /** Ask a reviewer to check a finished sub-task. */
  review(taskId: string, focus?: string): Promise<{ approved: boolean; feedback: string; reviewTaskId: string }>;
}

/** The shared memory, already bound to this agent and the request it works on. */
export interface MemoryApi {
  /** scope "all" = the office memory, this agent's own notes and this request's notes. */
  search(query: string, scope?: MemoryScope | "all", limit?: number): Promise<MemoryItem[]>;
  save(text: string, scope: MemoryScope): Promise<MemoryItem[]>;
}

export interface RunContext {
  task: Task;
  agent: AgentInfo;
  config: AgentConfig;
  workdir: string;
  signal: AbortSignal;
  /** Report progress; drives the dashboard timeline and the character in the office. */
  emit(event: EmitInput): void;
  /** Present only when the Manager works on a request from the user. */
  team?: TeamApi;
  /** What this agent may do with a tool (from its tool permissions; unknown tools are "ask"). */
  toolMode(tool: string): ToolMode;
  /** Spending / turn ceilings for this run (already reduced to what is left of the daily budget). */
  limits: { maxBudgetUsd: number; maxTurns: number };
  /** Skills from the library this agent may use (only ones that still exist). */
  skills: string[];
  /** Shared memory tools. */
  memory?: MemoryApi;
  /** Memories recalled for this task, to add to the agent's instructions. */
  memoryContext?: string;
  /** Ask the human to approve a risky action. Resolves true when approved. */
  requestApproval(tool: string, summary: string, input: unknown): Promise<boolean>;
}

export interface RunResult {
  result: string;
  usage?: Usage;
}

export interface AgentProvider {
  id: string;
  /** Whether this provider can run here (CLI installed, credentials present...). */
  available(): Promise<{ ok: boolean; reason?: string }>;
  run(ctx: RunContext): Promise<RunResult>;
}

/** One-line summary of a tool input for speech bubbles and the timeline. */
export function summarizeToolInput(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => keys.map((k) => i[k]).find((v) => typeof v === "string") as string | undefined;
  const value =
    pick("query", "url", "pattern", "command", "file_path", "path", "description", "prompt") ??
    JSON.stringify(input ?? "").slice(0, 80);
  return `${tool}: ${clip(value, 70)}`;
}

export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("cancelled"));
      },
      { once: true },
    );
  });
