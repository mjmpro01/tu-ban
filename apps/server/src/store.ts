import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentInfo, Approval, Snapshot, Task } from "@tu-ban/shared";
import { MODE } from "./config.ts";

const MAX_EVENTS = 500;

type Listener = {
  agent(a: AgentInfo): void;
  task(t: Task): void;
  event(e: AgentEvent): void;
  approval(a: Approval): void;
};

/** In-memory state of the office. Swap for SQLite/Postgres later — the API stays the same. */
export class Store {
  agents = new Map<string, AgentInfo>();
  tasks = new Map<string, Task>();
  events: AgentEvent[] = [];
  approvals = new Map<string, Approval>();
  private listeners: Listener[] = [];

  subscribe(l: Listener) {
    this.listeners.push(l);
  }

  snapshot(): Snapshot {
    return {
      mode: MODE,
      agents: [...this.agents.values()],
      tasks: [...this.tasks.values()].slice(-100),
      events: this.events.slice(-200),
      approvals: [...this.approvals.values()].filter((a) => a.status === "pending"),
    };
  }

  setAgent(a: AgentInfo) {
    this.agents.set(a.id, a);
    this.listeners.forEach((l) => l.agent(a));
  }

  patchAgent(id: string, patch: Partial<AgentInfo>) {
    const a = this.agents.get(id);
    if (a) this.setAgent({ ...a, ...patch });
  }

  setTask(t: Task) {
    this.tasks.set(t.id, t);
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
    this.listeners.forEach((l) => l.event(ev));
    return ev;
  }

  setApproval(a: Approval) {
    this.approvals.set(a.id, a);
    this.listeners.forEach((l) => l.approval(a));
  }
}
