import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { admin, cleanup, constraints, order, setup } from "./helpers";
import {
  cancelRun,
  claimRun,
  contextFor,
  createRun,
} from "../src/server/execution";
import { planRun } from "../src/server/agent";
import { candidatePlan } from "../src/server/planning";
import { events, getRun, inventory } from "../src/server/store";
import type { chat, ToolCall } from "../src/lib/llm/provider";
beforeEach(setup);
afterEach(cleanup);
const call = (name: string, args: unknown = {}): ToolCall => ({
  id: crypto.randomUUID(),
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
function response(tool_calls: ToolCall[]) {
  return {
    message: { role: "assistant" as const, content: null, tool_calls },
    usage: { total_tokens: 30 },
    model: "test-model",
  };
}
test("agent performs actual tool workflow and persists validated plan and evidence", async () => {
  const o = order();
  const c = constraints([o.id]);
  const r = createRun(c, admin, crypto.randomUUID());
  const claimed = claimRun("test")!;
  let turns = 0;
  const fake: typeof chat = async () => {
    turns++;
    if (turns === 1)
      return response([
        call("inspect_orders"),
        call("inspect_inventory"),
        call("inspect_supplier_offers"),
      ]);
    if (turns === 2) return response([call("build_candidate_plan")]);
    return response([
      call("submit_plan", candidatePlan(c, contextFor(c)).candidate),
    ]);
  };
  await planRun(claimed, "test", new AbortController().signal, fake);
  assert.equal(getRun(r.id)?.status, "awaiting_approval");
  assert.equal(getRun(r.id)?.plan?.totalCostIdr, 135000);
  assert.equal(
    events(r.id).filter((e) => e.type === "tool" && e.status === "success")
      .length,
    5,
  );
  assert.equal(
    inventory().reduce((n, s) => n + s.reserved, 0),
    0,
  );
});
test("agent rejects premature submission and unknown tools, then can correct the plan", async () => {
  const o = order(80);
  const c = constraints([o.id]);
  const r = createRun(c, admin, crypto.randomUUID());
  const claimed = claimRun("test")!;
  let turns = 0;
  const fake: typeof chat = async () => {
    turns++;
    if (turns === 1)
      return response([
        call("submit_plan", candidatePlan(c, contextFor(c)).candidate),
        call("execute_payment"),
      ]);
    if (turns === 2)
      return response([
        call("inspect_orders"),
        call("inspect_inventory"),
        call("inspect_supplier_offers"),
      ]);
    return response([
      call("submit_plan", candidatePlan(c, contextFor(c)).candidate),
    ]);
  };
  await planRun(claimed, "test", new AbortController().signal, fake);
  assert.equal(getRun(r.id)?.status, "awaiting_approval");
  assert.equal(
    events(r.id).filter((e) => e.type === "tool" && e.status === "error")
      .length,
    2,
  );
});
test("cancellation during an LLM turn prevents the result from changing run state", async () => {
  const o = order(80);
  const r = createRun(constraints([o.id]), admin, crypto.randomUUID());
  const claimed = claimRun("test")!;
  const fake: typeof chat = async () => {
    cancelRun(r.id, admin);
    return response([call("inspect_orders")]);
  };
  await assert.rejects(
    () => planRun(claimed, "test", new AbortController().signal, fake),
    /Lease/,
  );
  assert.equal(getRun(r.id)?.status, "cancelled");
  assert.equal(
    inventory().reduce((n, s) => n + s.reserved, 0),
    0,
  );
});
test("unproductive model responses terminate without producing execution claims", async () => {
  const o = order(80);
  const r = createRun(constraints([o.id]), admin, crypto.randomUUID());
  const claimed = claimRun("test")!;
  const fake: typeof chat = async () => ({
    message: { role: "assistant", content: "Tidak ada rencana yang layak." },
    usage: {},
    model: "test",
  });
  await assert.rejects(
    () => planRun(claimed, "test", new AbortController().signal, fake),
    /Tidak ada rencana/,
  );
  assert.equal(getRun(r.id)?.plan, null);
});
