import "./load-env";
import { SCHEMA_VERSION } from "../src/server/db";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
const source = process.argv[2];
const destination = process.argv[3];
if (!source || !destination) {
  console.error(
    "Usage: npm run db:restore -- <backup.sqlite> <new-database.sqlite>",
  );
  process.exit(1);
}
const target = resolve(destination);
if (existsSync(target))
  throw new Error(
    "Restore target exists. Stop the application and choose a NEW database path. This command never overwrites live data.",
  );
const check = new DatabaseSync(resolve(source), { readOnly: true });
const integrity = check.prepare("PRAGMA integrity_check").get() as {
  integrity_check: string;
};
const version = check.prepare("PRAGMA user_version").get() as {
  user_version: number;
};
const foreign = check.prepare("PRAGMA foreign_key_check").all();
check.close();
if (
  integrity.integrity_check !== "ok" ||
  foreign.length ||
  version.user_version !== SCHEMA_VERSION
)
  throw new Error("Backup integrity or schema validation failed.");
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
copyFileSync(resolve(source), target);
chmodSync(target, 0o600);
console.log(
  `Restored to ${target}. Stop the app, update DATABASE_PATH, then restart. Existing data was preserved.`,
);
