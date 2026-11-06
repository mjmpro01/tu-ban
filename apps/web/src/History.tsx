import { ACTIVE_STATUSES, type AgentEvent, type Task, type TaskQuery, matchesTaskQuery } from "@tu-ban/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { actions, store, useStore } from "./store";
import { Portrait, TASK_LABEL, TimelineItem, fmtCost, fmtDateTime, fmtDuration, fmtTokens } from "./ui";

const PAGE = 30;

type Filters = Required<Pick<TaskQuery, "q">> & { agentId: string; status: string };

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Mọi trạng thái" },
  { value: "active", label: "Đang mở" },
  { value: "done", label: TASK_LABEL.done },
  { value: "error", label: TASK_LABEL.error },
  { value: "cancelled", label: TASK_LABEL.cancelled },
];

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

function toQuery(f: Filters): TaskQuery {
  return {
    agentId: f.agentId || undefined,
    status: (f.status || undefined) as TaskQuery["status"],
    q: f.q.trim() || undefined,
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
  const [filters, setFilters] = useState<Filters>({ agentId: "", status: "", q: "" });
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

  const query = useMemo(() => toQuery({ ...filters, q: debouncedQ }), [filters.agentId, filters.status, debouncedQ]);

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

  const selected = list.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="history-body" data-view={selected ? "detail" : "list"}>
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
                      <strong>{t.title}</strong>
                    </div>
                    <div className="muted">
                      {agent?.name ?? t.agentId} · {fmtDateTime(t.createdAt)}
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
        {selected ? (
          <TaskDetail task={selected} onBack={() => setSelectedId(null)} />
        ) : (
          <p className="muted empty">Chọn một task bên trái để xem chi tiết.</p>
        )}
      </section>
    </div>
  );
}

function TaskDetail({ task, onBack }: { task: Task; onBack: () => void }) {
  const agents = useStore((s) => s.agents);
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
          <div className="muted">{agent?.name ?? task.agentId}</div>
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
          <dt>Token</dt>
          <dd>{fmtTokens(task.usage.tokensIn + task.usage.tokensOut)}</dd>
        </div>
        <div>
          <dt>Chi phí</dt>
          <dd>{fmtCost(task.usage.costUsd)}</dd>
        </div>
      </dl>

      <div className="detail-actions">
        <button type="button" className="secondary" onClick={() => void runAgain()}>
          Giao lại
        </button>
        {active && (
          <button type="button" className="secondary danger" onClick={() => actions.cancelTask(task.id)}>
            Huỷ task
          </button>
        )}
        {rerun && <span className="muted" role="status">{rerun}</span>}
      </div>

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
