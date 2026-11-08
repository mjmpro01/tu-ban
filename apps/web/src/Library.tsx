import type { LibraryDoc, LibraryHit, LibrarySettings } from "@tu-ban/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useStore } from "./store";
import { fmtDateTime } from "./ui";

const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function LibraryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
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
      aria-labelledby="library-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header className="history-header">
        <h2 id="library-title">Tài liệu tham khảo</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Đóng">
          ✕
        </button>
      </header>
      <div className="small-dialog-body">{open && <LibraryBody />}</div>
    </dialog>
  );
}

function LibraryBody() {
  const isAdmin = useStore((s) => s.auth?.user?.role === "admin");
  const [docs, setDocs] = useState<LibraryDoc[] | null>(null);
  const [types, setTypes] = useState<string[]>([]);
  const [settings, setSettings] = useState<LibrarySettings | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<LibraryHit[] | null>(null);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState<LibraryDoc | null>(null);

  const load = () =>
    api<{ docs: LibraryDoc[]; settings: LibrarySettings; types: string[] }>("GET", "/api/library").then(
      (r) => {
        setDocs(r.docs);
        setTypes(r.types);
        setSettings(r.settings);
      },
      (e: Error) => setError(e.message),
    );
  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setHits(null);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      api<LibraryHit[]>("GET", `/api/library/search?q=${encodeURIComponent(q.trim())}`).then(
        (r) => !stale && setHits(r),
        (e: Error) => !stale && setError(e.message),
      );
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [q]);

  if (viewing) return <DocText doc={viewing} onBack={() => setViewing(null)} />;

  return (
    <div className="settings-form memory-view">
      <p className="muted">
        Tài liệu ở đây được các agent tìm và trích dẫn khi làm việc (công cụ library_search), và tự đưa vào hướng dẫn khi khớp với yêu cầu. File gốc nằm trong
        thư mục <code>library/</code> của thư mục làm việc.
      </p>
      {isAdmin && <Upload types={types} onDone={() => void load()} />}
      <div className="memory-filters">
        <input type="search" placeholder="Tìm trong tài liệu…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Tìm trong tài liệu" />
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {hits ? (
        hits.length === 0 ? (
          <p className="muted empty">Không có đoạn nào khớp.</p>
        ) : (
          <ul className="memory-list">
            {hits.map((h) => (
              <li key={`${h.docId}:${h.chunk}`} className="memory-item">
                <div className="memory-meta">
                  <strong>{h.name}</strong>
                  <span className="muted">đoạn {h.chunk + 1}</span>
                  <span className="muted memory-score">độ khớp {Math.round(h.score * 100)}%</span>
                </div>
                <p className="memory-text library-snippet">{h.text}</p>
              </li>
            ))}
          </ul>
        )
      ) : docs === null ? (
        <p className="muted empty">Đang tải…</p>
      ) : docs.length === 0 ? (
        <p className="muted empty">Chưa có tài liệu nào.</p>
      ) : (
        <ul className="memory-list">
          {docs.map((d) => (
            <DocRow key={d.id} doc={d} canEdit={isAdmin} onView={() => setViewing(d)} onChanged={() => void load()} />
          ))}
        </ul>
      )}
      {isAdmin && settings && <LibrarySettingsForm settings={settings} onSaved={setSettings} />}
    </div>
  );
}

function Upload({ types, onDone }: { types: string[]; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState("");
  const [msgs, setMsgs] = useState<{ ok: boolean; text: string }[]>([]);
  const [over, setOver] = useState(false);

  const upload = async (files: FileList | File[]) => {
    const out: { ok: boolean; text: string }[] = [];
    for (const f of Array.from(files)) {
      setBusy(`Đang tải ${f.name}…`);
      try {
        const d = await api<LibraryDoc>("POST", `/api/library?name=${encodeURIComponent(f.name)}`, f);
        out.push(d.warning ? { ok: false, text: `${f.name}: ${d.warning}` } : { ok: true, text: `${f.name}: ${d.chunks} đoạn đã sẵn sàng để tìm` });
      } catch (e) {
        out.push({ ok: false, text: `${f.name}: ${(e as Error).message}` });
      }
    }
    setBusy("");
    setMsgs(out);
    onDone();
    if (input.current) input.current.value = "";
  };

  return (
    <div
      className={`dropzone ${over ? "over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
      }}
    >
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={types.map((t) => `.${t}`).join(",")}
        onChange={(e) => e.target.files?.length && void upload(e.target.files)}
      />
      <button type="button" className="primary" disabled={!!busy} onClick={() => input.current?.click()}>
        {busy || "Tải tài liệu lên"}
      </button>
      <span className="muted">hoặc kéo thả vào đây · PDF, Word (.docx), Markdown, TXT, CSV, HTML… tối đa 20 MB</span>
      {msgs.length > 0 && (
        <ul className="upload-results">
          {msgs.map((m) => (
            <li key={m.text} className={m.ok ? "success" : "error"}>
              {m.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DocRow({ doc, canEdit, onView, onChanged }: { doc: LibraryDoc; canEdit: boolean; onView: () => void; onChanged: () => void }) {
  const [error, setError] = useState("");
  return (
    <li className="memory-item">
      <div className="memory-meta">
        <strong className="doc-name">{doc.name}</strong>
        <span className="muted">
          {fmtSize(doc.size)} · {doc.chunks} đoạn
        </span>
        {doc.createdBy && <span className="muted">· bởi {doc.createdBy}</span>}
        <span className="muted">· {fmtDateTime(doc.createdAt)}</span>
      </div>
      {doc.warning && <p className="error">{doc.warning}</p>}
      <div className="detail-actions">
        {doc.chars > 0 && (
          <button type="button" className="secondary small" onClick={onView}>
            Xem nội dung
          </button>
        )}
        <a className="secondary small button-link" href={`/api/library/${doc.id}/file`} download={doc.name}>
          Tải về
        </a>
        {canEdit && (
          <button
            type="button"
            className="secondary small danger"
            onClick={() => {
              if (!confirm(`Xoá "${doc.name}" khỏi thư viện? File gốc cũng bị xoá.`)) return;
              api("DELETE", `/api/library/${doc.id}`).then(onChanged, (e: Error) => setError(e.message));
            }}
          >
            Xoá
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </li>
  );
}

function DocText({ doc, onBack }: { doc: LibraryDoc; onBack: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ text: string }>("GET", `/api/library/${doc.id}/text`).then(
      (r) => setText(r.text),
      (e: Error) => setError(e.message),
    );
  }, [doc.id]);
  return (
    <div className="settings-form memory-view">
      <div className="detail-actions">
        <button type="button" className="secondary small" onClick={onBack}>
          ← Danh sách
        </button>
        <strong className="doc-name">{doc.name}</strong>
      </div>
      <p className="muted">Nội dung chữ mà agent đọc được từ file này ({doc.chars.toLocaleString("vi-VN")} ký tự).</p>
      {error && <p className="error">{error}</p>}
      <pre className="doc-text">{text ?? "Đang tải…"}</pre>
    </div>
  );
}

function LibrarySettingsForm({ settings, onSaved }: { settings: LibrarySettings; onSaved: (s: LibrarySettings) => void }) {
  const [error, setError] = useState("");
  const [n, setN] = useState(String(settings.contextChunks));
  const save = async (patch: Partial<LibrarySettings>) => {
    setError("");
    onSaved({ ...settings, ...patch });
    try {
      onSaved(await api<LibrarySettings>("PUT", "/api/settings/library", patch));
    } catch (e) {
      onSaved(settings);
      setN(String(settings.contextChunks));
      setError((e as Error).message);
    }
  };
  return (
    <fieldset className="settings-group">
      <legend>Cách agent dùng tài liệu</legend>
      <ul className="skill-checks">
        <li>
          <label>
            <input type="checkbox" checked={settings.autoContext} onChange={(e) => void save({ autoContext: e.target.checked })} />
            <span>
              <strong>Tự đưa tài liệu liên quan</strong>
              <span className="muted"> · Trước mỗi task, thêm những đoạn khớp nhất (kèm tên file) vào hướng dẫn cho agent.</span>
            </span>
          </label>
        </li>
      </ul>
      <label className="field memory-limit">
        <span>Số đoạn tối đa</span>
        <input
          type="number"
          min={1}
          max={10}
          value={n}
          onChange={(e) => setN(e.target.value)}
          onBlur={() => Number(n) !== settings.contextChunks && void save({ contextChunks: Number(n) })}
        />
      </label>
      {error && <p className="error">{error}</p>}
    </fieldset>
  );
}
