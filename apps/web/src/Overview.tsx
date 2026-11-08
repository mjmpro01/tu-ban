import { ACTIVE_STATUSES, type AgentInfo, NEXT_AGENT_HINTS, type Task } from "@tu-ban/shared";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { useCanCancel } from "./App";
import { actions, store, useStore } from "./store";
import { Portrait, STATUS_LABEL, TASK_LABEL, fmtCost, fmtDuration } from "./ui";

const isActive = (t: Task) => ACTIVE_STATUSES.includes(t.status);

/** Re-render every second for live "running for …" timers. */
function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** One board for the whole office: what each agent does, what waits for whom, and where work goes next. */
export function OverviewBoard() {
  const agents = useStore((s) => s.agents);
  const tasks = useStore((s) => s.tasks);
  const approvals = useStore((s) => s.approvals);
  const [handoffFrom, setHandoffFrom] = useState<Task | null>(null);
  const list = useMemo(() => Object.values(agents).sort((a, b) => a.desk - b.desk), [agents]);
  const all = Object.values(tasks);
  const queued = all.filter((t) => t.status === "queued");
  const openRequests = all.filter((t) => !t.parentId && isActive(t)).sort((a, b) => a.createdAt - b.createdAt);

  return (
    <div className="overview">
      <div className="overview-summary" aria-label="Tóm tắt">
        <SummaryTile label="Đang làm" value={list.filter((a) => a.status === "working").length} />
        <SummaryTile label="Chờ duyệt" value={Object.keys(approvals).length} tone={Object.keys(approvals).length ? "warn" : undefined} />
        <SummaryTile label="Trong hàng đợi" value={queued.length} />
        <SummaryTile label="Yêu cầu đang mở" value={openRequests.length} />
      </div>

      <section aria-labelledby="ov-agents">
        <h2 id="ov-agents" className="overview-h">
          Agent
        </h2>
        <div className="agent-columns">
          {list.map((a) => (
            <AgentColumn key={a.id} agent={a} onHandoff={setHandoffFrom} />
          ))}
        </div>
      </section>

      <section aria-labelledby="ov-flows">
        <h2 id="ov-flows" className="overview-h">
          Luồng công việc đang mở
        </h2>
        {openRequests.length === 0 ? (
          <p className="muted empty">Không có yêu cầu nào đang mở.</p>
        ) : (
          <ul className="flows">
            {openRequests.map((t) => (
              <FlowRow key={t.id} root={t} />
            ))}
          </ul>
        )}
      </section>

      <HandoffDialog from={handoffFrom} onClose={() => setHandoffFrom(null)} />
    </div>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: number; tone?: "warn" }) {
  return (
    <div className={`stat ${tone === "warn" ? "stat-warn" : ""}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function AgentColumn({ agent, onHandoff }: { agent: AgentInfo; onHandoff: (t: Task) => void }) {
  const tasks = useStore((s) => s.tasks);
  const now = useNow();
  const all = Object.values(tasks);
  const current = agent.currentTaskId ? tasks[agent.currentTaskId] : undefined;
  const queue = all.filter((t) => t.agentId === agent.id && t.status === "queued").sort((a, b) => a.createdAt - b.createdAt);
  const recent = all
    .filter((t) => t.agentId === agent.id && (t.status === "done" || t.status === "error"))
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, 3);
  const rootOf = (t: Task) => (t.parentId ? tasks[t.parentId] : undefined);

  return (
    <article className={`agent-col ${agent.enabled ? "" : "is-disabled"}`} aria-label={agent.name}>
      <header className="agent-col-head">
        <Portrait agent={agent} size={36} />
        <div>
          <button type="button" className="link agent-col-name" onClick={() => store.select(agent.id)}>
            {agent.name}
          </button>
          <span className={`status status-${agent.enabled ? agent.status : "off"}`}>{agent.enabled ? STATUS_LABEL[agent.status] : "Đã tắt"}</span>
        </div>
      </header>

      <div className="agent-col-block">
        <h3>Đang làm</h3>
        {current ? (
          <div className={`now-card ${agent.status === "waiting_approval" ? "waiting" : ""}`}>
            <strong>{current.title}</strong>
            {rootOf(current) && <span className="muted">thuộc: {rootOf(current)!.title}</span>}
            <span className="now-step">{agent.summary}</span>
            <span className="muted">
              {current.startedAt ? `đã chạy ${fmtDuration(now - current.startedAt)}` : "đang bắt đầu"}
              {agent.status === "waiting_approval" && " · ⏳ chờ duyệt"}
            </span>
          </div>
        ) : (
          <p className="muted">{agent.enabled ? "Rảnh" : "Agent đang tắt"}</p>
        )}
      </div>

      <div className="agent-col-block">
        <h3>Hàng đợi ({queue.length})</h3>
        {queue.length === 0 ? (
          <p className="muted">Trống</p>
        ) : (
          <ol className="queue">
            {queue.map((t) => (
              <QueueItem key={t.id} task={t} root={rootOf(t)} />
            ))}
          </ol>
        )}
      </div>

      <div className="agent-col-block">
        <h3>Vừa xong</h3>
        {recent.length === 0 ? (
          <p className="muted">Chưa có</p>
        ) : (
          <ul className="recent">
            {recent.map((t) => (
              <li key={t.id}>
                <span className={`task-status ts-${t.status}`}>{TASK_LABEL[t.status]}</span> {t.title}
                <div className="recent-meta muted">
                  {t.finishedAt && t.startedAt ? fmtDuration(t.finishedAt - t.startedAt) : ""}
                  {t.usage.costUsd > 0 ? ` · ${fmtCost(t.usage.costUsd)}` : ""}
                </div>
                {t.status === "done" && t.kind !== "review" && (
                  <button type="button" className="secondary small" onClick={() => onHandoff(t)}>
                    Bàn giao tiếp →
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

function QueueItem({ task, root }: { task: Task; root?: Task }) {
  const agents = useStore((s) => s.agents);
  const canMove = useCanCancel(task);
  const [error, setError] = useState("");
  const targets = Object.values(agents).filter(
    (a) => a.enabled && a.id !== task.agentId && !(task.parentId && a.id === "manager"),
  );
  const move = async (agentId: string) => {
    if (!agentId) return;
    setError("");
    try {
      await api("POST", `/api/tasks/${task.id}/reassign`, { agentId });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <li>
      <span>{task.title}</span>
      {root && <div className="muted">thuộc: {root.title}</div>}
      {canMove && (
        <div className="queue-actions">
          <select aria-label={`Chuyển "${task.title}" cho agent khác`} value="" onChange={(e) => void move(e.target.value)}>
            <option value="">Chuyển cho…</option>
            {targets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.status === "idle" ? " (rảnh)" : ""}
              </option>
            ))}
          </select>
          <button type="button" className="link" onClick={() => actions.cancelTask(task.id)}>
            Huỷ
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </li>
  );
}

/** A request and its steps in order, and who it is waiting on right now. */
function FlowRow({ root }: { root: Task }) {
  const tasks = useStore((s) => s.tasks);
  const agents = useStore((s) => s.agents);
  const now = useNow();
  const steps = Object.values(tasks)
    .filter((t) => t.parentId === root.id)
    .sort((a, b) => a.createdAt - b.createdAt);
  const activeSteps = steps.filter(isActive);
  const waitingOn = activeSteps.length ? activeSteps : [root];
  const followed = root.followUpOf ? tasks[root.followUpOf] : undefined;
  const name = (id: string) => agents[id]?.name ?? id;

  return (
    <li className="flow">
      <div className="flow-head">
        <strong>{root.title}</strong>
        <span className="muted">
          {root.createdBy ? `${root.createdBy} · ` : ""}mở {fmtDuration(now - root.createdAt)}
          {followed && ` · tiếp nối "${followed.title}" của ${name(followed.agentId)}`}
        </span>
      </div>
      <ol className="flow-steps" aria-label="Các bước">
        <FlowStep agent={agents[root.agentId]} label={root.agentId === "manager" ? "Điều phối" : root.title} status={root.status} />
        {steps.map((s) => (
          <FlowStep key={s.id} agent={agents[s.agentId]} label={s.kind === "review" ? "Review" : s.title} status={s.status} />
        ))}
      </ol>
      <div className="flow-waiting">
        Đang chờ:{" "}
        {waitingOn.map((t, i) => (
          <span key={t.id}>
            {i > 0 && ", "}
            <strong>{name(t.agentId)}</strong> ({TASK_LABEL[t.status].toLowerCase()})
          </span>
        ))}
      </div>
    </li>
  );
}

function FlowStep({ agent, label, status }: { agent?: AgentInfo; label: string; status: Task["status"] }) {
  return (
    <li className={`flow-step fs-${status}`} title={`${agent?.name ?? ""}: ${label} · ${TASK_LABEL[status]}`}>
      {agent && <Portrait agent={agent} size={22} />}
      <span className="flow-step-text">
        <strong>{agent?.name}</strong>
        <span>{label}</span>
      </span>
      <span className={`task-status ts-${status}`}>{TASK_LABEL[status]}</span>
    </li>
  );
}

/** Continue a finished task with another agent; the previous result is passed on as context. */
function HandoffDialog({ from, onClose }: { from: Task | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (from && !d.open) d.showModal();
    if (!from && d.open) d.close();
  }, [from]);
  return (
    <dialog
      ref={ref}
      className="small-dialog"
      aria-labelledby="handoff-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header className="history-header">
        <h2 id="handoff-title">Bàn giao tiếp</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Đóng">
          ✕
        </button>
      </header>
      <div className="small-dialog-body">{from && <HandoffForm key={from.id} from={from} onDone={onClose} />}</div>
    </dialog>
  );
}

function HandoffForm({ from, onDone }: { from: Task; onDone: () => void }) {
  const agents = useStore((s) => s.agents);
  const fromAgent = agents[from.agentId];
  const candidates = Object.values(agents)
    .filter((a) => a.enabled && a.id !== from.agentId)
    .sort((a, b) => a.desk - b.desk);
  const hints = (NEXT_AGENT_HINTS[from.agentId] ?? []).filter((id) => candidates.some((c) => c.id === id));
  const suggested = hints[0] ?? candidates[0]?.id ?? "";
  const [agentId, setAgentId] = useState(suggested);
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("POST", `/api/tasks/${from.id}/handoff`, { agentId, instructions });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-form" onSubmit={submit}>
      <div>
        <div className="muted">
          Từ {fromAgent?.name ?? from.agentId}: <strong>{from.title}</strong>
        </div>
        <details>
          <summary>Kết quả sẽ được chuyển kèm</summary>
          <pre>{from.result}</pre>
        </details>
      </div>
      <fieldset className="settings-group">
        <legend>Giao cho</legend>
        <div className="handoff-targets" role="radiogroup">
          {candidates.map((a) => (
            <label key={a.id} className={`handoff-target ${agentId === a.id ? "on" : ""}`}>
              <input type="radio" name="handoff-agent" value={a.id} checked={agentId === a.id} onChange={() => setAgentId(a.id)} />
              <Portrait agent={a} size={28} />
              <span>
                <span className="handoff-name">
                  <strong>{a.name}</strong>
                  {a.id === suggested && <span className="kind-badge ok">Gợi ý</span>}
                </span>
                <span className="muted">
                  {a.role} · {a.status === "idle" ? "rảnh" : STATUS_LABEL[a.status].toLowerCase()}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span>Việc cần làm tiếp</span>
        <textarea
          rows={4}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={`Ví dụ: Dựa trên kết quả của ${fromAgent?.name ?? "agent trước"}, viết bản tóm tắt 1 trang cho khách hàng`}
          required
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="detail-actions">
        <button type="submit" className="primary" disabled={busy || !agentId || !instructions.trim()}>
          {busy ? "Đang giao…" : `Giao cho ${agents[agentId]?.name ?? "…"}`}
        </button>
      </div>
    </form>
  );
}
