# CASE 002 / DISPATCH: PRD

Status: draft for review. Owner: John Balogun. Simulated demo only: no real fuel, drivers or money move.

## 1. Problem

On-demand delivery coordinates customers, stations and drivers in real time, with money moving and states changing concurrently. Most portfolio clones show the map and skip the hard part: what happens when two things change at once.

## 2. Users

| User | Goal | Constraint |
| --- | --- | --- |
| Customer | Order fuel to a location, see it coming, cancel or change it if plans change | Phone in hand, one-thumb use |
| Station | Accept orders it can fill, cancel or adjust when stock runs out | Busy counter, wants a queue |
| Driver | Take a job, navigate, mark arrival and delivery | Sunlight, gloves, background location |
| Operator | See every active order and driver, and why an order is stuck | Needs the event log, not a summary |

## 3. Goals and measurable success criteria

1. **Fast assignment.** Driver assigned within 5 s at p95 with 50 drivers and 200 orders/hour simulated.
2. **Fast tracking.** Live location reaches a subscriber within 2 s at p95.
3. **No double charges.** 0 double charges when a payment webhook is replayed 10 times (chaos test).
4. **No illegal transitions.** 0 illegal order-state transitions under property-based testing; replaying the event log reproduces the state.
5. **Usability.** Place an order in under a minute on a phone; axe clean; keyboard usable.

Numbers in the README come from local, in-process runs and are labelled so. Production numbers are not measured.

## 4. Non-goals

- Real fuel operations. Fuel transport is regulated dangerous-goods work. The README says this is a simulation.
- Real payments (test mode only), multiple cities, batched deliveries, surge pricing.

## 5. Scope

**MVP:** order state machine, simulator, live tracking, ops console.
**v1.1:** payments, cancellations, ratings.
**v2:** batched deliveries, surge-aware dispatch.

## 6. Key design decisions

Each is an ADR in `docs/adr/`.

1. **State machine is a pure module (ADR 0002).** States: placed, accepted, assigned, en_route, arrived, delivering, completed, cancelled. Rules per state and per actor (customer, station, driver, system). Every change is an append-only `order_events` row.
2. **Geometry without PostGIS for now (ADR 0003).** lat/lng stored as numeric so PGlite tests run; PostGIS is the production upgrade for service-area polygons and nearest-driver queries.
3. **Match by ETA behind an interface (ADR 0004).** Default: haversine at an assumed urban speed. OpenRouteService adapter exists but is not enabled (needs a key).
4. **Optimistic append, one statement (ADR 0005).** The Neon HTTP driver has no interactive transactions. An event and the order projection change in one SQL statement guarded by the expected version.
5. **Payments behind a provider interface (ADR 0006).** Test provider behaves like Stripe/Paystack: intents, idempotency keys, HMAC-signed webhooks, refund on cancel.
6. **Live tracking in one Durable Object per delivery (ADR 0007).** Live position is not written to Postgres; a downsampled track (one point per 30 s) is.
7. **Expo for the driver app (ADR 0008).** Background location needs a native-capable runtime; Expo keeps TypeScript across API, web and mobile.

## 7. Flows

**Customer:** pick station and fuel, enter drop-off, place order, pay (test), watch driver approach on the map, cancel while allowed.
**Station:** accept the order (in the simulator a bot does this).
**Driver:** receives assignment, departs, arrives, starts delivery, completes; may decline before arriving, which reassigns.
**Operator:** map of active orders and drivers, order table, event log per order.

## 8. Data model

`customers`, `stations` (location, prices, rating), `drivers` (status, last position), `orders` (projection: state, version, driver), `order_events` (append-only, unique per order and sequence), `driver_locations` (downsampled), `payments` (intent, status, refund), `payment_webhook_events` (dedupe by provider event id).

## 9. Capacity estimate

50 drivers pinging every 5 s for 8 hours is 288,000 rows/day (strategy doc). Only a downsampled point per 30 s is stored: 48,000 rows/day, about one sixth. A retention job is still needed for Neon's 0.5 GB. WebSocket messages to Durable Objects are billed at a lower rate than requests; sending every ping as an HTTP request would exceed the Workers Free 100,000 requests/day on its own.

## 10. Risks and open questions

1. Real deployment needs a Neon project and Cloudflare secrets (docs/SETUP.md).
2. Driver ETA quality: haversine ignores roads; ORS needs a key and has rate limits.
3. No authentication in the simulated demo: actors are declared by the caller. Real use needs sessions and per-actor authorisation.
4. Regulation: any real-world pilot needs licensed carriers and dangerous-goods compliance.
