import {
  ACTIVE_STATUSES,
  type AgentEvent,
  type AgentSettings,
  type AgentStats,
  type DayStats,
  type Approval,
  type Task,
  type TaskQuery,
  type Usage,
} from "@tu-ban/shared";
import pg from "pg";
import type { AuthRepo, StoredUser } from "./auth.ts";

/** What the store needs from a database. The office runs without one (in-memory only). */
export interface Persistence {
  load(): Promise<LoadedState>;
  saveTask(t: Task): void;
  saveEvent(e: AgentEvent): void;
  saveApproval(a: Approval): void;
  saveAgentStats(agentId: string, usage: Usage, requests: number): void;
  taskEvents(taskId: string): Promise<AgentEvent[]>;
  getTask(id: string): Promise<Task | undefined>;
  /** Settings edited in the dashboard, by agent id (only agents that differ from the defaults). */
  loadAgentSettings(): Promise<Record<string, Partial<AgentSettings>>>;
  saveAgentSettings(agentId: string, settings: Partial<AgentSettings>): Promise<void>;
  deleteAgentSettings(agentId: string): Promise<void>;
  loadSetting<T>(key: string): Promise<T | undefined>;
  saveSetting(key: string, value: unknown): Promise<void>;
  /** Spending since `since` (ms), all tasks. */
  spentSince(since: number): Promise<number>;
  stats(days: number, timeZone: string): Promise<{ days: DayStats[]; agents: AgentStats[] }>;
  listTasks(query: TaskQuery & { limit: number }): Promise<Task[]>;
  /** Wait for queued writes, then close the pool. */
  close(): Promise<void>;
}

export interface LoadedState {
  tasks: Task[];
  events: AgentEvent[];
  approvals: Approval[];
  agentStats: Record<string, { usage: Usage; requests: number }>;
}

const LOAD_TASKS = 200;
const LOAD_EVENTS = 500;

/** Ordered migrations. Never edit one that has shipped — append a new one. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE agent_stats (
    agent_id    text PRIMARY KEY,
    tokens_in   bigint NOT NULL DEFAULT 0,
    tokens_out  bigint NOT NULL DEFAULT 0,
    cost_usd    numeric(12, 6) NOT NULL DEFAULT 0,
    requests    integer NOT NULL DEFAULT 0,
    updated_at  timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE tasks (
    id          uuid PRIMARY KEY,
    title       text NOT NULL,
    prompt      text NOT NULL,
    agent_id    text NOT NULL,
    parent_id   uuid,
    status      text NOT NULL,
    created_at  timestamptz NOT NULL,
    started_at  timestamptz,
    finished_at timestamptz,
    result      text,
    error       text,
    tokens_in   bigint NOT NULL DEFAULT 0,
    tokens_out  bigint NOT NULL DEFAULT 0,
    cost_usd    numeric(12, 6) NOT NULL DEFAULT 0
  );
  CREATE INDEX tasks_created_at_idx ON tasks (created_at DESC);
  CREATE INDEX tasks_agent_idx ON tasks (agent_id, created_at DESC);

  CREATE TABLE events (
    id              uuid PRIMARY KEY,
    ts              timestamptz NOT NULL,
    agent_id        text NOT NULL,
    task_id         uuid,
    type            text NOT NULL,
    activity        text NOT NULL,
    summary         text NOT NULL,
    tool            text,
    detail          text,
    target_agent_id text,
    tokens_in       bigint,
    tokens_out      bigint,
    cost_usd        numeric(12, 6)
  );
  CREATE INDEX events_ts_idx ON events (ts DESC);
  CREATE INDEX events_task_idx ON events (task_id, ts);

  CREATE TABLE approvals (
    id          uuid PRIMARY KEY,
    agent_id    text NOT NULL,
    task_id     uuid NOT NULL,
    tool        text NOT NULL,
    summary     text NOT NULL,
    input       text NOT NULL,
    status      text NOT NULL,
    created_at  timestamptz NOT NULL,
    decided_at  timestamptz
  );
  CREATE INDEX approvals_status_idx ON approvals (status);
  `,
  `
  ALTER TABLE tasks ADD COLUMN kind text NOT NULL DEFAULT 'task';
  CREATE INDEX tasks_parent_idx ON tasks (parent_id, created_at);
  ALTER TABLE events ADD COLUMN participants text[];
  `,
  `
  CREATE TABLE agent_settings (
    agent_id    text PRIMARY KEY,
    settings    jsonb NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
  );
  `,
  `
  CREATE TABLE users (
    id            uuid PRIMARY KEY,
    username      text NOT NULL UNIQUE,
    display_name  text NOT NULL,
    password_hash text NOT NULL,
    role          text NOT NULL,
    disabled      boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE sessions (
    id          text PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL
  );
  CREATE INDEX sessions_user_idx ON sessions (user_id);
  ALTER TABLE tasks ADD COLUMN created_by text;
  ALTER TABLE tasks ADD COLUMN created_by_id uuid;
  ALTER TABLE approvals ADD COLUMN decided_by text;
  ALTER TABLE events ADD COLUMN actor text;
  `,
  `
  CREATE TABLE app_settings (
    key         text PRIMARY KEY,
    value       jsonb NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
  );
  `,
];

const ms = (d: Date | null | undefined) => (d ? d.getTime() : undefined);
const date = (n: number | undefined) => (n === undefined ? null : new Date(n));
const num = (v: string | number | null) => (v === null ? 0 : Number(v));

type Row = Record<string, any>;

const toTask = (r: Row): Task => ({
  id: r.id,
  title: r.title,
  prompt: r.prompt,
  agentId: r.agent_id,
  parentId: r.parent_id ?? undefined,
  kind: r.kind ?? "task",
  createdBy: r.created_by ?? undefined,
  createdById: r.created_by_id ?? undefined,
  status: r.status,
  createdAt: ms(r.created_at)!,
  startedAt: ms(r.started_at),
  finishedAt: ms(r.finished_at),
  result: r.result ?? undefined,
  error: r.error ?? undefined,
  usage: { tokensIn: num(r.tokens_in), tokensOut: num(r.tokens_out), costUsd: num(r.cost_usd) },
});

const toEvent = (r: Row): AgentEvent => ({
  id: r.id,
  ts: ms(r.ts)!,
  agentId: r.agent_id,
  taskId: r.task_id ?? undefined,
  type: r.type,
  activity: r.activity,
  summary: r.summary,
  tool: r.tool ?? undefined,
  detail: r.detail ?? undefined,
  targetAgentId: r.target_agent_id ?? undefined,
  participants: r.participants ?? undefined,
  actor: r.actor ?? undefined,
  usage:
    r.tokens_in === null ? undefined : { tokensIn: num(r.tokens_in), tokensOut: num(r.tokens_out), costUsd: num(r.cost_usd) },
});

const toApproval = (r: Row): Approval => ({
  id: r.id,
  agentId: r.agent_id,
  taskId: r.task_id,
  tool: r.tool,
  summary: r.summary,
  input: r.input,
  status: r.status,
  createdAt: ms(r.created_at)!,
  decidedBy: r.decided_by ?? undefined,
});

const toUser = (r: Row): StoredUser => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  role: r.role,
  disabled: r.disabled,
  createdAt: ms(r.created_at)!,
  passwordHash: r.password_hash,
});

export class PgPersistence implements Persistence, AuthRepo {
  private pool: pg.Pool;
  /** Writes are queued and run one after another so the database sees them in order. */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 5 });
    this.pool.on("error", (e) => console.error("[db] pool error:", e.message));
  }

  static async connect(url: string): Promise<PgPersistence> {
    const db = new PgPersistence(url);
    await db.migrate();
    return db;
  }

  private async migrate() {
    const client = await this.pool.connect();
    try {
      // one server migrates at a time
      await client.query("SELECT pg_advisory_lock(727272)");
      await client.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const { rows } = await client.query("SELECT coalesce(max(version), 0) AS v FROM schema_migrations");
      const current = Number(rows[0].v);
      for (let v = current + 1; v <= MIGRATIONS.length; v++) {
        await client.query("BEGIN");
        try {
          await client.query(MIGRATIONS[v - 1]);
          await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [v]);
          await client.query("COMMIT");
          console.log(`[db] applied migration ${v}`);
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(727272)").catch(() => {});
      client.release();
    }
  }

  private write(sql: string, params: unknown[]) {
    this.queue = this.queue
      .then(() => this.pool.query(sql, params))
      .catch((e: Error) => console.error("[db] write failed:", e.message));
  }

  async load(): Promise<LoadedState> {
    const [tasks, events, approvals, stats] = await Promise.all([
      this.pool.query(`SELECT * FROM (SELECT * FROM tasks ORDER BY created_at DESC LIMIT $1) t ORDER BY created_at`, [LOAD_TASKS]),
      this.pool.query(`SELECT * FROM (SELECT * FROM events ORDER BY ts DESC LIMIT $1) e ORDER BY ts`, [LOAD_EVENTS]),
      this.pool.query(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at`),
      this.pool.query(`SELECT * FROM agent_stats`),
    ]);
    return {
      tasks: tasks.rows.map(toTask),
      events: events.rows.map(toEvent),
      approvals: approvals.rows.map(toApproval),
      agentStats: Object.fromEntries(
        stats.rows.map((r) => [
          r.agent_id,
          { usage: { tokensIn: num(r.tokens_in), tokensOut: num(r.tokens_out), costUsd: num(r.cost_usd) }, requests: r.requests },
        ]),
      ),
    };
  }

  saveTask(t: Task) {
    this.write(
      `INSERT INTO tasks (id, title, prompt, agent_id, parent_id, status, created_at, started_at, finished_at, result, error, tokens_in, tokens_out, cost_usd, kind, created_by, created_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status, started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at,
         result = EXCLUDED.result, error = EXCLUDED.error,
         tokens_in = EXCLUDED.tokens_in, tokens_out = EXCLUDED.tokens_out, cost_usd = EXCLUDED.cost_usd`,
      [
        t.id, t.title, t.prompt, t.agentId, t.parentId ?? null, t.status, date(t.createdAt), date(t.startedAt), date(t.finishedAt),
        t.result ?? null, t.error ?? null, t.usage.tokensIn, t.usage.tokensOut, t.usage.costUsd, t.kind,
        t.createdBy ?? null, t.createdById ?? null,
      ],
    );
  }

  saveEvent(e: AgentEvent) {
    this.write(
      `INSERT INTO events (id, ts, agent_id, task_id, type, activity, summary, tool, detail, target_agent_id, tokens_in, tokens_out, cost_usd, participants, actor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO NOTHING`,
      [
        e.id, date(e.ts), e.agentId, e.taskId ?? null, e.type, e.activity, e.summary, e.tool ?? null, e.detail ?? null,
        e.targetAgentId ?? null, e.usage?.tokensIn ?? null, e.usage?.tokensOut ?? null, e.usage?.costUsd ?? null,
        e.participants ?? null, e.actor ?? null,
      ],
    );
  }

  saveApproval(a: Approval) {
    this.write(
      `INSERT INTO approvals (id, agent_id, task_id, tool, summary, input, status, created_at, decided_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, decided_by = EXCLUDED.decided_by,
         decided_at = CASE WHEN EXCLUDED.status <> 'pending' THEN now() ELSE approvals.decided_at END`,
      [a.id, a.agentId, a.taskId, a.tool, a.summary, a.input, a.status, date(a.createdAt), a.decidedBy ?? null],
    );
  }

  saveAgentStats(agentId: string, usage: Usage, requests: number) {
    this.write(
      `INSERT INTO agent_stats (agent_id, tokens_in, tokens_out, cost_usd, requests, updated_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (agent_id) DO UPDATE SET tokens_in = EXCLUDED.tokens_in, tokens_out = EXCLUDED.tokens_out,
         cost_usd = EXCLUDED.cost_usd, requests = EXCLUDED.requests, updated_at = now()`,
      [agentId, usage.tokensIn, usage.tokensOut, usage.costUsd, requests],
    );
  }

  async taskEvents(taskId: string) {
    await this.queue;
    if (!/^[0-9a-f-]{36}$/i.test(taskId)) return [];
    const { rows } = await this.pool.query(`SELECT * FROM events WHERE task_id = $1 ORDER BY ts`, [taskId]);
    return rows.map(toEvent);
  }

  async loadSetting<T>(key: string) {
    const { rows } = await this.pool.query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
    return rows[0]?.value as T | undefined;
  }

  async saveSetting(key: string, value: unknown) {
    await this.pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  async spentSince(since: number) {
    await this.queue;
    const { rows } = await this.pool.query(`SELECT coalesce(sum(cost_usd), 0) AS c FROM tasks WHERE created_at >= $1`, [date(since)]);
    return num(rows[0].c);
  }

  async stats(days: number, timeZone: string) {
    await this.queue;
    const daily = await this.pool.query(
      `SELECT to_char(date_trunc('day', created_at AT TIME ZONE $2), 'YYYY-MM-DD') AS day,
              count(*) FILTER (WHERE parent_id IS NULL)::int AS requests,
              count(*) FILTER (WHERE parent_id IS NULL AND status = 'done')::int AS done,
              count(*) FILTER (WHERE parent_id IS NULL AND status = 'error')::int AS errors,
              coalesce(sum(cost_usd), 0) AS cost,
              coalesce(sum(tokens_in + tokens_out), 0) AS tokens
         FROM tasks
        WHERE created_at >= (date_trunc('day', now() AT TIME ZONE $2) - make_interval(days => $1 - 1)) AT TIME ZONE $2
        GROUP BY 1`,
      [days, timeZone],
    );
    const perAgent = await this.pool.query(
      `SELECT agent_id,
              count(*)::int AS tasks,
              count(*) FILTER (WHERE status = 'done')::int AS done,
              count(*) FILTER (WHERE status = 'error')::int AS errors,
              coalesce(sum(cost_usd), 0) AS cost,
              coalesce(sum(tokens_in + tokens_out), 0) AS tokens,
              avg(extract(epoch FROM finished_at - started_at) * 1000)
                FILTER (WHERE status = 'done' AND started_at IS NOT NULL AND finished_at IS NOT NULL) AS avg_ms
         FROM tasks
        WHERE created_at >= (date_trunc('day', now() AT TIME ZONE $2) - make_interval(days => $1 - 1)) AT TIME ZONE $2
        GROUP BY agent_id`,
      [days, timeZone],
    );
    return {
      days: daily.rows.map((r) => ({
        date: r.day as string,
        requests: r.requests as number,
        done: r.done as number,
        errors: r.errors as number,
        costUsd: num(r.cost),
        tokens: num(r.tokens),
      })),
      agents: perAgent.rows.map((r) => ({
        agentId: r.agent_id as string,
        tasks: r.tasks as number,
        done: r.done as number,
        errors: r.errors as number,
        costUsd: num(r.cost),
        tokens: num(r.tokens),
        avgDurationMs: r.avg_ms === null ? null : Number(r.avg_ms),
      })),
    };
  }

  async loadAgentSettings() {
    const { rows } = await this.pool.query(`SELECT agent_id, settings FROM agent_settings`);
    return Object.fromEntries(rows.map((r) => [r.agent_id, r.settings as Partial<AgentSettings>]));
  }

  async saveAgentSettings(agentId: string, settings: Partial<AgentSettings>) {
    await this.queue;
    await this.pool.query(
      `INSERT INTO agent_settings (agent_id, settings, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (agent_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()`,
      [agentId, JSON.stringify(settings)],
    );
  }

  async deleteAgentSettings(agentId: string) {
    await this.queue;
    await this.pool.query(`DELETE FROM agent_settings WHERE agent_id = $1`, [agentId]);
  }

  async getTask(id: string) {
    await this.queue;
    // ids are uuids; anything else cannot exist (and would make Postgres raise)
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    const { rows } = await this.pool.query(`SELECT * FROM tasks WHERE id = $1`, [id]);
    return rows[0] ? toTask(rows[0]) : undefined;
  }

  async listTasks({ limit, before, agentId, status, q, parentId, rootsOnly }: TaskQuery & { limit: number }) {
    await this.queue;
    const statuses = status === "active" ? ACTIVE_STATUSES : status ? [status] : null;
    // escape LIKE wildcards so the search is literal
    const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const { rows } = await this.pool.query(
      `SELECT * FROM tasks
       WHERE ($2::timestamptz IS NULL OR created_at < $2)
         AND ($3::text IS NULL OR agent_id = $3)
         AND ($4::text[] IS NULL OR status = ANY($4))
         AND ($5::text IS NULL OR title ILIKE $5 OR prompt ILIKE $5)
         AND ($6::uuid IS NULL OR parent_id = $6)
         AND (NOT $7::boolean OR parent_id IS NULL)
       ORDER BY created_at DESC LIMIT $1`,
      [limit, date(before), agentId ?? null, statuses, pattern, parentId && /^[0-9a-f-]{36}$/i.test(parentId) ? parentId : null, !!rootsOnly],
    );
    return rows.map(toTask);
  }

  // ---------------------------------------------------------------- users & sessions (AuthRepo)
  async countUsers() {
    const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM users`);
    return rows[0].n as number;
  }
  async listUsers() {
    const { rows } = await this.pool.query(`SELECT * FROM users ORDER BY created_at`);
    return rows.map(toUser);
  }
  async findUser(by: { id?: string; username?: string }) {
    const { rows } = by.id
      ? await this.pool.query(`SELECT * FROM users WHERE id = $1`, [by.id])
      : await this.pool.query(`SELECT * FROM users WHERE lower(username) = lower($1)`, [by.username]);
    return rows[0] ? toUser(rows[0]) : undefined;
  }
  async insertUser(u: StoredUser) {
    await this.pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [u.id, u.username, u.displayName, u.passwordHash, u.role, u.disabled, date(u.createdAt)],
    );
  }
  async updateUser(id: string, patch: Partial<StoredUser>) {
    // fixed column list: only these fields can be changed
    const cols: [string, unknown][] = [
      ["display_name", patch.displayName],
      ["password_hash", patch.passwordHash],
      ["role", patch.role],
      ["disabled", patch.disabled],
    ];
    const set = cols.filter(([, v]) => v !== undefined);
    if (!set.length) return;
    const assignments = set.map(([k], i) => `${k} = $${i + 2}`).join(", ");
    await this.pool.query(`UPDATE users SET ${assignments} WHERE id = $1`, [id, ...set.map(([, v]) => v)]);
  }
  async deleteUser(id: string) {
    await this.pool.query(`DELETE FROM users WHERE id = $1`, [id]);
  }
  async insertSession(id: string, userId: string, expiresAt: number) {
    await this.pool.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1,$2,$3)`, [id, userId, date(expiresAt)]);
  }
  async findSession(id: string) {
    const { rows } = await this.pool.query(`SELECT user_id, expires_at FROM sessions WHERE id = $1`, [id]);
    return rows[0] ? { userId: rows[0].user_id as string, expiresAt: ms(rows[0].expires_at)! } : undefined;
  }
  async deleteSession(id: string) {
    await this.pool.query(`DELETE FROM sessions WHERE id = $1`, [id]);
  }
  async deleteUserSessions(userId: string) {
    await this.pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  }
  async purgeSessions() {
    await this.pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
  }

  async close() {
    await this.queue;
    await this.pool.end();
  }
}
