import { randomUUID } from "node:crypto";
import {
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_SCOPES,
  type MemoryItem,
  type MemoryQuery,
  type MemoryScope,
  type MemorySettings,
  type MemoryStatus,
} from "@tu-ban/shared";
import {
  MEM0_API_KEY,
  MEM0_CONFIGURE,
  MEM0_NINEROUTER_URL,
  MEM0_URL,
  MEMORY_EMBED_DIMS,
  MEMORY_EMBED_MODEL,
  MEMORY_EMBED_URL,
  MEMORY_LLM_MODEL,
  NINEROUTER_KEY,
} from "./config.ts";
import type { Store } from "./store.ts";

export const MAX_MEMORY_CHARS = 4000;
const MAX_LIMIT = 50;
/** Local backend: how many memories are kept in memory for search. */
const LOCAL_CAP = 5000;

/** Where a memory is filed. office = everyone; agent = one agent; request = one user request (root task id). */
export interface MemoryTarget {
  scope: MemoryScope;
  agentId?: string;
  runId?: string;
}

export interface NewMemory extends MemoryTarget {
  text: string;
  createdBy?: string;
  taskId?: string;
  /**
   * Mem0 only: let its LLM pull short facts out of the text (and merge them with what it already
   * knows) instead of storing the text as it is.
   */
  infer?: boolean;
  /** Mem0 with infer: the conversation the facts come from. */
  messages?: { role: "user" | "assistant"; content: string }[];
}

interface Backend {
  readonly id: MemoryStatus["backend"];
  init(): Promise<void>;
  add(m: NewMemory): Promise<MemoryItem[]>;
  /** Search one target (scope + owner). */
  search(query: string, target: MemoryTarget, limit: number): Promise<MemoryItem[]>;
  /** List one target, or everything when no target is given. */
  list(target: MemoryTarget | undefined, limit: number): Promise<MemoryItem[]>;
  get(id: string): Promise<MemoryItem | undefined>;
  update(id: string, text: string): Promise<MemoryItem>;
  remove(id: string): Promise<void>;
}

// ---------------------------------------------------------------- local (keyword) backend

/** Lower case, no Vietnamese diacritics, so "ngân sách" also matches "ngan sach". */
export function fold(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
}
const words = (s: string) => fold(s).match(/[\p{L}\p{N}]+/gu) ?? [];
/** Very common Vietnamese / English words that say nothing about the topic. */
const STOP = new Set(
  "va la cua cho cac nhung mot de voi trong khi thi co khong duoc nay do o tu den ve nhu the hay roi da se dang bi vi neu ma cung rat the and the of to a an in on for is are be with or at by it this that".split(" "),
);

function keywordScore(query: string, text: string): number {
  const q = [...new Set(words(query).filter((w) => !STOP.has(w)))];
  if (!q.length) return 0;
  const t = new Set(words(text));
  const hits = q.filter((w) => t.has(w)).length;
  if (!hits) return 0;
  // a bonus when the words appear next to each other as in the query
  const phrase = fold(text).includes(q.join(" ")) ? 0.2 : 0;
  return Math.min(1, hits / q.length * 0.8 + phrase);
}

const matches = (m: MemoryItem, t: MemoryTarget) =>
  m.scope === t.scope &&
  (t.scope !== "agent" || m.agentId === t.agentId) &&
  (t.scope !== "request" || m.runId === t.runId);

class LocalBackend implements Backend {
  readonly id = "local" as const;
  private items: MemoryItem[] = [];

  constructor(private store: Store) {}

  async init() {
    this.items = (await this.store.db?.loadMemories(LOCAL_CAP)) ?? [];
  }

  async add(m: NewMemory) {
    // the same note again (ignoring case and accents) is not stored twice, as with Mem0
    const same = fold(m.text).replace(/\s+/g, " ");
    if (this.items.some((x) => matches(x, m) && fold(x.text).replace(/\s+/g, " ") === same)) return [];
    const now = Date.now();
    const item: MemoryItem = {
      id: randomUUID(),
      text: m.text,
      scope: m.scope,
      agentId: m.agentId,
      runId: m.runId,
      createdBy: m.createdBy,
      taskId: m.taskId,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.db?.saveMemory(item);
    this.items.unshift(item);
    if (this.items.length > LOCAL_CAP) this.items.length = LOCAL_CAP;
    return [item];
  }

  async search(query: string, target: MemoryTarget, limit: number) {
    return this.items
      .filter((m) => matches(m, target))
      .map((m) => ({ ...m, score: keywordScore(query, m.text) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, limit);
  }

  async list(target: MemoryTarget | undefined, limit: number) {
    return this.items.filter((m) => !target || matches(m, target)).slice(0, limit);
  }

  async get(id: string) {
    return this.items.find((m) => m.id === id);
  }

  async update(id: string, text: string) {
    const m = this.items.find((x) => x.id === id);
    if (!m) throw new Error("Không tìm thấy ghi nhớ");
    m.text = text;
    m.updatedAt = Date.now();
    await this.store.db?.saveMemory(m);
    return m;
  }

  async remove(id: string) {
    await this.store.db?.deleteMemory(id);
    this.items = this.items.filter((m) => m.id !== id);
  }
}

// ---------------------------------------------------------------- Mem0 backend

/** Mem0 user id that holds the office-wide memories. */
export const OFFICE_USER = "tuban-office";

type Mem0Row = {
  id: string;
  memory?: string;
  score?: number;
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
  event?: string;
};

const time = (s?: string) => (s ? Date.parse(s) || undefined : undefined);

export function fromMem0(r: Mem0Row): MemoryItem {
  const meta = r.metadata ?? {};
  const scope = (MEMORY_SCOPES as string[]).includes(meta.scope as string)
    ? (meta.scope as MemoryScope)
    : r.run_id
      ? "request"
      : r.agent_id
        ? "agent"
        : "office";
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    id: r.id,
    text: r.memory ?? "",
    scope,
    agentId: r.agent_id ?? str(meta.agentId),
    runId: r.run_id ?? str(meta.runId),
    createdBy: str(meta.createdBy),
    taskId: str(meta.taskId),
    createdAt: time(r.created_at),
    updatedAt: time(r.updated_at) ?? time(r.created_at),
    score: typeof r.score === "number" ? r.score : undefined,
  };
}

/** Mem0 entity ids for a target (each scope lives under its own id, so searches never mix them). */
export function mem0Ids(t: MemoryTarget): Record<string, string> {
  if (t.scope === "agent") {
    if (!t.agentId) throw new Error("Thiếu agent cho bộ nhớ riêng");
    return { agent_id: t.agentId };
  }
  if (t.scope === "request") {
    if (!t.runId) throw new Error("Thiếu yêu cầu cho bộ nhớ theo yêu cầu");
    return { run_id: t.runId };
  }
  return { user_id: OFFICE_USER };
}

/** What we send to POST /configure: Mem0's LLM and embedder go through 9router or the embedding server. */
export function mem0Config(): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {};
  if (MEM0_NINEROUTER_URL && MEMORY_LLM_MODEL) {
    config.llm = {
      provider: "openai",
      config: { model: MEMORY_LLM_MODEL, openai_base_url: `${MEM0_NINEROUTER_URL}/v1`, api_key: NINEROUTER_KEY || "9router", temperature: 0.1 },
    };
  }
  const embedBase = MEMORY_EMBED_URL ? `${MEMORY_EMBED_URL}/v1` : MEM0_NINEROUTER_URL ? `${MEM0_NINEROUTER_URL}/v1` : undefined;
  if (embedBase && MEMORY_EMBED_MODEL) {
    // embedding_dims is left out on purpose: Mem0 would then send `dimensions`, which models
    // with a fixed size (like Vietnamese_Embedding) reject. The vector table gets the size instead,
    // and a collection per size, so changing models never mixes vectors of different lengths.
    config.embedder = {
      provider: "openai",
      config: { model: MEMORY_EMBED_MODEL, openai_base_url: embedBase, api_key: (MEMORY_EMBED_URL ? "tei" : NINEROUTER_KEY) || "none" },
    };
    config.vector_store = {
      provider: "pgvector",
      config: { embedding_model_dims: MEMORY_EMBED_DIMS, collection_name: `tuban_memories_${MEMORY_EMBED_DIMS}` },
    };
  }
  return Object.keys(config).length ? config : undefined;
}

class Mem0Backend implements Backend {
  readonly id = "mem0" as const;

  constructor(
    private url: string,
    private apiKey?: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const fail = (msg: string) => Object.assign(new Error(msg), { statusCode: 502 });
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    }).catch((e: Error) => {
      throw fail(`Không kết nối được Mem0 (${this.url}): ${e.name === "TimeoutError" ? "hết thời gian chờ" : e.message}`);
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        if (j.detail) detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail).slice(0, 300);
      } catch {}
      throw fail(`Mem0 ${res.status}: ${detail}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private rows(r: unknown): Mem0Row[] {
    const list = Array.isArray(r) ? r : ((r as { results?: unknown })?.results ?? []);
    return (list as Mem0Row[]).filter((x) => x && typeof x.id === "string");
  }

  async init() {
    const config = MEM0_CONFIGURE ? mem0Config() : undefined;
    if (config) {
      await this.call("POST", "/configure", config);
      console.log(`[memory] đã cấu hình Mem0: ${Object.keys(config).join(", ")}`);
    }
  }

  async add(m: NewMemory) {
    const r = await this.call("POST", "/memories", {
      messages: m.messages ?? [{ role: "user", content: m.text }],
      ...mem0Ids(m),
      infer: m.infer ?? false,
      metadata: {
        scope: m.scope,
        ...(m.agentId ? { agentId: m.agentId } : {}),
        ...(m.runId ? { runId: m.runId } : {}),
        ...(m.createdBy ? { createdBy: m.createdBy } : {}),
        ...(m.taskId ? { taskId: m.taskId } : {}),
      },
    });
    // the add answer only has id/memory/event; DELETE events are memories Mem0 merged away
    return this.rows(r)
      .filter((x) => x.event !== "DELETE" && x.event !== "NONE")
      .map((x) => ({ ...fromMem0(x), scope: m.scope, agentId: m.agentId, runId: m.runId, createdBy: m.createdBy, taskId: m.taskId, createdAt: Date.now(), updatedAt: Date.now() }));
  }

  async search(query: string, target: MemoryTarget, limit: number) {
    const r = await this.call("POST", "/search", { query, filters: mem0Ids(target), top_k: limit });
    return this.rows(r).map(fromMem0);
  }

  async list(target: MemoryTarget | undefined, limit: number) {
    const params = new URLSearchParams({ top_k: String(limit), ...(target ? mem0Ids(target) : {}) });
    const r = await this.call("GET", `/memories?${params}`);
    return this.rows(r)
      .map(fromMem0)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  async get(id: string) {
    try {
      const r = await this.call<Mem0Row>("GET", `/memories/${encodeURIComponent(id)}`);
      return r?.id ? fromMem0(r) : undefined;
    } catch {
      return undefined;
    }
  }

  async update(id: string, text: string) {
    await this.call("PUT", `/memories/${encodeURIComponent(id)}`, { text });
    return (await this.get(id)) ?? { id, text, scope: "office" };
  }

  async remove(id: string) {
    await this.call("DELETE", `/memories/${encodeURIComponent(id)}`);
  }
}

// ---------------------------------------------------------------- service

export function validateMemorySettings(raw: unknown, partial = false): Partial<MemorySettings> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: Partial<MemorySettings> = {};
  for (const k of ["autoRecall", "autoSave"] as const) {
    if (r[k] === undefined) continue;
    if (typeof r[k] !== "boolean") throw new Error(`${k} phải là true/false`);
    out[k] = r[k] as boolean;
  }
  if (r.recallLimit !== undefined) {
    const n = Number(r.recallLimit);
    if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error("Số ghi nhớ tự nhắc phải từ 1 đến 20");
    out.recallLimit = n;
  }
  if (!partial && !Object.keys(out).length) throw new Error("Không có gì để đổi");
  return out;
}

export function cleanText(text: unknown): string {
  if (typeof text !== "string" || !text.trim()) throw new Error("Nội dung ghi nhớ trống");
  const t = text.trim();
  if (t.length > MAX_MEMORY_CHARS) throw new Error(`Ghi nhớ dài tối đa ${MAX_MEMORY_CHARS} ký tự`);
  return t;
}

const byScore = (a: MemoryItem, b: MemoryItem) => (b.score ?? 0) - (a.score ?? 0);

/**
 * Shared context memory for every agent, whichever provider or 9router model runs it.
 * Backed by Mem0 when MEM0_URL is set, otherwise by keyword search over a Postgres table.
 */
export class Memory {
  private backend: Backend;
  private value: MemorySettings = { ...DEFAULT_MEMORY_SETTINGS };
  private lastError?: string;
  private ok = true;

  constructor(
    private store: Store,
    /** Agent ids, for searching every agent's memories at once. */
    private agentIds: () => string[],
  ) {
    this.backend = MEM0_URL ? new Mem0Backend(MEM0_URL, MEM0_API_KEY) : new LocalBackend(store);
  }

  async init() {
    const saved = await this.store.db?.loadSetting<Partial<MemorySettings>>("memory");
    if (saved) {
      try {
        this.value = { ...this.value, ...validateMemorySettings(saved, true) };
      } catch {}
    }
    // a Mem0 server that is down must not stop the office from starting
    await this.track(() => this.backend.init()).catch((e) => console.warn(`[memory] ${e.message}`));
    console.log(`[memory] bộ nhớ chung: ${this.backend.id === "mem0" ? `Mem0 (${MEM0_URL})` : "từ khoá (Postgres)"}`);
  }

  get settings() {
    return this.value;
  }

  status(): MemoryStatus {
    const config = this.backend.id === "mem0" ? mem0Config() : undefined;
    const model = (k: string) => ((config?.[k] as { config?: { model?: string } } | undefined)?.config?.model);
    return {
      backend: this.backend.id,
      ok: this.ok,
      lastError: this.lastError,
      settings: this.value,
      llmModel: model("llm"),
      embedModel: model("embedder"),
    };
  }

  async updateSettings(patch: unknown) {
    this.value = { ...this.value, ...validateMemorySettings(patch) };
    await this.store.db?.saveSetting("memory", this.value);
    return this.value;
  }

  /** Remember whether the backend answers, for the status shown in the dashboard. */
  private async track<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const r = await fn();
      this.ok = true;
      this.lastError = undefined;
      return r;
    } catch (e) {
      this.ok = false;
      this.lastError = (e as Error).message;
      throw e;
    }
  }

  private targets(q: { scope?: MemoryScope; agentId?: string; runId?: string }): MemoryTarget[] {
    if (q.scope === "office") return [{ scope: "office" }];
    if (q.scope === "agent") return (q.agentId ? [q.agentId] : this.agentIds()).map((agentId) => ({ scope: "agent" as const, agentId }));
    if (q.scope === "request") {
      if (!q.runId) throw new Error("Cần chọn một yêu cầu để xem bộ nhớ theo yêu cầu");
      return [{ scope: "request", runId: q.runId }];
    }
    return [
      { scope: "office" },
      ...(q.agentId ? [q.agentId] : this.agentIds()).map((agentId) => ({ scope: "agent" as const, agentId })),
      ...(q.runId ? [{ scope: "request" as const, runId: q.runId }] : []),
    ];
  }

  private limit(n: unknown, fallback = 20) {
    const v = Number(n ?? fallback);
    return Number.isFinite(v) ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(v))) : fallback;
  }

  /** Dashboard: search when there is a query, otherwise the newest memories. */
  async query(q: MemoryQuery): Promise<MemoryItem[]> {
    if (q.scope && !MEMORY_SCOPES.includes(q.scope)) throw new Error("Phạm vi không hợp lệ");
    const limit = this.limit(q.limit);
    const text = q.q?.trim();
    return this.track(async () => {
      if (!text && !q.scope && !q.agentId && !q.runId) return this.backend.list(undefined, limit);
      const targets = this.targets(q);
      const lists = await Promise.all(
        targets.map((t) => (text ? this.backend.search(text, t, limit) : this.backend.list(t, limit))),
      );
      const all = lists.flat();
      return (text ? all.sort(byScore) : all.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))).slice(0, limit);
    });
  }

  /** What an agent sees: the office memory, its own notes, and the notes of the request it works on. */
  async recall(query: string, who: { agentId: string; runId?: string }, limit = this.value.recallLimit) {
    const targets: MemoryTarget[] = [
      { scope: "office" },
      { scope: "agent", agentId: who.agentId },
      ...(who.runId ? [{ scope: "request" as const, runId: who.runId }] : []),
    ];
    return this.track(async () => {
      const lists = await Promise.all(targets.map((t) => this.backend.search(query, t, limit)));
      const seen = new Set<string>();
      return lists
        .flat()
        .sort(byScore)
        .filter((m) => !seen.has(m.id) && seen.add(m.id))
        .slice(0, limit);
    });
  }

  async add(m: NewMemory) {
    const text = cleanText(m.text);
    if (!MEMORY_SCOPES.includes(m.scope)) throw new Error("Phạm vi không hợp lệ");
    if (m.scope === "agent" && !this.agentIds().includes(m.agentId ?? "")) throw new Error("Agent không tồn tại");
    if (m.scope === "request" && !m.runId) throw new Error("Thiếu yêu cầu cho bộ nhớ theo yêu cầu");
    const target = { scope: m.scope, agentId: m.scope === "agent" ? m.agentId : undefined, runId: m.scope === "request" ? m.runId : undefined };
    return this.track(() => this.backend.add({ ...m, ...target, text }));
  }

  get(id: string) {
    return this.track(() => this.backend.get(id));
  }

  update(id: string, text: unknown) {
    const t = cleanText(text);
    return this.track(() => this.backend.update(id, t));
  }

  remove(id: string) {
    return this.track(() => this.backend.remove(id));
  }

  /** Whether automatic saves can extract facts with an LLM (Mem0 with a model) or store a short note. */
  get canInfer() {
    return this.backend.id === "mem0" && !!mem0Config()?.llm;
  }
}

/** The block of memories put into an agent's instructions. */
export function recallSection(items: MemoryItem[]) {
  const label: Record<MemoryScope, string> = { office: "chung", agent: "của bạn", request: "yêu cầu này" };
  return [
    "## Bộ nhớ chung của văn phòng",
    "Những điều đã ghi nhớ từ trước, có thể liên quan đến việc này (có thể đã cũ — kiểm tra lại khi quan trọng):",
    ...items.map((m) => `- [${label[m.scope]}] ${m.text.replace(/\s+/g, " ").slice(0, 600)}`),
    "Dùng memory_search để tìm thêm và memory_save để ghi lại điều đáng nhớ (quyết định, sở thích của người dùng, thông tin dự án).",
  ].join("\n");
}
