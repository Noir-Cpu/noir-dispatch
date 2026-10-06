# ADR 0015: A RouteProvider interface; OSRM's public demo server, used sparingly

Status: accepted

**Context.** The driver "blinked across the map" in straight lines. A road polyline is needed to draw and animate a trip. `EtaProvider` (ADR 0004) answers "how long", not "which way", and the OpenRouteService adapter needs a key.

**Decision.**
- `RouteProvider.route(from, to)` returns a `Route`: polyline vertices, distance, duration, and `source` (`osrm` or `straight`) (`packages/core/src/route.ts`).
- `OsrmRouteProvider` calls `https://router.project-osrm.org/route/v1/driving/{lng},{lat};{lng},{lat}?overview=full&geometries=geojson` with an identifying `User-Agent`, a 3 s timeout (abort), and strict validation of the answer.
- `FallbackRouteProvider` wraps it: on any failure (network, timeout, HTTP error, bad body) it uses `StraightLineRouteProvider` (the old mover, same 1.3 circuity and 30 km/h as `HaversineEta`) and logs why. Which one was used is stored with the order (`order_demos.route_source`) and shown to the visitor.
- **Usage policy.** The public server is a demo with no uptime or performance guarantee and a usage policy (identify yourself, light use). So: **one lookup per order at most**, made by the first "Run demo" step, claimed with a guarded `UPDATE` so two tabs cannot both call it; the polyline is cached on the order (new table `order_demos`, additive migration 0004) and served to browsers from our own `GET /api/orders/:id/route`; the burst simulator never calls it (it keeps straight lines for its orders, which is also why no routes are precomputed: that would take dozens of calls to the public server); orders that never press "Run demo" never trigger a lookup. The polyline is simplified (Douglas-Peucker, 3 m) and rounded to 5 decimals before storing: for one Cape Town pair the real server returned 71 points and the stored route had 17.
- If the server disappears or throttles us, the demo still works with straight lines. A production deployment that wanted roads for real would run its own OSRM or use a paid router; the interface is the seam.
- `OpenRouteServiceEta` is unchanged.

**Consequences.** Road geometry and durations are OpenStreetMap-based and approximate (free-flow estimates, no live traffic). The adapter is unit tested against fixtures written by hand (no network in tests); it was called against the real server once, by hand, from one machine (README). Everything else about OSRM's behaviour, rate limiting and availability is unverified.
