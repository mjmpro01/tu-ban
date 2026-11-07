import {
  type AgentConfigView,
  type AgentSettings,
  CLAUDE_MODELS,
  SKILL_NAME_PATTERN,
  type SkillDetail,
  type SkillSummary,
  TOOL_GROUPS,
  type ToolMode,
  sameValue,
} from "@tu-ban/shared";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
  skills: [...c.skills],
  tools: { ...c.tools },
});

const sameSettings = (a: AgentSettings, b: AgentSettings) =>
  (Object.keys(a) as (keyof AgentSettings)[]).every((k) => sameValue(a[k], b[k]));

const TOOL_MODES: { value: ToolMode; label: string }[] = [
  { value: "off", label: "Tắt" },
  { value: "ask", label: "Hỏi trước" },
  { value: "auto", label: "Tự chạy" },
];
const NEW_SKILL = "__new__";

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
  const [tab, setTab] = useState<"agents" | "skills">("agents");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillSel, setSkillSel] = useState<string | null>(null);

  const reloadConfigs = () => send<AgentConfigView[]>("GET", "/api/agents/settings").then(setConfigs);
  const reloadSkills = () => send<SkillSummary[]>("GET", "/api/skills").then(setSkills);

  useEffect(() => {
    reloadConfigs().catch((e: Error) => setError(`Không tải được cấu hình (${e.message})`));
    reloadSkills().catch(() => {});
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
    reloadConfigs().catch(() => {});
    reloadSkills().catch(() => {});
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

  const switchTab = (next: "agents" | "skills") => {
    if (next === tab) return;
    if (dirty && !window.confirm("Bỏ các thay đổi chưa lưu?")) return;
    setTab(next);
    setSelectedId(null);
    setDraft(null);
    setSkillSel(null);
    setError("");
    setNotice("");
  };

  const tabs = (
    <div className="tabs settings-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === "agents"} onClick={() => switchTab("agents")}>
        Agent
      </button>
      <button type="button" role="tab" aria-selected={tab === "skills"} onClick={() => switchTab("skills")}>
        Thư viện skill ({skills.length})
      </button>
    </div>
  );

  const detailOpen = tab === "agents" ? !!selected : !!skillSel;

  return (
    <div className="history-body" data-view={detailOpen ? "detail" : "list"}>
      <header className="history-header">
        <h2 id="settings-title">Quản lý agent</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Đóng">
          ✕
        </button>
      </header>

      {tab === "skills" ? (
        <SkillLibrary
          tabs={tabs}
          skills={skills}
          agents={configs ?? []}
          selected={skillSel}
          onSelect={setSkillSel}
          onChanged={async () => {
            await reloadSkills().catch(() => {});
            await reloadConfigs().catch(() => {});
          }}
        />
      ) : (
      <>
      <section className="history-list" aria-label="Danh sách agent">
        {tabs}
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

            {draft.provider === "claude" ? (
              <>
                <ToolPermissions value={draft.tools} onChange={(tools) => setDraft({ ...draft, tools })} />
                <SkillPicker
                  skills={skills}
                  value={draft.skills}
                  onChange={(list) => setDraft({ ...draft, skills: list })}
                  onOpenLibrary={() => switchTab("skills")}
                />
              </>
            ) : (
              <p className="muted">Quyền công cụ và skill chỉ áp dụng cho provider Claude.</p>
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
      </>
      )}
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

function ToolPermissions({ value, onChange }: { value: AgentSettings["tools"]; onChange: (v: AgentSettings["tools"]) => void }) {
  return (
    <fieldset className="settings-group">
      <legend>Quyền dùng công cụ</legend>
      <p className="muted">
        "Hỏi trước": agent phải chờ bạn bấm Duyệt. "Tắt": agent không thấy nhóm công cụ này. Công cụ làm việc nhóm của Manager luôn được dùng.
      </p>
      {TOOL_GROUPS.map((g) => (
        <div key={g.id} className="tool-row" role="radiogroup" aria-label={g.label}>
          <div className="tool-row-label">
            <strong>{g.label}</strong>
            <span className="muted">
              {g.description} · <code>{g.tools.slice(0, 3).join(", ")}</code>
            </span>
          </div>
          <div className="segmented">
            {TOOL_MODES.map((m) => (
              <label key={m.value} className={`seg seg-${m.value} ${value[g.id] === m.value ? "on" : ""}`}>
                <input
                  type="radio"
                  name={`tool-${g.id}`}
                  value={m.value}
                  checked={value[g.id] === m.value}
                  onChange={() => onChange({ ...value, [g.id]: m.value })}
                />
                {m.label}
              </label>
            ))}
          </div>
        </div>
      ))}
    </fieldset>
  );
}

function SkillPicker(props: {
  skills: SkillSummary[];
  value: string[];
  onChange: (v: string[]) => void;
  onOpenLibrary: () => void;
}) {
  const toggle = (name: string, on: boolean) =>
    props.onChange(on ? [...props.value, name].sort() : props.value.filter((n) => n !== name));
  return (
    <fieldset className="settings-group">
      <legend>Skill</legend>
      {props.skills.length === 0 ? (
        <p className="muted">
          Thư viện chưa có skill nào.{" "}
          <button type="button" className="link" onClick={props.onOpenLibrary}>
            Tạo skill trong Thư viện skill →
          </button>
        </p>
      ) : (
        <>
          <p className="muted">Agent chỉ thấy các skill được tích. Agent tự quyết định dùng skill nào dựa vào mô tả.</p>
          <ul className="skill-checks">
            {props.skills.map((sk) => (
              <li key={sk.name}>
                <label>
                  <input type="checkbox" checked={props.value.includes(sk.name)} onChange={(e) => toggle(sk.name, e.target.checked)} />
                  <span>
                    <code>{sk.name}</code>
                    <span className="muted"> · {sk.description}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <button type="button" className="link" onClick={props.onOpenLibrary}>
            Mở Thư viện skill →
          </button>
        </>
      )}
    </fieldset>
  );
}

/** List + editor for the skill library (workspace/.claude/skills/<name>/SKILL.md). */
function SkillLibrary(props: {
  tabs: ReactNode;
  skills: SkillSummary[];
  agents: AgentConfigView[];
  selected: string | null;
  onSelect: (name: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const agentName = (id: string) => props.agents.find((a) => a.id === id)?.name ?? id;
  // A new editor is mounted when the user picks a skill; creating one keeps the same editor (and its notice).
  const [editorKey, setEditorKey] = useState(0);
  const open = (name: string | null) => {
    setEditorKey((k) => k + 1);
    props.onSelect(name);
  };
  return (
    <>
      <section className="history-list" aria-label="Danh sách skill">
        {props.tabs}
        <button type="button" className="secondary new-skill" onClick={() => open(NEW_SKILL)}>
          + Tạo skill mới
        </button>
        {props.skills.length === 0 && <p className="muted empty">Chưa có skill nào.</p>}
        <ul className="history-items">
          {props.skills.map((sk) => (
            <li key={sk.name}>
              <button
                type="button"
                className={`history-item ${props.selected === sk.name ? "selected" : ""}`}
                onClick={() => open(sk.name)}
                aria-current={props.selected === sk.name}
              >
                <div className="history-item-body">
                  <div className="history-item-top">
                    <strong>
                      <code>{sk.name}</code>
                    </strong>
                  </div>
                  <div className="muted skill-desc">{sk.description}</div>
                  <div className="muted">
                    {sk.usedBy.length ? `Dùng bởi: ${sk.usedBy.map(agentName).join(", ")}` : "Chưa agent nào dùng"}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
        <p className="muted settings-note">
          Skill nằm trong <code>workspace/.claude/skills/</code>. Đừng để mật khẩu hay khoá API trong skill: agent nào cũng đọc được file trong thư mục làm việc.
        </p>
      </section>
      <section className="history-detail" aria-label="Nội dung skill">
        {props.selected ? (
          <SkillEditor
            key={editorKey}
            name={props.selected === NEW_SKILL ? null : props.selected}
            agentName={agentName}
            onBack={() => open(null)}
            onSaved={async (name) => {
              await props.onChanged();
              props.onSelect(name);
            }}
            onDeleted={async () => {
              await props.onChanged();
              props.onSelect(null);
            }}
          />
        ) : (
          <p className="muted empty">Chọn một skill để sửa, hoặc tạo skill mới.</p>
        )}
      </section>
    </>
  );
}

const SKILL_TEMPLATE = `# Tên skill

## Khi nào dùng
Mô tả tình huống agent nên dùng skill này.

## Cách làm
1. Bước 1
2. Bước 2

## Kết quả cần có
- …
`;

function SkillEditor(props: {
  name: string | null;
  agentName: (id: string) => string;
  onBack: () => void;
  onSaved: (name: string) => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const isNew = props.name === null;
  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [name, setName] = useState(props.name ?? "");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState(isNew ? SKILL_TEMPLATE : "");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isNew) return;
    send<SkillDetail>("GET", `/api/skills/${props.name}`)
      .then((sk) => {
        setSkill(sk);
        setDescription(sk.description);
        setBody(sk.body);
      })
      .catch((e: Error) => setError(e.message));
  }, [props.name]);

  const dirty = isNew || !skill || description !== skill.description || body !== skill.body;
  if (!isNew && !skill) return <p className={error ? "error" : "muted empty"}>{error || "Đang tải…"}</p>;

  const save = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await send<SkillDetail>("PUT", `/api/skills/${encodeURIComponent(name)}`, { description, body, create: isNew });
      setSkill(saved);
      setNotice(isNew ? "Đã tạo skill. Bật skill cho agent trong tab Agent." : "Đã lưu.");
      await props.onSaved(saved.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const users = skill?.usedBy.map(props.agentName).join(", ");
    if (!window.confirm(`Xoá skill "${props.name}"?${users ? ` Skill sẽ bị gỡ khỏi: ${users}.` : ""}`)) return;
    setBusy(true);
    try {
      await send("DELETE", `/api/skills/${props.name}`);
      await props.onDeleted();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <form
      className="detail settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <button type="button" className="link back" onClick={props.onBack}>
        ← Danh sách
      </button>
      <h3>{isNew ? "Skill mới" : <code>{props.name}</code>}</h3>
      {skill && skill.usedBy.length > 0 && (
        <p className="muted">Đang dùng bởi: {skill.usedBy.map(props.agentName).join(", ")}</p>
      )}
      {isNew && (
        <label className="field">
          <span>Tên (id)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            pattern={SKILL_NAME_PATTERN}
            placeholder="vd. bao-cao-tuan"
            title="Chữ thường a-z, số và dấu gạch ngang"
            required
          />
        </label>
      )}
      <label className="field">
        <span>Mô tả ({description.length}/1024): agent dựa vào đây để biết khi nào dùng skill</span>
        <input value={description} maxLength={1024} onChange={(e) => setDescription(e.target.value)} required />
      </label>
      <label className="field">
        <span>Nội dung SKILL.md (Markdown)</span>
        <textarea value={body} rows={16} onChange={(e) => setBody(e.target.value)} required />
      </label>
      {skill && skill.files.length > 0 && (
        <div className="muted">
          File kèm theo: {skill.files.map((f) => <code key={f}>{f} </code>)}
        </div>
      )}
      <div className="detail-actions">
        <button type="submit" className="primary" disabled={busy || !dirty}>
          {busy ? "Đang lưu…" : isNew ? "Tạo skill" : "Lưu"}
        </button>
        {!isNew && (
          <button type="button" className="secondary danger" disabled={busy} onClick={() => void remove()}>
            Xoá skill
          </button>
        )}
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
  );
}
