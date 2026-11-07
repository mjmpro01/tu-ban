import { type AgentConfigView, type AgentSettings, CLAUDE_MODELS } from "@tu-ban/shared";
import { useEffect, useRef, useState } from "react";
import { useStore } from "./store";
import { Portrait } from "./ui";

const PROVIDERS: { value: AgentSettings["provider"]; label: string }[] = [
  { value: "claude", label: "Claude (Agent SDK)" },
  { value: "cursor", label: "Cursor CLI (thử nghiệm)" },
  { value: "copilot", label: "GitHub Copilot (chưa làm)" },
];
const KNOWN_MODELS: readonly string[] = CLAUDE_MODELS.map((m) => m.id);
const CUSTOM = "__custom__";

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

const settingsOf = (c: AgentConfigView): AgentSettings => ({
  name: c.name,
  role: c.role,
  provider: c.provider,
  model: c.model,
  systemPrompt: c.systemPrompt,
  enabled: c.enabled,
});

const sameSettings = (a: AgentSettings, b: AgentSettings) =>
  (Object.keys(a) as (keyof AgentSettings)[]).every((k) => a[k] === b[k]);

/** Dialog to edit each agent's name, role, provider, model, system prompt and on/off switch. */
export function AgentSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
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
      aria-labelledby="settings-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && <SettingsBody onClose={onClose} />}
    </dialog>
  );
}

function SettingsBody({ onClose }: { onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const [configs, setConfigs] = useState<AgentConfigView[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentSettings | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  /** Bumped whenever the form is reloaded, so fields with local state (the model picker) start fresh. */
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    send<AgentConfigView[]>("GET", "/api/agents/settings")
      .then((list) => setConfigs(list))
      .catch((e: Error) => setError(`Không tải được cấu hình (${e.message})`));
  }, []);

  const selected = configs?.find((c) => c.id === selectedId) ?? null;
  const dirty = !!(selected && draft && !sameSettings(draft, settingsOf(selected)));

  const select = (id: string | null) => {
    if (dirty && !window.confirm("Bỏ các thay đổi chưa lưu?")) return;
    const c = configs?.find((x) => x.id === id);
    setSelectedId(id);
    setDraft(c ? settingsOf(c) : null);
    setFormKey((k) => k + 1);
    setError("");
    setNotice("");
  };

  const apply = (updated: AgentConfigView, message: string) => {
    // the Manager's generated team list depends on the other agents: reload everything
    send<AgentConfigView[]>("GET", "/api/agents/settings").then(setConfigs).catch(() => {});
    setConfigs((list) => list?.map((c) => (c.id === updated.id ? updated : c)) ?? null);
    setDraft(settingsOf(updated));
    setFormKey((k) => k + 1);
    setNotice(message);
  };

  const save = async () => {
    if (!selected || !draft) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const working = agents[selected.id]?.status !== "idle";
      const updated = await send<AgentConfigView>("PUT", `/api/agents/${selected.id}/settings`, draft);
      apply(updated, working ? "Đã lưu. Agent đang làm việc nên thay đổi áp dụng từ task sau." : "Đã lưu.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!selected || !window.confirm(`Khôi phục ${selected.name} về cấu hình mặc định?`)) return;
    setSaving(true);
    setError("");
    try {
      apply(await send<AgentConfigView>("POST", `/api/agents/${selected.id}/settings/reset`), "Đã khôi phục mặc định.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="history-body" data-view={selected ? "detail" : "list"}>
      <header className="history-header">
        <h2 id="settings-title">Quản lý agent</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Đóng">
          ✕
        </button>
      </header>

      <section className="history-list" aria-label="Danh sách agent">
        {!configs && !error && <p className="muted empty">Đang tải…</p>}
        <ul className="history-items">
          {configs?.map((c) => {
            const info = agents[c.id];
            return (
              <li key={c.id}>
                <button
                  type="button"
                  className={`history-item ${c.id === selectedId ? "selected" : ""} ${c.enabled ? "" : "is-disabled"}`}
                  onClick={() => select(c.id)}
                  aria-current={c.id === selectedId}
                >
                  {info && <Portrait agent={info} size={36} />}
                  <div className="history-item-body">
                    <div className="history-item-top">
                      <strong>{c.name}</strong>
                      {!c.enabled && <span className="kind-badge off">Đã tắt</span>}
                      {!c.isDefault && <span className="kind-badge edited">Đã chỉnh</span>}
                    </div>
                    <div className="muted">
                      {PROVIDERS.find((p) => p.value === c.provider)?.label}
                      {c.provider === "claude" ? ` · ${c.model}` : ""}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="muted settings-note">
          Thay đổi được lưu vào database và áp dụng cho task kế tiếp. Dashboard chưa có đăng nhập: ai mở được trang này đều sửa được.
        </p>
      </section>

      <section className="history-detail" aria-label="Cấu hình agent">
        {selected && draft ? (
          <form
            className="detail settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <button type="button" className="link back" onClick={() => select(null)}>
              ← Danh sách
            </button>
            <header className="detail-head">
              {agents[selected.id] && <Portrait agent={agents[selected.id]} size={48} />}
              <div>
                <h3>{selected.name}</h3>
                <div className="muted">
                  id: <code>{selected.id}</code>
                  {agents[selected.id]?.status !== "idle" && " · đang làm việc"}
                </div>
              </div>
            </header>

            {selected.runtimeNote && <p className="warning">{selected.runtimeNote}</p>}

            <label className="toggle">
              <input
                type="checkbox"
                checked={draft.enabled}
                disabled={selected.required}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              />
              <span>
                <strong>{draft.enabled ? "Đang bật" : "Đã tắt"}</strong>
                <span className="muted">
                  {selected.required
                    ? " · Manager luôn bật vì nhận mọi yêu cầu không chỉ định agent."
                    : " · Agent tắt không nhận việc mới và rời khỏi văn phòng; việc đang làm vẫn chạy nốt."}
                </span>
              </span>
            </label>

            <div className="field-row">
              <label className="field">
                <span>Tên hiển thị</span>
                <input value={draft.name} maxLength={40} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required />
              </label>
              <label className="field">
                <span>Provider</span>
                <select
                  value={draft.provider}
                  onChange={(e) => setDraft({ ...draft, provider: e.target.value as AgentSettings["provider"] })}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="field">
              <span>Vai trò</span>
              <input
                value={draft.role}
                maxLength={120}
                onChange={(e) => setDraft({ ...draft, role: e.target.value })}
                placeholder="Mô tả ngắn: Manager dùng câu này để biết nên giao việc gì"
              />
            </label>

            {draft.provider === "claude" && (
              <ModelField key={formKey} value={draft.model} onChange={(model) => setDraft({ ...draft, model })} />
            )}

            <label className="field">
              <span>
                System prompt <span className="muted">({draft.systemPrompt.length.toLocaleString("vi-VN")}/20.000 ký tự)</span>
              </span>
              <textarea
                value={draft.systemPrompt}
                maxLength={20000}
                rows={12}
                onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
              />
            </label>
            {draft.provider !== "claude" && (
              <p className="muted">Prompt chỉ dùng cho provider Claude. Cursor và Copilot dùng cấu hình riêng của công cụ đó.</p>
            )}

            {selected.generatedPrompt && (
              <details className="generated">
                <summary>Phần tự thêm khi chạy (danh sách nhóm và giới hạn, không sửa được)</summary>
                <pre>{selected.generatedPrompt}</pre>
              </details>
            )}

            <div className="detail-actions">
              <button type="submit" className="primary" disabled={!dirty || saving}>
                {saving ? "Đang lưu…" : "Lưu"}
              </button>
              <button type="button" className="secondary" disabled={!dirty || saving} onClick={() => {
                  setDraft(settingsOf(selected));
                  setFormKey((k) => k + 1);
                }}
              >
                Huỷ thay đổi
              </button>
              <button type="button" className="secondary" disabled={selected.isDefault || saving} onClick={() => void reset()}>
                Khôi phục mặc định
              </button>
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
          </form>
        ) : (
          <p className="muted empty">{error || "Chọn một agent bên trái để chỉnh cấu hình."}</p>
        )}
      </section>
    </div>
  );
}

function ModelField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [custom, setCustom] = useState(!KNOWN_MODELS.includes(value));
  return (
    <div className="field-row">
      <label className="field">
        <span>Model</span>
        <select
          value={custom ? CUSTOM : value}
          onChange={(e) => {
            if (e.target.value === CUSTOM) setCustom(true);
            else {
              setCustom(false);
              onChange(e.target.value);
            }
          }}
        >
          {CLAUDE_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          <option value={CUSTOM}>Model khác…</option>
        </select>
      </label>
      {custom && (
        <label className="field">
          <span>Model id</span>
          <input value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder="vd. claude-opus-5-5" required />
        </label>
      )}
    </div>
  );
}
