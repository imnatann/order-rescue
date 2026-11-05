import "./load-env";
import { backup } from "node:sqlite";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { db, closeDb } from "../src/server/db";
async function main() {
  const target = resolve(
    process.argv[2] ||
      `backups/order-rescue-${new Date().toISOString().replaceAll(":", "-")}.sqlite`,
  );
  if (existsSync(target))
    throw new Error("Backup target already exists. Choose a new filename.");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  await backup(db(), target);
  chmodSync(target, 0o600);
  console.log(`Consistent SQLite backup saved to ${target}`);
}
main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Backup failed");
    process.exitCode = 1;
  })
  .finally(closeDb);
