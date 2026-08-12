import { config } from "dotenv";

config({ path: ".env.local" });
config();

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set.");
  }

  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);

  console.log("Running migrations...");
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  console.log("Migrations complete.");

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
