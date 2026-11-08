import { randomUUID } from "node:crypto";
import {
  ACTIVE_STATUSES,
  type AgentConfigView,
  type AgentInfo,
  type AgentSettings,
  type CreateTaskInput,
  type ProviderId,
  type MemoryScope,
  type Task,
  type TaskKind,
  type Usage,
  emptyUsage,
  sameValue,
  toolGroupOf,
} from "@tu-ban/shared";
import { listSkills, skillExists } from "./skills.ts";
import {
  type AgentConfig,
  MANAGER_ID,
  ROSTER,
  SETTINGS_KEYS,
  managerTeamSection,
  pickSettings,
  toAgentInfo,
  validateSettings,
} from "./agents.ts";
import type { Budget } from "./budget.ts";
import { type Memory, recallSection } from "./memory.ts";
import { MODE, WORKDIR } from "./config.ts";
import { claudeProvider } from "./providers/claude.ts";
import { copilotProvider } from "./providers/copilot.ts";
import { cursorProvider } from "./providers/cursor.ts";
import { mockProvider } from "./providers/mock.ts";
import { type AgentProvider, type EmitInput, type SubtaskOutcome, type TeamApi, clip } from "./providers/types.ts";
import type { Store } from "./store.ts";

const PROVIDERS: Record<ProviderId, AgentProvider> = {
  claude: claudeProvider,
  cursor: cursorProvider,
  copilot: copilotProvider,
  mock: mockProvider,
};

/** The person behind an action (from the login session). */
export interface Actor {
  id: string;
  name: string;
}

/** Who reviews, in order of preference (the first enabled agent that did not do the work). */
const REVIEWERS = ["researcher", "writer"];
const SETTING_LABELS: Record<keyof AgentSettings, string> = {
  name: "tên",
  role: "vai trò",
  provider: "provider",
  model: "model",
  systemPrompt: "system prompt",
  enabled: "bật/tắt",
  skills: "skill",
  tools: "quyền công cụ",
};
/** How much of an earlier result is copied into a follow-up sub-task. */
const CONTEXT_CHARS = 6000;

const addUsage = (a: Usage, b?: Usage): Usage =>
  b ? { tokensIn: a.tokensIn + b.tokensIn, tokensOut: a.tokensOut + b.tokensOut, costUsd: a.costUsd + b.costUsd } : a;

const FINISHED = (t: Task) => !ACTIVE_STATUSES.includes(t.status);

/**
 * Assigns tasks to agents, runs one task at a time per agent, and turns provider output into state.
 * Requests from the user go to the Manager, which can delegate sub-tasks to the rest of the team.
 */
export class Orchestrator {
  private configs = new Map<string, AgentConfig>();
  private queues = new Map<string, string[]>();
  /** agentId -> the task it is running and the controller that cancels it */
  private running = new Map<string, { taskId: string; controller: AbortController }>();
  private approvalWaiters = new Map<string, (ok: boolean) => void>();
  private taskWaiters = new Map<string, ((t: Task) => void)[]>();
  private idleTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private store: Store,
    private budget: Budget,
    private memory?: Memory,
  ) {}

  async init() {
    const overrides = (await this.store.db?.loadAgentSettings()) ?? {};
    for (const base of ROSTER) {
      let c = base;
      try {
        c = { ...base, ...validateSettings(base.id, overrides[base.id] ?? {}) };
      } catch (e) {
        console.warn(`[${base.id}] bỏ qua cấu hình đã lưu không hợp lệ: ${(e as Error).message}`);
      }
      this.configs.set(c.id, c);
      this.queues.set(c.id, []);
      this.store.setAgent(toAgentInfo(c, await this.resolveRuntime(c)));
    }
    const saved = await this.store.db?.load();
    if (saved) {
      this.store.hydrate(saved);
      console.log(`[db] đã nạp ${saved.tasks.length} task, ${saved.events.length} event`);
    }
    console.log(`Mode: ${MODE}. Agents: ${[...this.store.agents.values()].map((a) => `${a.id}=${a.runtime}`).join(", ")}`);
  }

  /** Which provider an agent really runs on (demo mode, or a provider that is not set up, falls back to mock). */
  private runtimeNotes = new Map<string, string>();
  private async resolveRuntime(c: AgentConfig): Promise<ProviderId> {
    this.runtimeNotes.delete(c.id);
    if (MODE !== "live") return "mock";
    const check = await PROVIDERS[c.provider].available();
    if (check.ok) return c.provider;
    const note = `${c.provider} không dùng được: ${check.reason}. Agent chạy bằng kịch bản demo.`;
    this.runtimeNotes.set(c.id, note);
    console.warn(`[${c.id}] ${note}`);
    return "mock";
  }

  // ---------------------------------------------------------------- agent settings
  agentConfigs(): AgentConfigView[] {
    const all = [...this.configs.values()];
    return all.map((c) => {
      const defaults = pickSettings(ROSTER.find((r) => r.id === c.id)!);
      const current = pickSettings(c);
      return {
        ...current,
        id: c.id,
        character: c.character,
        desk: c.desk,
        defaults,
        isDefault: SETTINGS_KEYS.every((k) => sameValue(current[k], defaults[k])),
        generatedPrompt: c.id === MANAGER_ID ? managerTeamSection(all, this.budget.settings) : undefined,
        required: c.id === MANAGER_ID,
        runtimeNote: this.runtimeNotes.get(c.id),
      };
    });
  }

  /** Apply an edit from the dashboard. Running tasks keep the old settings; the next task uses the new ones. */
  async updateAgentSettings(id: string, patch: Partial<AgentSettings>, actor?: Actor): Promise<AgentConfigView> {
    const current = this.configs.get(id);
    if (!current) throw new Error(`Không có agent "${id}"`);
    const known = new Set((await listSkills(() => [])).map((sk) => sk.name));
    const clean = validateSettings(id, patch, known);
    const next: AgentConfig = { ...current, ...clean };
    const changed = SETTINGS_KEYS.filter((k) => !sameValue(next[k], current[k]));
    if (!changed.length) return this.agentConfigs().find((c) => c.id === id)!;

    // store only what differs from the defaults
    const defaults = pickSettings(ROSTER.find((r) => r.id === id)!);
    const diff = Object.fromEntries(SETTINGS_KEYS.filter((k) => !sameValue(next[k], defaults[k])).map((k) => [k, next[k]]));
    if (this.store.db) {
      if (Object.keys(diff).length) await this.store.db.saveAgentSettings(id, diff);
      else await this.store.db.deleteAgentSettings(id);
    }
    this.configs.set(id, next);

    const runtime = changed.includes("provider") ? await this.resolveRuntime(next) : this.agent(id).runtime;
    const busy = this.running.has(id);
    this.store.patchAgent(id, {
      name: next.name,
      role: next.role,
      provider: next.provider,
      runtime,
      model: runtime === "claude" ? next.model : undefined,
      enabled: next.enabled,
      ...(busy ? {} : { status: "idle", activity: "idle", summary: next.enabled ? "Đang rảnh" : "Đã tắt" }),
    });
    this.store.addEvent({
      agentId: id,
      type: "config",
      activity: busy ? this.agent(id).activity : "idle",
      summary: `${actor ? `${actor.name} cập nhật` : "Cập nhật"} cấu hình: ${changed.map((k) => SETTING_LABELS[k]).join(", ")}${busy ? " (áp dụng từ task sau)" : ""}`,
      actor: actor?.name,
    });
    return this.agentConfigs().find((c) => c.id === id)!;
  }

  /** Agents that have a skill enabled (for the skill library). */
  skillUsers(name: string) {
    return [...this.configs.values()].filter((c) => c.skills.includes(name)).map((c) => c.id);
  }

  /** After a skill is deleted from the library, take it off every agent. */
  async forgetSkill(name: string, actor?: Actor) {
    for (const id of this.skillUsers(name)) {
      const c = this.configs.get(id)!;
      await this.updateAgentSettings(id, { skills: c.skills.filter((s) => s !== name) }, actor);
    }
  }

  resetAgentSettings(id: string, actor?: Actor) {
    const defaults = ROSTER.find((r) => r.id === id);
    if (!defaults) throw new Error(`Không có agent "${id}"`);
    return this.updateAgentSettings(id, pickSettings(defaults), actor);
  }

  /** A request from the user. Without an explicit agent it goes to the Manager, who plans and delegates. */
  createTask(input: CreateTaskInput, actor?: Actor): Task {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("Nội dung task trống");
    const agentId = input.agentId && this.configs.has(input.agentId) ? input.agentId : MANAGER_ID;
    if (!this.configs.get(agentId)!.enabled) throw new Error(`${this.configs.get(agentId)!.name} đang tắt`);
    return this.enqueue({ agentId, prompt, title: clip(prompt, 60), kind: "task", createdBy: actor });
  }

  private enqueue(p: {
    agentId: string;
    prompt: string;
    title: string;
    kind: TaskKind;
    parentId?: string;
    createdBy?: Actor;
    followUpOf?: string;
  }): Task {
    const task: Task = {
      id: randomUUID(),
      title: p.title,
      prompt: p.prompt,
      agentId: p.agentId,
      parentId: p.parentId,
      kind: p.kind,
      createdBy: p.createdBy?.name,
      createdById: p.createdBy?.id,
      followUpOf: p.followUpOf,
      status: "queued",
      createdAt: Date.now(),
      usage: emptyUsage(),
    };
    this.store.setTask(task);
    this.queues.get(p.agentId)!.push(task.id);
    this.pump(p.agentId);
    return task;
  }

  /**
   * Move a task that has not started yet to another agent's queue (kept in creation order).
   * A Manager sub-task cannot go to the Manager: it is busy waiting for that very sub-task.
   */
  reassign(taskId: string, agentId: string, actor?: Actor): Task {
    const task = this.store.tasks.get(taskId);
    if (!task) throw new Error("Không có task này");
    if (task.status !== "queued") throw new Error("Chỉ chuyển được task đang chờ trong hàng đợi");
    const target = this.configs.get(agentId);
    if (!target) throw new Error(`Không có agent "${agentId}"`);
    if (!target.enabled) throw new Error(`${target.name} đang tắt`);
    if (agentId === task.agentId) return task;
    if (task.parentId && agentId === MANAGER_ID) throw new Error("Không chuyển việc con cho Manager: Manager đang chờ chính việc này");
    const from = this.queues.get(task.agentId)!;
    const i = from.indexOf(taskId);
    if (i >= 0) from.splice(i, 1);
    const to = this.queues.get(agentId)!;
    const at = to.findIndex((id) => (this.store.tasks.get(id)?.createdAt ?? 0) > task.createdAt);
    to.splice(at < 0 ? to.length : at, 0, taskId);
    const previous = this.store.agents.get(task.agentId)?.name ?? task.agentId;
    this.store.patchTask(taskId, { agentId });
    this.store.addEvent({
      agentId: task.agentId,
      taskId,
      type: "handoff",
      activity: "handoff",
      targetAgentId: agentId,
      summary: `${actor ? `${actor.name} chuyển` : "Chuyển"} "${task.title}" từ ${previous} sang ${target.name}`,
      actor: actor?.name,
    });
    this.pump(agentId);
    return this.store.tasks.get(taskId)!;
  }

  /** Start a new request for another agent that continues a finished task, with its result as context. */
  handoff(fromTaskId: string, input: { agentId?: string; instructions?: string }, actor?: Actor): Task {
    const from = this.store.tasks.get(fromTaskId);
    if (!from) throw new Error("Không có task này");
    if (from.status !== "done") throw new Error("Chỉ bàn giao tiếp được task đã xong");
    const target = input.agentId ? this.configs.get(input.agentId) : undefined;
    if (!target) throw new Error("Chọn agent nhận việc");
    if (!target.enabled) throw new Error(`${target.name} đang tắt`);
    const instructions = String(input.instructions ?? "").trim();
    if (!instructions) throw new Error("Nhập việc cần làm tiếp");
    const fromName = this.store.agents.get(from.agentId)?.name ?? from.agentId;
    const prompt = [
      instructions,
      `## Bối cảnh: kết quả trước đó của ${fromName} (task "${from.title}")`,
      clip(from.result ?? "", 8000),
      "File tạo ra hãy lưu trong thư mục làm việc chung và nêu đường dẫn trong câu trả lời.",
    ].join("\n\n");
    const task = this.enqueue({
      agentId: target.id,
      prompt,
      title: clip(instructions, 60),
      kind: "task",
      createdBy: actor,
      followUpOf: from.id,
    });
    this.store.addEvent({
      agentId: from.agentId,
      taskId: task.id,
      type: "handoff",
      activity: "handoff",
      targetAgentId: target.id,
      summary: `${actor ? `${actor.name}: ` : ""}${fromName} bàn giao cho ${target.name}: ${task.title}`,
      actor: actor?.name,
    });
    return task;
  }

  /** Cancel a task and everything it delegated. */
  cancel(taskId: string, actor?: Actor) {
    const task = this.store.tasks.get(taskId);
    if (!task) return;
    if (actor && !task.parentId && !FINISHED(task))
      this.store.addEvent({ agentId: task.agentId, taskId, type: "error", activity: "idle", summary: `${actor.name} huỷ: ${task.title}`, actor: actor.name });
    for (const child of this.children(taskId)) if (!FINISHED(child)) this.cancel(child.id);
    if (task.status === "queued") {
      const q = this.queues.get(task.agentId)!;
      const i = q.indexOf(taskId);
      if (i >= 0) q.splice(i, 1);
      this.finish(task.id, { status: "cancelled", finishedAt: Date.now(), error: "Đã huỷ" });
    } else {
      const r = this.running.get(task.agentId);
      if (r?.taskId === taskId) r.controller.abort();
    }
  }

  decide(approvalId: string, approve: boolean, actor?: Actor) {
    const a = this.store.approvals.get(approvalId);
    const waiter = this.approvalWaiters.get(approvalId);
    if (!a || a.status !== "pending" || !waiter) return;
    this.approvalWaiters.delete(approvalId);
    this.store.setApproval({ ...a, status: approve ? "approved" : "denied", decidedBy: actor?.name });
    this.store.addEvent({
      agentId: a.agentId,
      taskId: a.taskId,
      type: "approval_resolved",
      activity: approve ? "code" : "thinking",
      tool: a.tool,
      summary: `${approve ? "Đã duyệt" : "Từ chối"}${actor ? ` (${actor.name})` : ""}: ${a.summary}`,
      actor: actor?.name,
    });
    waiter(approve);
  }

  // ---------------------------------------------------------------- task tree helpers
  private children(taskId: string) {
    return [...this.store.tasks.values()].filter((t) => t.parentId === taskId);
  }

  private rootOf(task: Task): Task {
    let t = task;
    while (t.parentId) {
      const p = this.store.tasks.get(t.parentId);
      if (!p) break;
      t = p;
    }
    return t;
  }

  private treeTasks(root: Task): Task[] {
    const out = [root];
    for (let i = 0; i < out.length; i++) out.push(...this.children(out[i].id));
    return out;
  }

  private treeCost(root: Task) {
    // the running Manager's own spend is only known at the end; this counts finished work
    return this.treeTasks(root).reduce((n, t) => n + t.usage.costUsd, 0);
  }

  private waitTask(taskId: string): Promise<Task> {
    const t = this.store.tasks.get(taskId);
    if (!t) return Promise.reject(new Error(`Không có task ${taskId}`));
    if (FINISHED(t)) return Promise.resolve(t);
    return new Promise((resolve) => {
      const list = this.taskWaiters.get(taskId) ?? [];
      list.push(resolve);
      this.taskWaiters.set(taskId, list);
    });
  }

  /** Mark a task finished and wake up whoever waits for it. */
  private finish(taskId: string, patch: Partial<Task>) {
    this.store.patchTask(taskId, patch);
    const t = this.store.tasks.get(taskId)!;
    for (const resolve of this.taskWaiters.get(taskId) ?? []) resolve(t);
    this.taskWaiters.delete(taskId);
  }

  // ---------------------------------------------------------------- team API for the Manager
  private makeTeam(root: Task, emit: (e: EmitInput) => void, signal: AbortSignal): TeamApi {
    const name = (id: string) => this.store.agents.get(id)?.name ?? id;
    const outcome = (t: Task): SubtaskOutcome => ({
      taskId: t.id,
      agentId: t.agentId,
      status: t.status === "done" ? "done" : t.status === "cancelled" ? "cancelled" : "error",
      result: t.result,
      error: t.error,
    });
    const checkLimits = () => {
      if (signal.aborted) throw new Error("Request was cancelled");
      const limits = this.budget.settings;
      const subtasks = this.treeTasks(root).length - 1;
      if (subtasks >= limits.maxSubtasks) throw new Error(`Limit reached: at most ${limits.maxSubtasks} sub-tasks per request`);
      const cost = this.treeCost(root);
      if (cost >= limits.maxRequestUsd)
        throw new Error(`Budget reached: $${cost.toFixed(2)} of $${limits.maxRequestUsd} spent on this request`);
      if (this.budget.remainingToday < 0.01) throw new Error("Daily budget reached: no new work can start today");
    };
    const contextBlock = (ids: string[] = []) =>
      ids
        .map((id) => this.store.tasks.get(id))
        .filter((t): t is Task => !!t)
        .map((t) => `### Kết quả từ ${name(t.agentId)} (task ${t.id})\n${clip(t.result ?? t.error ?? "(chưa có kết quả)", CONTEXT_CHARS)}`)
        .join("\n\n");

    const delegate = (agentId: string, instructions: string, contextTaskIds?: string[], kind: TaskKind = "task") => {
      const member = this.configs.get(agentId);
      if (!member || agentId === MANAGER_ID || !member.enabled) {
        const ids = [...this.configs.values()].filter((c) => c.enabled && c.id !== MANAGER_ID).map((c) => c.id);
        throw new Error(`"${agentId}" is not an available team member. Available: ${ids.join(", ") || "nobody"}`);
      }
      checkLimits();
      const context = contextBlock(contextTaskIds);
      const prompt = [
        `[Việc do Manager giao, thuộc yêu cầu của người dùng: "${clip(root.prompt, 400)}"]`,
        instructions.trim(),
        context && `## Bối cảnh từ các bước trước\n${context}`,
        "File tạo ra hãy lưu trong thư mục làm việc chung và nêu đường dẫn trong câu trả lời. Trả lời ngắn gọn, đúng trọng tâm.",
      ]
        .filter(Boolean)
        .join("\n\n");
      const task = this.enqueue({
        agentId,
        prompt,
        title: clip(instructions, 60),
        kind,
        parentId: root.id,
        createdBy: root.createdById ? { id: root.createdById, name: root.createdBy ?? "" } : undefined,
      });
      this.store.addEvent({
        agentId: MANAGER_ID,
        taskId: root.id,
        type: "handoff",
        activity: "handoff",
        targetAgentId: agentId,
        summary: `Giao cho ${name(agentId)}: ${task.title}`,
      });
      return task.id;
    };

    const waitFor = async (taskIds: string[]) => {
      const pending = taskIds.map((id) => this.store.tasks.get(id)).filter((t) => t && !FINISHED(t)) as Task[];
      if (pending.length) emit({ type: "thinking", activity: "thinking", summary: `Đợi ${[...new Set(pending.map((t) => name(t.agentId)))].join(", ")}…` });
      const done = await Promise.race([
        Promise.all(taskIds.map((id) => this.waitTask(id))),
        new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })),
      ]);
      const agents = [...new Set(done.map((t) => t.agentId))];
      if (agents.length >= 2) {
        this.store.addEvent({
          agentId: MANAGER_ID,
          taskId: root.id,
          type: "meeting",
          activity: "thinking",
          participants: [MANAGER_ID, ...agents],
          summary: `Họp tổng hợp với ${agents.map(name).join(", ")}`,
        });
      }
      return done.map(outcome);
    };

    return {
      members: () =>
        [...this.configs.values()]
          .filter((c) => c.id !== MANAGER_ID && c.enabled)
          .map((c) => ({ id: c.id, name: c.name, role: c.role, busy: this.running.has(c.id) })),
      delegate: (agentId, instructions, contextTaskIds) => delegate(agentId, instructions, contextTaskIds),
      waitFor,
      review: async (taskId, focus) => {
        const target = this.store.tasks.get(taskId);
        if (!target || this.rootOf(target).id !== root.id) throw new Error(`Task ${taskId} is not part of this request`);
        const rounds = this.treeTasks(root).filter((t) => t.kind === "review").length;
        const maxReviews = this.budget.settings.maxReviewRounds;
        if (rounds >= maxReviews) throw new Error(`Limit reached: at most ${maxReviews} reviews per request`);
        await this.waitTask(taskId);
        const reviewer = [...REVIEWERS, ...this.configs.keys()].find(
          (id) => id !== MANAGER_ID && id !== target.agentId && this.configs.get(id)?.enabled,
        );
        if (!reviewer) throw new Error("No enabled team member can review this task");
        const instructions = [
          `Review công việc của ${name(target.agentId)} cho việc: "${target.title}".`,
          focus && `Tập trung vào: ${focus}`,
          "Nếu là thay đổi code: đọc các file liên quan trong thư mục làm việc (git diff nếu có) và kiểm tra đúng yêu cầu, lỗi, rủi ro.",
          "Chỉ nhận xét, không tự sửa. Liệt kê vấn đề cụ thể (nếu có).",
          "Dòng cuối cùng phải đúng một trong hai: VERDICT: APPROVED hoặc VERDICT: CHANGES_REQUESTED",
        ]
          .filter(Boolean)
          .join("\n");
        const reviewTaskId = delegate(reviewer, instructions, [taskId], "review");
        const [r] = await waitFor([reviewTaskId]);
        const text = r.result ?? r.error ?? "";
        const approved = r.status === "done" && /VERDICT:\s*APPROVED/i.test(text);
        return { approved, feedback: text.replace(/VERDICT:.*$/im, "").trim(), reviewTaskId };
      },
    };
  }

  // ---------------------------------------------------------------- memory
  private memoryApi(memory: Memory, agentId: string, runId: string, taskId: string, emit: (e: EmitInput) => void) {
    const label: Record<MemoryScope, string> = { office: "chung", agent: "riêng", request: "cho cả nhóm" };
    return {
      search: async (query: string, scope: MemoryScope | "all" = "all", limit?: number) => {
        const items =
          scope === "all"
            ? await memory.recall(query, { agentId, runId }, limit ?? 8)
            : await memory.query({ q: query, scope, agentId: scope === "agent" ? agentId : undefined, runId, limit: limit ?? 8 });
        emit({
          type: "memory",
          activity: "search",
          tool: "memory_search",
          summary: `Tra bộ nhớ: "${clip(query, 50)}" → ${items.length} kết quả`,
          detail: items.map((m) => `- ${m.text}`).join("\n") || undefined,
        });
        return items;
      },
      save: async (text: string, scope: MemoryScope) => {
        const saved = await memory.add({ text, scope, agentId, runId, createdBy: agentId, taskId });
        emit({
          type: "memory",
          activity: "write",
          tool: "memory_save",
          summary: `Ghi nhớ (${label[scope]}): ${clip(text, 70)}`,
          detail: text,
        });
        return saved;
      },
    };
  }

  /** Find what the office already knows about this task and hand it to the agent. */
  private async autoRecall(task: Task, agentId: string, runId: string, emit: (e: EmitInput) => void) {
    if (!this.memory?.settings.autoRecall || task.kind === "review") return undefined;
    try {
      // search with the work itself, not the wrapper text added around delegated work
      const query = task.prompt
        .replace(/^\[Việc do Manager giao[^\n]*\n+/, "")
        .split(/\n## Bối cảnh/)[0];
      const items = await this.memory.recall(clip(query, 500), { agentId, runId });
      if (!items.length) return undefined;
      emit({
        type: "memory",
        activity: "search",
        summary: `Nhớ lại ${items.length} điều liên quan`,
        detail: items.map((m) => `- [${m.scope}] ${m.text}`).join("\n"),
      });
      return recallSection(items);
    } catch (e) {
      console.warn(`[memory] không nhắc lại được: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** Keep what a finished user request produced, so later requests (and other agents) can build on it. */
  private async autoSave(task: Task, result: string) {
    const memory = this.memory;
    if (!memory?.settings.autoSave || !result.trim()) return;
    try {
      const saved = memory.canInfer
        ? await memory.add({
            text: result.slice(0, 4000),
            scope: "office",
            createdBy: "auto",
            taskId: task.id,
            infer: true,
            messages: [
              { role: "user", content: clip(task.prompt, 2000) },
              { role: "assistant", content: result.slice(0, 6000) },
            ],
          })
        : await memory.add({
            text: `Yêu cầu "${clip(task.title, 120)}" (${new Date(task.createdAt).toISOString().slice(0, 10)}): ${clip(result, 900)}`,
            scope: "office",
            createdBy: "auto",
            taskId: task.id,
          });
      if (saved.length)
        this.store.addEvent({
          agentId: task.agentId,
          taskId: task.id,
          type: "memory",
          activity: "done",
          summary: `Đã ghi ${saved.length} điều vào bộ nhớ chung`,
          detail: saved.map((m) => `- ${m.text}`).join("\n"),
        });
    } catch (e) {
      console.warn(`[memory] không tự ghi nhớ được: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- running
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
    this.running.set(task.agentId, { taskId, controller });
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

    // Only the Manager working on a user's request may delegate (sub-tasks cannot delegate further).
    const team = agent.id === MANAGER_ID && !task.parentId ? this.makeTeam(task, emit, controller.signal) : undefined;

    try {
      const skills = (await Promise.all(config.skills.map(async (n) => ((await skillExists(n)) ? n : undefined)))).filter(
        (n): n is string => !!n,
      );
      // daily budget: nothing new starts once it is used up, and a run may spend at most what is left
      await this.budget.refresh();
      const remaining = this.budget.remainingToday;
      if (remaining < 0.01) {
        const b = this.budget.settings;
        throw new Error(`Đã hết ngân sách trong ngày ($${this.budget.spentToday.toFixed(2)} / $${b.dailyUsd}). Admin có thể nâng hạn mức trong Thống kê & ngân sách.`);
      }
      const limits = {
        maxBudgetUsd: Math.min(this.budget.settings.maxTaskUsd, remaining),
        maxTurns: this.budget.settings.maxTurns,
      };
      const toolMode = (tool: string) => {
        const group = toolGroupOf(tool);
        return group ? config.tools[group] : "ask";
      };
      const runId = this.rootOf(task).id;
      const memory = this.memory ? this.memoryApi(this.memory, agent.id, runId, taskId, emit) : undefined;
      const memoryContext = await this.autoRecall(task, agent.id, runId, emit);
      const { result, usage } = await provider.run({
        task,
        agent,
        memory,
        memoryContext,
        skills,
        toolMode,
        limits,
        config: team
          ? { ...config, systemPrompt: `${config.systemPrompt}\n\n${managerTeamSection([...this.configs.values()], this.budget.settings)}` }
          : config,
        workdir: WORKDIR,
        signal: controller.signal,
        emit,
        requestApproval,
        team,
      });
      // a provider may still return normally after being cancelled
      if (controller.signal.aborted) throw new Error("cancelled");
      const a = this.agent(agent.id);
      this.finish(taskId, { status: "done", finishedAt: Date.now(), result, usage: usage ?? emptyUsage() });
      this.store.patchAgent(agent.id, { status: "idle", activity: "done", summary: "Xong việc!", usage: addUsage(a.usage, usage) });
      this.store.addEvent({ agentId: agent.id, taskId, type: "done", activity: "done", summary: `Xong: ${task.title}`, detail: result, usage });
      if (!task.parentId && task.kind === "task") void this.autoSave(task, result);
    } catch (err) {
      const cancelled = controller.signal.aborted;
      const message = err instanceof Error ? err.message : String(err);
      const usage = (err as { usage?: Usage }).usage;
      const a = this.agent(agent.id);
      this.finish(taskId, { status: cancelled ? "cancelled" : "error", finishedAt: Date.now(), error: message, usage: usage ?? emptyUsage() });
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
      // a cancelled request also stops the work it delegated
      if (cancelled) for (const child of this.children(taskId)) if (!FINISHED(child)) this.cancel(child.id);
    } finally {
      void this.budget.refresh().catch(() => {});
      this.running.delete(agent.id);
      this.store.patchAgent(agent.id, { currentTaskId: undefined });

      // Sub-task finished: bring the result back to the Manager's desk.
      const parent = task.parentId ? this.store.tasks.get(task.parentId) : undefined;
      const final = this.store.tasks.get(taskId)!;
      if (parent && final.status !== "cancelled") {
        this.store.addEvent({
          agentId: agent.id,
          taskId,
          type: "handoff",
          activity: "handoff",
          targetAgentId: parent.agentId,
          summary: final.status === "done" ? `Gửi kết quả cho ${this.agent(parent.agentId).name}` : "Báo lỗi cho Manager",
        });
      }

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
