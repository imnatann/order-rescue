import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  api,
  apiError,
  json,
  noStore,
  originGuard,
  readJson,
} from "@/server/http";
import {
  changePassword,
  createUser,
  listUsers,
  login,
  logout,
  rateLimit,
  requireRole,
  SESSION_COOKIE,
  SESSION_SECONDS,
  updateUser,
} from "@/server/auth";
import {
  auditEvents,
  dataMode,
  events,
  getOrder,
  getRun,
  inventory,
  offers,
  orders,
  products,
  purchaseOrders,
  saveResource,
  snapshot,
  suppliers,
  warehouses,
  workerHealthy,
} from "@/server/store";
import {
  approveRun,
  cancelOrder,
  cancelRun,
  createRun,
  receivePurchase,
  retryRun,
  shipOrder,
  failOffer,
} from "@/server/execution";
import { AppError } from "@/server/errors";
import {
  constraintsSchema,
  loginSchema,
  passwordSchema,
  userSchema,
  userUpdateSchema,
} from "@/server/validation";
import {
  isLlmConfigured,
  completeChat,
  ProviderError,
} from "@/lib/llm/provider";
import { one } from "@/server/db";

function cookieOptions() {
  return {
    httpOnly: true,
    secure: (process.env.APP_URL || "").startsWith("https://"),
    sameSite: "strict" as const,
    path: "/",
    maxAge: SESSION_SECONDS,
  };
}
function pathOf(request: NextRequest) {
  return request.nextUrl.pathname
    .replace(/^\/api\//, "")
    .split("/")
    .map(decodeURIComponent);
}
function admin(role: string) {
  if (role !== "admin")
    throw new AppError("Tindakan ini hanya tersedia untuk administrator.", 403);
}
const authenticated = api(async (request, user) => {
  const p = pathOf(request);
  const method = request.method;
  if (method === "GET") {
    if (p[0] === "auth" && p[1] === "me") return json({ user });
    if (p[0] === "workspace")
      return json({
        ...snapshot(),
        suppliers: suppliers(),
        llmConfigured: isLlmConfigured(),
      });
    if (p[0] === "orders") {
      if (!p[1]) return json({ data: orders() });
      const order = getOrder(p[1]);
      if (!order) throw new AppError("Pesanan tidak ditemukan.", 404);
      return json({ data: order });
    }
    if (p[0] === "inventory") return json({ data: inventory() });
    if (p[0] === "suppliers")
      return json({ data: suppliers(), offers: offers() });
    if (p[0] === "products") return json({ data: products() });
    if (p[0] === "warehouses") return json({ data: warehouses() });
    if (p[0] === "purchases") return json({ data: purchaseOrders() });
    if (p[0] === "runs" && p[1]) {
      const run = getRun(p[1]);
      if (!run) throw new AppError("Run tidak ditemukan.", 404);
      return json({ run, events: events(run.id) });
    }
    if (p[0] === "audit") {
      requireRole(user, ["admin", "operator"]);
      const before = Number(
        request.nextUrl.searchParams.get("before") || Number.MAX_SAFE_INTEGER,
      );
      if (!Number.isSafeInteger(before) || before < 1)
        throw new AppError("Cursor tidak valid.");
      return json({ data: auditEvents(before) });
    }
    if (p[0] === "users") {
      admin(user.role);
      return json({ data: listUsers() });
    }
    if (p[0] === "settings")
      return json({
        mode: dataMode(),
        llmConfigured: isLlmConfigured(),
        model: process.env.LLM_MODEL || null,
        workerHealthy: workerHealthy(),
        sessionHours: 12,
      });
    if (p[0] === "export" && p[1] === "orders.csv") {
      const cell = (v: unknown) =>
        `"${String(v)
          .replace(/^[=+@\-\t\r]/, "'$&")
          .replaceAll('"', '""')}"`;
      const rows = [
        [
          "Order",
          "Customer",
          "Due date",
          "Priority",
          "Status",
          "SKU",
          "Quantity",
          "Fulfilled",
          "Allocated",
        ],
        ...orders().flatMap((o) =>
          o.lines.map((l) => [
            o.id,
            o.customer,
            o.dueDate,
            o.priority,
            o.status,
            l.sku,
            l.quantity,
            l.fulfilled,
            l.allocated,
          ]),
        ),
      ];
      return new Response(
        "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n"),
        {
          headers: {
            ...noStore,
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition":
              'attachment; filename="order-rescue-orders.csv"',
          },
        },
      );
    }
    if (p[0] === "export" && p[1] === "runs" && p[2]) {
      const run = getRun(p[2]);
      if (!run) throw new AppError("Run tidak ditemukan.", 404);
      return new Response(
        JSON.stringify({ run, events: events(run.id) }, null, 2),
        {
          headers: {
            ...noStore,
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="${run.id}.json"`,
          },
        },
      );
    }
  }
  if (method === "POST" && p[0] === "auth" && p[1] === "logout") {
    await readJson(request, z.object({}).strict());
    logout(request.cookies.get(SESSION_COOKIE)?.value);
    const response = NextResponse.json({ ok: true }, { headers: noStore });
    response.cookies.set(SESSION_COOKIE, "", { ...cookieOptions(), maxAge: 0 });
    return response;
  }
  if (method === "POST" && p[0] === "auth" && p[1] === "password") {
    const v = await readJson(request, passwordSchema);
    rateLimit(`password:${user.id}`, 5, 15 * 60_000);
    await changePassword(user, v.currentPassword, v.newPassword);
    const response = NextResponse.json({ ok: true }, { headers: noStore });
    response.cookies.set(SESSION_COOKIE, "", { ...cookieOptions(), maxAge: 0 });
    return response;
  }
  requireRole(user, ["admin", "operator"]);
  if (method === "POST" && p[0] === "resources" && p[1]) {
    const raw = await readJson(request, z.unknown());
    return json(saveResource(p[1], raw, user.id), 201);
  }
  if (method === "POST" && p[0] === "runs" && !p[1]) {
    rateLimit(`run:${user.id}`, 10, 60_000);
    const v = await readJson(request, constraintsSchema);
    return json(
      { run: createRun(v, user, request.headers.get("idempotency-key") || "") },
      202,
    );
  }
  if (method === "POST" && p[0] === "runs" && p[1]) {
    await readJson(request, z.object({}).strict());
    if (p[2] === "approve") return json({ run: approveRun(p[1], user) }, 202);
    if (p[2] === "cancel") return json({ run: cancelRun(p[1], user) });
    if (p[2] === "retry") return json({ run: retryRun(p[1], user) }, 202);
  }
  if (method === "POST" && p[0] === "orders" && p[1]) {
    await readJson(request, z.object({}).strict());
    if (p[2] === "ship") return json(shipOrder(p[1], user));
    if (p[2] === "cancel") return json(cancelOrder(p[1], user));
  }
  if (method === "POST" && p[0] === "purchases" && p[1] && p[2] === "receive") {
    const v = await readJson(
      request,
      z.object({ warehouseId: z.string().min(1).max(80) }).strict(),
    );
    return json(receivePurchase(p[1], v.warehouseId, user));
  }
  if (method === "POST" && p[0] === "offers" && p[1] && p[2] === "fail") {
    await readJson(request, z.object({}).strict());
    return json(failOffer(p[1], user));
  }
  if (method === "POST" && p[0] === "simulation" && p[1] === "fail-offer") {
    if (dataMode() !== "simulation")
      throw new AppError(
        "Kontrol simulasi tidak aktif dalam mode operasi.",
        403,
      );
    const v = await readJson(
      request,
      z.object({ offerId: z.string().min(1).max(80) }).strict(),
    );
    const offer = offers().find((o) => o.id === v.offerId);
    if (!offer) throw new AppError("Penawaran tidak ditemukan.", 404);
    return json(failOffer(offer.id, user));
  }
  if (p[0] === "users") {
    admin(user.role);
    if (method === "POST" && !p[1])
      return json(
        {
          user: await createUser(await readJson(request, userSchema), user.id),
        },
        201,
      );
    if (method === "PATCH" && p[1])
      return json({
        user: await updateUser(
          p[1],
          await readJson(request, userUpdateSchema),
          user.id,
        ),
      });
  }
  if (method === "POST" && p[0] === "provider" && p[1] === "check") {
    admin(user.role);
    await readJson(request, z.object({}).strict());
    rateLimit(`providercheck:${user.id}`, 3, 60_000);
    const start = performance.now();
    try {
      const result = await completeChat([
        { role: "user", content: "Balas hanya OK." },
      ]);
      return json({
        ok: true,
        model: result.model,
        latencyMs: Math.round(performance.now() - start),
      });
    } catch (error) {
      throw new AppError(
        error instanceof ProviderError
          ? error.message
          : "Provider belum dapat dihubungi.",
        502,
      );
    }
  }
  throw new AppError("Endpoint tidak ditemukan.", 404);
});
async function handle(request: NextRequest) {
  try {
    const p = pathOf(request);
    if (request.method === "GET" && p[0] === "health")
      return json({ status: "ok", service: "order-rescue" });
    if (request.method === "GET" && p[0] === "ready") {
      const database = Boolean(one("SELECT 1 ok"));
      const worker = workerHealthy();
      const provider = isLlmConfigured();
      return json(
        {
          status: database && worker && provider ? "ready" : "degraded",
          database,
          worker,
          providerConfigured: provider,
        },
        database && worker && provider ? 200 : 503,
      );
    }
    if (request.method === "POST" && p[0] === "auth" && p[1] === "login") {
      originGuard(request);
      const v = await readJson(request, loginSchema);
      const result = await login(v.email, v.password);
      const response = NextResponse.json(
        { user: result.user },
        { headers: noStore },
      );
      response.cookies.set(SESSION_COOKIE, result.token, cookieOptions());
      return response;
    }
    return authenticated(request);
  } catch (error) {
    return apiError(error);
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
