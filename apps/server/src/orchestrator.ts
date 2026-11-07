import { randomUUID } from "node:crypto";
import {
  ACTIVE_STATUSES,
  type AgentInfo,
  type CreateTaskInput,
  type ProviderId,
  type Task,
  type TaskKind,
  type Usage,
  emptyUsage,
} from "@tu-ban/shared";
import { type AgentConfig, ROSTER, toAgentInfo } from "./agents.ts";
import { MAX_REVIEW_ROUNDS, MAX_SUBTASKS, MAX_TREE_BUDGET_USD, MODE, WORKDIR } from "./config.ts";
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

const MANAGER_ID = "manager";
const REVIEWER_ID = "researcher";
const FALLBACK_REVIEWER_ID = "writer";
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

  constructor(private store: Store) {}

  async init() {
    for (const c of ROSTER) {
      this.configs.set(c.id, c);
      this.queues.set(c.id, []);
      let runtime: ProviderId = "mock";
      if (MODE === "live") {
        const check = await PROVIDERS[c.provider].available();
        if (check.ok) runtime = c.provider;
        else console.warn(`[${c.id}] ${c.provider} không dùng được: ${check.reason} → chạy demo`);
      }
      this.store.setAgent(toAgentInfo(c, runtime));
    }
    const saved = await this.store.db?.load();
    if (saved) {
      this.store.hydrate(saved);
      console.log(`[db] đã nạp ${saved.tasks.length} task, ${saved.events.length} event`);
    }
    console.log(`Mode: ${MODE}. Agents: ${[...this.store.agents.values()].map((a) => `${a.id}=${a.runtime}`).join(", ")}`);
  }

  /** A request from the user. Without an explicit agent it goes to the Manager, who plans and delegates. */
  createTask(input: CreateTaskInput): Task {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("Nội dung task trống");
    const agentId = input.agentId && this.configs.has(input.agentId) ? input.agentId : MANAGER_ID;
    return this.enqueue({ agentId, prompt, title: clip(prompt, 60), kind: "task" });
  }

  private enqueue(p: { agentId: string; prompt: string; title: string; kind: TaskKind; parentId?: string }): Task {
    const task: Task = {
      id: randomUUID(),
      title: p.title,
      prompt: p.prompt,
      agentId: p.agentId,
      parentId: p.parentId,
      kind: p.kind,
      status: "queued",
      createdAt: Date.now(),
      usage: emptyUsage(),
    };
    this.store.setTask(task);
    this.queues.get(p.agentId)!.push(task.id);
    this.pump(p.agentId);
    return task;
  }

  /** Cancel a task and everything it delegated. */
  cancel(taskId: string) {
    const task = this.store.tasks.get(taskId);
    if (!task) return;
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

  decide(approvalId: string, approve: boolean) {
    const a = this.store.approvals.get(approvalId);
    const waiter = this.approvalWaiters.get(approvalId);
    if (!a || a.status !== "pending" || !waiter) return;
    this.approvalWaiters.delete(approvalId);
    this.store.setApproval({ ...a, status: approve ? "approved" : "denied" });
    this.store.addEvent({
      agentId: a.agentId,
      taskId: a.taskId,
      type: "approval_resolved",
      activity: approve ? "code" : "thinking",
      tool: a.tool,
      summary: `${approve ? "Đã duyệt" : "Từ chối"}: ${a.summary}`,
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
      const subtasks = this.treeTasks(root).length - 1;
      if (subtasks >= MAX_SUBTASKS) throw new Error(`Limit reached: at most ${MAX_SUBTASKS} sub-tasks per request`);
      const cost = this.treeCost(root);
      if (cost >= MAX_TREE_BUDGET_USD)
        throw new Error(`Budget reached: $${cost.toFixed(2)} of $${MAX_TREE_BUDGET_USD} spent on this request`);
    };
    const contextBlock = (ids: string[] = []) =>
      ids
        .map((id) => this.store.tasks.get(id))
        .filter((t): t is Task => !!t)
        .map((t) => `### Kết quả từ ${name(t.agentId)} (task ${t.id})\n${clip(t.result ?? t.error ?? "(chưa có kết quả)", CONTEXT_CHARS)}`)
        .join("\n\n");

    const delegate = (agentId: string, instructions: string, contextTaskIds?: string[], kind: TaskKind = "task") => {
      if (!this.configs.has(agentId) || agentId === MANAGER_ID)
        throw new Error(`Unknown team member "${agentId}". Use one of: ${[...this.configs.keys()].filter((k) => k !== MANAGER_ID).join(", ")}`);
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
      const task = this.enqueue({ agentId, prompt, title: clip(instructions, 60), kind, parentId: root.id });
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
          .filter((c) => c.id !== MANAGER_ID)
          .map((c) => ({ id: c.id, name: c.name, role: c.role, busy: this.running.has(c.id) })),
      delegate: (agentId, instructions, contextTaskIds) => delegate(agentId, instructions, contextTaskIds),
      waitFor,
      review: async (taskId, focus) => {
        const target = this.store.tasks.get(taskId);
        if (!target || this.rootOf(target).id !== root.id) throw new Error(`Task ${taskId} is not part of this request`);
        const rounds = this.treeTasks(root).filter((t) => t.kind === "review").length;
        if (rounds >= MAX_REVIEW_ROUNDS) throw new Error(`Limit reached: at most ${MAX_REVIEW_ROUNDS} reviews per request`);
        await this.waitTask(taskId);
        const reviewer = target.agentId === REVIEWER_ID ? FALLBACK_REVIEWER_ID : REVIEWER_ID;
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
      const { result, usage } = await provider.run({
        task,
        agent,
        config,
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
