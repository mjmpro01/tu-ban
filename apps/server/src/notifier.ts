import type { Approval, NotificationEvents, NotificationStatus, Task } from "@tu-ban/shared";
import { type Budget, startOfToday } from "./budget.ts";
import { PUBLIC_URL, SLACK_WEBHOOK_URL, TELEGRAM_API_BASE, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from "./config.ts";
import type { Store } from "./store.ts";

export const DEFAULT_EVENTS: NotificationEvents = { approval: true, done: true, error: true, budget: true };

const SEND_TIMEOUT_MS = 10_000;
const MAX_QUEUE = 50;

type Channel = "telegram" | "slack";

/** Sends short messages to Telegram and/or Slack when something needs a human or a request ends. */
export class Notifier {
  private events: NotificationEvents = { ...DEFAULT_EVENTS };
  private queue: string[] = [];
  private sending = false;
  private lastError: Record<Channel, string | undefined> = { telegram: undefined, slack: undefined };
  private lastSentAt: number | undefined;
  /** Requests already announced (a task object is re-sent on every change). */
  private announced = new Set<string>();
  /** Budget thresholds already announced, per day ("<midnight ms>:80"). */
  private budgetAlerts = new Set<string>();

  constructor(
    private store: Store,
    private budget: Budget,
  ) {}

  private get channels(): Channel[] {
    const list: Channel[] = [];
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) list.push("telegram");
    if (SLACK_WEBHOOK_URL) list.push("slack");
    return list;
  }

  async init() {
    const saved = await this.store.db?.loadSetting<Partial<NotificationEvents>>("notifications");
    if (saved) this.events = { ...this.events, ...pickEvents(saved) };
    // tasks restored from the database are not news
    for (const t of this.store.tasks.values()) if (t.status === "done" || t.status === "error" || t.status === "cancelled") this.announced.add(t.id);
    this.store.subscribe({
      agent: () => {},
      event: () => {},
      task: (t) => this.onTask(t),
      approval: (a) => this.onApproval(a),
    });
    if (this.channels.length) console.log(`[notify] kênh thông báo: ${this.channels.join(", ")}`);
  }

  status(): NotificationStatus {
    return {
      events: this.events,
      channels: {
        telegram: { configured: this.channels.includes("telegram"), lastError: this.lastError.telegram },
        slack: { configured: this.channels.includes("slack"), lastError: this.lastError.slack },
      },
      publicUrl: PUBLIC_URL,
      lastSentAt: this.lastSentAt,
    };
  }

  async updateEvents(patch: Partial<NotificationEvents>) {
    this.events = { ...this.events, ...pickEvents(patch) };
    await this.store.db?.saveSetting("notifications", this.events);
    return this.status();
  }

  /** Send a test message right away and report each channel's result. */
  async test(by: string) {
    if (!this.channels.length) throw new Error("Chưa cấu hình kênh nào (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID hoặc SLACK_WEBHOOK_URL)");
    const text = `🔔 Thử thông báo từ Văn phòng AI (gửi bởi ${by}).\n${PUBLIC_URL}`;
    const results: Record<string, string> = {};
    for (const ch of this.channels) {
      try {
        await this.sendTo(ch, text);
        results[ch] = "ok";
      } catch (e) {
        results[ch] = (e as Error).message;
      }
    }
    return { results, status: this.status() };
  }

  // ---------------------------------------------------------------- triggers
  private onApproval(a: Approval) {
    if (a.status !== "pending" || !this.events.approval || this.announced.has(`approval:${a.id}`)) return;
    this.announced.add(`approval:${a.id}`);
    const agent = this.store.agents.get(a.agentId)?.name ?? a.agentId;
    this.push(`⏳ ${agent} cần duyệt: ${a.summary}\nDuyệt tại: ${PUBLIC_URL}`);
  }

  private onTask(t: Task) {
    if (t.status === "done" || t.status === "error") void this.checkBudget();
    // only requests from people: sub-tasks are part of their request
    if (t.parentId || this.announced.has(t.id)) return;
    if (t.status !== "done" && t.status !== "error" && t.status !== "cancelled") return;
    this.announced.add(t.id);
    const agent = this.store.agents.get(t.agentId)?.name ?? t.agentId;
    const who = t.createdBy ? ` (giao bởi ${t.createdBy})` : "";
    const cost = t.usage.costUsd > 0 ? ` · $${t.usage.costUsd.toFixed(3)}` : "";
    if (t.status === "done" && this.events.done)
      this.push(`✅ ${agent} xong: ${t.title}${who}${cost}\n${clip(t.result ?? "", 300)}\n${PUBLIC_URL}`);
    if (t.status === "error" && this.events.error) this.push(`❌ ${agent} gặp lỗi: ${t.title}${who}\n${clip(t.error ?? "", 300)}\n${PUBLIC_URL}`);
  }

  private async checkBudget() {
    const daily = this.budget.settings.dailyUsd;
    if (!this.events.budget || daily <= 0) return;
    const spent = await this.budget.refresh();
    const day = String(startOfToday()); // the budget's day, in the server time zone
    for (const pct of [100, 80]) {
      if (spent < (daily * pct) / 100) continue;
      const key = `${day}:${pct}`;
      if (this.budgetAlerts.has(key)) return;
      this.budgetAlerts.add(key);
      if (pct === 100) this.budgetAlerts.add(`${day}:80`);
      this.push(
        pct === 100
          ? `🛑 Đã hết ngân sách ngày: $${spent.toFixed(2)} / $${daily}. Task mới sẽ không chạy tới ngày mai.\n${PUBLIC_URL}`
          : `⚠️ Đã dùng ${Math.round((spent / daily) * 100)}% ngân sách ngày: $${spent.toFixed(2)} / $${daily}.\n${PUBLIC_URL}`,
      );
      return;
    }
  }

  // ---------------------------------------------------------------- sending
  private push(text: string) {
    if (!this.channels.length) return;
    if (this.queue.length >= MAX_QUEUE) return; // drop rather than flood
    this.queue.push(text);
    void this.drain();
  }

  private async drain() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const text = this.queue.shift()!;
        for (const ch of this.channels) await this.sendTo(ch, text).catch(() => {});
      }
    } finally {
      this.sending = false;
    }
  }

  private async sendTo(channel: Channel, text: string) {
    try {
      const res =
        channel === "telegram"
          ? await fetch(`${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              // plain text (no parse_mode): nothing in the message can be interpreted as markup
              body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text.slice(0, 4000), disable_web_page_preview: true }),
              signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
            })
          : await fetch(SLACK_WEBHOOK_URL!, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ text: slackEscape(text.slice(0, 3000)) }),
              signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
            });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${clip(await res.text().catch(() => ""), 120)}`);
      this.lastError[channel] = undefined;
      this.lastSentAt = Date.now();
    } catch (e) {
      // never log the URL: it contains the bot token / webhook secret
      const msg = (e as Error).name === "TimeoutError" ? "hết thời gian chờ" : (e as Error).message;
      this.lastError[channel] = msg;
      console.warn(`[notify] gửi ${channel} thất bại: ${msg}`);
      throw new Error(msg);
    }
  }
}

function pickEvents(input: Partial<NotificationEvents>): Partial<NotificationEvents> {
  const out: Partial<NotificationEvents> = {};
  for (const k of Object.keys(DEFAULT_EVENTS) as (keyof NotificationEvents)[]) if (typeof input[k] === "boolean") out[k] = input[k];
  return out;
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** Slack treats &, < and > as control characters in message text. */
const slackEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
