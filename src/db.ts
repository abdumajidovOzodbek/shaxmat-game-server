// -----------------------------------------------------------------------------
// Database client. Uses postgres-js (works with Neon's pooled connection
// string out of the box) wrapped in Drizzle.
//
// If DATABASE_URL is missing, exports `null` and the rest of the app falls
// back to in-memory only — letting the bot work without a DB during
// development.
// -----------------------------------------------------------------------------

import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "./config.js";
import * as schema from "./schema.js";

export type DB = PostgresJsDatabase<typeof schema>;

let dbInstance: DB | null = null;

if (config.databaseUrl) {
  // `prepare: false` is recommended for poolers like Neon's pgbouncer.
  const client = postgres(config.databaseUrl, { prepare: false, max: 5 });
  dbInstance = drizzle(client, { schema });
}

export const db: DB | null = dbInstance;
export { schema };
