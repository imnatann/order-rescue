import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
process.env.DATABASE_PATH = resolve(
  process.env.DATABASE_PATH || "data/order-rescue.sqlite",
);
const dev = process.argv.includes("--dev");
const appUrl = new URL(process.env.APP_URL || "http://127.0.0.1:3000");
if (
  !dev &&
  appUrl.protocol !== "https:" &&
  !(
    process.env.ALLOW_INSECURE_LOCALHOST === "true" &&
    ["localhost", "127.0.0.1"].includes(appUrl.hostname)
  )
) {
  console.error(
    "Production requires HTTPS APP_URL. For a loopback-only production smoke test set ALLOW_INSECURE_LOCALHOST=true.",
  );
  process.exit(1);
}
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(code);
  }, 10000);
  timer.unref();
  Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) =>
          child.exitCode !== null || child.signalCode !== null
            ? resolve()
            : child.once("exit", resolve),
        ),
    ),
  ).then(() => process.exit(code));
}
function launch(args) {
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: process.env,
  });
  children.push(child);
  child.on("error", () => stop(1));
  child.once("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
  return child;
}
if (!process.argv.includes("--web-only")) {
  launch(["--conditions=react-server", "--import", "tsx", "scripts/worker.ts"]);
}
if (!dev) {
  process.env.HOSTNAME = process.env.HOSTNAME_OVERRIDE || "127.0.0.1";
  const entry = process.argv.includes("--standalone")
    ? "server.js"
    : ".next/standalone/server.js";
  if (!existsSync(entry)) {
    console.error("Production artifact missing. Run npm run build first.");
    stop(1);
  } else launch([entry]);
} else {
  launch([
    "node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    process.env.HOSTNAME_OVERRIDE || "127.0.0.1",
    "--port",
    process.env.PORT || "3000",
  ]);
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
