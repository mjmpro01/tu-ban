import type { AgentStats, BudgetSettings, DayStats, StatsResponse, Task } from "@tu-ban/shared";
import { DAILY_BUDGET_USD, MAX_BUDGET_USD, MAX_REVIEW_ROUNDS, MAX_SUBTASKS, MAX_TREE_BUDGET_USD, MAX_TURNS } from "./config.ts";
import type { Store } from "./store.ts";

/** Defaults come from the environment; admins override them from the dashboard. */
export const DEFAULT_BUDGET: BudgetSettings = {
  maxTaskUsd: MAX_BUDGET_USD,
  maxRequestUsd: MAX_TREE_BUDGET_USD,
  dailyUsd: DAILY_BUDGET_USD,
  maxSubtasks: MAX_SUBTASKS,
  maxReviewRounds: MAX_REVIEW_ROUNDS,
  maxTurns: MAX_TURNS,
};

const RANGES: Record<keyof BudgetSettings, [number, number, string]> = {
  maxTaskUsd: [0.01, 100, "Chi phí tối đa mỗi task"],
  maxRequestUsd: [0.01, 500, "Chi phí tối đa mỗi yêu cầu"],
  dailyUsd: [0, 10000, "Ngân sách mỗi ngày"],
  maxSubtasks: [0, 30, "Số việc con tối đa"],
  maxReviewRounds: [0, 10, "Số lần review tối đa"],
  maxTurns: [1, 300, "Số lượt tối đa mỗi task"],
};
const INTEGER_KEYS = new Set<keyof BudgetSettings>(["maxSubtasks", "maxReviewRounds", "maxTurns"]);

/** Validate a (partial) budget. Throws a user-facing message, or drops bad values when `lenient`. */
export function validateBudget(input: Partial<BudgetSettings>, lenient = false): Partial<BudgetSettings> {
  const out: Partial<BudgetSettings> = {};
  for (const key of Object.keys(RANGES) as (keyof BudgetSettings)[]) {
    if (input[key] === undefined) continue;
    const [min, max, label] = RANGES[key];
    const v = Number(input[key]);
    const ok = Number.isFinite(v) && v >= min && v <= max && (!INTEGER_KEYS.has(key) || Number.isInteger(v));
    if (!ok) {
      if (lenient) continue;
      throw new Error(`${label} phải ${INTEGER_KEYS.has(key) ? "là số nguyên " : ""}từ ${min} đến ${max}`);
    }
    out[key] = v;
  }
  return out;
}

export const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** YYYY-MM-DD of a timestamp in the server's time zone. */
const dayKey = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: TIME_ZONE });

const TZ_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Offset of the server's time zone from UTC at a given moment, in ms. */
export function tzOffsetMs(ms: number) {
  const parts = Object.fromEntries(
    TZ_FORMAT
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - (ms - (ms % 1000));
}

/** Midnight today in the server's time zone, as a timestamp. */
export function startOfToday(now = Date.now()) {
  const local = now + tzOffsetMs(now);
  const midnightLocal = local - (((local % 86400000) + 86400000) % 86400000);
  return midnightLocal - tzOffsetMs(midnightLocal - tzOffsetMs(now));
}

export class Budget {
  private value: BudgetSettings = { ...DEFAULT_BUDGET };
  /** Spending today, refreshed when tasks start and finish (used by synchronous checks). */
  private spent = 0;

  constructor(private store: Store) {}

  async init() {
    const saved = await this.store.db?.loadSetting<Partial<BudgetSettings>>("budget");
    if (saved) this.value = { ...this.value, ...validateBudget(saved, true) };
    await this.refresh();
  }

  get settings(): BudgetSettings {
    return this.value;
  }

  async update(patch: Partial<BudgetSettings>) {
    const next = { ...this.value, ...validateBudget(patch) };
    if (next.maxRequestUsd < next.maxTaskUsd) throw new Error("Chi phí mỗi yêu cầu phải lớn hơn hoặc bằng chi phí mỗi task");
    this.value = next;
    await this.store.db?.saveSetting("budget", next);
    return next;
  }

  async refresh() {
    const since = startOfToday();
    this.spent = this.store.db
      ? await this.store.db.spentSince(since)
      : [...this.store.tasks.values()].filter((t) => t.createdAt >= since).reduce((n, t) => n + t.usage.costUsd, 0);
    return this.spent;
  }

  get spentToday() {
    return this.spent;
  }

  /** Money left today; Infinity when there is no daily limit. */
  get remainingToday() {
    return this.value.dailyUsd > 0 ? Math.max(0, this.value.dailyUsd - this.spent) : Number.POSITIVE_INFINITY;
  }

  async stats(days: number): Promise<StatsResponse> {
    days = Math.max(1, Math.min(days, 90));
    await this.refresh();
    const raw = this.store.db ? await this.store.db.stats(days, TIME_ZONE) : memoryStats([...this.store.tasks.values()], days);
    // one entry per day, oldest first, empty days included
    const byDay = new Map(raw.days.map((d) => [d.date, d]));
    const list: DayStats[] = [];
    const today = startOfToday();
    for (let i = days - 1; i >= 0; i--) {
      const key = dayKey(today - i * 86400000 + 43200000);
      list.push(byDay.get(key) ?? { date: key, requests: 0, done: 0, errors: 0, costUsd: 0, tokens: 0 });
    }
    const last = list[list.length - 1];
    return {
      timeZone: TIME_ZONE,
      days: list,
      agents: raw.agents,
      today: { costUsd: this.spent, requests: last.requests, done: last.done, errors: last.errors },
      budget: this.value,
    };
  }
}

function memoryStats(tasks: Task[], days: number): { days: DayStats[]; agents: AgentStats[] } {
  const since = startOfToday() - (days - 1) * 86400000;
  const recent = tasks.filter((t) => t.createdAt >= since);
  const byDay = new Map<string, DayStats>();
  const byAgent = new Map<string, AgentStats & { durations: number[] }>();
  for (const t of recent) {
    const key = dayKey(t.createdAt);
    const d = byDay.get(key) ?? { date: key, requests: 0, done: 0, errors: 0, costUsd: 0, tokens: 0 };
    if (!t.parentId) {
      d.requests++;
      if (t.status === "done") d.done++;
      if (t.status === "error") d.errors++;
    }
    d.costUsd += t.usage.costUsd;
    d.tokens += t.usage.tokensIn + t.usage.tokensOut;
    byDay.set(key, d);
    const a = byAgent.get(t.agentId) ?? { agentId: t.agentId, tasks: 0, done: 0, errors: 0, costUsd: 0, tokens: 0, avgDurationMs: null, durations: [] };
    a.tasks++;
    if (t.status === "done") a.done++;
    if (t.status === "error") a.errors++;
    a.costUsd += t.usage.costUsd;
    a.tokens += t.usage.tokensIn + t.usage.tokensOut;
    if (t.status === "done" && t.startedAt && t.finishedAt) a.durations.push(t.finishedAt - t.startedAt);
    byAgent.set(t.agentId, a);
  }
  return {
    days: [...byDay.values()],
    agents: [...byAgent.values()].map(({ durations, ...a }) => ({
      ...a,
      avgDurationMs: durations.length ? durations.reduce((x, y) => x + y, 0) / durations.length : null,
    })),
  };
}
