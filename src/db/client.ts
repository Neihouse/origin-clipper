import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

// Lazily constructed so importing this module never touches DATABASE_URL —
// Next.js evaluates route modules during `next build` even for dynamic routes.
let cached: Db | undefined;

export function getDb(): Db {
  if (cached) return cached;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Add it to your environment (see .env.example).",
    );
  }

  const client = postgres(url, { max: 1 });
  cached = drizzle(client, { schema });
  return cached;
}
