import "../scripts/load-env";
import assert from "node:assert/strict";
import { relative } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setup, cleanup, admin, order } from "./helpers";
import { hashPassword } from "../src/server/auth";
import { exec, closeDb } from "../src/server/db";
const base = "http://127.0.0.1:3001";
let child: ChildProcess | undefined;
let diagnostic = "";
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      reject(new Error("Production process did not stop gracefully."));
    }, 15000);
    child!.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
async function start() {
  child = spawn(process.execPath, ["scripts/start.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      APP_URL: base,
      PORT: "3001",
      NODE_ENV: "production",
      ALLOW_INSECURE_LOCALHOST: "true",
      HOSTNAME_OVERRIDE: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-8000);
  });
  child.stderr?.on("data", (chunk) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-8000);
  });
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (child.exitCode !== null)
      throw new Error(`Production process exited ${child.exitCode}`);
    try {
      const r = await fetch(base + "/api/ready");
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Production process was not ready.");
}
async function main() {
  if (!process.env.LLM_API_KEY)
    throw new Error("Live production smoke requires configured LLM.");
  setup();
  exec(
    "UPDATE users SET password_hash=? WHERE id=?",
    await hashPassword("Production-Test-Password-123"),
    admin.id,
  );
  const o = order(50);
  closeDb();
  process.env.DATABASE_PATH = relative(
    process.cwd(),
    process.env.DATABASE_PATH!,
  );
  await start();
  assert.equal((await fetch(base + "/api/workspace")).status, 401);
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      "X-Requested-With": "OrderRescue",
    },
    body: JSON.stringify({
      email: admin.email,
      password: "Production-Test-Password-123",
    }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const request = async (path: string, body?: unknown) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: cookie,
        ...(body === undefined
          ? {}
          : {
              Origin: base,
              "Content-Type": "application/json",
              "X-Requested-With": "OrderRescue",
              "Idempotency-Key": crypto.randomUUID(),
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const page = await request("/");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes("Kendalikan pemenuhan pesanan."));
  assert.match(page.headers.get("content-security-policy")!, /nonce-/);
  assert.ok(html.includes("nonce="));
  const created = await request("/api/runs", {
    orderIds: [o.id],
    maxCostIdr: 0,
    allowPartialDelivery: false,
    autoExecute: true,
    goal: "Penuhi stok lokal dengan anggaran nol.",
  });
  assert.equal(created.status, 202);
  const runId = (await created.json()).run.id;
  const started = Date.now();
  let run;
  while (Date.now() - started < 150000) {
    const response = await request(`/api/runs/${runId}`);
    run = (await response.json()).run;
    if (run.status === "completed") break;
    if (["failed", "needs_attention"].includes(run.status))
      throw new Error(run.error || "Run failed.");
    await new Promise((r) => setTimeout(r, 400));
  }
  assert.equal(run?.status, "completed");
  assert.equal(run.result.totalCostIdr, 0);
  assert.ok(run.result.verified);
  assert.equal((await request(`/api/orders/${o.id}/ship`, {})).status, 200);
  await stop();
  await start();
  const persisted = await request(`/api/orders/${o.id}`);
  assert.equal(persisted.status, 200);
  assert.equal((await persisted.json()).data.status, "fulfilled");
  console.log(
    JSON.stringify(
      {
        ok: true,
        node: process.version,
        standaloneProductionServer: true,
        relativeDatabasePath: true,
        authenticatedHttpWorkflow: true,
        realLlmAutomaticExecution: true,
        nonceCsp: true,
        persistenceAcrossServerRestart: true,
        gracefulSupervisorShutdown: true,
      },
      null,
      2,
    ),
  );
}
main()
  .catch((error) => {
    console.error(
      JSON.stringify({
        ok: false,
        diagnostic: diagnostic.replaceAll(
          process.env.LLM_API_KEY || "__no_key__",
          "[REDACTED]",
        ),
        error: error instanceof Error ? error.stack : "Production smoke failed",
      }),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await stop().catch(() => {});
    cleanup();
  });
