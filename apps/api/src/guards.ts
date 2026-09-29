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
export const isAllowedLogin = (login: string | undefined, raw: string | undefined) => !!login && parseAllowList(raw).includes(login.toLowerCase());

/** Token proving the holder placed this order: HMAC(secret, order id). Returned once at placement. */
export const orderToken = async (secret: string, orderId: string) => (await hmacHex(secret, `order-token:${orderId}`)).slice(0, 32);

export function safeEqual(a: string | undefined | null, b: string | undefined | null) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
