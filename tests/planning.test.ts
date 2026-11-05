import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { admin, cleanup, constraints, order, setup } from "./helpers";
import { contextFor } from "../src/server/execution";
import { candidatePlan, validatePlan } from "../src/server/planning";
import { saveResource } from "../src/server/store";
beforeEach(setup);
afterEach(cleanup);
test("candidate covers exact quantity and counts procurement plus fixed shipping", () => {
  const o = order();
  const c = constraints([o.id]);
  const plan = validatePlan(
    candidatePlan(c, contextFor(c)).candidate,
    c,
    contextFor(c),
  );
  assert.equal(
    plan.allocations.reduce((s, a) => s + a.quantity, 0),
    300,
  );
  assert.equal(plan.totalCostIdr, 135000);
  assert.equal(plan.coverage[0].allocated, 300);
});
test("budget includes both warehouse transfer and supplier shipping", () => {
  const o = order();
  const c = constraints([o.id], { maxCostIdr: 134999 });
  const candidate = candidatePlan(c, contextFor(c)).candidate;
  assert.throws(() => validatePlan(candidate, c, contextFor(c)), /anggaran/);
});
test("a shared warehouse cannot be allocated twice across separate orders", () => {
  const a = order(100),
    b = order(100);
  const c = constraints([a.id, b.id]);
  assert.throws(
    () =>
      validatePlan(
        {
          summary: "Overbook",
          allocations: [
            {
              lineId: a.lines[0].id,
              kind: "warehouse",
              sourceId: "WH-1",
              quantity: 100,
            },
            {
              lineId: b.lines[0].id,
              kind: "warehouse",
              sourceId: "WH-1",
              quantity: 100,
            },
          ],
        },
        c,
        contextFor(c),
      ),
    /Kapasitas/,
  );
});
test("late suppliers and malformed identifiers or fractional quantities are rejected", () => {
  const o = order(200);
  saveResource(
    "offers",
    {
      id: "OFF-1",
      supplierId: "SUP-1",
      sku: "CUP",
      available: 500,
      unitPriceIdr: 800,
      leadTimeDays: 10,
      shippingCostIdr: 0,
      active: true,
    },
    admin.id,
  );
  const c = constraints([o.id]);
  assert.throws(
    () =>
      validatePlan(
        {
          summary: "Late",
          allocations: [
            {
              lineId: o.lines[0].id,
              kind: "supplier",
              sourceId: "OFF-1",
              quantity: 200,
            },
          ],
        },
        c,
        contextFor(c),
      ),
    /tenggat/,
  );
  assert.throws(() =>
    validatePlan(
      {
        summary: "Invalid",
        allocations: [
          {
            lineId: o.lines[0].id,
            kind: "warehouse",
            sourceId: "WH-1",
            quantity: 0.5,
          },
        ],
      },
      c,
      contextFor(c),
    ),
  );
});
test("partial fulfillment requires permission from both order and run", () => {
  const o = order(300, false);
  const c = constraints([o.id], { allowPartialDelivery: true });
  const input = {
    summary: "Partial",
    allocations: [
      {
        lineId: o.lines[0].id,
        kind: "warehouse",
        sourceId: "WH-1",
        quantity: 100,
      },
    ],
  };
  assert.throws(() => validatePlan(input, c, contextFor(c)), /seluruhnya/);
  const allowed = order(300, true);
  const cc = constraints([allowed.id], { allowPartialDelivery: true });
  assert.equal(
    validatePlan(
      {
        ...input,
        allocations: [{ ...input.allocations[0], lineId: allowed.lines[0].id }],
      },
      cc,
      contextFor(cc),
    ).coverage[0].allocated,
    100,
  );
});
test("duplicate source allocations and allocations for another order are rejected", () => {
  const o = order(100),
    other = order(100);
  const c = constraints([o.id]);
  const allocation = {
    lineId: o.lines[0].id,
    kind: "warehouse",
    sourceId: "WH-1",
    quantity: 50,
  };
  assert.throws(
    () =>
      validatePlan(
        { summary: "Duplicate", allocations: [allocation, allocation] },
        c,
        contextFor(c),
      ),
    /duplikat/,
  );
  assert.throws(
    () =>
      validatePlan(
        {
          summary: "Foreign line",
          allocations: [{ ...allocation, lineId: other.lines[0].id }],
        },
        c,
        contextFor(c),
      ),
    /baris/,
  );
});
test("calendar lead times and zero budget work for local stock only", () => {
  const o = order(80);
  const c = constraints([o.id], { maxCostIdr: 0 });
  const plan = validatePlan(
    candidatePlan(c, contextFor(c)).candidate,
    c,
    contextFor(c),
  );
  assert.equal(plan.totalCostIdr, 0);
  assert.equal(plan.allocations[0].arrivalDate, contextFor(c).today);
});
test("approval summaries use deterministic validated facts instead of model execution claims", () => {
  const o = order(80);
  const c = constraints([o.id], { maxCostIdr: 0 });
  const draft = candidatePlan(c, contextFor(c)).candidate;
  const plan = validatePlan(
    {
      ...draft,
      summary: "Sudah dibayar Rp999999 dan supplier sudah dikontak.",
    },
    c,
    contextFor(c),
  );
  assert.ok(!plan.summary.includes("dibayar"));
  assert.ok(plan.summary.includes("80 dari 80"));
});
