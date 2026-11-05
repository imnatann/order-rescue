import "../scripts/load-env";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { admin, cleanup, constraints, order, setup } from "./helpers";
import {
  approveRun,
  createRun,
  receivePurchase,
  shipOrder,
} from "../src/server/execution";
import {
  events,
  getOrder,
  getRun,
  inventory,
  offers,
  purchaseOrders,
  saveResource,
} from "../src/server/store";
import { closeDb } from "../src/server/db";
if (
  !process.env.LLM_BASE_URL ||
  !process.env.LLM_API_KEY ||
  !process.env.LLM_MODEL
)
  throw new Error(
    "Configure the LLM provider before running live verification.",
  );
setup();
const child = spawn(
  process.execPath,
  ["--conditions=react-server", "--import", "tsx", "scripts/worker.ts"],
  { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
);
let workerLog = "";
child.stdout.on("data", (d) => (workerLog += d));
child.stderr.on("data", (d) => (workerLog += d));
async function wait(runId: string, status: string, timeout = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const run = getRun(runId)!;
    if (run.status === status) return run;
    if (["failed", "needs_attention", "cancelled"].includes(run.status))
      throw new Error(`Run ${run.status}: ${run.error}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `Timed out waiting for ${status}; worker running=${child.exitCode === null}`,
  );
}
async function main() {
  const o = order(300);
  const run = createRun(constraints([o.id]), admin, crypto.randomUUID());
  const first = await wait(run.id, "awaiting_approval");
  assert.ok(first.plan);
  assert.ok(first.plan.allocations.some((a) => a.kind === "supplier"));
  const supplier = offers().find(
    (s) =>
      s.id ===
      first.plan!.allocations.find((a) => a.kind === "supplier")!.sourceId,
  )!;
  saveResource(
    "offers",
    {
      id: supplier.id,
      supplierId: supplier.supplierId,
      sku: supplier.sku,
      available: supplier.available,
      unitPriceIdr: supplier.unitPriceIdr,
      leadTimeDays: supplier.leadTimeDays,
      shippingCostIdr: supplier.shippingCostIdr,
      active: false,
    },
    admin.id,
  );
  approveRun(run.id, admin);
  const start = Date.now();
  while (!events(run.id).some((e) => e.name === "replan_required")) {
    if (Date.now() - start > 15000)
      throw new Error("Automatic replan event not observed.");
    await new Promise((r) => setTimeout(r, 200));
  }
  const replanned = await wait(run.id, "awaiting_approval");
  assert.equal(replanned.attempt, 2);
  assert.ok(
    replanned.plan!.allocations.every((a) => a.sourceId !== supplier.id),
  );
  approveRun(run.id, admin);
  const completed = await wait(run.id, "completed");
  assert.ok(completed.result?.verified);
  assert.ok(completed.plan!.totalCostIdr <= completed.constraints.maxCostIdr);
  for (const po of purchaseOrders()) receivePurchase(po.id, "WH-1", admin);
  shipOrder(o.id, admin);
  assert.equal(getOrder(o.id)?.status, "fulfilled");
  assert.equal(
    inventory().reduce((n, s) => n + s.reserved, 0),
    0,
  );
  const trace = events(run.id);
  for (const name of [
    "inspect_orders",
    "inspect_inventory",
    "inspect_supplier_offers",
    "submit_plan",
  ])
    assert.ok(trace.some((e) => e.name === name && e.status === "success"));
  closeDb();
  assert.equal(getOrder(o.id)?.status, "fulfilled");
  console.log(
    JSON.stringify(
      {
        ok: true,
        model: process.env.LLM_MODEL,
        actualToolCalling: true,
        replannedAfterSupplierFailure: true,
        persistentExecution: true,
        receivedAndShipped: true,
        attempts: completed.attempt,
        toolCalls: trace.filter((e) => e.type === "tool").length,
        totalCostIdr: completed.plan!.totalCostIdr,
        externalPurchasesSubmitted: false,
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
        error: error instanceof Error ? error.message : "Live check failed",
        workerExited: child.exitCode,
      }),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null)
        return resolve(null);
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(null);
      }, 10000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
    cleanup();
  });
