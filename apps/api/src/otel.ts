import type { MiddlewareHandler } from "hono";

export type OtelEnv = {
  GRAFANA_OTLP_ENDPOINT?: string;
  GRAFANA_OTLP_AUTH?: string;
};

const SERVICE_NAME = "noir-template-api";

const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

// W3C traceparent: 00-<32 hex trace id>-<16 hex parent span id>-<flags>
export function parseTraceparent(header: string | undefined) {
  const m = header?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/);
  return m ? { traceId: m[1]!, parentSpanId: m[2]! } : null;
}

let warned = false;
function warnOnce(msg: string) {
  if (warned) return;
  warned = true;
  console.warn(JSON.stringify({ level: "warn", msg }));
}

// Accepts "Basic abc", "abc", or "Authorization=Basic abc" (as pasted from Grafana), with stray whitespace.
export function normaliseAuth(raw: string) {
  const v = raw.trim().replace(/^authorization\s*=\s*/i, "").replace(/^"|"$/g, "").replace(/%20/g, " ").trim();
  return /^basic\s/i.test(v) ? `Basic ${v.replace(/^basic\s+/i, "")}` : `Basic ${v}`;
}

const nano = (ms: number) => (BigInt(ms) * 1_000_000n).toString();

type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMs: number;
  endMs: number;
  method: string;
  route: string;
  status: number;
};

async function exportSpan(env: OtelEnv, s: Span) {
  const body = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: SERVICE_NAME } }] },
        scopeSpans: [
          {
            scope: { name: "noir-template" },
            spans: [
              {
                traceId: s.traceId,
                spanId: s.spanId,
                ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
                name: s.name,
                kind: 2, // SERVER
                startTimeUnixNano: nano(s.startMs),
                endTimeUnixNano: nano(s.endMs),
                attributes: [
                  { key: "http.request.method", value: { stringValue: s.method } },
                  { key: "http.route", value: { stringValue: s.route } },
                  { key: "http.response.status_code", value: { intValue: String(s.status) } },
                ],
                status: { code: s.status >= 500 ? 2 : 1 },
              },
            ],
          },
        ],
      },
    ],
  };
  try {
    const res = await fetch(`${env.GRAFANA_OTLP_ENDPOINT!.trim().replace(/\/+$/, "")}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: normaliseAuth(env.GRAFANA_OTLP_AUTH!) },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(JSON.stringify({ level: "error", msg: "otlp export rejected", status: res.status, body: (await res.text()).slice(0, 200) }));
    }
  } catch (err) {
    // Telemetry must never break a request, but failures must be visible.
    console.error(JSON.stringify({ level: "error", msg: "otlp export failed", err: String(err) }));
  }
}

export const tracing = (): MiddlewareHandler<{ Bindings: OtelEnv }> => async (c, next) => {
  const incoming = parseTraceparent(c.req.header("traceparent"));
  const traceId = incoming?.traceId ?? randomHex(16);
  const spanId = randomHex(8);
  const startMs = Date.now();

  let thrown = false;
  try {
    await next();
  } catch (err) {
    thrown = true;
    throw err;
  } finally {
    const endMs = Date.now();
    const status = thrown ? 500 : c.res.status;
    const route = c.req.routePath;
    if (!thrown) c.res.headers.set("x-request-id", traceId);

    console.log(
      JSON.stringify({ level: status >= 500 ? "error" : "info", requestId: traceId, method: c.req.method, route, status, ms: endMs - startMs }),
    );

    const env = c.env ?? {};
    if (!env.GRAFANA_OTLP_ENDPOINT || !env.GRAFANA_OTLP_AUTH) {
      warnOnce("otlp disabled: GRAFANA_OTLP_ENDPOINT or GRAFANA_OTLP_AUTH not set on this Worker");
    } else {
      const p = exportSpan(env, {
        traceId,
        spanId,
        parentSpanId: incoming?.parentSpanId,
        name: `${c.req.method} ${route}`,
        startMs,
        endMs,
        method: c.req.method,
        route,
        status,
      });
      try {
        c.executionCtx.waitUntil(p);
      } catch {
        // No execution context (unit tests): the promise still runs.
      }
    }
  }
};
