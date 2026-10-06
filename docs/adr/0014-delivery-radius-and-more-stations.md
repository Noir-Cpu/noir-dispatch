# ADR 0014: A straight-line delivery radius, and fifteen stations

Status: accepted

**Context.** A visitor dropped a pin in Stellenbosch, about 45 km from any station then seeded, and nothing happened: the order was accepted and no sensible driver could ever serve it. The demo had five stations, all in the Cape Town metro core.

**Decision.**
- `DELIVERY_RADIUS_KM = 12` (`packages/core/src/delivery.ts`): the straight-line (haversine) distance from the chosen station to the drop-off must be at most the radius, boundary included. Straight line, not road distance, because it needs no routing call and is the same everywhere (server, order form, tests). The real drive is longer; 12 km is a product rule for the demo, not a measurement.
- It is configurable with a plain wrangler var, `DELIVERY_RADIUS_KM` in `apps/api/wrangler.toml`. A value that is not a positive number falls back to 12 (`parseRadiusKm`, tested).
- The **engine** enforces it, not just the route, so every path is covered: `placeOrder` (public orders and `/sim/orders`) and a customer moving the drop-off with `order_modified`. The API answers 422 `out_of_radius` with the radius, the distance, and the nearest station that can deliver, in one sentence built by `rangeAdvice` (also used by the form, so both say the same thing).
- The order form fetches `GET /api/config` (radius, whether the demo is on), draws a circle per station (the chosen one emphasised), lists stations nearest first with their distance, disables out-of-range ones with the reason in text, and replaces "Place order" with a disabled "Choose a station in range" plus a one-click "Use <nearest in-range station>". The server's 422 is shown in the same box if the form's own check was ever bypassed.
- Ten stations were added (Stellenbosch, Somerset West, Paarl, Durbanville, Table View, Mitchells Plain, Muizenberg, Constantia, Hout Bay, Brackenfell). Names are fictional with no real brands; coordinates are approximate area centres, not real forecourts. The seed is an upsert per station, so it is idempotent, and `.github/workflows/deploy.yml` runs it after the migration on every deploy.
- The in-process and HTTP simulators keep using only the original five (`SIM_STATIONS`). Their published benchmark was measured on those five, and simulated drivers roam the metro-core box, which would not serve Paarl.

**Consequences.** Anything inside the radius of at least one station can order. Eight sample drop-offs cover the new areas; Franschhoek is deliberately outside every radius so the message can be seen. Because the seed re-writes the 15 station rows on each deploy, editing a station by hand in the database is overwritten. The seed step runs with `DATABASE_URL_DIRECT` over Neon's HTTP driver; that exact combination has not been run by this change in CI (see README, unproven).
