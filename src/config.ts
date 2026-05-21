import "dotenv/config";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(here, "../.env"),
  path.resolve(here, "../../../.env"),
  path.resolve(here, "../../../../.env"),
];
for (const file of candidates) {
  if (existsSync(file)) dotenv.config({ path: file, override: false });
}

export const config = {
  port: Number(process.env["PORT"] ?? 3001),
  /** Comma-separated list of allowed origins for CORS / WS. */
  corsOrigins: (process.env["CORS_ORIGINS"] ??
    [
      "http://localhost:5173",
      "https://shaxmat-chess.vercel.app",
      // Allow Vercel preview deploys (random subdomain) for the same project.
      // Express's CORS middleware uses string equality unless we pass a
      // function — handled in server.ts.
    ].join(",")).split(","),
  /** Optional shared secret used by the Telegram bot to authenticate as itself. */
  botSecret: process.env["BOT_SECRET"] ?? "",
};
