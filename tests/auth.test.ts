import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { admin, cleanup, setup } from "./helpers";
import {
  createUser,
  hashPassword,
  login,
  logout,
  rateLimit,
  requireRole,
  sessionUser,
  updateUser,
  verifyPassword,
} from "../src/server/auth";
import { exec, one } from "../src/server/db";
beforeEach(setup);
afterEach(cleanup);
test("password hashing uses a random salt and verifies without storing plaintext", async () => {
  const a = await hashPassword("Correct-Horse-12345");
  const b = await hashPassword("Correct-Horse-12345");
  assert.notEqual(a, b);
  assert.ok(!a.includes("Correct"));
  assert.equal(await verifyPassword("Correct-Horse-12345", a), true);
  assert.equal(await verifyPassword("Wrong-Password", a), false);
});
test("sessions are hashed at rest, expire, and are revoked by logout or password change", async () => {
  const user = await createUser({
    email: "operator@example.test",
    name: "Operator",
    role: "operator",
    password: "Operator-Password-123",
  });
  const session = await login(user.email, "Operator-Password-123");
  assert.equal(sessionUser(session.token)?.id, user.id);
  assert.equal(
    one("SELECT user_id FROM sessions WHERE token_hash=?", session.token),
    undefined,
  );
  logout(session.token);
  assert.equal(sessionUser(session.token), null);
  const another = await login(user.email, "Operator-Password-123");
  await updateUser(user.id, { password: "Changed-Password-123" }, admin.id);
  assert.equal(sessionUser(another.token), null);
  const expired = await login(user.email, "Changed-Password-123");
  exec("UPDATE sessions SET expires_at=0");
  assert.equal(sessionUser(expired.token), null);
});
test("role checks and last-administrator protection are server-side invariants", async () => {
  assert.throws(() => requireRole(null), /masuk/);
  assert.throws(
    () => requireRole({ ...admin, role: "viewer" }, ["admin", "operator"]),
    /izin/,
  );
  await assert.rejects(
    () => updateUser(admin.id, { active: false }, admin.id),
    /terakhir/,
  );
  await assert.rejects(
    () => updateUser(admin.id, { role: "viewer" }, admin.id),
    /terakhir/,
  );
});
test("database-backed throttling survives independent calls and allows a new window", () => {
  rateLimit("test-key", 2, 1000);
  rateLimit("test-key", 2, 1000);
  assert.throws(() => rateLimit("test-key", 2, 1000), /banyak/);
  exec("UPDATE rate_limits SET expires_at=0");
  assert.doesNotThrow(() => rateLimit("test-key", 2, 1000));
});
test("invalid login returns a generic message and disabled users cannot sign in", async () => {
  await assert.rejects(
    () => login("missing@example.test", "wrong"),
    /Email atau kata sandi/,
  );
  const user = await createUser({
    email: "inactive@example.test",
    name: "Inactive",
    role: "viewer",
    password: "Viewer-Password-123",
  });
  await updateUser(user.id, { active: false }, admin.id);
  await assert.rejects(
    () => login(user.email, "Viewer-Password-123"),
    /Email atau kata sandi/,
  );
});
