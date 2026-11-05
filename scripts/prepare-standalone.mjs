import { cpSync, mkdirSync } from "node:fs";
mkdirSync(".next/standalone/.next", { recursive: true });
cpSync("public", ".next/standalone/public", { recursive: true });
cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
console.log("Standalone public and static assets prepared.");
