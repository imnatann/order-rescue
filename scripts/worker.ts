import "./load-env";
import { randomUUID } from "node:crypto";
import {
  claimRun,
  executeRun,
  failRun,
  ownsLease,
} from "../src/server/execution";
import { planRun, safeAgentError } from "../src/server/agent";
import { closeDb, exec } from "../src/server/db";

const workerId = `worker-${randomUUID()}`;
let stopping = false;
let active: AbortController | null = null;
process.on("SIGTERM", () => {
  stopping = true;
  active?.abort();
});
process.on("SIGINT", () => {
  stopping = true;
  active?.abort();
});
function heartbeat() {
  exec(
    "INSERT INTO worker_heartbeats(id,updated_at) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at",
    workerId,
    Date.now(),
  );
  exec(
    "DELETE FROM worker_heartbeats WHERE updated_at<?",
    Date.now() - 300_000,
  );
}
async function main() {
  heartbeat();
  console.log(
    JSON.stringify({ level: "info", event: "worker_started", workerId }),
  );
  const beat = setInterval(heartbeat, 5000);
  try {
    while (!stopping) {
      const run = claimRun(workerId);
      if (!run) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        continue;
      }
      active = new AbortController();
      const lease = setInterval(() => {
        if (!ownsLease(run.id, workerId)) {
          active?.abort();
          return;
        }
        exec(
          "UPDATE runs SET lease_until=? WHERE id=? AND lease_owner=? AND status IN ('planning','executing')",
          Date.now() + 120_000,
          run.id,
          workerId,
        );
      }, 10_000);
      try {
        if (run.status === "executing") executeRun(run.id, workerId);
        else await planRun(run, workerId, active.signal);
      } catch (error) {
        if (!stopping) failRun(run.id, workerId, safeAgentError(error));
      } finally {
        clearInterval(lease);
        active = null;
        if (stopping)
          exec(
            "UPDATE runs SET lease_until=0 WHERE id=? AND lease_owner=?",
            run.id,
            workerId,
          );
      }
    }
  } finally {
    clearInterval(beat);
    exec("DELETE FROM worker_heartbeats WHERE id=?", workerId);
    closeDb();
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "worker_fatal",
      name: error instanceof Error ? error.name : "UnknownError",
    }),
  );
  process.exitCode = 1;
});
