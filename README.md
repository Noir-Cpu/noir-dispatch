# CASE 002 / DISPATCH

**Verdict: a dispatch engine for on-demand fuel delivery whose order rules, driver matching, payment handling and live tracking are built and tested locally against a simulated fleet. A demo of it runs at https://noir-dispatch-api.noir-cpu.workers.dev (Cloudflare Workers, Neon); no real fuel, driver or money is involved.**

> **This is a simulation.** Fuel transport is regulated dangerous-goods work. Stations, drivers and customers here are fictional, the "payment provider" is a fake that behaves like Stripe/Paystack test mode, and nothing is delivered or charged. Do not use this to move real fuel or take real payments.

## The brief

On-demand delivery coordinates customers, stations and drivers in real time, with money moving and states changing concurrently. DISPATCH puts three surfaces (customer, driver, operations console) on one dispatch engine, and a driver simulator (50 virtual drivers around Cape Town) keeps it alive and doubles as a load generator. Success criteria, from the [PRD](docs/PRD.md):

1. Driver assigned within 5 s at p95 with 50 drivers and 200 orders/hour simulated.
2. Live location reaches the customer within 2 s at p95.
3. 0 double charges when a payment webhook is replayed 10 times.
4. 0 illegal order-state transitions under property-based testing.

## The evidence

Every number below comes from a run on one laptop, in one process, against an in-memory Postgres (PGlite). They are **local, in-process numbers**. They say nothing about Cloudflare Workers, Neon or a real network.

| Criterion | Result | How to reproduce |
| --- | --- | --- |
| 0 illegal transitions | **Met.** 3 properties x 3,000 = 9,000 generated event sequences (about 29,000 transitions checked per run) against an independent oracle table; every accepted transition matches it, every state is reached, and replaying the log (also after a JSON round trip) reproduces the state. Plus an exhaustive 8 states x 11 events x 4 actors check. | `npm test -w @noir/core -- --reporter=verbose` |
| 0 double charges on 10x webhook replay | **Met.** Same signed webhook delivered 10 times in sequence, 10 times concurrently, and 10 times under new event ids: exactly 1 charge row each time. Bad signature, tampered body, stale timestamp and malformed header are all rejected with no charge. | `npm test -w @noir/engine` |
| Assignment within 5 s at p95 | **Met at 120 orders/hour, not met at 200.** The assignment step itself (rank drivers, claim one, append the event) took p50 2.4 ms, p95 3.7 ms over 132 assignments at 120/hour, and p50 2.2 ms, p95 3.5 ms over 203 at 200/hour. Waiting for a *free* driver (accepted and paid to assigned, simulated time): at 120/hour p50 0 s, p95 0 s, max 4.8 s; at 200/hour p50 25 s, **p95 440 s**, max 525 s. With 50 drivers, 40 km/h and a 4 km delivery radius the fleet saturates somewhere between the two, so the 5 s target holds when demand fits the fleet. | `npm run bench -- --hours 1 --seed 42 --orders-per-hour 120` (or `200`) |
| Live location within 2 s at p95 | **Depends on load.** In-process subscriber: p50 0.002 ms, p95 0.004 ms. Over a loopback WebSocket, 200/hour flat out (one virtual hour in 11.5 s, about 300x load): p50 34 ms, **p95 2,013 ms**, max 2,496 ms. 200/hour paced at 20x (one virtual hour in 275 s): p50 4.1 ms, **p95 26.6 ms**, max 134.5 ms over 38,608 frames. 120/hour: flat out p50 21.6 ms, **p95 824 ms**, max 1,059 ms; paced at 20x one virtual hour in 236.5 s: p50 3.2 ms, **p95 7.9 ms**, max 19.8 ms over 20,618 frames. | `npm run bench -- --hours 1 --seed 42 [--orders-per-hour 120] [--time-scale 20]` |

The flat-out WebSocket tail is a saturated event loop (the simulator, PGlite and the socket server share one thread), not network latency; the paced run is the fairer reading. Neither is a claim about production. Raw results for all four runs (120 and 200 orders/hour, flat out and paced): [`docs/bench/`](docs/bench). Run facts, 200/hour flat out: 41,314 pings produced 9,132 stored `driver_locations` rows (22%, the downsample gate), 7 driver declines were reassigned, 0 cancellations. 120/hour: 25,040 pings, 7,829 rows (31%), 1 decline. All are labelled local, single-process (PGlite in memory).

Other tests: 162 unit tests (counted from `npm test` output): 53 core (state machine, geo, matching, ORS and Paystack adapters against fixtures, tracking room, delivery radius, OSRM adapter against hand-written fixtures, fallback, polyline maths, glide planning), 6 db, 52 engine (PGlite: placing, idempotency, dispatch, decline reassign, racing orders, refunds, downsampling, webhooks, retention, the radius at the boundary for all 15 stations, idempotent seed, the whole demo through steps), 4 simulator, 47 API (role boundary, order tokens, rate limiting, the DEV_TOOLS guard, the demo endpoint's 403/404/429 cases, the radius over HTTP, and the HTTP simulator). Playwright is listed under "Map, radius and demo" below.

Not covered by automated tests: the Durable Object wrapper (`apps/api/src/tracking-do.ts`) needs the Workers runtime; the Neon HTTP driver path; the Worker entry; the GitHub OAuth round trip. Only `wrangler deploy --dry-run` bundling was checked. The Expo driver app is a scaffold that was never installed or run.

## The method

```
web (React, Leaflet/OSM)  ->  Hono API  ->  Engine  ->  Store (Drizzle: Neon HTTP | PGlite)
                                 |            |-> pure order state machine (order_events append-only)
                                 |            |-> matching (EtaProvider: haversine | OpenRouteService)
                                 |            |-> payments (PaymentProvider: test | Paystack, Stripe stubs)
                                 +-> WS -> TrackRoom (Durable Object per delivery | in-process)
simulator (50 bots) drives the Engine directly; dev server = same app on Node
```

- **State machine** (`packages/core/src/order-machine.ts`): pure; rules per state and per actor; ADR 0002.
- **Persistence** (`packages/db`): tables `customers, stations, drivers, orders, order_events, driver_locations, payments` plus `payment_charges` and `payment_webhook_events`. lat/lng are `numeric`, no PostGIS (ADR 0003). One-statement optimistic appends (ADR 0005); a trigger makes `order_events` append-only.
- **Matching** (`packages/core/src/matching.ts`, `eta.ts`): nearest 8 by straight line, ranked by ETA, ties by id. Default ETA is haversine x 1.3 at 30 km/h (assumptions). The OpenRouteService adapter needs a key (`apiKey`) and is not enabled (ADR 0004).
- **Payments** (`packages/core/src/payments`): intents, idempotency keys, HMAC-signed webhooks with a 5-minute replay window, refund on cancel (ADR 0006). The fake provider is the default. `PaystackProvider` is a test-mode adapter (initialise, refund, HMAC-SHA512 webhook) written from Paystack's docs and unit-tested against fixtures I wrote; **it has not been run against Paystack** and parts are marked UNSURE (ADR 0012). It refuses live keys and is used only if `PAYMENTS_PROVIDER=paystack`. `StripeProvider` is still a stub.
- **Roles and ops auth** (ADR 0010): the ops console sits behind Better Auth GitHub sign-in with an allow-list (`OPS_ALLOWED_GITHUB`, default `Noir-Cpu`). Customers and drivers stay anonymous; a customer proves ownership of an order with an order token, so knowing an order or customer id does not let you cancel it. Every role-declaring request is rate limited (Workers Rate Limiting binding, 60/min per client). Tested at the HTTP layer with a stand-in session; the real GitHub OAuth round trip is untested.
- **Retention** (ADR 0013): `driver_locations` older than 7 days and finished simulated orders older than 24 hours are deleted by the Worker cron (03:00 UTC) or by ops on demand. Tested on PGlite.
- **Delivery radius** (ADR 0014): an order is accepted only if the drop-off is within `DELIVERY_RADIUS_KM` (default 12, a plain wrangler var) in a straight line of the chosen station. The engine enforces it (422 `out_of_radius`, message includes the radius); the order form shows a circle per station, labels out-of-range stations and suggests the nearest in-range one. 15 fictional stations; the seed is an idempotent upsert and runs on every deploy.
- **Roads** (ADR 0015): a `RouteProvider` interface with an OSRM adapter (**the public OSRM demo server: a free demo with no uptime or performance guarantee and a usage policy; we send an identifying User-Agent, ask once per order, cache the polyline with the order, time out at 3 s and fall back to straight lines, recording which was used**). The burst simulator never calls it and keeps straight lines.
- **Run demo** (ADR 0016): on a paid order the visitor can press "Run demo"; their browser calls a stateless step endpoint about every 2.5 s while the tab is visible, at **10x demo speed** (shown in the UI). Only with `DEV_TOOLS=1` and the fake provider, only with the order's own token, rate limited, with a global daily step cap. Nothing runs in the background, so Neon compute is used only while someone is watching; the arithmetic is in the ADR.
- **Tracking**: `TrackRoom` is a plain class (unit tested); the Durable Object wraps it; one point per 30 s is persisted (ADR 0007). `wrangler.toml` binds a SQLite-backed DO, valid on the Free plan.
- **HTTP-mode simulator** (`packages/sim/src/http-sim.ts`, ADR 0011): drives the public API so a deployed Worker shows live movement. Authenticated with `SIM_TOKEN`; the server lets that token touch only records flagged `is_simulated` (plus accepting new orders as stand-in station staff so visitors' orders progress). Seeded, at most 5 requests/s, hard request cap per burst, expires old simulated orders when it finishes. Scheduled by `.github/workflows/simulator.yml`, **off unless the repo variable `SIMULATOR_ENABLED` is `true`**.
- **Simulator** (`packages/sim`, in-process): 50 drivers roam Cape Town, take assigned jobs through the state machine (3% decline), stand-in stations accept, stand-in customers pay through the signed webhook. Seeded (mulberry32); the same seed gives the same orders, declines and event counts (tested).
- **Web** (`apps/web`; the dev server leaves ops open, production needs the GitHub sign-in): `/` place an order, `/order/:id` live tracking, `/ops` operations console. Shared NOIR tokens, no brand costume.

## Run it

```
npm install
npm run dev:local      # builds the web app, starts API + PGlite + simulator on http://localhost:8787
npm run sim -- --hours 1 --seed 42          # simulator report (local, in-process)
npm run bench -- --hours 1 --seed 42        # adds a loopback WebSocket subscriber per order
npm test               # unit tests
npm run e2e            # Playwright (installs nothing; run `npx playwright install chromium` once)
```

`SIM_TIME_SCALE`, `SIM_DRIVERS`, `SIM_ORDERS_PER_HOUR` and `SIM=0` tune the dev server. OSM tiles are loaded from tile.openstreetmap.org by the browser; heavy use needs a different tile provider under OSM's tile usage policy.

## Map, radius and demo

- Markers differ by shape and glyph, not only colour: station is a square with a fuel pump, drop-off is a pin with a house, driver is a round badge with a heading arrow, a white halo and a dark outline. Both maps have a visible key, plus a text version of the map under it ("Driver: 920 m from the drop-off by road", "Station: ...", "Drop-off: ...").
- Driver markers glide along the route polyline between pings (`requestAnimationFrame`), the remaining route is drawn, and the view fits station, drop-off and driver once. With `prefers-reduced-motion` the marker jumps instead. Orders without a road route (simulator orders, or OSRM unavailable) glide in a straight line, labelled as such.
- Playwright (`npm run e2e`): 29 passing in one local run (desktop 16, phone 9, demo 4). Three projects: `desktop` (order flow with the background simulator, ops, radius messages, axe in light and dark), `phone` (axe in light and dark, Pixel 7), and `demo` (its own server on port 8788 with the simulator off, straight-line routes so tests never call OSRM): place, pay, Run demo, watch it deliver, axe in light and dark mid-run and after, the driver moves in small steps rather than jumping, and with reduced motion it jumps.

## Request budget (Workers Free: 100,000 requests/day)

Arithmetic, not a measurement of production:

- One simulator burst is capped at 400 requests. Run in-process against the app (12 bursts, 4 virtual minutes each, 6 drivers, 3 simulated orders kept in flight) it made **226 to 239 requests** per burst, of which 151 to 164 were location pings.
- Every 30 minutes is 48 bursts a day: **about 12,700 requests/day typical (48 x 265, measured on one live burst), 19,200 at the cap (48 x 400)**, plus 24 hourly cron runs.
- **Neon compute is the tighter limit, not requests.** The free plan gives 100 CU-hours per project per month and compute scales to zero after 5 idle minutes. Assuming the smallest size (0.25 CU, not checked against the console), each 4-minute burst keeps it awake about 9 minutes, so 48 bursts a day is about 30% duty, roughly 55 CU-hours a month, plus the hourly cron (about 15) and visitors. That is inside 100 but not by a wide margin: watch Neon's usage page. A per-minute cron, which this project originally had, would have kept compute on 24/7 (about 180 CU-hours) and exhausted the allowance in about 17 days.
- The once-a-minute cron adds 1,440 invocations/day.
- That leaves about 60,000 requests/day for visitors and ops. One open ops tab polls twice every 5 s (about 35,000/day if left open for 24 h); the order page polls every 3 s until delivery. These are estimates from the polling intervals in the code, not measured.
- Location pings to Durable Objects are separate DO requests (roughly the ping count above per day: about 15,000); the Free DO limits were not checked against this.

## What `DEV_TOOLS=1` does and cannot do

`DEV_TOOLS=1` enables the demo "Pay with test card" button (`POST /api/dev/pay/:orderId`). It plays the fake payment provider by sending a signed webhook through the normal endpoint, and it requires the order's own token. **It cannot enable a real-money path:** the endpoint (and the simulator's pay endpoint) return 404/403 unless the active provider is the fake one, whatever `DEV_TOOLS` says, and the Paystack adapter refuses non-test keys. Tested (`payments switch` in `apps/api/src/app.test.ts`).

## The verdict

Cost at 10k users: **not measured.** Arithmetic from the strategy doc: 10,000 users x 30 requests is about 300,000 requests/day, three times the Workers Free quota of 100,000/day, so the $5/month plan is needed. Driver pings must go over WebSockets to the delivery's Durable Object rather than as HTTP requests; as HTTP they would exceed the free quota by themselves (288,000/day for 50 drivers). Location storage is downsampled to about a sixth of raw pings; Neon's free 0.5 GB still needs a retention job (not built).

## Open leads

- **Deployed at https://noir-dispatch-api.noir-cpu.workers.dev**, with automatic deploys of `main` after CI (migrations and the station seed run first). The scheduled simulator workflow is off. Setup steps are in [docs/SETUP.md](docs/SETUP.md).
- **Untested against the real thing:** the GitHub OAuth flow and Better Auth sessions, the Durable Object wrapper, the Neon HTTP path, the Worker entry, and the Paystack adapter (fixtures only). The HTTP simulator was tested against the app in process, not over a network to a Worker.
- The OSRM adapter was run against the real public server once, by hand, for one Cape Town pair (Claremont station to Newlands: 1,658 m, 173 s, 71 points, 1.5 s). Nothing else about its behaviour under load, rate limiting or availability is known. The demo step path has been run on PGlite and in Playwright against the dev server (straight-line routes), not on the deployed Worker. The Durable Object broadcast of demo pings, the seed over the direct Neon URL, and Neon compute use are unmeasured.
- HTTP simulator simplifications: drivers go straight to the drop-off (no station stop) and a busy driver's stored position is up to 30 s old, so it can step back between bursts.
- Order tokens live in localStorage: clearing site data loses the ability to cancel from that browser.
- **Real ETAs and geometry:** OpenRouteService (key) and PostGIS on Neon.
- Stripe adapter (stub); a Paystack checkout redirect in the web app.
- k6 load test against a Neon branch; SLO dashboards; a Workers-runtime test for the Durable Object.
- Driver app: `apps/driver` is an Expo scaffold (background location, ADR 0008), untested, and outside the npm workspaces.
- Ratings, batched deliveries and surge-aware dispatch (PRD v1.1, v2).

See also: [PRD](docs/PRD.md), [ADRs](docs/adr), [next steps](docs/NEXT.md).
