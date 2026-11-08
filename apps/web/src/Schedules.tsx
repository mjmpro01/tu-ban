import { type Schedule, type ScheduleInput, describeCron, parseCron } from "@tu-ban/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { useStore } from "./store";
import { TASK_LABEL } from "./ui";

/** Times in the server's time zone, the one the schedules run in. */
const fmtIn = (ts: number, timeZone: string) =>
  new Date(ts).toLocaleString("vi-VN", { timeZone, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

type Freq = "daily" | "weekdays" | "weekly" | "monthly" | "hourly" | "custom";
const DAYS = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];

/** Turn the simple picker into a cron expression. */
function buildCron(freq: Freq, time: string, weekday: number, monthDay: number, custom: string) {
  const [h, m] = time.split(":").map((x) => Number(x) || 0);
  switch (freq) {
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly":
      return `${m} ${h} * * ${weekday}`;
    case "monthly":
      return `${m} ${h} ${monthDay} * *`;
    case "hourly":
      return `${m} * * * *`;
    default:
      return custom.trim();
  }
}

/** Best guess of the picker settings for an existing cron expression. */
function readCron(cron: string): { freq: Freq; time: string; weekday: number; monthDay: number } {
  const base = { freq: "custom" as Freq, time: "08:00", weekday: 1, monthDay: 1 };
  const p = cron.split(" ");
  if (p.length !== 5 || !/^\d+$/.test(p[0])) return base;
  const time = `${String(Number(p[1]) || 0).padStart(2, "0")}:${p[0].padStart(2, "0")}`;
  if (p[1] === "*" && p[2] === "*" && p[3] === "*" && p[4] === "*") return { ...base, freq: "hourly", time: `00:${p[0].padStart(2, "0")}` };
  if (!/^\d+$/.test(p[1]) || p[3] !== "*") return base;
  if (p[2] === "*" && p[4] === "*") return { ...base, freq: "daily", time };
  if (p[2] === "*" && p[4] === "1-5") return { ...base, freq: "weekdays", time };
  if (p[2] === "*" && /^[0-6]$/.test(p[4])) return { ...base, freq: "weekly", time, weekday: Number(p[4]) };
  if (/^\d+$/.test(p[2]) && p[4] === "*") return { ...base, freq: "monthly", time, monthDay: Number(p[2]) };
  return base;
}

export function SchedulesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
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
      aria-labelledby="schedules-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header className="history-header">
        <h2 id="schedules-title">Lịch chạy định kỳ</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Đóng">
          ✕
        </button>
      </header>
      <div className="small-dialog-body">{open && <SchedulesBody />}</div>
    </dialog>
  );
}

function SchedulesBody() {
  const isAdmin = useStore((s) => s.auth?.user?.role === "admin");
  const [items, setItems] = useState<Schedule[] | null>(null);
  const [timeZone, setTimeZone] = useState("UTC");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);

  const load = () =>
    api<{ timeZone: string; items: Schedule[] }>("GET", "/api/schedules").then(
      (r) => {
        setItems(r.items);
        setTimeZone(r.timeZone);
        setError("");
      },
      (e: Error) => setError(e.message),
    );
  useEffect(() => {
    void load();
    // next/last run times move on their own
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, []);

  if (editing)
    return (
      <ScheduleForm
        initial={editing === "new" ? undefined : editing}
        timeZone={timeZone}
        onDone={() => {
          setEditing(null);
          void load();
        }}
      />
    );

  return (
    <div className="settings-form">
      <p className="muted">
        Agent tự nhận việc theo lịch (giờ {timeZone}), như thể người tạo lịch gửi yêu cầu. Lần chạy bị bỏ qua nếu lần trước chưa xong, agent đang tắt hoặc đã hết
        ngân sách ngày.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {items === null ? (
        <p className="muted empty">Đang tải…</p>
      ) : items.length === 0 ? (
        <p className="muted empty">Chưa có lịch nào.</p>
      ) : (
        <ul className="schedule-list">
          {items.map((s) => (
            <ScheduleRow key={s.id} s={s} timeZone={timeZone} canEdit={isAdmin} onEdit={() => setEditing(s)} onChanged={() => void load()} />
          ))}
        </ul>
      )}
      {isAdmin && (
        <div className="detail-actions">
          <button type="button" className="primary" onClick={() => setEditing("new")}>
            + Thêm lịch
          </button>
        </div>
      )}
    </div>
  );
}

function ScheduleRow({
  s,
  timeZone,
  canEdit,
  onEdit,
  onChanged,
}: {
  s: Schedule;
  timeZone: string;
  canEdit: boolean;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const agents = useStore((st) => st.agents);
  const tasks = useStore((st) => st.tasks);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const last = s.lastTaskId ? tasks[s.lastTaskId] : undefined;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={`schedule-item ${s.enabled ? "" : "off"}`}>
      <div className="schedule-top">
        <strong>{s.name}</strong>
        <span className="kind-badge">{describeCron(s.cron)}</span>
        <span className="muted">→ {s.agentId ? (agents[s.agentId]?.name ?? s.agentId) : "Manager (cả nhóm)"}</span>
        {!s.enabled && <span className="kind-badge off">Đang tắt</span>}
      </div>
      <p className="schedule-prompt">{s.prompt}</p>
      <div className="schedule-meta muted">
        {s.enabled && s.nextRunAt && <span>Lần tới: {fmtIn(s.nextRunAt, timeZone)}</span>}
        {s.lastRunAt && (
          <span>
            Lần trước: {fmtIn(s.lastRunAt, timeZone)}
            {last && ` (${TASK_LABEL[last.status]})`}
          </span>
        )}
        {s.createdBy && <span>Tạo bởi {s.createdBy}</span>}
      </div>
      {s.lastSkip && <p className="error">Bỏ qua lần gần nhất: {s.lastSkip}</p>}
      {canEdit && (
        <div className="detail-actions">
          <button type="button" className="secondary small" disabled={busy} onClick={() => void run(() => api("POST", `/api/schedules/${s.id}/run`, {}))}>
            Chạy ngay
          </button>
          <button
            type="button"
            className="secondary small"
            disabled={busy}
            onClick={() => void run(() => api("PUT", `/api/schedules/${s.id}`, { enabled: !s.enabled }))}
          >
            {s.enabled ? "Tạm dừng" : "Bật lại"}
          </button>
          <button type="button" className="secondary small" onClick={onEdit}>
            Sửa
          </button>
          <button
            type="button"
            className="secondary small danger"
            disabled={busy}
            onClick={() => {
              if (confirm(`Xoá lịch "${s.name}"?`)) void run(() => api("DELETE", `/api/schedules/${s.id}`));
            }}
          >
            Xoá
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </li>
  );
}

function ScheduleForm({ initial, timeZone, onDone }: { initial?: Schedule; timeZone: string; onDone: () => void }) {
  const agents = useStore((s) => s.agents);
  const guess = useMemo(() => readCron(initial?.cron ?? "0 8 * * 1-5"), [initial]);
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [agentId, setAgentId] = useState(initial?.agentId ?? "");
  const [freq, setFreq] = useState<Freq>(guess.freq);
  const [time, setTime] = useState(guess.time);
  const [weekday, setWeekday] = useState(guess.weekday);
  const [monthDay, setMonthDay] = useState(guess.monthDay);
  const [custom, setCustom] = useState(initial?.cron ?? "0 8 * * 1-5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const cron = buildCron(freq, time, weekday, monthDay, custom);
  let cronError = "";
  try {
    parseCron(cron);
  } catch (e) {
    cronError = (e as Error).message;
  }

  const save = async () => {
    setBusy(true);
    setError("");
    const body: ScheduleInput = { name, prompt, cron, agentId: agentId || null };
    try {
      if (initial) await api("PUT", `/api/schedules/${initial.id}`, body);
      else await api("POST", "/api/schedules", body);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-form">
      <label className="field">
        <span>Tên lịch</span>
        <input value={name} maxLength={80} placeholder="Tóm tắt tin công nghệ buổi sáng" onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Yêu cầu gửi cho agent</span>
        <textarea
          rows={4}
          value={prompt}
          maxLength={8000}
          placeholder="Tìm 5 tin công nghệ nổi bật trong 24 giờ qua và tóm tắt mỗi tin 2 câu, kèm link."
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Giao cho</span>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">Manager (tự chia việc cho nhóm)</option>
          {Object.values(agents)
            .filter((a) => a.id !== "manager")
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
      </label>
      <fieldset className="settings-group">
        <legend>Khi nào chạy</legend>
        <div className="field-row">
          <label className="field">
            <span>Tần suất</span>
            <select value={freq} onChange={(e) => setFreq(e.target.value as Freq)}>
              <option value="daily">Mỗi ngày</option>
              <option value="weekdays">Thứ 2 – Thứ 6</option>
              <option value="weekly">Mỗi tuần</option>
              <option value="monthly">Mỗi tháng</option>
              <option value="hourly">Mỗi giờ</option>
              <option value="custom">Tự nhập (cron)</option>
            </select>
          </label>
          {freq === "weekly" && (
            <label className="field">
              <span>Vào</span>
              <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                {DAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
          )}
          {freq === "monthly" && (
            <label className="field">
              <span>Ngày</span>
              <input type="number" min={1} max={28} value={monthDay} onChange={(e) => setMonthDay(Math.max(1, Math.min(28, Number(e.target.value) || 1)))} />
            </label>
          )}
          {freq === "hourly" ? (
            <label className="field">
              <span>Phút thứ</span>
              <input
                type="number"
                min={0}
                max={59}
                value={Number(time.split(":")[1])}
                onChange={(e) => setTime(`00:${String(Math.max(0, Math.min(59, Number(e.target.value) || 0))).padStart(2, "0")}`)}
              />
            </label>
          ) : freq !== "custom" ? (
            <label className="field">
              <span>Lúc</span>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value || "08:00")} />
            </label>
          ) : (
            <label className="field">
              <span>Cron (phút giờ ngày tháng thứ)</span>
              <input value={custom} onChange={(e) => setCustom(e.target.value)} spellCheck={false} />
            </label>
          )}
        </div>
        <p className={cronError ? "error" : "muted"}>
          {cronError || (
            <>
              {describeCron(cron)} · <code>{cron}</code> · giờ {timeZone}
            </>
          )}
        </p>
      </fieldset>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="detail-actions">
        <button type="button" className="primary" disabled={busy || !name.trim() || !prompt.trim() || !!cronError} onClick={() => void save()}>
          {busy ? "Đang lưu…" : initial ? "Lưu" : "Tạo lịch"}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Huỷ
        </button>
      </div>
    </div>
  );
}
