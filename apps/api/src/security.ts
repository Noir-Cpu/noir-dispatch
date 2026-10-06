import type { MiddlewareHandler } from "hono";

/**
 * Security headers for everything the Worker itself generates (the /api routes, which run first; see run_worker_first in wrangler.toml).
 * Static files get theirs from apps/web/public/_headers, which the dev server also applies, so Playwright tests the same policy.
 *
 * This is JSON, never a page, so the policy is the strictest one: nothing may load, nothing may frame it. The page policy
 * (OpenStreetMap tiles, same-origin WebSocket, self-hosted Leaflet) is in _headers; a unit test keeps the two in step.
 */
export const API_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const PERMISSIONS_POLICY = "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()";

export const API_HEADERS: Record<string, string> = {
  "content-security-policy": API_CSP,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  // Not no-referrer: the same policy as the pages (OpenStreetMap needs a Referer, and one policy is easier to reason about).
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": PERMISSIONS_POLICY,
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-robots-tag": "noindex, nofollow",
};
const HSTS = "max-age=31536000; includeSubDomains";

/** Sets the headers on a response, rebuilding it when the headers are read-only (a response that came from fetch()). A 101 upgrade cannot be rebuilt and is left alone. */
export function withSecurityHeaders(res: Response, https: boolean): Response {
  if (res.status === 101) return res;
  const apply = (r: Response) => {
    for (const [k, v] of Object.entries(API_HEADERS)) r.headers.set(k, v);
    if (https) r.headers.set("strict-transport-security", HSTS);
    // Private by default: order details, positions and ops data must not sit in a shared cache. Routes that are safe to cache say so themselves.
    if (!r.headers.has("cache-control")) r.headers.set("cache-control", "no-store");
    return r;
  };
  try {
    return apply(res);
  } catch {
    return apply(new Response(res.body, res));
  }
}

export const securityHeaders = (): MiddlewareHandler => async (c, next) => {
  await next();
  c.res = withSecurityHeaders(c.res, new URL(c.req.url).protocol === "https:");
};

/**
 * Browsers always send Origin on a WebSocket handshake, and a page on another site can open a socket to us with the visitor's
 * network position. A request with no Origin (a script, curl, the simulator) is not a browser page and is allowed. An Origin must
 * match the host the socket is opened on.
 */
export function sameOriginSocket(origin: string | null | undefined, host: string | null | undefined): boolean {
  if (!origin) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Removes anything that looks like a credential from text on its way to the logs: connection strings, bearer/basic values, long hex or base64 runs. */
export function redact(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*@[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[redacted-hex]")
    .slice(0, 500);
}

/** Most simultaneous viewers of one delivery's Durable Object. A real order has one or two (the customer's tabs, ops); the cap stops one room from holding thousands of sockets. */
export const MAX_SOCKETS_PER_ROOM = 25;
