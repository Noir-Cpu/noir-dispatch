# Next steps for John

## Questions

1. Do you want the ops console's GitHub allow-list to include anyone besides `Noir-Cpu`? Recommended: no (default).
2. The HTTP simulator runs every 15 minutes at up to 400 requests per burst (about 23,000 requests/day measured-per-burst, 38,400 as a hard ceiling; see README). Is a 15 minute cadence fine, or should the demo be livelier at the cost of quota? Recommended: keep 15 minutes.
3. Wire a Paystack checkout redirect into the web app once you have a test key? Recommended: yes, but only after one real test-mode payment has been made by hand.

## Actions only you can do, in order

Full detail and the exact commands are in `docs/SETUP.md`.

1. Create the Neon project `noir-dispatch` in Frankfurt; copy the pooled and direct URLs.
2. Migrate and seed with the direct URL.
3. Create the GitHub OAuth app (callback `.../api/auth/callback/github`).
4. Set the Worker secrets: `DATABASE_URL`, `PAYMENT_WEBHOOK_SECRET`, `ORDER_TOKEN_SECRET`, `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SIM_TOKEN`, `DEV_TOOLS=1`.
5. Set the GitHub secrets and variables (`DATABASE_URL_DIRECT`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SIM_TOKEN`, `SIMULATOR_URL`).
6. Deploy once by hand, check `/api/health`, sign in at `/ops`.
7. Run one simulator burst by hand, then `gh variable set SIMULATOR_ENABLED --body true`.
8. Move `docs/deploy.yml.example` to `.github/workflows/deploy.yml`.
