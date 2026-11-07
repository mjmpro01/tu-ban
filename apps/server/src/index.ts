import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { type ClientToServer, type ServerToClient, type TaskQuery, matchesTaskQuery } from "@tu-ban/shared";
import Fastify from "fastify";
import { Server } from "socket.io";
import { DATABASE_URL, MODE, PORT, ROOT, WORKDIR } from "./config.ts";
import { PgPersistence } from "./db.ts";
import { Orchestrator } from "./orchestrator.ts";
import { Store } from "./store.ts";

const app = Fastify({ logger: false });
const db = DATABASE_URL ? await PgPersistence.connect(DATABASE_URL) : undefined;
if (!db) console.warn("DATABASE_URL chưa đặt: dữ liệu chỉ nằm trong bộ nhớ và sẽ mất khi tắt server.");
const store = new Store(db);
const orchestrator = new Orchestrator(store);
await orchestrator.init();

app.get("/api/state", async () => store.snapshot());
app.post<{ Body: { prompt: string; agentId?: string } }>("/api/tasks", async (req, reply) => {
  try {
    return orchestrator.createTask(req.body);
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

app.post<{ Params: { id: string }; Body: { approve?: boolean } }>("/api/approvals/:id", async (req) => {
  orchestrator.decide(req.params.id, req.body?.approve === true);
  return { ok: true };
});
app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (req) => {
  orchestrator.cancel(req.params.id);
  return { ok: true };
});

// Task history beyond what the dashboard keeps in memory (needs the database).
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

await app.ready();
const io = new Server<ClientToServer, ServerToClient>(app.server, { cors: { origin: true } });

store.subscribe({
  agent: (a) => io.emit("agent", a),
  task: (t) => io.emit("task", t),
  event: (e) => io.emit("event", e),
  approval: (a) => io.emit("approval", a),
});

io.on("connection", (socket) => {
  socket.emit("snapshot", store.snapshot());
  socket.on("task:create", (input, ack) => {
    try {
      const task = orchestrator.createTask(input);
      ack?.({ ok: true, taskId: task.id });
    } catch (e) {
      ack?.({ ok: false, error: (e as Error).message });
    }
  });
  socket.on("task:cancel", (id) => orchestrator.cancel(id));
  socket.on("approval:decide", ({ id, approve }) => orchestrator.decide(id, approve));
});

await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`AI office server on http://localhost:${PORT} (mode: ${MODE}, workdir: ${WORKDIR})`);

const shutdown = async () => {
  io.close();
  await app.close();
  await db?.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
