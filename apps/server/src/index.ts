import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import type { ClientToServer, ServerToClient } from "@tu-ban/shared";
import Fastify from "fastify";
import { Server } from "socket.io";
import { MODE, PORT, ROOT, WORKDIR } from "./config.ts";
import { Orchestrator } from "./orchestrator.ts";
import { Store } from "./store.ts";

const app = Fastify({ logger: false });
const store = new Store();
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
