import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentInfo, Approval, Snapshot, Task } from "@tu-ban/shared";
import { MODE } from "./config.ts";
import type { LoadedState, Persistence } from "./db.ts";

const MAX_EVENTS = 500;
const MAX_TASKS = 500;

type Listener = {
  agent(a: AgentInfo): void;
  task(t: Task): void;
  event(e: AgentEvent): void;
  approval(a: Approval): void;
};

/**
 * Live state of the office. Recent tasks/events are kept in memory for the dashboard;
 * every change is also written to the database when one is configured.
 */
export class Store {
  agents = new Map<string, AgentInfo>();
  tasks = new Map<string, Task>();
  events: AgentEvent[] = [];
  approvals = new Map<string, Approval>();
  private listeners: Listener[] = [];

  constructor(readonly db?: Persistence) {}

  subscribe(l: Listener) {
    this.listeners.push(l);
  }

  /** Restore state saved by a previous run. Work that was in flight cannot resume, so it is closed. */
  hydrate(saved: LoadedState) {
    for (const [id, stats] of Object.entries(saved.agentStats)) {
      const a = this.agents.get(id);
      if (a) this.agents.set(id, { ...a, usage: stats.usage, requests: stats.requests });
    }
    this.events = saved.events.slice(-MAX_EVENTS);
    for (const t of saved.tasks) this.tasks.set(t.id, t);
    for (const t of saved.tasks) {
      if (t.status === "queued" || t.status === "running" || t.status === "waiting_approval")
        this.patchTask(t.id, { status: "error", error: "Server khởi động lại khi task đang chạy", finishedAt: Date.now() });
    }
    for (const a of saved.approvals) this.setApproval({ ...a, status: "denied" });
  }

  snapshot(): Snapshot {
    return {
      mode: MODE,
      agents: [...this.agents.values()],
      tasks: [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-100),
      events: this.events.slice(-200),
      approvals: [...this.approvals.values()].filter((a) => a.status === "pending"),
    };
  }

  setAgent(a: AgentInfo) {
    const prev = this.agents.get(a.id);
    this.agents.set(a.id, a);
    if (prev && (prev.requests !== a.requests || prev.usage !== a.usage)) this.db?.saveAgentStats(a.id, a.usage, a.requests);
    this.listeners.forEach((l) => l.agent(a));
  }

  patchAgent(id: string, patch: Partial<AgentInfo>) {
    const a = this.agents.get(id);
    if (a) this.setAgent({ ...a, ...patch });
  }

  setTask(t: Task) {
    this.tasks.set(t.id, t);
    if (this.tasks.size > MAX_TASKS) this.tasks.delete(this.tasks.keys().next().value!);
    this.db?.saveTask(t);
    this.listeners.forEach((l) => l.task(t));
  }

  patchTask(id: string, patch: Partial<Task>) {
    const t = this.tasks.get(id);
    if (t) this.setTask({ ...t, ...patch });
  }

  addEvent(e: Omit<AgentEvent, "id" | "ts">): AgentEvent {
    const ev: AgentEvent = { ...e, id: randomUUID(), ts: Date.now() };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.db?.saveEvent(ev);
    this.listeners.forEach((l) => l.event(ev));
    return ev;
  }

  setApproval(a: Approval) {
    if (a.status === "pending") this.approvals.set(a.id, a);
    else this.approvals.delete(a.id);
    this.db?.saveApproval(a);
    this.listeners.forEach((l) => l.approval(a));
  }
}
