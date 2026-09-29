import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { passkey } from "@better-auth/passkey";
import { createDb, schema } from "@noir/db";

export type AuthEnv = {
  DATABASE_URL: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
};

// Built per request: Workers have no long-lived process, and bindings arrive with each request.
export function createAuth(env: AuthEnv, requestUrl: string) {
  const origin = new URL(env.BETTER_AUTH_URL ?? requestUrl).origin;
  const github =
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
      : {};

  return betterAuth({
    database: drizzleAdapter(createDb(env.DATABASE_URL), { provider: "pg", schema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: origin,
    trustedOrigins: [origin],
    // No passwords: sign in with GitHub, then add a passkey. Avoids password hashing on the 10 ms Workers CPU budget.
    emailAndPassword: { enabled: false },
    socialProviders: github,
    plugins: [passkey({ rpID: new URL(origin).hostname, rpName: "NOIR", origin })],
  });
}
