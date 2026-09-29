import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { sql } from "drizzle-orm";
import { createDb } from "@noir/db";
import { tracing, type OtelEnv } from "./otel";
import { createAuth, type AuthEnv } from "./auth";

export type Env = AuthEnv & OtelEnv & { SENTRY_DSN_API?: string };

export const app = new Hono<{ Bindings: Env }>().basePath("/api");

app.use("*", tracing());

app.get("/health", (c) => c.json({ ok: true }));

app.get("/health/db", async (c) => {
  const started = Date.now();
  try {
    await createDb(c.env.DATABASE_URL).execute(sql`select 1`);
    return c.json({ ok: true, ms: Date.now() - started });
  } catch {
    return c.json({ ok: false }, 503);
  }
});

app.on(["GET", "POST"], "/auth/*", (c) => createAuth(c.env, c.req.url).handler(c.req.raw));

app.get("/me", async (c) => {
  const session = await createAuth(c.env, c.req.url).api.getSession({ headers: c.req.raw.headers });
  return session ? c.json({ user: { id: session.user.id, name: session.user.name } }) : c.json({ user: null }, 401);
});

app.post(
  "/echo",
  zValidator("json", z.object({ message: z.string().min(1).max(200) })),
  (c) => c.json({ message: c.req.valid("json").message }),
);
