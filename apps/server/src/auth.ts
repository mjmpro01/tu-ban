import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { Role, UserInfo } from "@tu-ban/shared";

export interface StoredUser extends UserInfo {
  passwordHash: string;
}

/** Storage for accounts and login sessions (Postgres, or memory when there is no database). */
export interface AuthRepo {
  countUsers(): Promise<number>;
  listUsers(): Promise<StoredUser[]>;
  findUser(by: { id?: string; username?: string }): Promise<StoredUser | undefined>;
  insertUser(u: StoredUser): Promise<void>;
  updateUser(id: string, patch: Partial<StoredUser>): Promise<void>;
  deleteUser(id: string): Promise<void>;
  insertSession(id: string, userId: string, expiresAt: number): Promise<void>;
  findSession(id: string): Promise<{ userId: string; expiresAt: number } | undefined>;
  deleteSession(id: string): Promise<void>;
  deleteUserSessions(userId: string): Promise<void>;
  purgeSessions(): Promise<void>;
}

export class MemoryAuthRepo implements AuthRepo {
  private users = new Map<string, StoredUser>();
  private sessions = new Map<string, { userId: string; expiresAt: number }>();
  async countUsers() {
    return this.users.size;
  }
  async listUsers() {
    return [...this.users.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
  async findUser(by: { id?: string; username?: string }) {
    if (by.id) return this.users.get(by.id);
    return [...this.users.values()].find((u) => u.username.toLowerCase() === by.username?.toLowerCase());
  }
  async insertUser(u: StoredUser) {
    this.users.set(u.id, u);
  }
  async updateUser(id: string, patch: Partial<StoredUser>) {
    const u = this.users.get(id);
    if (u) this.users.set(id, { ...u, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
  }
  async deleteUser(id: string) {
    this.users.delete(id);
    await this.deleteUserSessions(id);
  }
  async insertSession(id: string, userId: string, expiresAt: number) {
    this.sessions.set(id, { userId, expiresAt });
  }
  async findSession(id: string) {
    return this.sessions.get(id);
  }
  async deleteSession(id: string) {
    this.sessions.delete(id);
  }
  async deleteUserSessions(userId: string) {
    for (const [id, s] of this.sessions) if (s.userId === userId) this.sessions.delete(id);
  }
  async purgeSessions() {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (s.expiresAt < now) this.sessions.delete(id);
  }
}

// ---------------------------------------------------------------- passwords
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number }) {
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, keylen, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, N, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length, { N: +N, r: +r, p: +p });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// ---------------------------------------------------------------- service
export const SESSION_COOKIE = "tuban_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/i;

const toInfo = ({ passwordHash: _hash, ...u }: StoredUser): UserInfo => u;

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function checkPassword(password: unknown) {
  const p = String(password ?? "");
  if (p.length < 8) throw new AuthError("Mật khẩu cần ít nhất 8 ký tự");
  if (p.length > 200) throw new AuthError("Mật khẩu quá dài");
  return p;
}

function checkUsername(username: unknown) {
  const u = String(username ?? "").trim();
  if (!USERNAME_RE.test(u)) throw new AuthError("Tên đăng nhập gồm 3–32 ký tự: chữ, số, dấu chấm, gạch dưới, gạch ngang");
  return u;
}

function checkDisplayName(name: unknown, fallback: string) {
  const n = String(name ?? "").trim() || fallback;
  if (n.length > 60) throw new AuthError("Tên hiển thị tối đa 60 ký tự");
  return n;
}

function checkRole(role: unknown): Role {
  if (role !== "admin" && role !== "member") throw new AuthError("Vai trò không hợp lệ");
  return role;
}

export class AuthService {
  private failures = new Map<string, { count: number; until: number }>();

  constructor(
    private repo: AuthRepo,
    /** Called when a user's sessions must end (disabled, deleted, role or password changed). */
    private onRevoke: (userId: string) => void = () => {},
  ) {}

  /** Create the first admin from ADMIN_USERNAME / ADMIN_PASSWORD when there is no account yet. */
  async bootstrap(username?: string, password?: string) {
    await this.repo.purgeSessions();
    if (!username || !password || (await this.repo.countUsers()) > 0) return;
    await this.createUser({ username, password, displayName: username, role: "admin" });
    console.log(`[auth] đã tạo tài khoản admin "${username}" từ biến môi trường`);
  }

  async needsSetup() {
    return (await this.repo.countUsers()) === 0;
  }

  /** The user behind a session cookie, or undefined when the session is missing, expired or the user is disabled. */
  async userForSession(sessionId: string | undefined): Promise<UserInfo | undefined> {
    if (!sessionId) return undefined;
    const s = await this.repo.findSession(sessionId);
    if (!s) return undefined;
    if (s.expiresAt < Date.now()) {
      await this.repo.deleteSession(sessionId);
      return undefined;
    }
    const u = await this.repo.findUser({ id: s.userId });
    return u && !u.disabled ? toInfo(u) : undefined;
  }

  private async startSession(userId: string) {
    const id = randomBytes(32).toString("base64url");
    await this.repo.insertSession(id, userId, Date.now() + SESSION_TTL_MS);
    return id;
  }

  /** First-run setup: only works while no account exists. */
  async setup(input: { username?: string; password?: string; displayName?: string }) {
    if (!(await this.needsSetup())) throw new AuthError("Đã có tài khoản, hãy đăng nhập", 409);
    const user = await this.createUser({ ...input, role: "admin" });
    return { user, sessionId: await this.startSession(user.id) };
  }

  async login(username: unknown, password: unknown, ip: string) {
    const key = `${ip}|${String(username ?? "").toLowerCase()}`;
    const f = this.failures.get(key);
    if (f && f.count >= LOGIN_MAX_FAILURES && f.until > Date.now())
      throw new AuthError("Đăng nhập sai quá nhiều lần. Thử lại sau 15 phút.", 429);
    const u = await this.repo.findUser({ username: String(username ?? "") });
    const ok = !!u && !u.disabled && (await verifyPassword(String(password ?? ""), u.passwordHash));
    if (!ok) {
      const next = f && f.until > Date.now() ? f.count + 1 : 1;
      this.failures.set(key, { count: next, until: Date.now() + LOGIN_WINDOW_MS });
      throw new AuthError("Sai tên đăng nhập hoặc mật khẩu", 401);
    }
    this.failures.delete(key);
    return { user: toInfo(u), sessionId: await this.startSession(u.id) };
  }

  async logout(sessionId: string | undefined) {
    if (sessionId) await this.repo.deleteSession(sessionId);
  }

  async listUsers() {
    return (await this.repo.listUsers()).map(toInfo);
  }

  async createUser(input: { username?: unknown; password?: unknown; displayName?: unknown; role?: unknown }) {
    const username = checkUsername(input.username);
    if (await this.repo.findUser({ username })) throw new AuthError("Tên đăng nhập đã tồn tại", 409);
    const user: StoredUser = {
      id: randomUUID(),
      username,
      displayName: checkDisplayName(input.displayName, username),
      role: checkRole(input.role ?? "member"),
      disabled: false,
      createdAt: Date.now(),
      passwordHash: await hashPassword(checkPassword(input.password)),
    };
    await this.repo.insertUser(user);
    return toInfo(user);
  }

  private async enabledAdmins() {
    return (await this.repo.listUsers()).filter((u) => u.role === "admin" && !u.disabled);
  }

  /** Admin edit of another account (or their own display name). Keeps at least one enabled admin. */
  async updateUser(id: string, input: { displayName?: unknown; role?: unknown; disabled?: unknown; password?: unknown }, actorId: string) {
    const u = await this.repo.findUser({ id });
    if (!u) throw new AuthError("Không có người dùng này", 404);
    const patch: Partial<StoredUser> = {};
    if (input.displayName !== undefined) patch.displayName = checkDisplayName(input.displayName, u.username);
    if (input.role !== undefined) patch.role = checkRole(input.role);
    if (input.disabled !== undefined) patch.disabled = !!input.disabled;
    if (input.password !== undefined && input.password !== "") patch.passwordHash = await hashPassword(checkPassword(input.password));
    if (id === actorId && (patch.disabled || patch.role === "member")) throw new AuthError("Không thể tự khoá hoặc tự hạ quyền chính mình");
    const losesAdmin = u.role === "admin" && !u.disabled && (patch.role === "member" || patch.disabled);
    if (losesAdmin && (await this.enabledAdmins()).length <= 1) throw new AuthError("Phải còn ít nhất một admin đang hoạt động");
    await this.repo.updateUser(id, patch);
    if (patch.disabled || patch.role || patch.passwordHash) {
      await this.repo.deleteUserSessions(id);
      this.onRevoke(id);
    }
    return toInfo((await this.repo.findUser({ id }))!);
  }

  async deleteUser(id: string, actorId: string) {
    if (id === actorId) throw new AuthError("Không thể tự xoá tài khoản của mình");
    const u = await this.repo.findUser({ id });
    if (!u) throw new AuthError("Không có người dùng này", 404);
    if (u.role === "admin" && !u.disabled && (await this.enabledAdmins()).length <= 1)
      throw new AuthError("Phải còn ít nhất một admin đang hoạt động");
    await this.repo.deleteUser(id);
    this.onRevoke(id);
  }

  /** A user changing their own password. Other sessions of that user are signed out. */
  async changePassword(userId: string, current: unknown, next: unknown, keepSession: string | undefined) {
    const u = await this.repo.findUser({ id: userId });
    if (!u || !(await verifyPassword(String(current ?? ""), u.passwordHash))) throw new AuthError("Mật khẩu hiện tại không đúng", 403);
    await this.repo.updateUser(userId, { passwordHash: await hashPassword(checkPassword(next)) });
    await this.repo.deleteUserSessions(userId);
    this.onRevoke(userId);
    void keepSession; // every session is replaced, including the current one
    return this.startSession(userId);
  }
}
