import type { NotificationEvents, NotificationStatus } from "@tu-ban/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { fmtDateTime } from "./ui";

const EVENTS: { key: keyof NotificationEvents; label: string; hint: string }[] = [
  { key: "approval", label: "Agent cần duyệt", hint: "Gửi ngay khi một agent chờ bạn bấm Duyệt." },
  { key: "done", label: "Yêu cầu hoàn thành", hint: "Khi một yêu cầu (không tính việc con) xong, kèm tóm tắt kết quả." },
  { key: "error", label: "Yêu cầu lỗi", hint: "Khi một yêu cầu kết thúc với lỗi." },
  { key: "budget", label: "Ngân sách ngày", hint: "Khi chi tiêu trong ngày chạm 80% và 100% (chỉ khi có đặt ngân sách ngày)." },
];

const CHANNELS = [
  { id: "telegram" as const, label: "Telegram", env: "TELEGRAM_BOT_TOKEN=…  TELEGRAM_CHAT_ID=…" },
  { id: "slack" as const, label: "Slack", env: "SLACK_WEBHOOK_URL=https://hooks.slack.com/services/…" },
];

/** Admin: which events notify, channel status, test message. */
export function NotificationsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="small-dialog wide"
      aria-labelledby="notify-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header className="history-header">
        <h2 id="notify-title">Thông báo</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Đóng">
          ✕
        </button>
      </header>
      <div className="small-dialog-body">{open && <NotificationsBody />}</div>
    </dialog>
  );
}

function NotificationsBody() {
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<NotificationStatus>("GET", "/api/settings/notifications")
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (!status) return <p className={error ? "error" : "muted empty"}>{error || "Đang tải…"}</p>;
  const anyChannel = CHANNELS.some((c) => status.channels[c.id].configured);

  const toggle = async (key: keyof NotificationEvents, on: boolean) => {
    setError("");
    const before = status;
    // show the change at once; roll back if the server refuses it
    setStatus({ ...status, events: { ...status.events, [key]: on } });
    try {
      setStatus(await api<NotificationStatus>("PUT", "/api/settings/notifications", { [key]: on }));
    } catch (e) {
      setStatus(before);
      setError((e as Error).message);
    }
  };

  const test = async () => {
    setBusy(true);
    setError("");
    setTestResult(null);
    try {
      const r = await api<{ results: Record<string, string>; status: NotificationStatus }>("POST", "/api/settings/notifications/test", {});
      setTestResult(r.results);
      setStatus(r.status);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-form">
      <fieldset className="settings-group">
        <legend>Kênh gửi</legend>
        <ul className="channels">
          {CHANNELS.map((c) => {
            const ch = status.channels[c.id];
            return (
              <li key={c.id} className="channel">
                <div>
                  <strong>{c.label}</strong>{" "}
                  <span className={`kind-badge ${ch.configured ? "ok" : "off"}`}>{ch.configured ? "Đã cấu hình" : "Chưa cấu hình"}</span>
                  {ch.lastError && <div className="error">Lần gửi gần nhất lỗi: {ch.lastError}</div>}
                  {testResult?.[c.id] && (
                    <div className={testResult[c.id] === "ok" ? "success" : "error"}>
                      Gửi thử: {testResult[c.id] === "ok" ? "thành công" : testResult[c.id]}
                    </div>
                  )}
                </div>
                {!ch.configured && <code className="env-hint">{c.env}</code>}
              </li>
            );
          })}
        </ul>
        <p className="muted">
          Token và webhook đặt bằng biến môi trường trên server (rồi khởi động lại), không lưu trong database và không hiện ở đây. Link trong
          tin nhắn trỏ về <code>{status.publicUrl}</code>: đặt <code>PUBLIC_URL</code> nếu địa chỉ này sai.
        </p>
        <div className="detail-actions">
          <button type="button" className="secondary" disabled={!anyChannel || busy} onClick={() => void test()}>
            {busy ? "Đang gửi…" : "Gửi thử"}
          </button>
          {status.lastSentAt && <span className="muted">Gửi gần nhất: {fmtDateTime(status.lastSentAt)}</span>}
        </div>
      </fieldset>

      <fieldset className="settings-group">
        <legend>Gửi thông báo khi</legend>
        <ul className="skill-checks">
          {EVENTS.map((ev) => (
            <li key={ev.key}>
              <label>
                <input type="checkbox" checked={status.events[ev.key]} onChange={(e) => void toggle(ev.key, e.target.checked)} />
                <span>
                  <strong>{ev.label}</strong>
                  <span className="muted"> · {ev.hint}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        {!anyChannel && <p className="muted">Chưa có kênh nào được cấu hình, nên hiện chưa gửi gì.</p>}
      </fieldset>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
