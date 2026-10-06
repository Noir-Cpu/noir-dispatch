import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createNeonDb, schema } from "@noir/db";
import { isAllowedLogin, parseAllowedIds } from "./guards";

export type AuthEnv = {
  DATABASE_URL: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Comma-separated GitHub usernames allowed into the ops console. Default: Noir-Cpu. */
  OPS_ALLOWED_GITHUB?: string;
  /** Comma-separated numeric GitHub user ids; when set, the only rule (see guards.ts isAllowedOps). Find yours with: gh api users/<login> --jq .id */
  OPS_ALLOWED_GITHUB_IDS?: string;
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
    // Explicit rather than inherited from the library defaults, so a library change cannot quietly weaken the ops session cookie:
    // HttpOnly (script cannot read it), SameSite=Lax (not sent on cross-site POSTs), Secure and the __Secure- prefix on https.
    advanced: { useSecureCookies: origin.startsWith("https://"), defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" } },
    emailAndPassword: { enabled: false },
    socialProviders:
      env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? {
            github: {
              clientId: env.GITHUB_CLIENT_ID,
              clientSecret: env.GITHUB_CLIENT_SECRET,
              // Store the GitHub username as the user's name: it is what the allow-list matches.
              mapProfileToUser: (p: { login: string; id: number | string }) => {
                // With ids configured, refuse a stranger here, before any user row exists. (The login is not what is checked then.)
                const ids = parseAllowedIds(env.OPS_ALLOWED_GITHUB_IDS);
                if (ids && !ids.includes(String(p.id))) throw new Error("not on the ops allow-list");
                return { name: p.login };
              },
            },
          }
        : {},
    databaseHooks: {
      user: {
        create: {
          before: async (u) => {
            // Ids, when configured, were already checked against GitHub's profile in mapProfileToUser; the login is only the fallback rule.
            if (!parseAllowedIds(env.OPS_ALLOWED_GITHUB_IDS) && !isAllowedLogin(u.name, env.OPS_ALLOWED_GITHUB)) throw new Error("not on the ops allow-list");
            return { data: u };
          },
        },
      },
    },
  });
}

/**
 * The signed-in user, with the GitHub account id when ids are configured (the caller decides with isAllowedOps; this never grants anything).
 * The id comes from the linked account row, which Better Auth fills from GitHub's own profile, not from anything the user can edit.
 */
export async function opsSession(env: AuthEnv, req: Request): Promise<{ login: string; githubId?: string | null } | null> {
  if (!env.DATABASE_URL || !env.BETTER_AUTH_SECRET) return null;
  const auth = createAuth(env, req.url);
  const s = await auth.api.getSession({ headers: req.headers });
  if (!s) return null;
  if (!parseAllowedIds(env.OPS_ALLOWED_GITHUB_IDS)) return { login: s.user.name };
  const accounts = await (await auth.$context).internalAdapter.findAccounts(s.user.id);
  return { login: s.user.name, githubId: accounts.find((a) => a.providerId === "github")?.accountId ?? null };
}
