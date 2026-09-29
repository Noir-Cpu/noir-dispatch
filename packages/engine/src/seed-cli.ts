// Seeds the demo stations into a real database: DATABASE_URL=<direct or pooled url> npm run seed -w @noir/engine
import { DrizzleStore, createNeonDb } from "@noir/db";
import { seedStations } from "./seed";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("set DATABASE_URL");
await seedStations(new DrizzleStore(createNeonDb(url)));
console.log("seeded stations");
