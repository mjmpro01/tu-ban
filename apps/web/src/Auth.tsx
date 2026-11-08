import type { Role, UserInfo } from "@tu-ban/shared";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { auth, useStore } from "./store";
import { fmtDateTime } from "./ui";

const ROLE_LABEL: Record<Role, string> = { admin: "Admin", member: "Thành viên" };

/** Login screen; on a fresh install (no account yet) it creates the first admin instead. */
export function LoginScreen({ needsSetup }: { needsSetup: boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (needsSetup && password !== confirm) return setError("Hai mật khẩu không khớp");
    setBusy(true);
    try {
      if (needsSetup) await auth.setup(username, password, displayName);
      else await auth.login(username, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <img src="/portraits/portrait_manager.png" width={64} height={64} alt="" className="portrait" />
        <h1>Văn phòng AI</h1>
        {needsSetup ? (
          <p className="muted">
            Lần chạy đầu tiên: tạo tài khoản <strong>admin</strong>. Admin cấu hình agent, duyệt lệnh và thêm người dùng khác.
          </p>
        ) : (
          <p className="muted">Đăng nhập để vào văn phòng.</p>
        )}
        <label className="field">
          <span>Tên đăng nhập</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
        </label>
        {needsSetup && (
          <label className="field">
            <span>Tên hiển thị</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="vd. Minh" />
          </label>
        )}
        <label className="field">
          <span>Mật khẩu {needsSetup && <span className="muted">(ít nhất 8 ký tự)</span>}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={needsSetup ? "new-password" : "current-password"}
            minLength={needsSetup ? 8 : undefined}
            required
          />
        </label>
        {needsSetup && (
          <label className="field">
            <span>Nhập lại mật khẩu</span>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          </label>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Đang xử lý…" : needsSetup ? "Tạo admin và vào văn phòng" : "Đăng nhập"}
        </button>
      </form>
    </main>
  );
}

/** Name + role in the header with account actions. */
export function UserMenu({
  onOpenUsers,
  onOpenPassword,
  onOpenNotifications,
}: {
  onOpenUsers: () => void;
  onOpenPassword: () => void;
  onOpenNotifications: () => void;
}) {
  const user = useStore((s) => s.auth?.user);
  const ref = useRef<HTMLDetailsElement>(null);
  if (!user) return null;
  const pick = (fn: () => void) => () => {
    ref.current?.removeAttribute("open");
    fn();
  };
  return (
    <details className="user-menu" ref={ref}>
      <summary>
        <span className="user-name">{user.displayName}</span>
        <span className={`role-badge role-${user.role}`}>{ROLE_LABEL[user.role]}</span>
      </summary>
      <div className="user-menu-panel" role="menu">
        <div className="muted">@{user.username}</div>
        {user.role === "admin" && (
          <>
            <button type="button" role="menuitem" onClick={pick(onOpenUsers)}>
              Quản lý người dùng
            </button>
            <button type="button" role="menuitem" onClick={pick(onOpenNotifications)}>
              Thông báo
            </button>
          </>
        )}
        <button type="button" role="menuitem" onClick={pick(onOpenPassword)}>
          Đổi mật khẩu
        </button>
        <button type="button" role="menuitem" onClick={pick(() => void auth.logout())}>
          Đăng xuất
        </button>
      </div>
    </details>
  );
}

function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`small-dialog ${wide ? "wide" : ""}`}
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header className="history-header">
        <h2>{title}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Đóng">
          ✕
        </button>
      </header>
      <div className="small-dialog-body">{open && children}</div>
    </dialog>
  );
}

export function PasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Đổi mật khẩu">
      <PasswordForm onDone={onClose} />
    </Dialog>
  );
}

function PasswordForm({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (next !== confirm) return setError("Hai mật khẩu mới không khớp");
    try {
      await api("POST", "/api/auth/password", { current, next });
      setDone(true);
      setTimeout(onDone, 1200);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form className="settings-form" onSubmit={submit}>
      <label className="field">
        <span>Mật khẩu hiện tại</span>
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
      </label>
      <label className="field">
        <span>Mật khẩu mới (ít nhất 8 ký tự)</span>
        <input type="password" value={next} minLength={8} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
      </label>
      <label className="field">
        <span>Nhập lại mật khẩu mới</span>
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
      </label>
      <p className="muted">Các thiết bị khác đang đăng nhập bằng tài khoản này sẽ bị đăng xuất.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="success" role="status">
          Đã đổi mật khẩu.
        </p>
      )}
      <div className="detail-actions">
        <button type="submit" className="primary">
          Đổi mật khẩu
        </button>
      </div>
    </form>
  );
}

/** Admin: add people, change roles, reset passwords, disable or delete accounts. */
export function UsersDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Quản lý người dùng" wide>
      <UsersPanel />
    </Dialog>
  );
}

function UsersPanel() {
  const me = useStore((s) => s.auth?.user);
  const [users, setUsers] = useState<UserInfo[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ username: "", displayName: "", password: "", role: "member" as Role });

  const load = () =>
    api<UserInfo[]>("GET", "/api/users")
      .then(setUsers)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const run = async (fn: () => Promise<unknown>, message: string) => {
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(message);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api("POST", "/api/users", form);
      setForm({ username: "", displayName: "", password: "", role: "member" });
    }, `Đã thêm ${form.displayName || form.username}.`);
  };

  return (
    <div className="users">
      <table className="users-table">
        <thead>
          <tr>
            <th scope="col">Người dùng</th>
            <th scope="col">Vai trò</th>
            <th scope="col">Trạng thái</th>
            <th scope="col">
              <span className="visually-hidden">Thao tác</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {users?.map((u) => {
            const self = u.id === me?.id;
            return (
              <tr key={u.id} className={u.disabled ? "is-disabled" : ""}>
                <td>
                  <strong>{u.displayName}</strong>
                  {self && <span className="muted"> (bạn)</span>}
                  <div className="muted">
                    @{u.username} · tạo {fmtDateTime(u.createdAt)}
                  </div>
                </td>
                <td>
                  <select
                    value={u.role}
                    disabled={self}
                    aria-label={`Vai trò của ${u.displayName}`}
                    onChange={(e) =>
                      void run(() => api("PATCH", `/api/users/${u.id}`, { role: e.target.value }), `Đã đổi vai trò của ${u.displayName}.`)
                    }
                  >
                    <option value="member">{ROLE_LABEL.member}</option>
                    <option value="admin">{ROLE_LABEL.admin}</option>
                  </select>
                </td>
                <td>{u.disabled ? "Đã khoá" : "Hoạt động"}</td>
                <td>
                  <div className="users-actions">
                  <button
                    type="button"
                    className="secondary small"
                    onClick={() => {
                      const pw = window.prompt(`Mật khẩu mới cho ${u.displayName} (ít nhất 8 ký tự):`);
                      if (pw) void run(() => api("PATCH", `/api/users/${u.id}`, { password: pw }), `Đã đặt lại mật khẩu cho ${u.displayName}.`);
                    }}
                  >
                    Đặt lại mật khẩu
                  </button>
                  {!self && (
                    <>
                      <button
                        type="button"
                        className="secondary small"
                        onClick={() =>
                          void run(
                            () => api("PATCH", `/api/users/${u.id}`, { disabled: !u.disabled }),
                            u.disabled ? `Đã mở khoá ${u.displayName}.` : `Đã khoá ${u.displayName}.`,
                          )
                        }
                      >
                        {u.disabled ? "Mở khoá" : "Khoá"}
                      </button>
                      <button
                        type="button"
                        className="secondary small danger"
                        onClick={() => {
                          if (window.confirm(`Xoá tài khoản ${u.displayName}? Lịch sử task vẫn giữ tên người này.`))
                            void run(() => api("DELETE", `/api/users/${u.id}`), `Đã xoá ${u.displayName}.`);
                        }}
                      >
                        Xoá
                      </button>
                    </>
                  )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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

      <form className="settings-group add-user" onSubmit={add}>
        <h3>Thêm người dùng</h3>
        <div className="field-row">
          <label className="field">
            <span>Tên đăng nhập</span>
            <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />
          </label>
          <label className="field">
            <span>Tên hiển thị</span>
            <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Mật khẩu (ít nhất 8 ký tự)</span>
            <input
              type="password"
              value={form.password}
              minLength={8}
              autoComplete="new-password"
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
            />
          </label>
          <label className="field">
            <span>Vai trò</span>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              <option value="member">Thành viên: giao việc, xem, huỷ task của mình</option>
              <option value="admin">Admin: cấu hình agent, duyệt lệnh, quản lý người dùng</option>
            </select>
          </label>
        </div>
        <div className="detail-actions">
          <button type="submit" className="primary">
            Thêm
          </button>
        </div>
      </form>
    </div>
  );
}
