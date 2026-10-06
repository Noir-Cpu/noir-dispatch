import { hmacHex } from "@noir/core";

export interface RateLimiter {
  allow(key: string): Promise<boolean>;
}

/** Fixed-window counter, per isolate. Best effort on Workers (isolates are not shared); the Cloudflare binding is the real limit. */
export class MemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, { n: number; resetAt: number }>();
  constructor(
    private readonly limit = 60,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}
  async allow(key: string) {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || h.resetAt <= t) {
      if (this.hits.size > 10_000) this.hits.clear(); // bound memory under a key-spraying attack
      this.hits.set(key, { n: 1, resetAt: t + this.windowMs });
      return true;
    }
    return ++h.n <= this.limit;
  }
}

/** Adapter for the Cloudflare Workers Rate Limiting binding. */
export const cloudflareLimiter = (b: { limit(o: { key: string }): Promise<{ success: boolean }> }): RateLimiter => ({
  allow: async (key) => (await b.limit({ key })).success,
});

export function parseAllowList(raw: string | undefined): string[] {
  const list = (raw ?? "Noir-Cpu").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : ["noir-cpu"];
}
/**
 * GitHub user ids (numeric, permanent) allowed into the ops console, from OPS_ALLOWED_GITHUB_IDS. Returns null when the variable is unset
 * or blank, meaning "use the login allow-list". When it is set it is the only rule, and a value with no valid id in it (a typo) allows
 * nobody rather than falling back to logins.
 */
export function parseAllowedIds(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === "") return null;
  return raw.split(",").map((s) => s.trim()).filter((s) => /^[1-9]\d{0,18}$/.test(s));
}

/**
 * Whether this signed-in identity may use the console. A GitHub login can be renamed, and a released name can be taken by someone
 * else, so when OPS_ALLOWED_GITHUB_IDS is set only the numeric id counts and the login is ignored. With no ids configured the login
 * allow-list applies, as before (a convenience for local setups; set the ids in production).
 */
export function isAllowedOps(who: { login?: string; githubId?: string | null }, env: { OPS_ALLOWED_GITHUB?: string; OPS_ALLOWED_GITHUB_IDS?: string }): boolean {
  const ids = parseAllowedIds(env.OPS_ALLOWED_GITHUB_IDS);
  if (ids) return !!who.githubId && ids.includes(who.githubId.trim());
  return isAllowedLogin(who.login, env.OPS_ALLOWED_GITHUB);
}

export const isAllowedLogin = (login: string | undefined, raw: string | undefined) => !!login && parseAllowList(raw).includes(login.toLowerCase());

/** Token proving the holder placed this order: HMAC(secret, order id). Returned once at placement. */
export const orderToken = async (secret: string, orderId: string) => (await hmacHex(secret, `order-token:${orderId}`)).slice(0, 32);

export function safeEqual(a: string | undefined | null, b: string | undefined | null) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
