import type { BudgetSettings, DayStats, StatsResponse } from "@tu-ban/shared";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useStore } from "./store";
import { fmtCost, fmtDuration, fmtTokens } from "./ui";

const RANGES = [7, 14, 30];

/** Statistics (everyone) and spending limits (admins edit, members read). */
export function StatsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="small-dialog wide stats-dialog"
      aria-labelledby="stats-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header className="history-header">
        <h2 id="stats-title">Thống kê &amp; ngân sách</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Đóng">
          ✕
        </button>
      </header>
      <div className="small-dialog-body">{open && <StatsBody />}</div>
    </dialog>
  );
}

function StatsBody() {
  const [days, setDays] = useState(14);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState("");
  const agents = useStore((s) => s.agents);

  const load = () =>
    api<StatsResponse>("GET", `/api/stats?days=${days}`)
      .then((s) => {
        setStats(s);
        setError("");
      })
      .catch((e: Error) => setError(`Không tải được thống kê (${e.message})`));

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30000);
    return () => clearInterval(t);
  }, [days]);

  if (!stats) return <p className={error ? "error" : "muted empty"}>{error || "Đang tải…"}</p>;

  const totals = stats.days.reduce(
    (a, d) => ({ cost: a.cost + d.costUsd, requests: a.requests + d.requests, done: a.done + d.done, errors: a.errors + d.errors }),
    { cost: 0, requests: 0, done: 0, errors: 0 },
  );
  const finished = totals.done + totals.errors;
  const daily = stats.budget.dailyUsd;
  const usedPct = daily > 0 ? Math.min(100, (stats.today.costUsd / daily) * 100) : 0;

  return (
    <div className="stats">
      <div className="stats-toolbar" role="group" aria-label="Khoảng thời gian">
        {RANGES.map((r) => (
          <button key={r} type="button" className={`chip ${r === days ? "on" : ""}`} aria-pressed={r === days} onClick={() => setDays(r)}>
            {r} ngày
          </button>
        ))}
        <span className="muted">Múi giờ: {stats.timeZone}</span>
      </div>

      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Chi phí hôm nay</span>
          <span className="kpi-value">{fmtCost(stats.today.costUsd)}</span>
          {daily > 0 ? (
            <>
              <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={daily} aria-valuenow={stats.today.costUsd} aria-label="Đã dùng ngân sách ngày">
                <div className={`meter-fill ${usedPct >= 100 ? "over" : usedPct >= 80 ? "near" : ""}`} style={{ width: `${usedPct}%` }} />
              </div>
              <span className="kpi-sub">
                {usedPct >= 100 ? "⚠ Đã hết" : `${Math.round(usedPct)}%`} ngân sách ngày {fmtCost(daily)}
              </span>
            </>
          ) : (
            <span className="kpi-sub">Không giới hạn theo ngày</span>
          )}
        </div>
        <div className="kpi">
          <span className="kpi-label">Yêu cầu hôm nay</span>
          <span className="kpi-value">{stats.today.requests}</span>
          <span className="kpi-sub">
            {stats.today.done} xong · {stats.today.errors} lỗi
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Tỉ lệ thành công ({days} ngày)</span>
          <span className="kpi-value">{finished ? `${Math.round((totals.done / finished) * 100)}%` : "—"}</span>
          <span className="kpi-sub">
            {totals.done}/{finished} yêu cầu đã kết thúc
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Tổng chi phí ({days} ngày)</span>
          <span className="kpi-value">{fmtCost(totals.cost)}</span>
          <span className="kpi-sub">{totals.requests} yêu cầu</span>
        </div>
      </div>

      <div className="charts">
        <BarChart title="Chi phí mỗi ngày (USD)" days={stats.days} value={(d) => d.costUsd} format={fmtCost} />
        <BarChart title="Số yêu cầu mỗi ngày" days={stats.days} value={(d) => d.requests} format={(n) => String(n)} integer />
      </div>
      <details className="table-view">
        <summary>Xem số liệu theo ngày dạng bảng</summary>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Ngày</th>
              <th scope="col">Yêu cầu</th>
              <th scope="col">Xong</th>
              <th scope="col">Lỗi</th>
              <th scope="col">Token</th>
              <th scope="col">Chi phí</th>
            </tr>
          </thead>
          <tbody>
            {[...stats.days].reverse().map((d) => (
              <tr key={d.date}>
                <td>{fmtDay(d.date)}</td>
                <td>{d.requests}</td>
                <td>{d.done}</td>
                <td>{d.errors}</td>
                <td>{fmtTokens(d.tokens)}</td>
                <td>{fmtCost(d.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <h3 className="stats-h">Theo agent ({days} ngày, gồm cả việc con)</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Task</th>
            <th scope="col">Thành công</th>
            <th scope="col">Thời gian TB</th>
            <th scope="col">Token</th>
            <th scope="col">Chi phí</th>
          </tr>
        </thead>
        <tbody>
          {Object.values(agents)
            .sort((a, b) => a.desk - b.desk)
            .map((a) => {
              const s = stats.agents.find((x) => x.agentId === a.id);
              const ended = s ? s.done + s.errors : 0;
              return (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>{s?.tasks ?? 0}</td>
                  <td>{ended ? `${Math.round((s!.done / ended) * 100)}%` : "—"}</td>
                  <td>{s?.avgDurationMs != null ? fmtDuration(s.avgDurationMs) : "—"}</td>
                  <td>{fmtTokens(s?.tokens ?? 0)}</td>
                  <td>{fmtCost(s?.costUsd ?? 0)}</td>
                </tr>
              );
            })}
        </tbody>
      </table>

      <BudgetForm budget={stats.budget} onSaved={() => void load()} />
    </div>
  );
}

const fmtDay = (iso: string) => {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
};

/** Single-series bar chart: thin bars on a baseline, recessive grid, hover tooltip per day. */
function BarChart(props: { title: string; days: DayStats[]; value: (d: DayStats) => number; format: (n: number) => string; integer?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  // small viewBox so that 13-unit text renders at ~11px in a half-width card
  const W = 420;
  const H = 170;
  const pad = { l: 50, r: 6, t: 10, b: 24 };
  const values = props.days.map(props.value);
  const rawMax = Math.max(...values, 0);
  const max = niceMax(rawMax, props.integer);
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const band = plotW / props.days.length;
  const barW = Math.max(3, Math.min(16, band * 0.56));
  const y = (v: number) => pad.t + plotH - (max ? (v / max) * plotH : 0);
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(props.days.length / 6);
  const h = hover === null ? null : { d: props.days[hover], v: values[hover], x: pad.l + band * hover + band / 2 };

  return (
    <figure className="chart">
      <figcaption>{props.title}</figcaption>
      <div className="chart-box">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${props.title}, ${props.days.length} ngày`} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className={t === 0 ? "axis" : "grid"} />
              <text x={pad.l - 6} y={y(t)} className="tick" textAnchor="end" dominantBaseline="middle">
                {props.format(t)}
              </text>
            </g>
          ))}
          {props.days.map((d, i) => {
            const v = values[i];
            const x = pad.l + band * i + (band - barW) / 2;
            const top = y(v);
            const height = pad.t + plotH - top;
            return (
              <g key={d.date}>
                {v > 0 && <path d={roundedTop(x, top, barW, height, Math.min(4, barW / 2, height))} className={`bar ${hover === i ? "on" : ""}`} />}
                {/* count from the newest day so today is always labelled and labels never collide */}
                {(props.days.length - 1 - i) % labelEvery === 0 && (
                  <text x={pad.l + band * i + band / 2} y={H - 6} className="tick" textAnchor="middle">
                    {fmtDay(d.date)}
                  </text>
                )}
                {/* hit target: the whole column, bigger than the bar */}
                <rect x={pad.l + band * i} y={pad.t} width={band} height={plotH} className="hit" onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
        </svg>
        {h && (
          <div className="chart-tip" style={{ left: `${(h.x / W) * 100}%` }} role="status">
            <strong>{fmtDay(h.d.date)}</strong>
            <span>{props.format(h.v)}</span>
            <span className="muted">
              {h.d.done} xong · {h.d.errors} lỗi
            </span>
          </div>
        )}
      </div>
    </figure>
  );
}

function niceMax(v: number, integer?: boolean) {
  if (v <= 0) return integer ? 2 : 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const n = v / exp;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  const out = nice * exp;
  return integer ? Math.max(2, Math.ceil(out / 2) * 2) : out;
}

/** Bar with rounded top corners, square at the baseline. */
function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

const FIELDS: { key: keyof BudgetSettings; label: string; hint: string; step: number; usd?: boolean }[] = [
  { key: "dailyUsd", label: "Ngân sách mỗi ngày", hint: "0 = không giới hạn. Hết ngân sách thì task mới không chạy cho tới ngày hôm sau.", step: 0.5, usd: true },
  { key: "maxRequestUsd", label: "Tối đa mỗi yêu cầu", hint: "Cho cả nhóm: Manager và mọi việc con của một yêu cầu.", step: 0.5, usd: true },
  { key: "maxTaskUsd", label: "Tối đa mỗi task", hint: "Một agent Claude dừng khi tiêu quá số này.", step: 0.1, usd: true },
  { key: "maxSubtasks", label: "Số việc con tối đa", hint: "Mỗi yêu cầu.", step: 1 },
  { key: "maxReviewRounds", label: "Số lần review tối đa", hint: "Mỗi yêu cầu.", step: 1 },
  { key: "maxTurns", label: "Số lượt tối đa", hint: "Mỗi task của agent Claude.", step: 1 },
];

function BudgetForm({ budget, onSaved }: { budget: BudgetSettings; onSaved: () => void }) {
  const isAdmin = useStore((s) => s.auth?.user?.role === "admin");
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map((f) => [f.key, String(budget[f.key])])));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dirty = FIELDS.some((f) => Number(draft[f.key]) !== budget[f.key]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setNotice("");
    try {
      await api("PUT", "/api/settings/budget", Object.fromEntries(FIELDS.map((f) => [f.key, Number(draft[f.key])])));
      setNotice("Đã lưu hạn mức. Áp dụng cho task bắt đầu từ bây giờ.");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form className="settings-group budget-form" onSubmit={save}>
      <h3>Hạn mức chi tiêu</h3>
      {!isAdmin && <p className="muted">Chỉ admin được thay đổi hạn mức.</p>}
      <div className="budget-grid">
        {FIELDS.map((f) => (
          <label key={f.key} className="field">
            <span>
              {f.label}
              {f.usd ? " (USD)" : ""}
            </span>
            <input
              type="number"
              min={0}
              step={f.step}
              value={draft[f.key]}
              disabled={!isAdmin}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              required
            />
            <small className="muted">{f.hint}</small>
          </label>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="success" role="status">
          {notice}
        </p>
      )}
      {isAdmin && (
        <div className="detail-actions">
          <button type="submit" className="primary" disabled={!dirty}>
            Lưu hạn mức
          </button>
        </div>
      )}
    </form>
  );
}
