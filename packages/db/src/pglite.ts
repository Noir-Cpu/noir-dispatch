// Dev and test only. Kept out of the main entry so the Worker bundle never pulls in PGlite.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import type { Db } from "./client";
import * as schema from "./schema";

export async function createPgliteDb(dataDir?: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  return { db: db as unknown as Db, close: () => client.close() };
}
