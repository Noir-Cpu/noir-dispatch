import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

/** Common shape of the Neon HTTP and PGlite drivers. The store only uses what both provide. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

// Use Neon's pooled endpoint in DATABASE_URL; never open a raw connection per request.
export function createNeonDb(databaseUrl: string): Db {
  return drizzle(neon(databaseUrl), { schema }) as unknown as Db;
}
