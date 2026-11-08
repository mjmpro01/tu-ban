import type { Approval, Task } from "@tu-ban/shared";
import {
  PUBLIC_URL,
  TELEGRAM_ADMIN_CHATS,
  TELEGRAM_ALLOWED_CHATS,
  TELEGRAM_API_BASE,
  TELEGRAM_BOT_COMMANDS,
  TELEGRAM_BOT_TOKEN,
} from "./config.ts";
import { findRequest, isFinished, openRequestsText, resultMessages, routeRequest, statusText } from "./chat.ts";
import type { Memory } from "./memory.ts";
import type { Actor, Orchestrator } from "./orchestrator.ts";
import { clip } from "./providers/types.ts";
import type { Store } from "./store.ts";

const POLL_TIMEOUT_S = 25;
/** Messages older than this when the server sees them (sent while it was off) are not acted on. */
const MAX_AGE_S = 10 * 60;
const CHUNK = 3900;
const MAX_CHUNKS = 3;

export interface TelegramBotStatus {
  enabled: boolean;
  ok: boolean;
  username?: string;
  lastError?: string;
  allowedChats: number;
  adminChats: number;
}

type TgUser = { id: number; first_name?: string; username?: string };
type TgMessage = { message_id: number; date: number; chat: { id: number; type: string }; from?: TgUser; text?: string };
type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; data?: string; message?: TgMessage };
};

const HELP = `Văn phòng AI — gửi tin nhắn là giao việc cho Manager.
• @writer <việc> — giao thẳng cho một agent (manager, researcher, writer, cursor, copilot)
• /trangthai — các agent đang làm gì
• /viec — các yêu cầu đang chạy
• /huy <mã> — huỷ một yêu cầu (mã là 8 ký tự đầu)
• /timnho <từ khoá> — tìm trong bộ nhớ chung
• /nho <nội dung> — ghi vào bộ nhớ chung
Khi agent cần duyệt, tin nhắn có nút Duyệt / Từ chối.`;

/**
 * Telegram as a second front door: people send requests and approve actions from their phone.
 * Uses long polling (getUpdates), so the server needs no public address.
 */
export class TelegramBot {
  private offset = 0;
  private running = false;
  private abort = new AbortController();
  private ok = false;
  private lastError?: string;
  private username?: string;
  /** Chats already told they are not allowed (answer once, not on every message). */
  private refused = new Set<string>();
  /** Requests already answered. */
  private answered = new Set<string>();

  constructor(
    private store: Store,
    private orchestrator: Orchestrator,
    private memory?: Memory,
  ) {}

  get enabled() {
    return TELEGRAM_BOT_COMMANDS;
  }

  status(): TelegramBotStatus {
    return {
      enabled: this.enabled,
      ok: this.ok,
      username: this.username,
      lastError: this.lastError,
      allowedChats: TELEGRAM_ALLOWED_CHATS.length,
      adminChats: TELEGRAM_ADMIN_CHATS.length,
    };
  }

  init() {
    if (!this.enabled) return;
    for (const t of this.store.tasks.values()) if (t.source === "telegram") this.answered.add(t.id);
    this.store.subscribe({ agent: () => {}, event: () => {}, approval: () => {}, task: (t) => this.onTask(t) });
    this.running = true;
    void this.loop();
    console.log(`[telegram] nhận lệnh từ ${TELEGRAM_ALLOWED_CHATS.length} chat`);
  }

  stop() {
    this.running = false;
    this.abort.abort();
  }

  /** Inline buttons for an approval message. */
  static approvalMarkup(a: Approval) {
    return {
      inline_keyboard: [
        [
          { text: "✅ Duyệt", callback_data: `ap:${a.id}:y` },
          { text: "✋ Từ chối", callback_data: `ap:${a.id}:n` },
        ],
      ],
    };
  }

  // ---------------------------------------------------------------- Bot API
  private async api<T>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    // never put the URL in an error: it contains the token
    if (!res.ok || !j.ok) throw new Error(`${method}: ${j.description ?? `HTTP ${res.status}`}`);
    return j.result as T;
  }

  private send(chatId: number | string, text: string, extra: Record<string, unknown> = {}) {
    // plain text (no parse_mode): nothing in an agent's answer can be read as markup
    return this.api("sendMessage", { chat_id: chatId, text: text.slice(0, 4096), disable_web_page_preview: true, ...extra }).catch((e) =>
      console.warn(`[telegram] gửi thất bại: ${(e as Error).message}`),
    );
  }

  private async loop() {
    let backoff = 2000;
    try {
      const me = await this.api<{ username?: string }>("getMe", {});
      this.username = me.username;
    } catch (e) {
      this.lastError = (e as Error).message;
    }
    while (this.running) {
      try {
        const updates = await this.api<TgUpdate[]>(
          "getUpdates",
          { offset: this.offset, timeout: POLL_TIMEOUT_S, allowed_updates: ["message", "callback_query"] },
          (POLL_TIMEOUT_S + 10) * 1000,
        );
        this.ok = true;
        this.lastError = undefined;
        backoff = 2000;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handle(u).catch((e) => console.warn(`[telegram] lỗi xử lý: ${(e as Error).message}`));
        }
      } catch (e) {
        if (!this.running) return;
        this.ok = false;
        this.lastError = (e as Error).name === "TimeoutError" ? "hết thời gian chờ" : (e as Error).message;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  // ---------------------------------------------------------------- incoming
  private allowed(chatId: number) {
    return TELEGRAM_ALLOWED_CHATS.includes(String(chatId)) || TELEGRAM_ADMIN_CHATS.includes(String(chatId));
  }

  private isAdmin(chatId: number) {
    return TELEGRAM_ADMIN_CHATS.includes(String(chatId));
  }

  private actor(from?: TgUser): Actor {
    const name = from?.first_name || (from?.username ? `@${from.username}` : "?");
    return { id: "", name: `${name} (Telegram)` };
  }

  private async handle(u: TgUpdate) {
    if (u.callback_query) return this.onCallback(u.callback_query);
    const m = u.message;
    if (!m?.text) return;
    const chatId = m.chat.id;
    if (!this.allowed(chatId)) {
      if (!this.refused.has(String(chatId))) {
        this.refused.add(String(chatId));
        await this.send(chatId, `Chat này chưa được phép giao việc. Nhờ admin thêm chat id ${chatId} vào TELEGRAM_ALLOWED_CHATS.`);
      }
      return;
    }
    if (Date.now() / 1000 - m.date > MAX_AGE_S) return;
    const text = m.text.trim();
    // "/cmd@BotName args" in groups
    const cmd = /^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/.exec(text);
    if (cmd) return this.onCommand(m, cmd[1].toLowerCase(), cmd[2].trim());
    return this.onRequest(m, text);
  }

  private async onRequest(m: TgMessage, text: string) {
    const { agentId, prompt } = routeRequest(this.store, text);
    try {
      const task = this.orchestrator.createTask({ prompt, agentId }, this.actor(m.from), {
        source: "telegram",
        sourceRef: `${m.chat.id}:${m.message_id}`,
      });
      const who = this.store.agents.get(task.agentId)?.name ?? task.agentId;
      await this.send(m.chat.id, `📥 Đã giao cho ${who} — mã ${task.id.slice(0, 8)}. Mình sẽ nhắn khi xong.`, {
        reply_to_message_id: m.message_id,
      });
    } catch (e) {
      await this.send(m.chat.id, `Không giao được: ${(e as Error).message}`, { reply_to_message_id: m.message_id });
    }
  }

  private async onCommand(m: TgMessage, cmd: string, arg: string) {
    const chatId = m.chat.id;
    const adminOnly = () => this.send(chatId, "Chỉ chat admin mới được làm việc này.");
    switch (cmd) {
      case "start":
      case "help":
      case "trogiup":
        return this.send(chatId, HELP);
      case "giao":
        return arg ? this.onRequest(m, arg) : this.send(chatId, "Cách dùng: /giao <việc cần làm>");
      case "trangthai":
      case "status":
        return this.send(chatId, statusText(this.store));
      case "viec":
        return this.send(chatId, openRequestsText(this.store));
      case "huy": {
        if (!this.isAdmin(chatId)) return adminOnly();
        const task = findRequest(this.store, arg);
        if (!task) return this.send(chatId, "Không thấy yêu cầu có mã này. Gõ /viec để xem mã.");
        this.orchestrator.cancel(task.id, this.actor(m.from));
        return this.send(chatId, `🛑 Đã huỷ ${task.id.slice(0, 8)}: ${clip(task.title, 80)}`);
      }
      case "timnho": {
        if (!this.memory) return this.send(chatId, "Bộ nhớ chung chưa bật.");
        if (!arg) return this.send(chatId, "Cách dùng: /timnho <từ khoá>");
        try {
          const items = await this.memory.query({ q: arg, limit: 5 });
          return this.send(chatId, items.length ? items.map((x) => `• ${clip(x.text, 300)}`).join("\n") : "Không tìm thấy ghi nhớ nào.");
        } catch (e) {
          return this.send(chatId, `Bộ nhớ lỗi: ${(e as Error).message}`);
        }
      }
      case "nho": {
        if (!this.isAdmin(chatId)) return adminOnly();
        if (!this.memory) return this.send(chatId, "Bộ nhớ chung chưa bật.");
        if (!arg) return this.send(chatId, "Cách dùng: /nho <điều cần nhớ>");
        try {
          const saved = await this.memory.add({ text: arg, scope: "office", createdBy: this.actor(m.from).name });
          return this.send(chatId, saved.length ? "🧠 Đã ghi vào bộ nhớ chung." : "Bộ nhớ đã có điều này rồi.");
        } catch (e) {
          return this.send(chatId, `Không ghi được: ${(e as Error).message}`);
        }
      }
      default:
        return this.send(chatId, `Không hiểu lệnh /${cmd}.\n\n${HELP}`);
    }
  }

  private async onCallback(q: NonNullable<TgUpdate["callback_query"]>) {
    const answer = (text: string) => this.api("answerCallbackQuery", { callback_query_id: q.id, text }).catch(() => {});
    const m = /^ap:([0-9a-f-]{36}):([yn])$/.exec(q.data ?? "");
    const chatId = q.message?.chat.id;
    if (!m || chatId === undefined) return answer("Nút không hợp lệ");
    if (!this.isAdmin(chatId)) return answer("Chat này không có quyền duyệt");
    const before = this.store.approvals.get(m[1]);
    if (!before || before.status !== "pending") return answer("Yêu cầu này đã được xử lý rồi");
    const approve = m[2] === "y";
    const actor = this.actor(q.from);
    this.orchestrator.decide(m[1], approve, actor);
    await answer(approve ? "Đã duyệt" : "Đã từ chối");
    if (q.message?.text)
      await this.api("editMessageText", {
        chat_id: chatId,
        message_id: q.message.message_id,
        text: `${q.message.text}\n\n→ ${approve ? "✅ Đã duyệt" : "✋ Đã từ chối"} bởi ${actor.name}`,
      }).catch(() => {});
  }

  // ---------------------------------------------------------------- answers
  private onTask(t: Task) {
    if (t.source !== "telegram" || t.parentId || !t.sourceRef || this.answered.has(t.id)) return;
    if (!isFinished(t)) return;
    this.answered.add(t.id);
    const [chatId, messageId] = t.sourceRef.split(":");
    const parts = resultMessages(t, PUBLIC_URL, CHUNK, MAX_CHUNKS);
    void (async () => {
      await this.send(chatId, parts[0], { reply_to_message_id: Number(messageId) || undefined, allow_sending_without_reply: true });
      for (const p of parts.slice(1)) await this.send(chatId, p);
    })();
  }
}
