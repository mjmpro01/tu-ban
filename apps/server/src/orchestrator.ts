import { randomUUID } from "node:crypto";
import { type AgentInfo, type CreateTaskInput, type ProviderId, type Task, type Usage, emptyUsage } from "@tu-ban/shared";
import { type AgentConfig, ROSTER, routeTask, toAgentInfo } from "./agents.ts";
import { MODE, WORKDIR } from "./config.ts";
import { claudeProvider } from "./providers/claude.ts";
import { copilotProvider } from "./providers/copilot.ts";
import { cursorProvider } from "./providers/cursor.ts";
import { mockProvider } from "./providers/mock.ts";
import { type AgentProvider, type EmitInput, clip } from "./providers/types.ts";
import type { Store } from "./store.ts";

const PROVIDERS: Record<ProviderId, AgentProvider> = {
  claude: claudeProvider,
  cursor: cursorProvider,
  copilot: copilotProvider,
  mock: mockProvider,
};

const addUsage = (a: Usage, b?: Usage): Usage =>
  b ? { tokensIn: a.tokensIn + b.tokensIn, tokensOut: a.tokensOut + b.tokensOut, costUsd: a.costUsd + b.costUsd } : a;

/** Assigns tasks to agents, runs one task at a time per agent, and turns provider output into state. */
export class Orchestrator {
  private configs = new Map<string, AgentConfig>();
  private queues = new Map<string, string[]>();
  private running = new Map<string, AbortController>();
  private approvalWaiters = new Map<string, (ok: boolean) => void>();
  private idleTimers = new Map<string, NodeJS.Timeout>();

  constructor(private store: Store) {}

  async init() {
    for (const c of ROSTER) {
      this.configs.set(c.id, c);
      this.queues.set(c.id, []);
      let runtime: ProviderId = "mock";
      if (MODE === "live") {
        const check = await PROVIDERS[c.provider].available();
        if (check.ok) runtime = c.provider;
        else console.warn(`[${c.id}] ${c.provider} không dùng được: ${check.reason} → chạy demo`);
      }
      this.store.setAgent(toAgentInfo(c, runtime));
    }
    const saved = await this.store.db?.load();
    if (saved) {
      this.store.hydrate(saved);
      console.log(`[db] đã nạp ${saved.tasks.length} task, ${saved.events.length} event`);
    }
    console.log(`Mode: ${MODE}. Agents: ${[...this.store.agents.values()].map((a) => `${a.id}=${a.runtime}`).join(", ")}`);
  }

  createTask(input: CreateTaskInput): Task {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("Nội dung task trống");
    const agentId = input.agentId && this.configs.has(input.agentId) ? input.agentId : routeTask(prompt);
    const task: Task = {
      id: randomUUID(),
      title: clip(prompt, 60),
      prompt,
      agentId,
      status: "queued",
      createdAt: Date.now(),
      usage: emptyUsage(),
    };
    this.store.setTask(task);

    // When the Manager routes work to someone else, show it as a hand-off in the office.
    if (!input.agentId && agentId !== "manager") {
      this.store.addEvent({
        agentId: "manager",
        taskId: task.id,
        type: "handoff",
        activity: "handoff",
        targetAgentId: agentId,
        summary: `Giao cho ${this.store.agents.get(agentId)?.name}: ${task.title}`,
      });
    }
    this.queues.get(agentId)!.push(task.id);
    this.pump(agentId);
    return task;
  }

  cancel(taskId: string) {
    const task = this.store.tasks.get(taskId);
    if (!task) return;
    if (task.status === "queued") {
      const q = this.queues.get(task.agentId)!;
      q.splice(q.indexOf(taskId), 1);
      this.store.patchTask(taskId, { status: "cancelled", finishedAt: Date.now() });
    } else {
      this.running.get(task.agentId)?.abort();
    }
  }

  decide(approvalId: string, approve: boolean) {
    const a = this.store.approvals.get(approvalId);
    const waiter = this.approvalWaiters.get(approvalId);
    if (!a || a.status !== "pending" || !waiter) return;
    this.approvalWaiters.delete(approvalId);
    this.store.setApproval({ ...a, status: approve ? "approved" : "denied" });
    this.store.addEvent({
      agentId: a.agentId,
      taskId: a.taskId,
      type: "approval_resolved",
      activity: approve ? "code" : "thinking",
      tool: a.tool,
      summary: `${approve ? "Đã duyệt" : "Từ chối"}: ${a.summary}`,
    });
    waiter(approve);
  }

  private pump(agentId: string) {
    if (this.running.has(agentId)) return;
    const next = this.queues.get(agentId)!.shift();
    if (next) void this.runTask(next);
  }

  private agent(id: string): AgentInfo {
    return this.store.agents.get(id)!;
  }

  private async runTask(taskId: string) {
    const task = this.store.tasks.get(taskId)!;
    const config = this.configs.get(task.agentId)!;
    const controller = new AbortController();
    this.running.set(task.agentId, controller);
    clearTimeout(this.idleTimers.get(task.agentId));

    const agent = this.agent(task.agentId);
    const provider = PROVIDERS[agent.runtime];
    this.store.patchTask(taskId, { status: "running", startedAt: Date.now() });
    this.store.patchAgent(agent.id, {
      status: "working",
      activity: "thinking",
      currentTaskId: taskId,
      summary: `Nhận việc: ${task.title}`,
      requests: agent.requests + 1,
    });
    this.store.addEvent({ agentId: agent.id, taskId, type: "task_start", activity: "thinking", summary: `Bắt đầu: ${task.title}` });

    const emit = (e: EmitInput) => {
      this.store.addEvent({ ...e, agentId: agent.id, taskId });
      this.store.patchAgent(agent.id, { activity: e.activity, summary: e.summary });
    };

    const requestApproval = (tool: string, summary: string, input: unknown) =>
      new Promise<boolean>((resolve) => {
        const id = randomUUID();
        this.approvalWaiters.set(id, resolve);
        this.store.setApproval({
          id,
          agentId: agent.id,
          taskId,
          tool,
          summary,
          input: JSON.stringify(input, null, 2).slice(0, 4000),
          status: "pending",
          createdAt: Date.now(),
        });
        this.store.patchTask(taskId, { status: "waiting_approval" });
        this.store.patchAgent(agent.id, { status: "waiting_approval", activity: "approval", summary: `Cần duyệt: ${summary}` });
        this.store.addEvent({ agentId: agent.id, taskId, type: "approval_request", activity: "approval", tool, summary: `Xin duyệt: ${summary}` });
        controller.signal.addEventListener("abort", () => this.decide(id, false), { once: true });
      }).then((ok) => {
        this.store.patchTask(taskId, { status: "running" });
        this.store.patchAgent(agent.id, { status: "working" });
        return ok;
      });

    try {
      const { result, usage } = await provider.run({
        task,
        agent,
        config,
        workdir: WORKDIR,
        signal: controller.signal,
        emit,
        requestApproval,
      });
      const a = this.agent(agent.id);
      this.store.patchTask(taskId, { status: "done", finishedAt: Date.now(), result, usage: usage ?? emptyUsage() });
      this.store.patchAgent(agent.id, { status: "idle", activity: "done", summary: "Xong việc!", usage: addUsage(a.usage, usage) });
      this.store.addEvent({ agentId: agent.id, taskId, type: "done", activity: "done", summary: `Xong: ${task.title}`, detail: result, usage });
    } catch (err) {
      const cancelled = controller.signal.aborted;
      const message = err instanceof Error ? err.message : String(err);
      const usage = (err as { usage?: Usage }).usage;
      const a = this.agent(agent.id);
      this.store.patchTask(taskId, { status: cancelled ? "cancelled" : "error", finishedAt: Date.now(), error: message });
      this.store.patchAgent(agent.id, {
        status: cancelled ? "idle" : "error",
        activity: cancelled ? "idle" : "error",
        summary: cancelled ? "Đã huỷ task" : `Lỗi: ${clip(message, 80)}`,
        usage: addUsage(a.usage, usage),
      });
      this.store.addEvent({
        agentId: agent.id,
        taskId,
        type: "error",
        activity: cancelled ? "idle" : "error",
        summary: cancelled ? `Huỷ: ${task.title}` : `Lỗi: ${clip(message, 100)}`,
        detail: message,
      });
    } finally {
      this.running.delete(agent.id);
      this.store.patchAgent(agent.id, { currentTaskId: undefined });
      // Celebrate / show the error for a moment, then go back to idle.
      this.idleTimers.set(
        agent.id,
        setTimeout(() => {
          if (!this.running.has(agent.id)) this.store.patchAgent(agent.id, { status: "idle", activity: "idle", summary: "Đang rảnh" });
        }, 8000),
      );
      this.pump(agent.id);
    }
  }
}
