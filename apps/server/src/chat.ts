import type { Task } from "@tu-ban/shared";
import { clip } from "./providers/types.ts";
import type { Store } from "./store.ts";

/** "@writer do this" → the agent and the rest of the text; anything else goes to the Manager. */
export function routeRequest(store: Store, text: string): { agentId?: string; prompt: string } {
  const at = /^@(\S+)\s+([\s\S]+)$/.exec(text.trim());
  if (at) {
    const key = at[1].toLowerCase();
    const agent = [...store.agents.values()].find((a) => a.id === key || a.name.toLowerCase().replace(/\s+/g, "") === key);
    if (agent) return { agentId: agent.id, prompt: at[2].trim() };
  }
  return { prompt: text.trim() };
}

export function statusText(store: Store) {
  const label = { idle: "rảnh", working: "đang làm", waiting_approval: "chờ duyệt", error: "lỗi" } as const;
  const lines = [...store.agents.values()]
    .filter((a) => a.enabled)
    .map((a) => `• ${a.name}: ${label[a.status]}${a.status === "idle" ? "" : ` — ${clip(a.summary, 80)}`}`);
  return lines.join("\n") || "Không có agent nào đang bật.";
}

export function openRequestsText(store: Store) {
  const open = [...store.tasks.values()].filter(
    (t) => !t.parentId && (t.status === "queued" || t.status === "running" || t.status === "waiting_approval"),
  );
  if (!open.length) return "Không có yêu cầu nào đang chạy.";
  return open.map((t) => `• ${t.id.slice(0, 8)} — ${store.agents.get(t.agentId)?.name}: ${clip(t.title, 70)}`).join("\n");
}

/** A user request by the first characters of its id (at least 4). */
export function findRequest(store: Store, prefix: string): Task | undefined {
  const id = prefix.trim().toLowerCase();
  return id.length >= 4 ? [...store.tasks.values()].find((t) => !t.parentId && t.id.startsWith(id)) : undefined;
}

/** The message that answers a finished request: a head line plus the result cut into chunks. */
export function resultMessages(t: Task, publicUrl: string, chunk: number, maxChunks: number): string[] {
  const head =
    t.status === "done"
      ? `✅ Xong (${t.id.slice(0, 8)}): ${clip(t.title, 80)}`
      : t.status === "error"
        ? `❌ Lỗi (${t.id.slice(0, 8)}): ${clip(t.error ?? "", 300)}`
        : `🛑 Đã huỷ (${t.id.slice(0, 8)})`;
  const body = t.status === "done" ? (t.result ?? "").trim() : "";
  const chunks: string[] = [];
  for (let i = 0; i < body.length && chunks.length < maxChunks; i += chunk) chunks.push(body.slice(i, i + chunk));
  const more = body.length > chunk * maxChunks ? `\n\n… (còn nữa, xem đầy đủ tại ${publicUrl})` : "";
  if (!chunks.length) return [head];
  const out = [`${head}\n\n${chunks[0]}`, ...chunks.slice(1)];
  out[out.length - 1] += more;
  return out;
}

export const isFinished = (t: Task) => t.status === "done" || t.status === "error" || t.status === "cancelled";
