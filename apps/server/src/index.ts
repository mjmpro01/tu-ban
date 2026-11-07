import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import {
  type AgentSettings,
  CSRF_HEADER,
  type ClientToServer,
  type MeResponse,
  type ServerToClient,
  type TaskQuery,
  type UserInfo,
  matchesTaskQuery,
} from "@tu-ban/shared";
import Fastify, { type FastifyReply } from "fastify";
import { Server } from "socket.io";
import { AuthError, AuthService, MemoryAuthRepo, SESSION_COOKIE, SESSION_TTL_MS } from "./auth.ts";
import { ADMIN_PASSWORD, ADMIN_USERNAME, COOKIE_SECURE, DATABASE_URL, MODE, PORT, ROOT, WORKDIR } from "./config.ts";
import { PgPersistence } from "./db.ts";
import { type Actor, Orchestrator } from "./orchestrator.ts";
import { deleteSkill, getSkill, listSkills, saveSkill, skillExists } from "./skills.ts";
import { Store } from "./store.ts";

declare module "fastify" {
  interface FastifyRequest {
    user?: UserInfo;
    sessionId?: string;
  }
}

interface SocketData {
  user: UserInfo;
  sessionId: string;
}

const app = Fastify({ logger: false, trustProxy: true });
const db = DATABASE_URL ? await PgPersistence.connect(DATABASE_URL) : undefined;
if (!db) console.warn("DATABASE_URL chưa đặt: dữ liệu chỉ nằm trong bộ nhớ và sẽ mất khi tắt server.");
const store = new Store(db);
const orchestrator = new Orchestrator(store);
await orchestrator.init();

// ---------------------------------------------------------------- auth
let io: Server<ClientToServer, ServerToClient, Record<string, never>, SocketData> | undefined;
/** End the live connections of a user whose access changed. */
const disconnectUser = (userId: string) => {
  for (const s of io?.sockets.sockets.values() ?? []) if (s.data.user?.id === userId) s.disconnect(true);
};
const auth = new AuthService(db ?? new MemoryAuthRepo(), disconnectUser);
await auth.bootstrap(ADMIN_USERNAME, ADMIN_PASSWORD);
if (await auth.needsSetup())
  console.warn("Chưa có tài khoản nào: người mở dashboard đầu tiên sẽ tạo admin. Đặt ADMIN_USERNAME / ADMIN_PASSWORD nếu server mở ra mạng.");

await app.register(fastifyCookie);

const actorOf = (u: UserInfo): Actor => ({ id: u.id, name: u.displayName });

/** Routes anyone may call (the login screen). */
const PUBLIC_ROUTES = new Set(["GET /api/auth/me", "POST /api/auth/login", "POST /api/auth/setup", "POST /api/auth/logout"]);

/** Routes for admins only: configuration, people, and the approval gate. */
function adminOnly(method: string, path: string) {
  return (
    /^\/api\/(agents|skills|users)(\/|$)/.test(path) ||
    path.startsWith("/api/settings") ||
    (method === "POST" && path.startsWith("/api/approvals/"))
  );
}

app.addHook("onRequest", async (req, reply) => {
  if (!req.url.startsWith("/api/")) return;
  const path = req.url.split("?")[0];
  // A custom header cannot be added by a cross-site form or image, so it blocks CSRF on state-changing calls.
  if (req.method !== "GET" && req.method !== "HEAD" && req.headers[CSRF_HEADER] !== "1")
    return reply.code(403).send({ error: "Thiếu header bảo vệ CSRF" });
  req.sessionId = req.cookies[SESSION_COOKIE];
  req.user = await auth.userForSession(req.sessionId);
  if (PUBLIC_ROUTES.has(`${req.method} ${path}`)) return;
  if (!req.user) return reply.code(401).send({ error: "Cần đăng nhập" });
  if (adminOnly(req.method, path) && req.user.role !== "admin") return reply.code(403).send({ error: "Chỉ admin được làm việc này" });
});

app.setErrorHandler((err, _req, reply) => {
  const e = err as Error & { statusCode?: number };
  const status = e instanceof AuthError ? e.status : (e.statusCode ?? 400);
  reply.code(status).send({ error: e.message });
});

const setSession = (reply: FastifyReply, sessionId: string) =>
  reply.setCookie(SESSION_COOKIE, sessionId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: COOKIE_SECURE,
    maxAge: SESSION_TTL_MS / 1000,
  });

app.get("/api/auth/me", async (req): Promise<MeResponse> => ({ user: req.user ?? null, needsSetup: await auth.needsSetup() }));
app.post<{ Body: { username?: string; password?: string; displayName?: string } }>("/api/auth/setup", async (req, reply) => {
  const { user, sessionId } = await auth.setup(req.body ?? {});
  setSession(reply, sessionId);
  return { user };
});
app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", async (req, reply) => {
  const { user, sessionId } = await auth.login(req.body?.username, req.body?.password, req.ip);
  setSession(reply, sessionId);
  return { user };
});
app.post("/api/auth/logout", async (req, reply) => {
  await auth.logout(req.sessionId);
  for (const s of io?.sockets.sockets.values() ?? []) if (s.data.sessionId === req.sessionId) s.disconnect(true);
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
  return { ok: true };
});
app.post<{ Body: { current?: string; next?: string } }>("/api/auth/password", async (req, reply) => {
  const sessionId = await auth.changePassword(req.user!.id, req.body?.current, req.body?.next, req.sessionId);
  setSession(reply, sessionId);
  return { ok: true };
});

// people (admin)
app.get("/api/users", async () => auth.listUsers());
app.post<{ Body: Record<string, unknown> }>("/api/users", async (req) => auth.createUser(req.body ?? {}));
app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/users/:id", async (req) =>
  auth.updateUser(req.params.id, req.body ?? {}, req.user!.id),
);
app.delete<{ Params: { id: string } }>("/api/users/:id", async (req) => {
  await auth.deleteUser(req.params.id, req.user!.id);
  return { ok: true };
});

// ---------------------------------------------------------------- office
app.get("/api/state", async () => store.snapshot());
app.post<{ Body: { prompt: string; agentId?: string } }>("/api/tasks", async (req) =>
  orchestrator.createTask(req.body, actorOf(req.user!)),
);
app.post<{ Params: { id: string }; Body: { approve?: boolean } }>("/api/approvals/:id", async (req) => {
  orchestrator.decide(req.params.id, req.body?.approve === true, actorOf(req.user!));
  return { ok: true };
});

/** Members may cancel only the requests they created; admins any task. */
function mayCancel(user: UserInfo, taskId: string) {
  if (user.role === "admin") return true;
  let t = store.tasks.get(taskId);
  while (t?.parentId) t = store.tasks.get(t.parentId);
  return !!t && t.createdById === user.id;
}
app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (req, reply) => {
  if (!mayCancel(req.user!, req.params.id)) return reply.code(403).send({ error: "Bạn chỉ huỷ được task do mình tạo" });
  orchestrator.cancel(req.params.id, actorOf(req.user!));
  return { ok: true };
});

// agent settings (admin)
app.get("/api/agents/settings", async () => orchestrator.agentConfigs());
app.put<{ Params: { id: string }; Body: Partial<AgentSettings> }>("/api/agents/:id/settings", async (req) =>
  orchestrator.updateAgentSettings(req.params.id, req.body ?? {}, actorOf(req.user!)),
);
app.post<{ Params: { id: string } }>("/api/agents/:id/settings/reset", async (req) =>
  orchestrator.resetAgentSettings(req.params.id, actorOf(req.user!)),
);

// skill library (admin)
const usedBy = (name: string) => orchestrator.skillUsers(name);
app.get("/api/skills", async () => listSkills(usedBy));
app.get<{ Params: { name: string } }>("/api/skills/:name", async (req, reply) => {
  return (await getSkill(req.params.name, usedBy)) ?? reply.code(404).send({ error: "Không có skill này" });
});
app.put<{ Params: { name: string }; Body: { description?: string; body?: string; create?: boolean } }>(
  "/api/skills/:name",
  async (req) => {
    if (req.body?.create && (await skillExists(req.params.name))) throw new Error("Đã có skill trùng tên");
    await saveSkill(req.params.name, req.body ?? {});
    return getSkill(req.params.name, usedBy);
  },
);
app.delete<{ Params: { name: string } }>("/api/skills/:name", async (req) => {
  await deleteSkill(req.params.name);
  await orchestrator.forgetSkill(req.params.name, actorOf(req.user!));
  return { ok: true };
});

// task history
app.get<{ Querystring: Record<string, string | undefined> }>("/api/tasks", async (req) => {
  const q = req.query;
  const query: TaskQuery & { limit: number } = {
    limit: Math.max(1, Math.min(Number(q.limit ?? 50) || 50, 200)),
    before: q.before ? Number(q.before) : undefined,
    agentId: q.agentId || undefined,
    status: (q.status || undefined) as TaskQuery["status"],
    q: q.q?.trim() || undefined,
    parentId: q.parentId || undefined,
    rootsOnly: q.rootsOnly === "1" || q.rootsOnly === "true",
  };
  if (!db)
    return [...store.tasks.values()]
      .filter((t) => matchesTaskQuery(t, query))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, query.limit);
  return db.listTasks(query);
});
app.get<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
  const t = store.tasks.get(req.params.id) ?? (await db?.getTask(req.params.id));
  return t ?? reply.code(404).send({ error: "not found" });
});
app.get<{ Params: { id: string } }>("/api/tasks/:id/events", async (req) => {
  if (!db) return store.events.filter((e) => e.taskId === req.params.id);
  return db.taskEvents(req.params.id);
});

// Serve the built web app (npm run build) so one process is enough in production.
const webDist = resolve(ROOT, "apps/web/dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith("/api") ? reply.code(404).send({ error: "not found" }) : reply.sendFile("index.html"),
  );
}

// ---------------------------------------------------------------- live updates
await app.ready();
// No CORS: the dashboard is served from the same origin (directly, or through the Vite proxy in dev).
io = new Server(app.server);

io.use(async (socket, next) => {
  const { origin, host } = socket.handshake.headers;
  // refuse cross-site WebSocket connections that would ride on the session cookie
  if (origin && new URL(origin).host !== host) return next(new Error("forbidden"));
  const sessionId = app.parseCookie(socket.handshake.headers.cookie ?? "")[SESSION_COOKIE];
  const user = await auth.userForSession(sessionId);
  if (!user || !sessionId) return next(new Error("unauthorized"));
  socket.data = { user, sessionId };
  next();
});

store.subscribe({
  agent: (a) => io!.emit("agent", a),
  task: (t) => io!.emit("task", t),
  event: (e) => io!.emit("event", e),
  approval: (a) => io!.emit("approval", a),
});

io.on("connection", (socket) => {
  const user = () => socket.data.user;
  socket.emit("snapshot", store.snapshot());
  socket.on("task:create", (input, ack) => {
    try {
      const task = orchestrator.createTask(input, actorOf(user()));
      ack?.({ ok: true, taskId: task.id });
    } catch (e) {
      ack?.({ ok: false, error: (e as Error).message });
    }
  });
  socket.on("task:cancel", (id) => {
    if (mayCancel(user(), id)) orchestrator.cancel(id, actorOf(user()));
  });
  socket.on("approval:decide", ({ id, approve }) => {
    if (user().role === "admin") orchestrator.decide(id, approve, actorOf(user()));
  });
});

await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`AI office server on http://localhost:${PORT} (mode: ${MODE}, workdir: ${WORKDIR})`);

const shutdown = async () => {
  io?.close();
  await app.close();
  await db?.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
