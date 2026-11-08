import type { AgentInfo, Approval, Task } from "@tu-ban/shared";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createGame } from "./game/OfficeScene";
import { AgentSettingsDialog } from "./AgentSettings";
import { LoginScreen, PasswordDialog, UserMenu, UsersDialog } from "./Auth";
import { HistoryDialog } from "./History";
import { MemoryDialog } from "./Memory";
import { SchedulesDialog } from "./Schedules";
import { NotificationsDialog } from "./Notifications";
import { OverviewBoard } from "./Overview";
import { StatsDialog } from "./Stats";
import { actions, auth, store, useStore } from "./store";
import { PROVIDER_LABEL, Portrait, STATUS_LABEL, SourceBadge, TASK_LABEL, TimelineItem, fmtCost, fmtTime, fmtTokens } from "./ui";

export function App() {
  const session = useStore((s) => s.auth);
  useEffect(() => {
    void auth.refresh();
  }, []);
  if (!session) return <p className="muted splash">Đang tải…</p>;
  if (!session.user) return <LoginScreen needsSetup={session.needsSetup} />;
  return <Office />;
}

/** True when the current user may cancel this task (admins: any; members: requests they created). */
export function useCanCancel(task: Task) {
  const user = useStore((s) => s.auth?.user);
  const tasks = useStore((s) => s.tasks);
  if (!user) return false;
  if (user.role === "admin") return true;
  let root: Task | undefined = task;
  while (root?.parentId && tasks[root.parentId]) root = tasks[root.parentId];
  return root?.createdById === user.id;
}

function Office() {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usersOpen, setUsersOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [view, setView] = useState<"office" | "overview">(() => {
    try {
      return localStorage.getItem("tuban:view") === "overview" ? "overview" : "office";
    } catch {
      return "office";
    }
  });
  const switchView = (v: "office" | "overview") => {
    setView(v);
    try {
      localStorage.setItem("tuban:view", v);
    } catch {
      /* private mode: just don't remember */
    }
  };
  return (
    <div className="app">
      <main className="office">
        <div className="tabs view-tabs" role="tablist" aria-label="Chế độ xem">
          <button type="button" role="tab" aria-selected={view === "office"} onClick={() => switchView("office")}>
            Văn phòng
          </button>
          <button type="button" role="tab" aria-selected={view === "overview"} onClick={() => switchView("overview")}>
            Bảng tổng quan
          </button>
        </div>
        {/* the game keeps running while the board is shown, so switching back is instant */}
        <GameView visible={view === "office"} />
        {view === "office" ? (
          <p className="hint">Bấm vào một nhân vật để xem riêng hoạt động của agent đó.</p>
        ) : (
          <OverviewBoard />
        )}
      </main>
      <aside className="dashboard">
        <Header
          onOpenHistory={() => setHistoryOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenUsers={() => setUsersOpen(true)}
          onOpenPassword={() => setPasswordOpen(true)}
          onOpenStats={() => setStatsOpen(true)}
          onOpenNotifications={() => setNotifyOpen(true)}
          onOpenMemory={() => setMemoryOpen(true)}
          onOpenSchedules={() => setSchedulesOpen(true)}
        />
        <Composer />
        <Approvals />
        <AgentList />
        <Activity onOpenHistory={() => setHistoryOpen(true)} />
      </aside>
      <HistoryDialog open={historyOpen} onClose={() => setHistoryOpen(false)} />
      <AgentSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <UsersDialog open={usersOpen} onClose={() => setUsersOpen(false)} />
      <PasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
      <StatsDialog open={statsOpen} onClose={() => setStatsOpen(false)} />
      <NotificationsDialog open={notifyOpen} onClose={() => setNotifyOpen(false)} />
      <MemoryDialog open={memoryOpen} onClose={() => setMemoryOpen(false)} />
      <SchedulesDialog open={schedulesOpen} onClose={() => setSchedulesOpen(false)} />
    </div>
  );
}

function GameView({ visible }: { visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const game = useRef<ReturnType<typeof createGame> | null>(null);
  useEffect(() => {
    game.current = createGame(ref.current!);
    return () => {
      game.current?.destroy(true);
      game.current = null;
    };
  }, []);
  useEffect(() => {
    // the canvas was measured while hidden: fit it again when it comes back
    if (visible) requestAnimationFrame(() => game.current?.scale.refresh());
  }, [visible]);
  return <div className="game" ref={ref} hidden={!visible} />;
}

function Header(props: {
  onOpenHistory: () => void;
  onOpenSettings: () => void;
  onOpenUsers: () => void;
  onOpenPassword: () => void;
  onOpenStats: () => void;
  onOpenNotifications: () => void;
  onOpenMemory: () => void;
  onOpenSchedules: () => void;
}) {
  const { onOpenHistory, onOpenSettings } = props;
  const isAdmin = useStore((s) => s.auth?.user?.role === "admin");
  const connected = useStore((s) => s.connected);
  const mode = useStore((s) => s.mode);
  const agents = useStore((s) => s.agents);
  const tasks = useStore((s) => s.tasks);
  const totals = useMemo(() => {
    const list = Object.values(agents);
    return {
      cost: list.reduce((n, a) => n + a.usage.costUsd, 0),
      tokens: list.reduce((n, a) => n + a.usage.tokensIn + a.usage.tokensOut, 0),
      working: list.filter((a) => a.status !== "idle").length,
    };
  }, [agents]);
  const active = Object.values(tasks).filter((t) => t.status === "running" || t.status === "waiting_approval" || t.status === "queued").length;
  return (
    <header className="header">
      <div className="title">
        <h1>Văn phòng AI</h1>
        <span className={`pill ${connected ? "ok" : "bad"}`}>{connected ? "Đã kết nối" : "Mất kết nối"}</span>
        {mode && <span className={`pill ${mode === "live" ? "live" : "demo"}`}>{mode === "live" ? "Live" : "Demo"}</span>}
        <UserMenu onOpenUsers={props.onOpenUsers} onOpenPassword={props.onOpenPassword} onOpenNotifications={props.onOpenNotifications} />
      </div>
      <nav className="header-nav" aria-label="Màn hình">
        <button type="button" className="secondary small" onClick={onOpenHistory}>
          Lịch sử
        </button>
        <button type="button" className="secondary small" onClick={props.onOpenStats}>
          Thống kê
        </button>
        <button type="button" className="secondary small" onClick={props.onOpenSchedules}>
          Lịch chạy
        </button>
        <button type="button" className="secondary small" onClick={props.onOpenMemory}>
          Bộ nhớ
        </button>
        {isAdmin && (
          <button type="button" className="secondary small" onClick={onOpenSettings}>
            Quản lý agent
          </button>
        )}
      </nav>
      <div className="stats">
        <Stat label="Đang làm" value={`${totals.working}/${Object.values(agents).filter((a) => a.enabled).length}`} />
        <Stat label="Task mở" value={String(active)} />
        <Stat label="Token" value={fmtTokens(totals.tokens)} />
        <Stat label="Chi phí" value={fmtCost(totals.cost)} />
      </div>
    </header>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function Composer() {
  const agents = useStore((s) => s.agents);
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    setBusy(true);
    const res = await actions.createTask({ prompt, agentId: agentId || undefined });
    setBusy(false);
    if (res.ok) {
      setPrompt("");
      setError("");
    } else setError(res.error ?? "Không gửi được task");
  };

  return (
    <form className="panel composer" onSubmit={submit}>
      <label htmlFor="prompt" className="panel-title">
        Giao việc
      </label>
      <textarea
        id="prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(e);
        }}
        placeholder="Ví dụ: Tìm hiểu và so sánh 3 thư viện game 2D cho web"
        rows={3}
      />
      <div className="composer-row">
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Giao cho">
          <option value="">Tự động (Manager chọn)</option>
          {Object.values(agents)
            .filter((a) => a.enabled)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
        <button type="submit" disabled={busy || !prompt.trim()}>
          Gửi
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function Approvals() {
  const approvals = useStore((s) => s.approvals);
  const agents = useStore((s) => s.agents);
  const list = Object.values(approvals).sort((a, b) => a.createdAt - b.createdAt);
  if (!list.length) return null;
  return (
    <section className="panel approvals">
      <h2 className="panel-title">Cần duyệt ({list.length})</h2>
      {list.map((a) => (
        <ApprovalCard key={a.id} approval={a} agent={agents[a.agentId]} />
      ))}
    </section>
  );
}

function ApprovalCard({ approval, agent }: { approval: Approval; agent?: AgentInfo }) {
  const isAdmin = useStore((s) => s.auth?.user?.role === "admin");
  return (
    <div className="approval">
      <div className="approval-head">
        {agent && <Portrait agent={agent} size={28} />}
        <div>
          <strong>{agent?.name ?? approval.agentId}</strong> muốn chạy <code>{approval.tool}</code>
          <div className="muted">{approval.summary}</div>
        </div>
      </div>
      <details>
        <summary>Chi tiết</summary>
        <pre>{approval.input}</pre>
      </details>
      {isAdmin ? (
        <div className="approval-actions">
          <button type="button" className="approve" onClick={() => actions.decide(approval.id, true)}>
            Duyệt
          </button>
          <button type="button" className="deny" onClick={() => actions.decide(approval.id, false)}>
            Từ chối
          </button>
        </div>
      ) : (
        <p className="muted">Chờ admin duyệt.</p>
      )}
    </div>
  );
}


function AgentList() {
  const agents = useStore((s) => s.agents);
  const tasks = useStore((s) => s.tasks);
  const selected = useStore((s) => s.selectedAgentId);
  return (
    <section className="panel">
      <h2 className="panel-title">Agent</h2>
      <ul className="agents">
        {Object.values(agents)
          .sort((a, b) => a.desk - b.desk)
          .map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className={`agent ${selected === a.id ? "selected" : ""} ${a.enabled ? "" : "is-disabled"}`}
                onClick={() => store.select(a.id)}
              >
                <Portrait agent={a} />
                <div className="agent-body">
                  <div className="agent-top">
                    <strong>{a.name}</strong>
                    <span className={`badge provider-${a.provider}`}>{PROVIDER_LABEL[a.provider]}</span>
                    {a.runtime !== a.provider && <span className="badge provider-mock">demo</span>}
                    <span className={`status status-${a.enabled ? a.status : "off"}`}>{a.enabled ? STATUS_LABEL[a.status] : "Đã tắt"}</span>
                  </div>
                  <div className="agent-summary">{a.summary}</div>
                  <div className="agent-meta">
                    {a.currentTaskId && tasks[a.currentTaskId] ? <span>📋 {tasks[a.currentTaskId].title}</span> : <span>{a.role}</span>}
                  </div>
                  <div className="agent-meta">
                    {a.provider === "claude" ? (
                      <span>
                        {fmtTokens(a.usage.tokensIn + a.usage.tokensOut)} token · {fmtCost(a.usage.costUsd)}
                      </span>
                    ) : (
                      <span>{a.requests} lượt chạy</span>
                    )}
                  </div>
                </div>
              </button>
            </li>
          ))}
      </ul>
    </section>
  );
}

function Activity({ onOpenHistory }: { onOpenHistory: () => void }) {
  const [tab, setTab] = useState<"events" | "tasks">("events");
  const selected = useStore((s) => s.selectedAgentId);
  const agents = useStore((s) => s.agents);
  return (
    <section className="panel activity">
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "events"} onClick={() => setTab("events")}>
          Hoạt động
        </button>
        <button type="button" role="tab" aria-selected={tab === "tasks"} onClick={() => setTab("tasks")}>
          Task
        </button>
        {selected && (
          <button type="button" className="filter" onClick={() => store.select(null)}>
            {agents[selected]?.name} ✕
          </button>
        )}
      </div>
      {tab === "events" ? <Timeline agentId={selected} /> : <TaskList agentId={selected} />}
      {tab === "tasks" && (
        <button type="button" className="link see-all" onClick={onOpenHistory}>
          Xem toàn bộ lịch sử →
        </button>
      )}
    </section>
  );
}

function Timeline({ agentId }: { agentId: string | null }) {
  const events = useStore((s) => s.events);
  const agents = useStore((s) => s.agents);
  const list = (agentId ? events.filter((e) => e.agentId === agentId || e.targetAgentId === agentId) : events).slice(-120).reverse();
  if (!list.length) return <p className="muted empty">Chưa có hoạt động. Giao một task để bắt đầu.</p>;
  return (
    <ol className="timeline">
      {list.map((e) => (
        <TimelineItem key={e.id} event={e} agent={agents[e.agentId]} />
      ))}
    </ol>
  );
}


function TaskList({ agentId }: { agentId: string | null }) {
  const tasks = useStore((s) => s.tasks);
  const all = Object.values(tasks);
  const childrenOf = (id: string) => all.filter((t) => t.parentId === id).sort((a, b) => a.createdAt - b.createdAt);
  // Filtered by agent: flat list of that agent's work. Otherwise: requests with their sub-tasks underneath.
  const list = all
    .filter((t) => (agentId ? t.agentId === agentId : !t.parentId || !tasks[t.parentId]))
    .sort((a, b) => b.createdAt - a.createdAt);
  if (!list.length) return <p className="muted empty">Chưa có task nào.</p>;
  return (
    <ul className="tasks">
      {list.map((t) => (
        <TaskItem key={t.id} task={t} parent={agentId && t.parentId ? tasks[t.parentId] : undefined}>
          {!agentId && childrenOf(t.id).length > 0 && (
            <ul className="subtasks">
              {childrenOf(t.id).map((c) => (
                <TaskItem key={c.id} task={c} compact />
              ))}
            </ul>
          )}
        </TaskItem>
      ))}
    </ul>
  );
}

function TaskItem({ task: t, parent, compact, children }: { task: Task; parent?: Task; compact?: boolean; children?: ReactNode }) {
  const agents = useStore((s) => s.agents);
  const active = t.status === "queued" || t.status === "running" || t.status === "waiting_approval";
  const canCancel = useCanCancel(t);
  return (
    <li className={`task ${compact ? "task-compact" : ""}`}>
      <div className="task-head">
        <span className={`task-status ts-${t.status}`}>{TASK_LABEL[t.status]}</span>
        {t.kind === "review" && <span className="kind-badge">Review</span>}
        <SourceBadge task={t} />
        <strong>{t.title}</strong>
      </div>
      <div className="muted">
        {agents[t.agentId]?.name} · {fmtTime(t.createdAt)}
        {t.createdBy && !compact && ` · giao bởi ${t.createdBy}`}
        {t.usage.costUsd > 0 && ` · ${fmtCost(t.usage.costUsd)}`}
        {parent && ` · thuộc "${parent.title}"`}
      </div>
      {(t.result || t.error) && (
        <details>
          <summary>{t.error ? "Lỗi" : "Kết quả"}</summary>
          <pre>{t.error ?? t.result}</pre>
        </details>
      )}
      {active && !compact && canCancel && (
        <button type="button" className="link" onClick={() => actions.cancelTask(t.id)}>
          Huỷ{children ? " (cả việc con)" : ""}
        </button>
      )}
      {children}
    </li>
  );
}
