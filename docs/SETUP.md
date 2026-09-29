# Deploying DISPATCH: what John must do

Nothing here has been done. No database exists, so nothing is deployed and `.github/workflows/deploy.yml` was removed (a saved copy is at `docs/deploy.yml.example`; step 8 puts it back). The simulator workflow (`.github/workflows/simulator.yml`) is in place but does nothing until you set `SIMULATOR_ENABLED=true`.

## 1. Create the Neon project

1. neon.com, new project `noir-dispatch` (free plan), region **Frankfurt** (same as the other NOIR projects).
2. Copy two connection strings from the dashboard: the **pooled** one (host contains `-pooler`) and the **direct** one.

## 2. Migrate and seed (from your machine)

```
DATABASE_URL='<direct url>' npm run migrate -w @noir/db
DATABASE_URL='<direct url>' npm run seed -w @noir/engine
```

## 3. GitHub OAuth app (ops sign-in)

github.com, Settings, Developer settings, OAuth Apps, New. Homepage `https://noir-dispatch-api.noir-cpu.workers.dev`, callback `https://noir-dispatch-api.noir-cpu.workers.dev/api/auth/callback/github`. Copy the client id and generate a client secret.

## 4. Worker secrets

The Worker name is `noir-dispatch-api` (set in `apps/api/wrangler.toml`), so the URL will be `https://noir-dispatch-api.noir-cpu.workers.dev`.

```
cd apps/api
npx wrangler secret put DATABASE_URL                       # the POOLED url
openssl rand -hex 32 | npx wrangler secret put PAYMENT_WEBHOOK_SECRET
openssl rand -hex 32 | npx wrangler secret put ORDER_TOKEN_SECRET
openssl rand -hex 32 | npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
SIM=$(openssl rand -hex 32); echo "$SIM" | npx wrangler secret put SIM_TOKEN   # keep $SIM for step 5
echo 1 | npx wrangler secret put DEV_TOOLS                # public demo "Pay with test card"; works only with the fake provider
# optional
echo 'Noir-Cpu,someone-else' | npx wrangler secret put OPS_ALLOWED_GITHUB   # default is just Noir-Cpu
npx wrangler secret put GRAFANA_OTLP_ENDPOINT
npx wrangler secret put GRAFANA_OTLP_AUTH
npx wrangler secret put SENTRY_DSN_API
```

`BETTER_AUTH_URL` is not needed: it defaults to the request origin.

## 5. GitHub secrets and variables

```
gh secret set DATABASE_URL_DIRECT --repo Noir-Cpu/noir-dispatch      # direct url, migrations only
gh secret set CLOUDFLARE_API_TOKEN --repo Noir-Cpu/noir-dispatch     # token with "Edit Cloudflare Workers"
gh secret set CLOUDFLARE_ACCOUNT_ID --repo Noir-Cpu/noir-dispatch
gh secret set SIM_TOKEN --repo Noir-Cpu/noir-dispatch                # the same value as the Worker's SIM_TOKEN ($SIM above)
gh variable set SIMULATOR_URL --repo Noir-Cpu/noir-dispatch --body https://noir-dispatch-api.noir-cpu.workers.dev
# optional
gh variable set SENTRY_DSN_WEB --repo Noir-Cpu/noir-dispatch
gh variable set POSTHOG_KEY --repo Noir-Cpu/noir-dispatch
gh variable set POSTHOG_HOST --repo Noir-Cpu/noir-dispatch
```

## 6. First deploy (manual, to check before automating)

```
npm ci
npm run build -w @noir/web
cd apps/api && npx wrangler deploy
curl https://noir-dispatch-api.noir-cpu.workers.dev/api/health
curl https://noir-dispatch-api.noir-cpu.workers.dev/api/stations
```

The Durable Object class `TrackingRoom` is created by the `v1` migration (SQLite-backed, Free plan). The Worker registers a once-a-minute cron (1 of your 5 cron slots) for the dispatch tick and, at 03:00 UTC, retention. The `RATE_LIMIT` binding is created by wrangler from `wrangler.toml`.

Then open `/ops` and sign in with GitHub as `Noir-Cpu`.

## 7. Switch the simulator on

Try one burst by hand first:

```
SIM_TOKEN='<the token>' npm run sim:http -w @noir/sim -- --url https://noir-dispatch-api.noir-cpu.workers.dev --seed 1 --seconds 60
```

Then enable the schedule: `gh variable set SIMULATOR_ENABLED --repo Noir-Cpu/noir-dispatch --body true` (turn it off with `--body false`). It runs every 15 minutes; see the README "Request budget" for the arithmetic.

## 8. Automate deploys

```
git mv docs/deploy.yml.example .github/workflows/deploy.yml
git commit -m "Enable deploy workflow" && git push
```

## 9. Optional: Paystack test mode

Not run against Paystack yet (ADR 0012). With a Paystack **test** secret key (`sk_test_...`; the adapter refuses live keys):

```
cd apps/api
echo paystack | npx wrangler secret put PAYMENTS_PROVIDER
npx wrangler secret put PAYSTACK_SECRET_KEY
```

and set the webhook URL in the Paystack dashboard to `https://noir-dispatch-api.noir-cpu.workers.dev/api/payments/webhook`. With Paystack selected, the demo "Pay" button and the simulator's pay call stop working by design (no fake payments); a Paystack checkout page is not wired into the web app.

## Not built

A k6 load test and SLO dashboards.
