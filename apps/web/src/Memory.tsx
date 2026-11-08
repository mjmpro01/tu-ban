import type { MemoryItem, MemoryScope, MemorySettings, MemoryStatus } from "@tu-ban/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { useStore } from "./store";
import { fmtDateTime } from "./ui";

const SCOPE_LABEL: Record<MemoryScope, string> = { office: "Chung", agent: "Riêng agent", request: "Theo yêu cầu" };

/** Shared memory: what the agents remember, search for everyone, edit for admins. */
export function MemoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
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
      aria-labelledby="memory-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header className="history-header">
        <h2 id="memory-title">Bộ nhớ chung</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Đóng">
          ✕
        </button>
      </header>
      <div className="small-dialog-body">{open && <MemoryBody />}</div>
    </dialog>
  );
}

function MemoryBody() {
  const isAdmin = useStore((s) => s.auth?.user?.role === "admin");
  const agents = useStore((s) => s.agents);
  const tasks = useStore((s) => s.tasks);
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<MemoryScope | "">("");
  const [agentId, setAgentId] = useState("");
  const [runId, setRunId] = useState("");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  // recent user requests, for the "per request" scope
  const requests = useMemo(
    () =>
      Object.values(tasks)
        .filter((t) => !t.parentId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 30),
    [tasks],
  );

  useEffect(() => {
    api<MemoryStatus>("GET", "/api/memory/status").then(setStatus, (e: Error) => setError(e.message));
  }, [reload]);

  useEffect(() => {
    if (scope === "request" && !runId) {
      setItems([]);
      return;
    }
    const params = new URLSearchParams({ limit: "50" });
    if (q.trim()) params.set("q", q.trim());
    if (scope) params.set("scope", scope);
    if (scope === "agent" && agentId) params.set("agentId", agentId);
    if (scope === "request") params.set("runId", runId);
    let stale = false;
    // wait for the user to stop typing
    const t = setTimeout(() => {
      api<MemoryItem[]>("GET", `/api/memory?${params}`).then(
        (r) => {
          if (stale) return;
          setItems(r);
          setError("");
        },
        (e: Error) => {
          if (stale) return;
          setItems([]);
          setError(e.message);
        },
      );
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [q, scope, agentId, runId, reload]);

  const refresh = () => setReload((n) => n + 1);

  return (
    <div className="settings-form memory-view">
      {status && <MemoryStatusBar status={status} />}
      <div className="memory-filters">
        <input type="search" placeholder="Tìm trong bộ nhớ…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Tìm trong bộ nhớ" />
        <select value={scope} onChange={(e) => setScope(e.target.value as MemoryScope | "")} aria-label="Phạm vi">
          <option value="">Mọi phạm vi</option>
          <option value="office">Chung</option>
          <option value="agent">Riêng agent</option>
          <option value="request">Theo yêu cầu</option>
        </select>
        {scope === "agent" && (
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Agent">
            <option value="">Mọi agent</option>
            {Object.values(agents).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        {scope === "request" && (
          <select value={runId} onChange={(e) => setRunId(e.target.value)} aria-label="Yêu cầu">
            <option value="">Chọn yêu cầu…</option>
            {requests.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {items === null ? (
        <p className="muted empty">Đang tải…</p>
      ) : items.length === 0 ? (
        <p className="muted empty">
          {scope === "request" && !runId ? "Chọn một yêu cầu để xem ghi chú của nhóm." : q ? "Không có ghi nhớ nào khớp." : "Chưa có ghi nhớ nào."}
        </p>
      ) : (
        <ul className="memory-list">
          {items.map((m) => (
            <MemoryRow key={m.id} item={m} canEdit={isAdmin} onChanged={refresh} />
          ))}
        </ul>
      )}
      {isAdmin && <AddMemory onAdded={refresh} />}
      {isAdmin && status && <MemorySettingsForm settings={status.settings} onSaved={(s) => setStatus({ ...status, settings: s })} />}
    </div>
  );
}

function MemoryStatusBar({ status }: { status: MemoryStatus }) {
  return (
    <div className="memory-status">
      <span className={`kind-badge ${status.ok ? "ok" : "off"}`}>{status.backend === "mem0" ? "Mem0 · tìm theo ngữ nghĩa" : "Tìm theo từ khoá"}</span>
      {status.backend === "mem0" ? (
        <span className="muted">
          {status.embedModel ? `Embedding: ${status.embedModel}` : "Embedding theo cấu hình Mem0"}
          {status.llmModel ? ` · Trích ý: ${status.llmModel}` : ""}
        </span>
      ) : (
        <span className="muted">
          Đặt <code>MEM0_URL</code> để dùng Mem0 (tìm theo nghĩa, tự gộp trùng lặp).
        </span>
      )}
      {!status.ok && status.lastError && <span className="error">Lỗi gần nhất: {status.lastError}</span>}
    </div>
  );
}

function MemoryRow({ item, canEdit, onChanged }: { item: MemoryItem; canEdit: boolean; onChanged: () => void }) {
  const agents = useStore((s) => s.agents);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const who = item.createdBy === "auto" ? "Tự động" : (agents[item.createdBy ?? ""]?.name ?? item.createdBy);
  const owner = item.scope === "agent" ? (agents[item.agentId ?? ""]?.name ?? item.agentId) : undefined;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      setEditing(false);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="memory-item">
      <div className="memory-meta">
        <span className="kind-badge">{SCOPE_LABEL[item.scope]}</span>
        {owner && <strong>{owner}</strong>}
        {who && <span className="muted">bởi {who}</span>}
        {item.updatedAt && <span className="muted">· {fmtDateTime(item.updatedAt)}</span>}
        {item.score !== undefined && <span className="muted memory-score">độ khớp {Math.round(item.score * 100)}%</span>}
      </div>
      {editing ? (
        <label className="field">
          <span>Nội dung</span>
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} />
        </label>
      ) : (
        <p className="memory-text">{item.text}</p>
      )}
      {canEdit && (
        <div className="detail-actions">
          {editing ? (
            <>
              <button type="button" className="primary small" disabled={busy || !text.trim()} onClick={() => void run(() => api("PUT", `/api/memory/${item.id}`, { text }))}>
                Lưu
              </button>
              <button
                type="button"
                className="secondary small"
                onClick={() => {
                  setEditing(false);
                  setText(item.text);
                }}
              >
                Huỷ
              </button>
            </>
          ) : (
            <>
              <button type="button" className="secondary small" onClick={() => setEditing(true)}>
                Sửa
              </button>
              <button
                type="button"
                className="secondary small danger"
                disabled={busy}
                onClick={() => {
                  if (confirm("Xoá ghi nhớ này? Các agent sẽ không còn nhớ điều này nữa.")) void run(() => api("DELETE", `/api/memory/${item.id}`));
                }}
              >
                Xoá
              </button>
            </>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </li>
  );
}

function AddMemory({ onAdded }: { onAdded: () => void }) {
  const agents = useStore((s) => s.agents);
  const [text, setText] = useState("");
  const [scope, setScope] = useState<"office" | "agent">("office");
  const [agentId, setAgentId] = useState("manager");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const add = async () => {
    setBusy(true);
    setError("");
    try {
      const saved = await api<MemoryItem[]>("POST", "/api/memory", { text, scope, ...(scope === "agent" ? { agentId } : {}) });
      if (!saved.length) {
        setError("Bộ nhớ đã có điều này rồi.");
        return;
      }
      setText("");
      onAdded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="settings-group">
      <legend>Thêm ghi nhớ</legend>
      <label className="field">
        <span>Điều các agent cần nhớ</span>
        <textarea
          rows={3}
          value={text}
          maxLength={4000}
          placeholder="Ví dụ: Khách hàng muốn mọi báo cáo viết bằng tiếng Việt, tối đa 2 trang."
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Ai được dùng</span>
          <select value={scope} onChange={(e) => setScope(e.target.value as "office" | "agent")}>
            <option value="office">Cả văn phòng</option>
            <option value="agent">Chỉ một agent</option>
          </select>
        </label>
        {scope === "agent" && (
          <label className="field">
            <span>Agent</span>
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {Object.values(agents).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="detail-actions">
        <button type="button" className="primary" disabled={busy || !text.trim()} onClick={() => void add()}>
          {busy ? "Đang lưu…" : "Thêm"}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

function MemorySettingsForm({ settings, onSaved }: { settings: MemorySettings; onSaved: (s: MemorySettings) => void }) {
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(String(settings.recallLimit));

  const save = async (patch: Partial<MemorySettings>) => {
    setError("");
    // show the change at once; roll back if the server refuses it
    onSaved({ ...settings, ...patch });
    try {
      onSaved(await api<MemorySettings>("PUT", "/api/settings/memory", patch));
    } catch (e) {
      onSaved(settings);
      setLimit(String(settings.recallLimit));
      setError((e as Error).message);
    }
  };

  return (
    <fieldset className="settings-group">
      <legend>Cách agent dùng bộ nhớ</legend>
      <ul className="skill-checks">
        <li>
          <label>
            <input type="checkbox" checked={settings.autoRecall} onChange={(e) => void save({ autoRecall: e.target.checked })} />
            <span>
              <strong>Tự nhắc lại</strong>
              <span className="muted"> · Trước mỗi task, đưa những ghi nhớ liên quan nhất vào hướng dẫn cho agent.</span>
            </span>
          </label>
        </li>
        <li>
          <label>
            <input type="checkbox" checked={settings.autoSave} onChange={(e) => void save({ autoSave: e.target.checked })} />
            <span>
              <strong>Tự ghi nhớ</strong>
              <span className="muted"> · Khi một yêu cầu xong, lưu kết quả vào bộ nhớ chung (Mem0 sẽ tự rút ra các ý chính).</span>
            </span>
          </label>
        </li>
      </ul>
      <label className="field memory-limit">
        <span>Số ghi nhớ tự nhắc tối đa</span>
        <input
          type="number"
          min={1}
          max={20}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          onBlur={() => {
            if (Number(limit) !== settings.recallLimit) void save({ recallLimit: Number(limit) });
          }}
        />
      </label>
      <p className="muted">Agent Claude còn có công cụ memory_search và memory_save để tự tra và tự ghi chú khi làm việc.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
