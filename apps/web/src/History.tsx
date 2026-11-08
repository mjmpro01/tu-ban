import { ACTIVE_STATUSES, type AgentEvent, type Task, type TaskQuery, matchesTaskQuery } from "@tu-ban/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { useCanCancel } from "./App";
import { actions, store, useStore } from "./store";
import { Portrait, SourceBadge, TASK_LABEL, TimelineItem, fmtCost, fmtDateTime, fmtDuration, fmtTokens } from "./ui";

const PAGE = 30;

type Filters = Required<Pick<TaskQuery, "q">> & { agentId: string; status: string; withSubtasks: boolean };

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Mọi trạng thái" },
  { value: "active", label: "Đang mở" },
  { value: "done", label: TASK_LABEL.done },
  { value: "error", label: TASK_LABEL.error },
  { value: "cancelled", label: TASK_LABEL.cancelled },
];

const getJson = <T,>(url: string) => api<T>("GET", url);

function toQuery(f: Filters): TaskQuery {
  return {
    agentId: f.agentId || undefined,
    status: (f.status || undefined) as TaskQuery["status"],
    q: f.q.trim() || undefined,
    rootsOnly: f.withSubtasks ? undefined : true,
  };
}

/** Full-screen task history: filterable, paged list on the left, task detail with its timeline on the right. */
export function HistoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="history"
      aria-labelledby="history-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // click on the backdrop
      }}
    >
      {open && <HistoryBody onClose={onClose} />}
    </dialog>
  );
}

function HistoryBody({ onClose }: { onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const liveTasks = useStore((s) => s.tasks);
  const [filters, setFilters] = useState<Filters>({ agentId: "", status: "", q: "", withSubtasks: false });
  const [debouncedQ, setDebouncedQ] = useState("");
  const [items, setItems] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const request = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(filters.q), 300);
    return () => clearTimeout(t);
  }, [filters.q]);

  const query = useMemo(() => toQuery({ ...filters, q: debouncedQ }), [filters.agentId, filters.status, filters.withSubtasks, debouncedQ]);

  const load = useCallback(
    async (before?: number) => {
      const id = ++request.current;
      setLoading(true);
      setError("");
      const params = new URLSearchParams({ limit: String(PAGE) });
      for (const [k, v] of Object.entries({ ...query, before })) if (v !== undefined) params.set(k, String(v));
      try {
        const page = await getJson<Task[]>(`/api/tasks?${params}`);
        if (id !== request.current) return; // a newer request replaced this one
        setItems((prev) => (before ? [...prev, ...page.filter((t) => !prev.some((p) => p.id === t.id))] : page));
        setHasMore(page.length === PAGE);
      } catch (e) {
        if (id === request.current) setError(`Không tải được lịch sử (${(e as Error).message})`);
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [query],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Show live updates: fresher copies of listed tasks, and new tasks that match the filters.
  const list = useMemo(() => {
    const newest = items[0]?.createdAt ?? 0;
    const fresh = Object.values(liveTasks)
      .filter((t) => t.createdAt > newest && !items.some((i) => i.id === t.id) && matchesTaskQuery(t, query))
      .sort((a, b) => b.createdAt - a.createdAt);
    return [...fresh, ...items.map((t) => liveTasks[t.id] ?? t)];
  }, [items, liveTasks, query]);


  return (
    <div className="history-body" data-view={selectedId ? "detail" : "list"}>
      <header className="history-header">
        <h2 id="history-title">Lịch sử task</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Đóng">
          ✕
        </button>
      </header>

      <section className="history-list" aria-label="Danh sách task">
        <div className="history-filters">
          <input
            type="search"
            placeholder="Tìm theo nội dung…"
            value={filters.q}
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            aria-label="Tìm theo nội dung"
          />
          <select value={filters.agentId} onChange={(e) => setFilters({ ...filters, agentId: e.target.value })} aria-label="Agent">
            <option value="">Mọi agent</option>
            {Object.values(agents).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} aria-label="Trạng thái">
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={filters.withSubtasks}
              onChange={(e) => setFilters({ ...filters, withSubtasks: e.target.checked })}
            />
            Hiện việc con
          </label>
        </div>

        {error && <p className="error">{error}</p>}
        {!loading && !error && list.length === 0 && <p className="muted empty">Không có task nào khớp bộ lọc.</p>}

        <ul className="history-items">
          {list.map((t) => {
            const agent = agents[t.agentId];
            return (
              <li key={t.id}>
                <button
                  type="button"
                  className={`history-item ${t.id === selectedId ? "selected" : ""}`}
                  onClick={() => setSelectedId(t.id)}
                  aria-current={t.id === selectedId}
                >
                  {agent && <Portrait agent={agent} size={32} />}
                  <div className="history-item-body">
                    <div className="history-item-top">
                      <span className={`task-status ts-${t.status}`}>{TASK_LABEL[t.status]}</span>
                      {t.kind === "review" && <span className="kind-badge">Review</span>}
                      <SourceBadge task={t} />
                      <strong>
                        {t.parentId ? "↳ " : ""}
                        {t.title}
                      </strong>
                    </div>
                    <div className="muted">
                      {agent?.name ?? t.agentId} · {fmtDateTime(t.createdAt)}
                      {t.createdBy && !t.parentId ? ` · ${t.createdBy}` : ""}
                      {t.startedAt && t.finishedAt ? ` · ${fmtDuration(t.finishedAt - t.startedAt)}` : ""}
                      {t.usage.costUsd > 0 ? ` · ${fmtCost(t.usage.costUsd)}` : ""}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>

        {loading && <p className="muted empty">Đang tải…</p>}
        {hasMore && !loading && (
          <button type="button" className="secondary load-more" onClick={() => void load(items[items.length - 1]?.createdAt)}>
            Tải thêm
          </button>
        )}
      </section>

      <section className="history-detail" aria-label="Chi tiết task">
        {selectedId ? (
          <TaskDetailLoader
            key={selectedId}
            taskId={selectedId}
            known={list.find((t) => t.id === selectedId)}
            onSelect={setSelectedId}
            onBack={() => setSelectedId(null)}
          />
        ) : (
          <p className="muted empty">Chọn một task bên trái để xem chi tiết.</p>
        )}
      </section>
    </div>
  );
}

/** Finds the task (list, live store or server) and its sub-tasks, then shows the detail. */
function TaskDetailLoader(props: { taskId: string; known?: Task; onSelect: (id: string) => void; onBack: () => void }) {
  const live = useStore((s) => s.tasks);
  const [fetched, setFetched] = useState<Task | null>(null);
  const [children, setChildren] = useState<Task[]>([]);
  const [error, setError] = useState("");
  const task = live[props.taskId] ?? props.known ?? fetched;

  useEffect(() => {
    let alive = true;
    if (!props.known && !live[props.taskId])
      getJson<Task>(`/api/tasks/${props.taskId}`)
        .then((t) => alive && setFetched(t))
        .catch((e: Error) => alive && setError(`Không tải được task (${e.message})`));
    getJson<Task[]>(`/api/tasks?parentId=${props.taskId}&limit=100`)
      .then((list) => alive && setChildren(list))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [props.taskId]);

  // live copies win; new sub-tasks appear while the Manager delegates
  const subtasks = useMemo(() => {
    const byId = new Map(children.map((c) => [c.id, c]));
    for (const t of Object.values(live)) if (t.parentId === props.taskId) byId.set(t.id, t);
    return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  }, [children, live, props.taskId]);

  if (error) return <p className="error">{error}</p>;
  if (!task) return <p className="muted empty">Đang tải…</p>;
  return <TaskDetail task={task} subtasks={subtasks} onSelect={props.onSelect} onBack={props.onBack} />;
}

function TaskDetail({
  task,
  subtasks,
  onSelect,
  onBack,
}: {
  task: Task;
  subtasks: Task[];
  onSelect: (id: string) => void;
  onBack: () => void;
}) {
  const agents = useStore((s) => s.agents);
  const live = useStore((s) => s.tasks);
  const parent = task.parentId ? live[task.parentId] : undefined;
  const teamCost = subtasks.reduce((n, t) => n + t.usage.costUsd, task.usage.costUsd);
  const teamTokens = subtasks.reduce((n, t) => n + t.usage.tokensIn + t.usage.tokensOut, task.usage.tokensIn + task.usage.tokensOut);
  const agent = agents[task.agentId];
  const [events, setEvents] = useState<AgentEvent[] | null>(null);
  const [error, setError] = useState("");
  const [rerun, setRerun] = useState("");

  useEffect(() => {
    let alive = true;
    setEvents(null);
    setError("");
    setRerun("");
    getJson<AgentEvent[]>(`/api/tasks/${task.id}/events`)
      .then((list) => alive && setEvents((live) => mergeEvents(list, live ?? [])))
      .catch((e: Error) => alive && setError(`Không tải được hoạt động (${e.message})`));
    // keep appending events while the task is still running
    const off = store.onEvent((e) => {
      if (e.taskId === task.id) setEvents((prev) => mergeEvents(prev ?? [], [e]));
    });
    return () => {
      alive = false;
      off();
    };
  }, [task.id]);

  const active = ACTIVE_STATUSES.includes(task.status);
  const canCancel = useCanCancel(task);
  const runAgain = async () => {
    const res = await actions.createTask({ prompt: task.prompt, agentId: task.agentId });
    setRerun(res.ok ? "Đã giao lại task." : (res.error ?? "Không giao lại được"));
  };

  return (
    <article className="detail">
      <button type="button" className="link back" onClick={onBack}>
        ← Danh sách
      </button>
      <header className="detail-head">
        {agent && <Portrait agent={agent} size={48} />}
        <div>
          <span className={`task-status ts-${task.status}`}>{TASK_LABEL[task.status]}</span>
          <h3>{task.title}</h3>
          <div className="muted">
            {agent?.name ?? task.agentId}
            {task.kind === "review" && " · Review"}
            {task.createdBy && ` · giao bởi ${task.createdBy}`}
          </div>
          {task.parentId && (
            <button type="button" className="link" onClick={() => onSelect(task.parentId!)}>
              ↑ Thuộc yêu cầu: {parent?.title ?? "xem task cha"}
            </button>
          )}
          {task.followUpOf && (
            <button type="button" className="link" onClick={() => onSelect(task.followUpOf!)}>
              ↩ Tiếp nối từ: {live[task.followUpOf]?.title ?? "xem task trước"}
            </button>
          )}
        </div>
      </header>

      <dl className="detail-facts">
        <div>
          <dt>Tạo lúc</dt>
          <dd>{fmtDateTime(task.createdAt)}</dd>
        </div>
        <div>
          <dt>Thời gian chạy</dt>
          <dd>
            {task.startedAt ? fmtDuration((task.finishedAt ?? Date.now()) - task.startedAt) : "Chưa chạy"}
            {active && task.startedAt ? " (đang chạy)" : ""}
          </dd>
        </div>
        <div>
          <dt>{subtasks.length ? "Token (cả nhóm)" : "Token"}</dt>
          <dd>{fmtTokens(subtasks.length ? teamTokens : task.usage.tokensIn + task.usage.tokensOut)}</dd>
        </div>
        <div>
          <dt>{subtasks.length ? "Chi phí (cả nhóm)" : "Chi phí"}</dt>
          <dd>{fmtCost(subtasks.length ? teamCost : task.usage.costUsd)}</dd>
        </div>
      </dl>

      <div className="detail-actions">
        <button type="button" className="secondary" onClick={() => void runAgain()}>
          Giao lại
        </button>
        {active && canCancel && (
          <button type="button" className="secondary danger" onClick={() => actions.cancelTask(task.id)}>
            Huỷ task
          </button>
        )}
        {rerun && <span className="muted" role="status">{rerun}</span>}
      </div>

      {subtasks.length > 0 && (
        <>
          <h4>Việc con ({subtasks.length})</h4>
          <ul className="subtask-list">
            {subtasks.map((c) => (
              <li key={c.id}>
                <button type="button" className="history-item" onClick={() => onSelect(c.id)}>
                  {agents[c.agentId] && <Portrait agent={agents[c.agentId]} size={24} />}
                  <div className="history-item-body">
                    <div className="history-item-top">
                      <span className={`task-status ts-${c.status}`}>{TASK_LABEL[c.status]}</span>
                      {c.kind === "review" && <span className="kind-badge">Review</span>}
                      <strong>{c.title}</strong>
                    </div>
                    <div className="muted">
                      {agents[c.agentId]?.name ?? c.agentId}
                      {c.startedAt && c.finishedAt ? ` · ${fmtDuration(c.finishedAt - c.startedAt)}` : ""}
                      {c.usage.costUsd > 0 ? ` · ${fmtCost(c.usage.costUsd)}` : ""}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>Yêu cầu</h4>
      <pre>{task.prompt}</pre>

      {(task.result || task.error) && (
        <>
          <h4>{task.error ? "Lỗi" : "Kết quả"}</h4>
          <pre className={task.error ? "pre-error" : undefined}>{task.error ?? task.result}</pre>
        </>
      )}

      <h4>Hoạt động {events ? `(${events.length})` : ""}</h4>
      {error && <p className="error">{error}</p>}
      {!events && !error && <p className="muted">Đang tải…</p>}
      {events && events.length === 0 && <p className="muted">Không có hoạt động nào được ghi lại.</p>}
      {events && events.length > 0 && (
        <ol className="timeline detail-timeline">
          {events.map((e) => (
            <TimelineItem key={e.id} event={e} agent={agents[e.agentId]} />
          ))}
        </ol>
      )}
    </article>
  );
}

function mergeEvents(a: AgentEvent[], b: AgentEvent[]) {
  const byId = new Map(a.map((e) => [e.id, e]));
  for (const e of b) byId.set(e.id, e);
  return [...byId.values()].sort((x, y) => x.ts - y.ts);
}
