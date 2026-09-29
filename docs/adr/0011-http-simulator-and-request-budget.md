# ADR 0011: A second, HTTP-mode simulator with a hard request budget

Status: accepted

**Context.** The in-process simulator drives the engine directly and cannot animate a deployed Worker. The deployed demo must not look empty, must not burn the Workers Free quota (100,000 requests/day), and must not endanger real data.

**Decision.** `packages/sim/src/http-sim.ts` runs a short *burst* (default 240 s) against the public API using a shared-secret token. It is stateless between bursts (it re-reads `GET /api/sim/state` each tick), seeded, rate limited to 5 requests/s, and stops at a hard request cap (default 400). It ends by asking the server to expire simulated orders older than 6 hours. The server refuses the token any access to real customers' orders or real drivers (except accepting new orders as station staff). A scheduled GitHub Actions workflow runs a burst every 15 minutes, only when the repository variable `SIMULATOR_ENABLED` is `true`.

Simplifications versus the in-process simulator: drivers go straight to the drop-off (no station stop), because a stateless runner cannot remember which leg a driver is on; and a busy driver's stored position is at most 30 s old (downsampling), so a driver can appear to step back between bursts.

**Consequences.** Budget arithmetic is in the README. Simulated orders are labelled (`is_simulated`) so they can be deleted; the append-only trigger has one exception for events of simulated orders (migration 0003).
