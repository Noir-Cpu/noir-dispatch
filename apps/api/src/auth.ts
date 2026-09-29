import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createNeonDb, schema } from "@noir/db";
import { isAllowedLogin } from "./guards";

export type AuthEnv = {
  DATABASE_URL: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Comma-separated GitHub usernames allowed into the ops console. Default: Noir-Cpu. */
  OPS_ALLOWED_GITHUB?: string;
};

// Built per request: Workers have no long-lived process, and bindings arrive with each request.
export function createAuth(env: AuthEnv, requestUrl: string) {
  const origin = new URL(env.BETTER_AUTH_URL ?? requestUrl).origin;
  const { user, session, account, verification } = schema;
  return betterAuth({
    database: drizzleAdapter(createNeonDb(env.DATABASE_URL), { provider: "pg", schema: { user, session, account, verification } }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: origin,
    trustedOrigins: [origin],
    emailAndPassword: { enabled: false },
    socialProviders:
      env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? {
            github: {
              clientId: env.GITHUB_CLIENT_ID,
              clientSecret: env.GITHUB_CLIENT_SECRET,
              // Store the GitHub username as the user's name: it is what the allow-list matches.
              mapProfileToUser: (p: { login: string }) => ({ name: p.login }),
            },
          }
        : {},
    databaseHooks: {
      user: {
        create: {
          before: async (u) => {
            if (!isAllowedLogin(u.name, env.OPS_ALLOWED_GITHUB)) throw new Error("not on the ops allow-list");
            return { data: u };
          },
        },
      },
    },
  });
}

/** The signed-in ops user, or null. Checks the allow-list again on every request, so removing a name locks them out. */
export async function opsSession(env: AuthEnv, req: Request): Promise<{ login: string } | null> {
  if (!env.DATABASE_URL || !env.BETTER_AUTH_SECRET) return null;
  const s = await createAuth(env, req.url).api.getSession({ headers: req.headers });
  return s && isAllowedLogin(s.user.name, env.OPS_ALLOWED_GITHUB) ? { login: s.user.name } : null;
}
