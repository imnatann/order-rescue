import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET, POST, PATCH } from "../src/app/api/[...path]/route";
import { admin, cleanup, order, setup } from "./helpers";
import {
  createUser,
  hashPassword,
  login,
  SESSION_COOKIE,
} from "../src/server/auth";
import { exec } from "../src/server/db";
import { getOrder, inventory } from "../src/server/store";
beforeEach(setup);
afterEach(cleanup);
function request(
  path: string,
  body?: unknown,
  token?: string,
  origin = "http://127.0.0.1:3000",
) {
  return new NextRequest(`http://127.0.0.1:3000/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { Cookie: `${SESSION_COOKIE}=${token}` } : {}),
      ...(body === undefined
        ? {}
        : {
            Origin: origin,
            "Content-Type": "application/json",
            "X-Requested-With": "OrderRescue",
          }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function adminToken() {
  exec(
    "UPDATE users SET password_hash=? WHERE id=?",
    await hashPassword("Admin-Password-123"),
    admin.id,
  );
  return (await login(admin.email, "Admin-Password-123")).token;
}
test("anonymous operational reads are denied while liveness remains public", async () => {
  assert.equal((await GET(request("workspace"))).status, 401);
  assert.equal((await GET(request("health"))).status, 200);
  assert.equal((await GET(request("ready"))).status, 503);
});
test("login cookie is HttpOnly, same-site and contains no password or provider key", async () => {
  exec(
    "UPDATE users SET password_hash=? WHERE id=?",
    await hashPassword("Admin-Password-123"),
    admin.id,
  );
  const response = await POST(
    request("auth/login", {
      email: admin.email,
      password: "Admin-Password-123",
    }),
  );
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=strict/i);
  assert.ok(!JSON.stringify(await response.json()).includes("Admin-Password"));
});
test("cross-origin and oversized writes are rejected before mutation", async () => {
  const token = await adminToken();
  assert.equal(
    (
      await POST(
        request(
          "resources/products",
          { sku: "EVIL", name: "Bad" },
          token,
          "http://evil.example",
        ),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await POST(
        request(
          "resources/products",
          { sku: "X", name: "x".repeat(70 * 1024) },
          token,
        ),
      )
    ).status,
    413,
  );
});
test("viewer can inspect data but cannot create orders, runs or users", async () => {
  const viewer = await createUser({
    email: "viewer@example.test",
    name: "Viewer",
    role: "viewer",
    password: "Viewer-Password-123",
  });
  const token = (await login(viewer.email, "Viewer-Password-123")).token;
  assert.equal((await GET(request("workspace", undefined, token))).status, 200);
  assert.equal(
    (
      await POST(
        request("resources/products", { sku: "DENIED", name: "No" }, token),
      )
    ).status,
    403,
  );
  assert.equal((await POST(request("runs", {}, token))).status, 403);
  assert.equal((await GET(request("users", undefined, token))).status, 403);
});
test("operator API creates a multi-line order and prevents stock below reservations", async () => {
  const token = await adminToken();
  const response = await POST(
    request(
      "resources/orders",
      {
        customer: "API Customer",
        dueDate: "2030-01-01",
        priority: "high",
        allowPartial: false,
        lines: [{ sku: "CUP", quantity: 10 }],
      },
      token,
    ),
  );
  assert.equal(response.status, 201);
  const { id } = await response.json();
  assert.equal(getOrder(id)?.lines[0].quantity, 10);
  exec("UPDATE inventory SET reserved=50 WHERE warehouse_id='WH-1'");
  const invalid = await POST(
    request(
      "resources/inventory",
      { warehouseId: "WH-1", sku: "CUP", onHand: 40 },
      token,
    ),
  );
  assert.equal(invalid.status, 409);
  assert.equal(inventory().find((s) => s.warehouseId === "WH-1")?.onHand, 100);
});
test("run creation is idempotent and protected role updates cannot remove the last admin", async () => {
  const token = await adminToken();
  const o = order(10);
  const make = () => {
    const r = request(
      "runs",
      {
        orderIds: [o.id],
        maxCostIdr: 0,
        autoExecute: false,
        allowPartialDelivery: false,
        goal: "",
      },
      token,
    );
    r.headers.set("idempotency-key", "test-request-12345");
    return r;
  };
  const a = await POST(make()),
    b = await POST(make());
  assert.equal(a.status, 202);
  assert.equal((await a.json()).run.id, (await b.json()).run.id);
  const update = request(`users/${admin.id}`, { active: false }, token);
  const result = await PATCH(new NextRequest(update, { method: "PATCH" }));
  assert.equal(result.status, 409);
});
