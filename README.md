# CASE 002 / DISPATCH

**Verdict: a dispatch engine for on-demand fuel delivery whose order rules, driver matching, payment handling and live tracking are built and tested locally against a simulated fleet. It is not deployed, and no real fuel, driver or money is involved.**

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
| Assignment within 5 s at p95 | **Two different answers.** The assignment step itself (rank drivers, claim one, append the event) took p50 2.2 ms, p95 3.5 ms, max 6.4 ms over 203 assignments. But orders also wait for a *free* driver: from "accepted and paid" to "assigned", simulated time was p50 25 s, **p95 440 s**, max 525 s. With 50 drivers, 40 km/h and 4 km delivery radius the fleet is saturated at 200 orders/hour (196 placed, all completed by the end of the drain), so the 5 s target is met by the engine and **not** met by the fleet. | `npm run bench -- --hours 1 --seed 42` |
| Live location within 2 s at p95 | **Depends on load, see below.** In-process subscriber: p50 0.002 ms, p95 0.004 ms. Over a loopback WebSocket with the simulator running flat out (one virtual hour in 11.5 s, so about 300x real load): p50 34 ms, **p95 2,013 ms**, max 2,496 ms. Paced at 20x (one virtual hour in 275 s, so 20x real load): p50 4.1 ms, **p95 26.6 ms**, max 134.5 ms over 38,608 frames. | `npm run bench -- --hours 1 --seed 42 [--time-scale 20]` |

The flat-out WebSocket tail is a saturated event loop (the simulator, PGlite and the socket server share one thread), not network latency; the paced run is the fairer reading. Neither is a claim about production. Raw results: [`docs/bench/`](docs/bench). Other run facts (flat out): 41,314 pings produced 9,132 stored `driver_locations` rows (22%, the downsample gate), 7 driver declines were reassigned, 0 cancellations.

Other tests: 22 core (state machine, geo, matching, ORS adapter with mocked fetch, tracking room), 6 db (store guards: idempotent insert, stale-version append, driver claim, location gate, single charge), 24 engine (PGlite: placing, idempotency, dispatch, decline reassign, racing orders, refunds, downsampling, webhooks), 4 simulator (deterministic per seed, all logs replay), 10 API. Playwright: 12 passing (desktop and Pixel 7): place, pay, and watch an order go to delivered with the simulator running; live WebSocket positions; cancel; ops console; axe clean on all three screens; keyboard-only ordering; no horizontal scroll.

Not covered by automated tests: the Durable Object wrapper (`apps/api/src/tracking-do.ts`) needs the Workers runtime; the Neon HTTP driver path; the Worker entry. Only `wrangler deploy --dry-run` bundling was checked (see below). The Expo driver app is a scaffold that was never installed or run.

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
- **Payments** (`packages/core/src/payments`): intents, idempotency keys, HMAC-signed webhooks with a 5-minute replay window, refund on cancel (ADR 0006). **`PaystackProvider` and `StripeProvider` are stubs that throw; they need test-mode keys and an implementation.**
- **Tracking**: `TrackRoom` is a plain class (unit tested); the Durable Object wraps it; one point per 30 s is persisted (ADR 0007). `wrangler.toml` binds a SQLite-backed DO, valid on the Free plan.
- **Simulator** (`packages/sim`): 50 drivers roam Cape Town, take assigned jobs through the state machine (3% decline), stand-in stations accept, stand-in customers pay through the signed webhook. Seeded (mulberry32); the same seed gives the same orders, declines and event counts (tested).
- **Web** (`apps/web`): `/` place an order, `/order/:id` live tracking, `/ops` operations console. Shared NOIR tokens, no brand costume.

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

## The verdict

Cost at 10k users: **not measured.** Arithmetic from the strategy doc: 10,000 users x 30 requests is about 300,000 requests/day, three times the Workers Free quota of 100,000/day, so the $5/month plan is needed. Driver pings must go over WebSockets to the delivery's Durable Object rather than as HTTP requests; as HTTP they would exceed the free quota by themselves (288,000/day for 50 drivers). Location storage is downsampled to about a sixth of raw pings; Neon's free 0.5 GB still needs a retention job (not built).

## Open leads

- **Nothing is deployed.** See [docs/SETUP.md](docs/SETUP.md). A deployed Worker has no simulator; an HTTP-mode simulator is the missing piece for a live demo.
- **No authentication.** Callers declare their role; the system actor is blocked at the API. ADR 0009.
- **Real ETAs and geometry:** OpenRouteService (key) and PostGIS on Neon.
- **Real payments:** Paystack or Stripe test-mode adapters.
- Retention job for `driver_locations`; k6 load test against a Neon branch; SLO dashboards; a Workers-runtime test for the Durable Object.
- Driver app: `apps/driver` is an Expo scaffold (background location, ADR 0008), untested, and outside the npm workspaces.
- Ratings, batched deliveries and surge-aware dispatch (PRD v1.1, v2).

See also: [PRD](docs/PRD.md), [ADRs](docs/adr), [next steps](docs/NEXT.md).
