# Next steps for John

## Questions

1. Do you want the ops console's GitHub allow-list to include anyone besides `Noir-Cpu`? Recommended: no (default).
2. The HTTP simulator runs every 30 minutes at up to 400 requests per burst (see README for the request and Neon compute-hour arithmetic). A livelier demo costs Neon compute-hours, which are the tighter free-plan limit. Recommended: keep 30 minutes, check Neon's usage page after a week.
3. Wire a Paystack checkout redirect into the web app once you have a test key? Recommended: yes, but only after one real test-mode payment has been made by hand.

## Questions from the demo work

4. `DEMO_DAILY_STEP_CAP` is 400 steps a day (about 10 typical runs), chosen so demos plus the hourly cron stay under 100 compute-hours even if Neon counts every awake hour as a full compute-hour (ADR 0016). If the Neon console shows the project at 0.25 CU, the cap could be 4x higher. Recommended: keep 400 for a week, read Neon's usage page, then decide.
5. The public OSRM demo server has no guarantee. Recommended: keep it for now (straight-line fallback covers outages); revisit if the demo gets real traffic.
6. Demo order rows and cached routes are never deleted (visitor orders are not "simulated"). Recommended: add a retention rule for demo routes older than 7 days when the database grows.

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
9. Merge the `demo-roads-legend` pull request once CI is green. The merge deploys: migration 0004 (two new tables, additive), the station seed (10 new stations), then the Worker. Afterwards press Run demo on a paid order, check `/api/health`, and check Neon's usage page in a week.
