import type { Approval, Task } from "@tu-ban/shared";
import { findRequest, isFinished, openRequestsText, resultMessages, routeRequest, statusText } from "./chat.ts";
import {
  PUBLIC_URL,
  SLACK_ADMIN_USERS,
  SLACK_ALLOWED_CHANNELS,
  SLACK_API_BASE,
  SLACK_APPROVAL_CHANNEL,
  SLACK_APP_TOKEN,
  SLACK_BOT_TOKEN,
} from "./config.ts";
import { fold } from "./memory.ts";
import type { Memory } from "./memory.ts";
import type { Actor, Orchestrator } from "./orchestrator.ts";
import { clip } from "./providers/types.ts";
import type { Store } from "./store.ts";

const CHUNK = 3500;
const MAX_CHUNKS = 3;

const HELP = `Văn phòng AI — nhắc tên bot (hoặc nhắn riêng) để giao việc cho Manager.
• @writer <việc> — giao thẳng cho một agent
• trạng thái — các agent đang làm gì
• việc — các yêu cầu đang chạy
• huỷ <mã> — huỷ một yêu cầu (admin)
• tìm nhớ <từ khoá> / nhớ <nội dung> — bộ nhớ chung`;

/** Slack treats &, < and > as control characters. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Slack message markup back to plain text: <url|label>, <#C123|name>, &amp;… */
export const fromSlack = (s: string) =>
  s
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

type SlackEvent = { type: string; subtype?: string; bot_id?: string; user?: string; text?: string; channel?: string; channel_type?: string; ts?: string; thread_ts?: string };

/** Slack as a front door, over Socket Mode: requests by mention or DM, approvals with buttons. */
export class SlackBot {
  private ws?: WebSocket;
  private running = false;
  private ok = false;
  private lastError?: string;
  private seen = new Set<string>();
  private answered = new Set<string>();
  private announced = new Set<string>();

  constructor(
    private store: Store,
    private orchestrator: Orchestrator,
    private memory?: Memory,
  ) {}

  get enabled() {
    return !!(SLACK_APP_TOKEN && SLACK_BOT_TOKEN);
  }

  status() {
    return { enabled: this.enabled, ok: this.ok, lastError: this.lastError, allowedChannels: SLACK_ALLOWED_CHANNELS.length };
  }

  init() {
    if (!this.enabled) return;
    for (const t of this.store.tasks.values()) if (t.source === "slack") this.answered.add(t.id);
    for (const a of this.store.approvals.values()) this.announced.add(a.id);
    this.store.subscribe({ agent: () => {}, event: () => {}, task: (t) => this.onTask(t), approval: (a) => this.onApproval(a) });
    this.running = true;
    void this.connect();
  }

  stop() {
    this.running = false;
    this.ws?.close();
  }

  private async api<T = Record<string, unknown>>(method: string, body: Record<string, unknown>, token = SLACK_BOT_TOKEN): Promise<T> {
    const res = await fetch(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !j.ok) throw new Error(`${method}: ${j.error ?? `HTTP ${res.status}`}`);
    return j as T;
  }

  private post(channel: string, text: string, extra: Record<string, unknown> = {}) {
    return this.api("chat.postMessage", { channel, text: esc(text.slice(0, 3900)), mrkdwn: false, unfurl_links: false, ...extra }).catch((e) =>
      console.warn(`[slack] gửi thất bại: ${(e as Error).message}`),
    );
  }

  // ---------------------------------------------------------------- connection
  private async connect(backoff = 2000): Promise<void> {
    if (!this.running) return;
    try {
      const { url } = await this.api<{ url: string }>("apps.connections.open", {}, SLACK_APP_TOKEN);
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        this.ok = true;
        this.lastError = undefined;
        console.log("[slack] đã kết nối Socket Mode");
      };
      ws.onmessage = (m) => void this.onFrame(String(m.data)).catch((e) => console.warn(`[slack] lỗi xử lý: ${(e as Error).message}`));
      ws.onclose = () => {
        this.ok = false;
        if (this.running) setTimeout(() => void this.connect(), 1000);
      };
      ws.onerror = () => {
        this.lastError = "WebSocket lỗi";
      };
    } catch (e) {
      this.ok = false;
      this.lastError = (e as Error).message;
      setTimeout(() => void this.connect(Math.min(backoff * 2, 60_000)), backoff);
    }
  }

  private async onFrame(raw: string) {
    const f = JSON.parse(raw) as { type: string; envelope_id?: string; payload?: Record<string, any> };
    if (f.envelope_id) this.ws?.send(JSON.stringify({ envelope_id: f.envelope_id }));
    if (f.type === "disconnect") return this.ws?.close();
    if (f.type === "events_api" && f.payload) {
      const id = f.payload.event_id as string | undefined;
      if (id) {
        if (this.seen.has(id)) return;
        this.seen.add(id);
        if (this.seen.size > 1000) this.seen = new Set([...this.seen].slice(-500));
      }
      return this.onEvent(f.payload.event as SlackEvent);
    }
    if (f.type === "interactive" && f.payload?.type === "block_actions") return this.onAction(f.payload);
  }

  // ---------------------------------------------------------------- incoming
  private actor(user?: string): Actor {
    return { id: "", name: `Slack <${user ?? "?"}>` };
  }

  private async onEvent(e: SlackEvent) {
    if (!e || e.bot_id || e.subtype || !e.channel || !e.user || !e.text) return;
    const dm = e.channel_type === "im";
    // in channels only mentions count (plain messages there are people talking to each other)
    if (!dm && e.type !== "app_mention") return;
    if (e.type === "message" && !dm) return;
    if (!dm && SLACK_ALLOWED_CHANNELS.length && !SLACK_ALLOWED_CHANNELS.includes(e.channel)) {
      return void this.post(e.channel, "Kênh này chưa được phép giao việc cho văn phòng.", { thread_ts: e.ts });
    }
    const text = fromSlack(e.text.replace(/<@[A-Z0-9]+>/g, "")).trim();
    const thread = { thread_ts: e.thread_ts ?? e.ts };
    const admin = SLACK_ADMIN_USERS.includes(e.user);
    const [word, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ");
    const cmd = fold(word ?? "");
    const two = fold(text.split(/\s+/).slice(0, 2).join(" "));
    if (!text || cmd === "help" || cmd === "giup") return void this.post(e.channel, HELP, thread);
    if (two === "trang thai" || cmd === "status") return void this.post(e.channel, statusText(this.store), thread);
    if (cmd === "viec" && !arg) return void this.post(e.channel, openRequestsText(this.store), thread);
    if (cmd === "huy" && /^[0-9a-f]{4,}$/i.test(arg)) {
      if (!admin) return void this.post(e.channel, "Chỉ admin (SLACK_ADMIN_USERS) mới được huỷ.", thread);
      const t = findRequest(this.store, arg);
      if (!t) return void this.post(e.channel, "Không thấy yêu cầu có mã này.", thread);
      this.orchestrator.cancel(t.id, this.actor(e.user));
      return void this.post(e.channel, `🛑 Đã huỷ ${t.id.slice(0, 8)}: ${clip(t.title, 80)}`, thread);
    }
    if (two === "tim nho" && this.memory) {
      const q = text.split(/\s+/).slice(2).join(" ");
      const items = await this.memory.query({ q, limit: 5 }).catch(() => []);
      return void this.post(e.channel, items.length ? items.map((x) => `• ${clip(x.text, 300)}`).join("\n") : "Không tìm thấy ghi nhớ nào.", thread);
    }
    if (cmd === "nho" && arg && this.memory) {
      if (!admin) return void this.post(e.channel, "Chỉ admin mới được ghi vào bộ nhớ chung.", thread);
      const saved = await this.memory.add({ text: arg, scope: "office", createdBy: this.actor(e.user).name }).catch(() => []);
      return void this.post(e.channel, saved.length ? "🧠 Đã ghi vào bộ nhớ chung." : "Bộ nhớ đã có điều này rồi.", thread);
    }
    const { agentId, prompt } = routeRequest(this.store, text);
    try {
      const task = this.orchestrator.createTask({ prompt, agentId }, this.actor(e.user), {
        source: "slack",
        sourceRef: `${e.channel}:${thread.thread_ts}`,
      });
      await this.post(e.channel, `📥 Đã giao cho ${this.store.agents.get(task.agentId)?.name} — mã ${task.id.slice(0, 8)}. Sẽ trả lời trong thread này.`, thread);
    } catch (err) {
      await this.post(e.channel, `Không giao được: ${(err as Error).message}`, thread);
    }
  }

  private async onAction(p: Record<string, any>) {
    const action = p.actions?.[0];
    const user = p.user?.id as string | undefined;
    const channel = p.channel?.id as string | undefined;
    if (!action || !user || !channel || !["approve", "deny"].includes(action.action_id)) return;
    if (!SLACK_ADMIN_USERS.includes(user))
      return void this.api("chat.postEphemeral", { channel, user, text: "Bạn không có quyền duyệt (SLACK_ADMIN_USERS)." }).catch(() => {});
    const a = this.store.approvals.get(action.value);
    const approve = action.action_id === "approve";
    const done = !a || a.status !== "pending";
    if (!done) this.orchestrator.decide(action.value, approve, { id: "", name: p.user?.name ? `${p.user.name} (Slack)` : this.actor(user).name });
    if (p.message?.ts)
      await this.api("chat.update", {
        channel,
        ts: p.message.ts,
        text: esc(`${p.message.text ?? ""}\n→ ${done ? "Đã được xử lý trước đó" : approve ? "✅ Đã duyệt" : "✋ Đã từ chối"}`),
        blocks: [],
      }).catch(() => {});
  }

  // ---------------------------------------------------------------- outgoing
  private onApproval(a: Approval) {
    if (!SLACK_APPROVAL_CHANNEL || a.status !== "pending" || this.announced.has(a.id)) return;
    this.announced.add(a.id);
    const agent = this.store.agents.get(a.agentId)?.name ?? a.agentId;
    const text = `⏳ ${agent} cần duyệt: ${a.summary}`;
    void this.post(SLACK_APPROVAL_CHANNEL, text, {
      blocks: [
        { type: "section", text: { type: "plain_text", text: clip(text, 2900) } },
        {
          type: "actions",
          elements: [
            { type: "button", style: "primary", text: { type: "plain_text", text: "Duyệt" }, action_id: "approve", value: a.id },
            { type: "button", style: "danger", text: { type: "plain_text", text: "Từ chối" }, action_id: "deny", value: a.id },
          ],
        },
      ],
    });
  }

  private onTask(t: Task) {
    if (t.source !== "slack" || t.parentId || !t.sourceRef || this.answered.has(t.id) || !isFinished(t)) return;
    this.answered.add(t.id);
    const [channel, thread_ts] = t.sourceRef.split(":");
    void (async () => {
      for (const part of resultMessages(t, PUBLIC_URL, CHUNK, MAX_CHUNKS)) await this.post(channel, part, { thread_ts });
    })();
  }
}
