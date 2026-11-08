import type {
  AgentEvent,
  AgentInfo,
  Approval,
  ClientToServer,
  CreateTaskInput,
  MeResponse,
  ServerToClient,
  Snapshot,
  Task,
  UserInfo,
} from "@tu-ban/shared";
import { api, setUnauthorizedHandler } from "./api";
import { useSyncExternalStore } from "react";
import { type Socket, io } from "socket.io-client";

export interface State {
  /** null until GET /api/auth/me has answered */
  auth: { user: UserInfo | null; needsSetup: boolean } | null;
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
  auth: null,
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
// Created only once the user is logged in: the server refuses connections without a session.
let socket: Socket<ServerToClient, ClientToServer> | null = null;

function connect() {
  if (socket) return;
  const s: Socket<ServerToClient, ClientToServer> = io({ transports: ["websocket"] });
  socket = s;
  s.on("connect", () => set({ connected: true }));
  s.on("disconnect", (reason) => {
    set({ connected: false });
    // the server ends the connection when the session is revoked: find out whether we are still logged in
    if (reason === "io server disconnect") void auth.refresh();
  });
  s.on("connect_error", (err) => {
    if (err.message === "unauthorized") void auth.refresh();
  });
  s.on("snapshot", (snap) =>
    set({
      mode: snap.mode,
      agents: Object.fromEntries(snap.agents.map((a) => [a.id, a])),
      tasks: Object.fromEntries(snap.tasks.map((t) => [t.id, t])),
      events: snap.events,
      approvals: Object.fromEntries(snap.approvals.map((a) => [a.id, a])),
    }),
  );
  s.on("agent", (a) => set({ agents: { ...state.agents, [a.id]: a } }));
  s.on("task", (t) => set({ tasks: { ...state.tasks, [t.id]: t } }));
  s.on("event", (e) => {
    const events = [...state.events, e];
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    set({ events });
    eventListeners.forEach((l) => l(e));
  });
  s.on("approval", (a) => {
    const approvals = { ...state.approvals };
    if (a.status === "pending") approvals[a.id] = a;
    else delete approvals[a.id];
    set({ approvals });
  });
}

function disconnect() {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  set({ connected: false, agents: {}, tasks: {}, events: [], approvals: {}, selectedAgentId: null });
}

// ------------------------------------------------------------------ auth
export const auth = {
  async refresh() {
    try {
      const me = await api<MeResponse>("GET", "/api/auth/me");
      set({ auth: me });
      if (me.user) connect();
      else disconnect();
    } catch {
      set({ auth: { user: null, needsSetup: false } });
      disconnect();
    }
  },
  async login(username: string, password: string) {
    await api("POST", "/api/auth/login", { username, password });
    await auth.refresh();
  },
  async setup(username: string, password: string, displayName: string) {
    await api("POST", "/api/auth/setup", { username, password, displayName });
    await auth.refresh();
  },
  async logout() {
    await api("POST", "/api/auth/logout").catch(() => {});
    disconnect();
    set({ auth: { user: null, needsSetup: false } });
  },
};
setUnauthorizedHandler(() => void auth.refresh());

export const actions = {
  createTask: (input: CreateTaskInput) =>
    new Promise<{ ok: boolean; error?: string }>((resolve) =>
      socket ? socket.emit("task:create", input, resolve) : resolve({ ok: false, error: "Chưa kết nối" }),
    ),
  cancelTask: (id: string) => socket?.emit("task:cancel", id),
  decide: (id: string, approve: boolean) => socket?.emit("approval:decide", { id, approve }),
};
