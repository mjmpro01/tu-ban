import type {
  AgentEvent,
  AgentInfo,
  Approval,
  ClientToServer,
  CreateTaskInput,
  ServerToClient,
  Snapshot,
  Task,
} from "@tu-ban/shared";
import { useSyncExternalStore } from "react";
import { type Socket, io } from "socket.io-client";

export interface State {
  connected: boolean;
  mode: Snapshot["mode"] | null;
  agents: Record<string, AgentInfo>;
  tasks: Record<string, Task>;
  events: AgentEvent[];
  approvals: Record<string, Approval>;
  selectedAgentId: string | null;
}

const MAX_EVENTS = 300;

let state: State = {
  connected: false,
  mode: null,
  agents: {},
  tasks: {},
  events: [],
  approvals: {},
  selectedAgentId: null,
};

const listeners = new Set<() => void>();
const eventListeners = new Set<(e: AgentEvent) => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export const store = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** Live agent events (used by the game for one-off animations like hand-offs). */
  onEvent(l: (e: AgentEvent) => void) {
    eventListeners.add(l);
    return () => eventListeners.delete(l);
  },
  select(agentId: string | null) {
    set({ selectedAgentId: agentId === state.selectedAgentId ? null : agentId });
  },
};

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(state));
}

// ------------------------------------------------------------------ socket
const socket: Socket<ServerToClient, ClientToServer> = io({ transports: ["websocket"] });

socket.on("connect", () => set({ connected: true }));
socket.on("disconnect", () => set({ connected: false }));
socket.on("snapshot", (s) =>
  set({
    mode: s.mode,
    agents: Object.fromEntries(s.agents.map((a) => [a.id, a])),
    tasks: Object.fromEntries(s.tasks.map((t) => [t.id, t])),
    events: s.events,
    approvals: Object.fromEntries(s.approvals.map((a) => [a.id, a])),
  }),
);
socket.on("agent", (a) => set({ agents: { ...state.agents, [a.id]: a } }));
socket.on("task", (t) => set({ tasks: { ...state.tasks, [t.id]: t } }));
socket.on("event", (e) => {
  const events = [...state.events, e];
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  set({ events });
  eventListeners.forEach((l) => l(e));
});
socket.on("approval", (a) => {
  const approvals = { ...state.approvals };
  if (a.status === "pending") approvals[a.id] = a;
  else delete approvals[a.id];
  set({ approvals });
});

export const actions = {
  createTask: (input: CreateTaskInput) =>
    new Promise<{ ok: boolean; error?: string }>((resolve) => socket.emit("task:create", input, resolve)),
  cancelTask: (id: string) => socket.emit("task:cancel", id),
  decide: (id: string, approve: boolean) => socket.emit("approval:decide", { id, approve }),
};
