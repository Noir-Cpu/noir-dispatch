# Next steps for John

## Questions

1. Build an HTTP-mode simulator so a deployed demo has moving drivers (a script that drives the public API, run from a GitHub Actions cron or your machine)? Recommended: yes, before deploying; without it the live URL shows orders stuck at "placed".
2. Keep `DEV_TOOLS=1` on the public demo so visitors can press "Pay with test card"? Recommended: yes (payments are fake anyway); it only enables `/api/dev/pay`.
3. Which region for Neon? Recommended: Frankfurt (or London), the nearest to Cape Town offered.
4. Is 200 orders/hour with 50 drivers the right headline load? At my simulator settings (40 km/h, 4 km radius) the fleet saturates and p95 wait for a free driver is 440 s. Recommended: keep 200/hour as the stress case and also publish a 120/hour run that fits the fleet.
5. Add authentication (Better Auth passkeys/GitHub as in the template) before any public link? Recommended: not needed for a fictional demo, but say so on the page (already in the banner).
6. Paystack or Stripe test mode for the real adapter? Recommended: Paystack (South African context), needs a test secret key from you.

## Actions only you can do, in order

Full detail in `docs/SETUP.md`.

1. Create the Neon project `noir-dispatch`; copy the pooled and direct URLs.
2. `DATABASE_URL='<direct>' npm run migrate -w @noir/db` then `DATABASE_URL='<direct>' npm run seed -w @noir/engine`.
3. `cd apps/api && npx wrangler secret put DATABASE_URL` (pooled), `openssl rand -hex 32 | npx wrangler secret put PAYMENT_WEBHOOK_SECRET`, `npx wrangler secret put DEV_TOOLS` (value `1`).
4. `gh secret set DATABASE_URL_DIRECT|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID --repo Noir-Cpu/noir-dispatch`.
5. `npm run build -w @noir/web && cd apps/api && npx wrangler deploy`, then check `/api/health` and `/api/stations`.
6. `git mv docs/deploy.yml.example .github/workflows/deploy.yml`, commit, push.
