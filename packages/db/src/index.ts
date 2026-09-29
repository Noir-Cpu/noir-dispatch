import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

// Use Neon's pooled endpoint in DATABASE_URL; never open a raw connection per request.
export function createDb(databaseUrl: string) {
  return drizzle(neon(databaseUrl), { schema });
}

export { schema };
export * from "./schema";
