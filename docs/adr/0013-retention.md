# ADR 0013: Retention runs in the Worker cron

Status: accepted

**Decision.** The once-a-minute cron already runs the dispatch tick; at 03:00 UTC it also calls `engine.runRetention`, which deletes `driver_locations` older than 7 days and finished simulated orders older than 24 hours (and, via the simulator's own cleanup call, older than 6 hours). An ops-only `POST /api/ops/retention` runs the same code on demand. A GitHub Action calling an endpoint was rejected because it would need a stored credential for a destructive call; the cron needs none.

**Consequences.** Tested on PGlite (`engine.test.ts`, `store.test.ts`). The 03:00 trigger itself is not tested (it needs the Workers scheduler). If the 03:00 minute is missed, retention waits until the next day; the free cron gives no delivery guarantee.
