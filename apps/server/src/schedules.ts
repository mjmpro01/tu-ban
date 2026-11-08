import { randomUUID } from "node:crypto";
import { ACTIVE_STATUSES, type Schedule, type ScheduleInput, parseCron } from "@tu-ban/shared";
import type { Budget } from "./budget.ts";
import { nextRun } from "./cron.ts";
import type { Actor, Orchestrator } from "./orchestrator.ts";
import type { Store } from "./store.ts";

const TICK_MS = 20_000;
const MAX_SCHEDULES = 100;
/** Shortest gap between two runs: a schedule cannot fire every minute and burn the budget. */
const MIN_GAP_MS = 5 * 60_000;

/** Runs requests on a cron schedule, as if the person who made the schedule had sent them. */
export class Scheduler {
  private items = new Map<string, Schedule>();
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private store: Store,
    private orchestrator: Orchestrator,
    private budget: Budget,
    private onChange: (s: Schedule | { id: string; deleted: true }) => void = () => {},
  ) {}

  async init() {
    for (const s of (await this.store.db?.loadSchedules()) ?? []) {
      // runs missed while the server was off are not made up: the next one is counted from now
      this.items.set(s.id, { ...s, nextRunAt: s.enabled ? this.safeNext(s.cron) : undefined });
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    if (this.items.size) console.log(`[schedule] ${this.items.size} lịch chạy định kỳ`);
  }

  stop() {
    clearInterval(this.timer);
  }

  list(): Schedule[] {
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  private safeNext(cron: string, after = Date.now()) {
    try {
      return nextRun(cron, after);
    } catch {
      return undefined;
    }
  }

  private validate(input: ScheduleInput, current?: Schedule): Omit<Schedule, "id" | "createdAt" | "updatedAt"> {
    const name = (input.name ?? current?.name ?? "").trim();
    const prompt = (input.prompt ?? current?.prompt ?? "").trim();
    const cron = (input.cron ?? current?.cron ?? "").trim().replace(/\s+/g, " ");
    const agentId = input.agentId === null ? undefined : (input.agentId ?? current?.agentId) || undefined;
    const enabled = input.enabled ?? current?.enabled ?? true;
    if (!name || name.length > 80) throw new Error("Tên lịch cần từ 1 đến 80 ký tự");
    if (!prompt || prompt.length > 8000) throw new Error("Nội dung yêu cầu cần từ 1 đến 8000 ký tự");
    if (typeof enabled !== "boolean") throw new Error("enabled phải là true/false");
    if (agentId && !this.store.agents.has(agentId)) throw new Error(`Không có agent "${agentId}"`);
    parseCron(cron);
    const first = nextRun(cron);
    if (nextRun(cron, first) - first < MIN_GAP_MS) throw new Error("Lịch chạy dày quá: hai lần chạy phải cách nhau ít nhất 5 phút");
    return { ...current, name, prompt, cron, agentId, enabled };
  }

  async create(input: ScheduleInput, actor: Actor) {
    if (this.items.size >= MAX_SCHEDULES) throw new Error(`Tối đa ${MAX_SCHEDULES} lịch`);
    const now = Date.now();
    const v = this.validate(input);
    const s: Schedule = { ...v, id: randomUUID(), createdBy: actor.name, createdById: actor.id, createdAt: now, updatedAt: now };
    s.nextRunAt = s.enabled ? nextRun(s.cron) : undefined;
    await this.save(s);
    return s;
  }

  async update(id: string, input: ScheduleInput) {
    const current = this.items.get(id);
    if (!current) throw Object.assign(new Error("Không có lịch này"), { statusCode: 404 });
    const s: Schedule = { ...current, ...this.validate(input, current), updatedAt: Date.now() };
    s.nextRunAt = s.enabled ? nextRun(s.cron) : undefined;
    if (input.cron !== undefined || input.enabled) s.lastSkip = undefined;
    await this.save(s);
    return s;
  }

  async remove(id: string) {
    if (!this.items.delete(id)) throw Object.assign(new Error("Không có lịch này"), { statusCode: 404 });
    await this.store.db?.deleteSchedule(id);
    this.onChange({ id, deleted: true });
  }

  private async save(s: Schedule) {
    this.items.set(s.id, s);
    await this.store.db?.saveSchedule(s);
    this.onChange(s);
  }

  /** Start a schedule's request now (the "Chạy ngay" button, and every due run). */
  async runNow(id: string, manual = true) {
    const s = this.items.get(id);
    if (!s) throw Object.assign(new Error("Không có lịch này"), { statusCode: 404 });
    const skip = await this.skipReason(s);
    if (skip) {
      await this.save({ ...s, lastSkip: skip, nextRunAt: s.enabled ? this.safeNext(s.cron) : undefined });
      if (manual) throw new Error(skip);
      console.log(`[schedule] bỏ qua "${s.name}": ${skip}`);
      return undefined;
    }
    const task = this.orchestrator.createTask(
      { prompt: s.prompt, agentId: s.agentId },
      // the request belongs to whoever made the schedule (they can cancel it, it counts as theirs)
      { id: s.createdById ?? "", name: `${s.createdBy ?? "?"} · lịch "${s.name}"` },
      { source: "schedule", sourceRef: s.id },
    );
    await this.save({ ...s, lastRunAt: Date.now(), lastTaskId: task.id, lastSkip: undefined, nextRunAt: s.enabled ? this.safeNext(s.cron) : undefined });
    return task;
  }

  private async skipReason(s: Schedule): Promise<string | undefined> {
    const last = s.lastTaskId ? this.store.tasks.get(s.lastTaskId) : undefined;
    if (last && ACTIVE_STATUSES.includes(last.status)) return "Lần chạy trước chưa xong";
    const agentId = s.agentId ?? "manager";
    if (!this.orchestrator.agentEnabled(agentId)) return `${this.store.agents.get(agentId)?.name ?? agentId} đang tắt`;
    await this.budget.refresh();
    if (this.budget.remainingToday < 0.01) return "Đã hết ngân sách trong ngày";
    return undefined;
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      for (const s of this.items.values()) {
        if (!s.enabled || !s.nextRunAt || s.nextRunAt > now) continue;
        try {
          await this.runNow(s.id, false);
        } catch (e) {
          console.warn(`[schedule] "${s.name}" lỗi: ${(e as Error).message}`);
          await this.save({ ...s, lastSkip: (e as Error).message, nextRunAt: this.safeNext(s.cron) }).catch(() => {});
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
