# ADR 0004: Match by ETA behind a provider interface

Status: accepted

**Context.** Straight-line distance misjudges cities with rivers, one-way systems and highways. A routing API fixes that but needs a key and has rate limits.

**Decision.** `EtaProvider.etaSeconds(origins, destination)` is the seam. Default `HaversineEta`: straight-line distance times a circuity factor (1.3) at a constant speed (30 km/h). Both numbers are assumptions, not measurements. `OpenRouteServiceEta` calls the ORS matrix API with a key; it is unit-tested against a mocked `fetch` and is **not enabled**. Only the nearest 8 drivers by straight line reach the provider, to bound paid or rate-limited calls. Ties break on driver id, so matching is deterministic.

**Consequences.** Ranking by haversine ETA is the same order as ranking by distance; the interface, the shortlist and the tests exist so a real provider changes results without changing the engine. Self-hosted OSRM would be another adapter.
