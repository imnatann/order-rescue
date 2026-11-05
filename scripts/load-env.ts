import { existsSync } from "node:fs";
// Existing deployment environment wins over local files. Never log values.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
