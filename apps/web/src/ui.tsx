import type { AgentEvent, AgentInfo, ProviderId, Task } from "@tu-ban/shared";

export const PROVIDER_LABEL: Record<ProviderId, string> = { claude: "Claude", cursor: "Cursor", copilot: "Copilot", mock: "Demo" };
export const STATUS_LABEL: Record<AgentInfo["status"], string> = {
  idle: "Rảnh",
  working: "Đang làm",
  waiting_approval: "Chờ duyệt",
  error: "Lỗi",
};
export const TASK_LABEL: Record<Task["status"], string> = {
  queued: "Chờ",
  running: "Đang chạy",
  waiting_approval: "Chờ duyệt",
  done: "Xong",
  error: "Lỗi",
  cancelled: "Đã huỷ",
};

export const fmtCost = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
export const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const fmtDateTime = (ts: number) =>
  new Date(ts).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
export function fmtDuration(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} giây`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} phút ${s % 60} giây` : `${Math.floor(m / 60)} giờ ${m % 60} phút`;
}

export function Portrait({ agent, size = 40 }: { agent: AgentInfo; size?: number }) {
  return <img className="portrait" src={`/portraits/portrait_${agent.character}.png`} width={size} height={size} alt="" />;
}

export const EVENT_ICON: Record<AgentEvent["type"], string> = {
  task_start: "▶",
  thinking: "💭",
  message: "💬",
  tool_start: "🔧",
  tool_end: "✓",
  handoff: "➜",
  approval_request: "❗",
  approval_resolved: "🛡",
  done: "✅",
  error: "⚠",
  meeting: "👥",
  config: "⚙",
  memory: "🧠",
};

export function TimelineItem({ event, agent }: { event: AgentEvent; agent?: AgentInfo }) {
  return (
    <li className={`event event-${event.type}`}>
      <span className="event-icon" aria-hidden>
        {EVENT_ICON[event.type]}
      </span>
      <div className="event-body">
        <div className="event-head">
          <strong>{agent?.name ?? event.agentId}</strong>
          <time>{fmtTime(event.ts)}</time>
        </div>
        <div className="event-summary">{event.summary}</div>
        {event.detail && event.detail !== event.summary && (
          <details>
            <summary>Chi tiết</summary>
            <pre>{event.detail}</pre>
          </details>
        )}
      </div>
    </li>
  );
}
