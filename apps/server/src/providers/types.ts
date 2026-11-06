import type { AgentEvent, AgentInfo, Task, Usage } from "@tu-ban/shared";
import type { AgentConfig } from "../agents.ts";

export type EmitInput = Omit<AgentEvent, "id" | "ts" | "agentId" | "taskId">;

export interface RunContext {
  task: Task;
  agent: AgentInfo;
  config: AgentConfig;
  workdir: string;
  signal: AbortSignal;
  /** Report progress; drives the dashboard timeline and the character in the office. */
  emit(event: EmitInput): void;
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
