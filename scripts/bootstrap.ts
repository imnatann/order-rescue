import "./load-env";
import { randomBytes } from "node:crypto";
import { writeFileSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { closeDb, dbPath, one } from "../src/server/db";
import { createUser } from "../src/server/auth";
import { userSchema } from "../src/server/validation";
async function main() {
  if (one("SELECT id FROM users WHERE role='admin' AND active=1 LIMIT 1")) {
    console.log("Administrator already exists; bootstrap skipped.");
    return;
  }
  const password =
    process.env.BOOTSTRAP_ADMIN_PASSWORD ||
    randomBytes(24).toString("base64url");
  const input = userSchema.parse({
    email: process.env.BOOTSTRAP_ADMIN_EMAIL || "admin@orderrescue.local",
    name: process.env.BOOTSTRAP_ADMIN_NAME || "Administrator",
    password,
    role: "admin",
  });
  await createUser(input);
  if (!process.env.BOOTSTRAP_ADMIN_PASSWORD) {
    const path = resolve(dirname(dbPath()), "bootstrap-access.txt");
    writeFileSync(
      path,
      `Order Rescue local administrator\nURL: ${process.env.APP_URL || "http://127.0.0.1:3000"}\nEmail: ${input.email}\nPassword: ${password}\n\nStore securely and change this password after sign-in. Do not distribute this file.\n`,
      { mode: 0o600 },
    );
    chmodSync(path, 0o600);
    console.log(
      `Administrator created. Generated credentials saved privately to ${path}`,
    );
  } else
    console.log(
      "Administrator created using supplied bootstrap configuration.",
    );
}
main()
  .catch((error) => {
    console.error(error instanceof Error ? error.name : "BootstrapError");
    process.exitCode = 1;
  })
  .finally(closeDb);
