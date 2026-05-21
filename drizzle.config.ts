import "dotenv/config";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type { Config } from "drizzle-kit";

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(here, ".env"),
  path.resolve(here, "../../.env"),
  path.resolve(here, "../../../.env"),
];
for (const file of candidates) {
  if (existsSync(file)) dotenv.config({ path: file, override: false });
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for drizzle-kit; set it in .env");
}

export default {
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: databaseUrl },
  strict: true,
} satisfies Config;
