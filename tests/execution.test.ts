import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { admin, cleanup, constraints, order, setup } from "./helpers";
import {
  approveRun,
  cancelOrder,
  cancelRun,
  claimRun,
  contextFor,
  createRun,
  executeRun,
  ownsLease,
  receivePurchase,
  retryRun,
  savePlan,
  shipOrder,
} from "../src/server/execution";
import { candidatePlan } from "../src/server/planning";
import {
  getOrder,
  getRun,
  inventory,
  offers,
  purchaseOrders,
  saveResource,
  events,
} from "../src/server/store";
import { exec, one } from "../src/server/db";
beforeEach(setup);
afterEach(cleanup);
function prepared(quantity = 300) {
  const o = order(quantity);
  const c = constraints([o.id]);
  const r = createRun(c, admin, crypto.randomUUID());
  const worker = "worker-test";
  assert.equal(claimRun(worker)?.id, r.id);
  savePlan(r.id, worker, candidatePlan(c, contextFor(c)).candidate);
  approveRun(r.id, admin);
  assert.equal(claimRun(worker)?.status, "executing");
  return { o, c, r, worker };
}
test("execution is atomic, durable and idempotent; receiving and shipping completes order", () => {
  const { o, r, worker } = prepared();
  const result = executeRun(r.id, worker);
  assert.ok(result);
  assert.equal(getRun(r.id)?.status, "completed");
  assert.equal(
    inventory().reduce((s, i) => s + i.reserved, 0),
    150,
  );
  assert.equal(purchaseOrders().length, 1);
  executeRun(r.id, worker);
  assert.equal(purchaseOrders().length, 1);
  assert.equal(getOrder(o.id)?.status, "awaiting_supply");
  const po = purchaseOrders()[0];
  receivePurchase(po.id, "WH-1", admin);
  receivePurchase(po.id, "WH-1", admin);
  assert.equal(getOrder(o.id)?.status, "reserved");
  assert.equal(offers().find((v) => v.id === "OFF-1")?.remaining, 350);
  shipOrder(o.id, admin);
  shipOrder(o.id, admin);
  assert.equal(getOrder(o.id)?.status, "fulfilled");
  assert.equal(getOrder(o.id)?.lines[0].fulfilled, 300);
  assert.equal(
    inventory().reduce((s, i) => s + i.reserved, 0),
    0,
  );
});
test("cancelling an allocated order releases stock and supplier capacity; repeated cancellation is safe", () => {
  const { o, r, worker } = prepared();
  executeRun(r.id, worker);
  cancelOrder(o.id, admin);
  cancelOrder(o.id, admin);
  assert.equal(
    inventory().reduce((s, i) => s + i.reserved, 0),
    0,
  );
  assert.equal(
    offers().reduce((s, i) => s + i.reserved, 0),
    0,
  );
  assert.equal(purchaseOrders()[0].status, "cancelled");
  assert.equal(getOrder(o.id)?.status, "cancelled");
});
test("stale supplier availability queues an automatic replan without partial changes", () => {
  const { r, worker } = prepared();
  saveResource(
    "offers",
    {
      id: "OFF-1",
      supplierId: "SUP-1",
      sku: "CUP",
      available: 500,
      unitPriceIdr: 800,
      leadTimeDays: 1,
      shippingCostIdr: 10000,
      active: false,
    },
    admin.id,
  );
  executeRun(r.id, worker);
  assert.equal(getRun(r.id)?.status, "queued");
  assert.equal(
    inventory().reduce((s, i) => s + i.reserved, 0),
    0,
  );
  assert.equal(purchaseOrders().length, 0);
  const replanning = claimRun(worker)!;
  assert.equal(replanning.attempt, 2);
  const plan = savePlan(
    r.id,
    worker,
    candidatePlan(replanning.constraints, contextFor(replanning.constraints))
      .candidate,
  );
  assert.ok(plan.allocations.some((a) => a.sourceId === "OFF-2"));
  approveRun(r.id, admin);
  claimRun(worker);
  executeRun(r.id, worker);
  assert.equal(getRun(r.id)?.status, "completed");
  assert.ok(events(r.id).some((e) => e.name === "replan_required"));
});
test("a database failure rolls back warehouse reservations and purchase documents", () => {
  const { r, worker } = prepared();
  exec(
    "CREATE TRIGGER deny_purchase BEFORE INSERT ON purchase_orders BEGIN SELECT RAISE(ABORT,'test failure'); END",
  );
  executeRun(r.id, worker);
  assert.equal(getRun(r.id)?.status, "needs_attention");
  assert.equal(
    inventory().reduce((s, i) => s + i.reserved, 0),
    0,
  );
  assert.equal(
    offers().reduce((s, i) => s + i.reserved, 0),
    0,
  );
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM reservations")?.n, 0);
});
test("expired worker lease recovers and prevents the old worker from writing its plan", () => {
  const o = order(50);
  const c = constraints([o.id]);
  const r = createRun(c, admin, crypto.randomUUID());
  claimRun("old");
  exec("UPDATE runs SET lease_until=0 WHERE id=?", r.id);
  const recovered = claimRun("new");
  assert.equal(recovered?.id, r.id);
  assert.equal(ownsLease(r.id, "old"), false);
  assert.throws(
    () => savePlan(r.id, "old", candidatePlan(c, contextFor(c)).candidate),
    /lease|Lease/,
  );
  assert.ok(events(r.id).some((e) => e.name === "worker_recovered"));
});
test("run idempotency, cancellation, overlap and retries preserve state", () => {
  const o = order(50);
  const c = constraints([o.id]);
  const key = crypto.randomUUID();
  const r = createRun(c, admin, key);
  assert.equal(createRun(c, admin, key).id, r.id);
  assert.throws(() => createRun(c, admin, crypto.randomUUID()), /run lain/);
  cancelRun(r.id, admin);
  retryRun(r.id, admin);
  assert.equal(getRun(r.id)?.status, "queued");
  assert.throws(() => approveRun(r.id, admin), /persetujuan/);
});
test("deactivated execution authorizer cannot commit reservations", () => {
  const { r, worker } = prepared(80);
  exec("UPDATE users SET active=0 WHERE id=?", admin.id);
  executeRun(r.id, worker);
  assert.equal(getRun(r.id)?.status, "needs_attention");
  assert.equal(
    inventory().reduce((s, i) => s + i.reserved, 0),
    0,
  );
});
test("two independent processes cannot oversell a shared source", async () => {
  const a = order(90),
    b = order(90);
  const make = (orderId: string, worker: string) => {
    const c = constraints([orderId], { maxCostIdr: 0 });
    const r = createRun(c, admin, crypto.randomUUID());
    claimRun(worker);
    const o = getOrder(orderId)!;
    savePlan(r.id, worker, {
      summary: "Local stock",
      allocations: [
        {
          lineId: o.lines[0].id,
          kind: "warehouse",
          sourceId: "WH-1",
          quantity: 90,
        },
      ],
    });
    approveRun(r.id, admin);
    claimRun(worker);
    return { id: r.id, worker };
  };
  const jobs = [make(a.id, "a"), make(b.id, "b")];
  await Promise.all(
    jobs.map(
      (job) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              "--conditions=react-server",
              "--import",
              "tsx",
              "--eval",
              `import {executeRun} from './src/server/execution.ts';executeRun(${JSON.stringify(job.id)},${JSON.stringify(job.worker)});`,
            ],
            { cwd: process.cwd(), env: process.env, stdio: "pipe" },
          );
          let error = "";
          child.stderr.on("data", (d) => (error += d));
          child.on("error", reject);
          child.on("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(error)),
          );
        }),
    ),
  );
  assert.equal(inventory().find((s) => s.warehouseId === "WH-1")?.reserved, 90);
  assert.equal(
    jobs.filter((j) => getRun(j.id)?.status === "completed").length,
    1,
  );
  assert.equal(jobs.filter((j) => getRun(j.id)?.status === "queued").length, 1);
});

test("supplier failure after reservation releases pending allocations and queues recovery within the original budget", async () => {
  const { failOffer } = await import("../src/server/execution");
  const { o, r, worker } = prepared();
  executeRun(r.id, worker);
  const failed = purchaseOrders()[0];
  const originalOffer = offers().find((a) => a.reserved > 0)!;
  const recovery = failOffer(originalOffer.id, admin);
  assert.equal(recovery.recoveryRunIds.length, 1);
  assert.equal(getRun(r.id)?.status, "superseded");
  assert.equal(getOrder(o.id)?.status, "open");
  assert.equal(
    inventory().reduce((n, s) => n + s.reserved, 0),
    0,
  );
  assert.equal(
    purchaseOrders().find((po) => po.id === failed.id)?.status,
    "cancelled",
  );
  const next = claimRun(worker)!;
  assert.equal(next.id, recovery.recoveryRunIds[0]);
  const plan = savePlan(
    next.id,
    worker,
    candidatePlan(next.constraints, contextFor(next.constraints)).candidate,
  );
  assert.ok(plan.allocations.every((a) => a.sourceId !== originalOffer.id));
  approveRun(next.id, admin);
  claimRun(worker);
  executeRun(next.id, worker);
  assert.equal(getRun(next.id)?.status, "completed");
  assert.equal(failOffer(originalOffer.id, admin).recoveryRunIds.length, 0);
});
test("an idempotency key cannot be reused for different constraints", () => {
  const o = order(10);
  const c = constraints([o.id]);
  createRun(c, admin, "idempotency-example");
  assert.throws(
    () => createRun({ ...c, maxCostIdr: 1 }, admin, "idempotency-example"),
    /parameter berbeda/,
  );
});
test("historical supplier name remains unchanged when a supplier is renamed", () => {
  const { r, worker } = prepared();
  executeRun(r.id, worker);
  const before = purchaseOrders()[0].supplierName;
  saveResource(
    "suppliers",
    { id: "SUP-1", name: "Renamed Supplier", active: true },
    admin.id,
  );
  assert.equal(purchaseOrders()[0].supplierName, before);
});

test("recovery deducts received procurement cost and preserves physical goods", async () => {
  const { failOffer } = await import("../src/server/execution");
  saveResource(
    "offers",
    {
      id: "OFF-3",
      supplierId: "SUP-1",
      sku: "CUP",
      available: 100,
      unitPriceIdr: 1000,
      leadTimeDays: 1,
      shippingCostIdr: 0,
      active: true,
    },
    admin.id,
  );
  const { o, r, worker } = prepared(700);
  executeRun(r.id, worker);
  const purchases = purchaseOrders();
  assert.equal(purchases.length, 2);
  const first = purchases.find((p) => p.quantity === 500)!;
  const second = purchases.find((p) => p.quantity === 50)!;
  receivePurchase(first.id, "WH-1", admin);
  const failedOffer = one<{ id: string }>(
    "SELECT offer_id id FROM purchase_orders WHERE id=?",
    second.id,
  )!.id;
  const recovery = failOffer(failedOffer, admin);
  const next = getRun(recovery.recoveryRunIds[0])!;
  assert.equal(next.constraints.maxCostIdr, 500000 - first.totalCostIdr);
  assert.equal(
    inventory().reduce((n, s) => n + s.onHand, 0),
    650,
  );
  assert.equal(
    inventory().reduce((n, s) => n + s.reserved, 0),
    0,
  );
  assert.equal(getOrder(o.id)?.lines[0].fulfilled, 0);
  const claimed = claimRun(worker)!;
  const plan = savePlan(
    claimed.id,
    worker,
    candidatePlan(claimed.constraints, contextFor(claimed.constraints))
      .candidate,
  );
  assert.ok(plan.totalCostIdr <= next.constraints.maxCostIdr);
});
test("a full-only order cannot ship before all supplier goods are received", () => {
  const { o, r, worker } = prepared();
  executeRun(r.id, worker);
  assert.throws(() => shipOrder(o.id, admin), /Terima seluruh/);
  assert.equal(getOrder(o.id)?.lines[0].fulfilled, 0);
  assert.equal(
    inventory().reduce((n, s) => n + s.reserved, 0),
    150,
  );
});
