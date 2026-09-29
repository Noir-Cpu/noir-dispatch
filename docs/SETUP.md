# Deploying DISPATCH: what John must do

Nothing here has been done. No database exists, so nothing is deployed and `.github/workflows/deploy.yml` was removed (a saved copy is at `docs/deploy.yml.example`; step 6 puts it back).

## 1. Create the Neon project

1. neon.com, new project `noir-dispatch` (free plan). Pick the region closest to Cape Town that Neon offers (Frankfurt or London at the time of writing).
2. Copy two connection strings from the dashboard: the **pooled** one (host contains `-pooler`) and the **direct** one.

## 2. Migrate and seed (from your machine)

```
DATABASE_URL='<direct url>' npm run migrate -w @noir/db
DATABASE_URL='<direct url>' npm run seed -w @noir/engine
```

## 3. Worker secrets

The Worker name is `noir-dispatch-api` (set in `apps/api/wrangler.toml`), so the URL will be `https://noir-dispatch-api.noir-cpu.workers.dev`.

```
cd apps/api
npx wrangler secret put DATABASE_URL            # paste the POOLED url
openssl rand -hex 32 | npx wrangler secret put PAYMENT_WEBHOOK_SECRET
npx wrangler secret put DEV_TOOLS               # value 1: enables the "Pay with test card" button on the demo. Omit to disable.
# optional
npx wrangler secret put GRAFANA_OTLP_ENDPOINT
npx wrangler secret put GRAFANA_OTLP_AUTH
npx wrangler secret put SENTRY_DSN_API
```

## 4. GitHub secrets and variables (for the deploy workflow)

```
gh secret set DATABASE_URL_DIRECT --repo Noir-Cpu/noir-dispatch      # direct url, used only for migrations
gh secret set CLOUDFLARE_API_TOKEN --repo Noir-Cpu/noir-dispatch     # token with "Edit Cloudflare Workers"
gh secret set CLOUDFLARE_ACCOUNT_ID --repo Noir-Cpu/noir-dispatch
gh variable set SENTRY_DSN_WEB --repo Noir-Cpu/noir-dispatch         # optional
gh variable set POSTHOG_KEY --repo Noir-Cpu/noir-dispatch            # optional
gh variable set POSTHOG_HOST --repo Noir-Cpu/noir-dispatch           # optional
```

## 5. First deploy (manual, to check before automating)

```
npm ci
npm run build -w @noir/web
cd apps/api && npx wrangler deploy
curl https://noir-dispatch-api.noir-cpu.workers.dev/api/health/
curl https://noir-dispatch-api.noir-cpu.workers.dev/api/stations
```

The Durable Object class `TrackingRoom` is created by the `v1` migration in `wrangler.toml` (SQLite-backed, allowed on the Free plan). The Worker also registers a once-a-minute cron (1 of your 5 cron slots) for the dispatch tick.

## 6. Automate

```
git mv docs/deploy.yml.example .github/workflows/deploy.yml
git commit -m "Enable deploy workflow" && git push
```

## 7. Known gap before the public demo is alive

The simulator runs in-process against the engine (dev server, `npm run sim`). A deployed Worker has no simulator, so on the live URL orders would sit at "placed" and no drivers would move. An HTTP-mode simulator (a script or scheduled job that drives the public API) is not built. See `docs/NEXT.md`.

Also not built: a retention job for `driver_locations` (Neon free is 0.5 GB), and authentication (ADR 0009).
