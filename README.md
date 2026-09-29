# CASE 000 / TEMPLATE

Starting point for every NOIR case. Copy it, rename the packages, fill in the case-file README below.

## Layout

- `apps/api`: Hono on Cloudflare Workers, Zod validation, serves `apps/web/dist` as static assets
- `apps/web`: React + Vite + TanStack Query
- `packages/db`: Drizzle schema and Neon client (pooled endpoint)
- `packages/ui`: NOIR colour tokens
- `docs/adr`: architecture decision records

## Run

```
npm install
npm run dev:api   # http://localhost:8787
npm run dev:web   # http://localhost:5173, proxies /api
npm test
```

## Not wired yet

Better Auth, OpenTelemetry to Grafana, Sentry, PostHog, Turnstile, Playwright, k6, ZAP, brand fonts.

## Case-file README (replace per case)

1. `CASE 00X / NAME` + one-sentence verdict + live link
2. The brief
3. The evidence (load test, SLOs, postmortem)
4. The method (architecture, data model, ADRs)
5. The verdict (cost at 10k users)
6. Open leads
