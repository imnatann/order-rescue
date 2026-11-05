import "server-only";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { all, exec, id, now, one, transaction } from "./db";
import { AppError } from "./errors";
import type { Role, User } from "./types";
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}
export const SESSION_COOKIE = "order_rescue_session";
export const SESSION_SECONDS = 60 * 60 * 12;
const userColumns = "id,email,name,role,active,created_at AS createdAt";
export const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt);
  return `scrypt$${salt}$${key.toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, salt, hash] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !hash) return false;
  const key = await derive(password, salt);
  const stored = Buffer.from(hash, "hex");
  return key.length === stored.length && timingSafeEqual(key, stored);
}
export function audit(
  actorId: string | null,
  action: string,
  entityType: string,
  entityId: string,
  details: unknown = {},
) {
  exec(
    "INSERT INTO audit_events(actor_id,action,entity_type,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?)",
    actorId,
    action,
    entityType,
    entityId,
    JSON.stringify(details),
    now(),
  );
}
export async function createUser(
  input: { email: string; name: string; password: string; role: Role },
  actorId: string | null = null,
) {
  const hash = await hashPassword(input.password);
  return transaction(() => {
    if (one("SELECT id FROM users WHERE email=?", input.email))
      throw new AppError("Email sudah terdaftar.", 409);
    const userId = id("USR");
    exec(
      "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
      userId,
      input.email.toLowerCase(),
      input.name,
      input.role,
      hash,
      now(),
    );
    audit(actorId, "user.created", "user", userId, {
      email: input.email,
      role: input.role,
    });
    return one<User>(`SELECT ${userColumns} FROM users WHERE id=?`, userId)!;
  });
}
export function listUsers() {
  return all<User>(
    `SELECT ${userColumns} FROM users ORDER BY created_at DESC LIMIT 200`,
  );
}
export async function updateUser(
  userId: string,
  input: { name?: string; role?: Role; active?: boolean; password?: string },
  actorId: string,
) {
  const passwordHash = input.password
    ? await hashPassword(input.password)
    : undefined;
  return transaction(() => {
    const user = one<User>(
      `SELECT ${userColumns} FROM users WHERE id=?`,
      userId,
    );
    if (!user) throw new AppError("Pengguna tidak ditemukan.", 404);
    if (
      user.active &&
      user.role === "admin" &&
      (input.active === false || (input.role && input.role !== "admin"))
    ) {
      if (
        (one<{ n: number }>(
          "SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1",
        )?.n ?? 0) <= 1
      )
        throw new AppError(
          "Administrator aktif terakhir tidak dapat dinonaktifkan.",
          409,
        );
    }
    exec(
      "UPDATE users SET name=?,role=?,active=?,password_hash=COALESCE(?,password_hash) WHERE id=?",
      input.name ?? user.name,
      input.role ?? user.role,
      input.active === undefined ? user.active : Number(input.active),
      passwordHash ?? null,
      userId,
    );
    if (
      passwordHash ||
      (input.role && input.role !== user.role) ||
      input.active === false
    )
      exec("DELETE FROM sessions WHERE user_id=?", userId);
    audit(actorId, "user.updated", "user", userId, {
      name: input.name,
      role: input.role,
      active: input.active,
      passwordChanged: Boolean(passwordHash),
    });
    return one<User>(`SELECT ${userColumns} FROM users WHERE id=?`, userId)!;
  });
}
export function rateLimit(key: string, limit: number, windowMs: number) {
  transaction(() => {
    const current = Date.now();
    exec("DELETE FROM rate_limits WHERE expires_at<?", current);
    const entry = one<{ count: number; expires_at: number }>(
      "SELECT count,expires_at FROM rate_limits WHERE key=?",
      key,
    );
    if (entry && entry.count >= limit)
      throw new AppError(
        "Terlalu banyak permintaan. Coba kembali beberapa saat lagi.",
        429,
        "RATE_LIMIT",
      );
    exec(
      "INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
      key,
      current + windowMs,
    );
  });
}
export async function login(email: string, password: string) {
  rateLimit(`login:${tokenHash(email.toLowerCase())}`, 8, 15 * 60_000);
  rateLimit("login:global", 100, 60_000);
  const record = one<User & { passwordHash: string }>(
    `SELECT ${userColumns},password_hash AS passwordHash FROM users WHERE email=?`,
    email.toLowerCase(),
  );
  const valid = await verifyPassword(
    password,
    record?.passwordHash ?? `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`,
  );
  if (!record?.active || !valid)
    throw new AppError(
      "Email atau kata sandi tidak sesuai.",
      401,
      "INVALID_CREDENTIALS",
    );
  const token = randomBytes(32).toString("base64url");
  transaction(() => {
    exec("DELETE FROM sessions WHERE expires_at<?", Date.now());
    exec(
      "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
      tokenHash(token),
      record.id,
      Date.now() + SESSION_SECONDS * 1000,
      now(),
    );
    audit(record.id, "session.created", "user", record.id);
  });
  const { passwordHash: _passwordHash, ...user } = record;
  void _passwordHash;
  return { token, user };
}
export function sessionUser(token?: string): User | null {
  if (!token || token.length > 128) return null;
  return (
    one<User>(
      `SELECT u.id,u.email,u.name,u.role,u.active,u.created_at AS createdAt FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`,
      tokenHash(token),
      Date.now(),
    ) ?? null
  );
}
export function logout(token?: string) {
  if (token) exec("DELETE FROM sessions WHERE token_hash=?", tokenHash(token));
}
export function requireRole(
  user: User | null,
  roles: Role[] = ["admin", "operator", "viewer"],
): User {
  if (!user)
    throw new AppError(
      "Silakan masuk terlebih dahulu.",
      401,
      "UNAUTHENTICATED",
    );
  if (!roles.includes(user.role))
    throw new AppError(
      "Akun tidak memiliki izin untuk tindakan ini.",
      403,
      "FORBIDDEN",
    );
  return user;
}
export async function changePassword(
  user: User,
  current: string,
  next: string,
) {
  const record = one<{ hash: string }>(
    "SELECT password_hash hash FROM users WHERE id=?",
    user.id,
  );
  if (!record || !(await verifyPassword(current, record.hash)))
    throw new AppError("Kata sandi saat ini tidak sesuai.", 400);
  await updateUser(user.id, { password: next }, user.id);
}
