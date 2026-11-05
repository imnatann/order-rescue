import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { admin, cleanup, constraints, order, setup } from "./helpers";
import { createRun } from "../src/server/execution";
import { events, getRun, inventory } from "../src/server/store";
import { exec } from "../src/server/db";
beforeEach(setup);
afterEach(cleanup);
async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, "exit");
  child.kill(signal);
  await exit;
}
test("a real worker crash leaves durable work that a replacement worker recovers exactly once", async () => {
  const o = order(80);
  const r = createRun(
    constraints([o.id], { maxCostIdr: 0, autoExecute: true }),
    admin,
    crypto.randomUUID(),
  );
  let blocked = true;
  let signalRequest: () => void = () => {};
  const requested = new Promise<void>((resolve) => (signalRequest = resolve));
  const sourceCall = (name: string, args: unknown = {}) => ({
    id: crypto.randomUUID(),
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  });
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer worker-test-key");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (blocked) {
      signalRequest();
      return;
    }
    const inspected = body.messages.some(
      (m: { role: string }) => m.role === "tool",
    );
    const tool_calls = inspected
      ? [
          sourceCall("submit_plan", {
            summary: "Verified local allocation",
            allocations: [
              {
                lineId: o.lines[0].id,
                kind: "warehouse",
                sourceId: "WH-1",
                quantity: 80,
              },
            ],
          }),
        ]
      : ["inspect_orders", "inspect_inventory", "inspect_supplier_offers"].map(
          (name) => sourceCall(name),
        );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: null, tool_calls },
            finish_reason: "tool_calls",
          },
        ],
        usage: { total_tokens: 10 },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const start = () => {
    const child = spawn(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", "scripts/worker.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          LLM_API_KEY: "worker-test-key",
          LLM_MODEL: "test-worker",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.resume();
    child.stderr.resume();
    return child;
  };
  let original: ChildProcess | undefined;
  let replacement: ChildProcess | undefined;
  try {
    original = start();
    await Promise.race([
      requested,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Worker did not start request")),
          10000,
        ),
      ),
    ]);
    assert.equal(getRun(r.id)?.status, "planning");
    await stop(original, "SIGKILL");
    assert.equal(getRun(r.id)?.status, "planning");
    // Advance the persisted lease to its expiry rather than waiting two minutes in the test.
    exec("UPDATE runs SET lease_until=0 WHERE id=?", r.id);
    blocked = false;
    replacement = start();
    const started = Date.now();
    while (Date.now() - started < 15000) {
      const run = getRun(r.id)!;
      if (run.status === "completed") break;
      if (run.status === "failed")
        throw new Error(run.error ?? "Worker failed");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(getRun(r.id)?.status, "completed");
    assert.equal(getRun(r.id)?.attempt, 2);
    assert.equal(
      inventory().find((s) => s.warehouseId === "WH-1")?.reserved,
      80,
    );
    assert.equal(
      events(r.id).filter((e) => e.name === "reservations_committed").length,
      1,
    );
    assert.ok(events(r.id).some((e) => e.name === "worker_recovered"));
  } finally {
    if (original) await stop(original);
    if (replacement) await stop(replacement);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
