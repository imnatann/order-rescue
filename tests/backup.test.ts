import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { backup, DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { cleanup, order, setup } from "./helpers";
import { db, dbPath, closeDb } from "../src/server/db";
import { getOrder } from "../src/server/store";
beforeEach(setup);
afterEach(cleanup);
test("online backup restores into a new file with intact business state and refuses overwrite", async () => {
  const o = order(10);
  const backupPath = join(dirname(dbPath()), "backup.sqlite");
  const restoredPath = join(dirname(dbPath()), "restored.sqlite");
  await backup(db(), backupPath);
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "scripts/restore.ts",
      backupPath,
      restoredPath,
    ],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const restored = new DatabaseSync(restoredPath, { readOnly: true });
  assert.equal(
    (
      restored.prepare("SELECT customer FROM orders WHERE id=?").get(o.id) as {
        customer: string;
      }
    ).customer,
    "Test Customer",
  );
  assert.equal(
    (restored.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
    2,
  );
  restored.close();
  const overwrite = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "scripts/restore.ts",
      backupPath,
      restoredPath,
    ],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.notEqual(overwrite.status, 0);
  assert.equal(getOrder(o.id)?.lines[0].quantity, 10);
});
test("closing and reopening the database preserves migrations and data", () => {
  const o = order(12);
  closeDb();
  assert.equal(getOrder(o.id)?.lines[0].quantity, 12);
  assert.equal(
    (
      db().prepare("PRAGMA integrity_check").get() as {
        integrity_check: string;
      }
    ).integrity_check,
    "ok",
  );
});
test("database records are plain objects compatible with React server-component serialization", async () => {
  const { snapshot } = await import("../src/server/store");
  order(12);
  const state = snapshot();
  assert.equal(Object.getPrototypeOf(state.products[0]), Object.prototype);
  assert.equal(Object.getPrototypeOf(state.inventory[0]), Object.prototype);
  assert.equal(
    Object.getPrototypeOf(state.orders[0].lines[0]),
    Object.prototype,
  );
});
