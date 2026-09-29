# ADR 0007: One Durable Object per active delivery, downsampled persistence

Status: accepted

**Context.** Driver apps ping every 5 s. Writing each ping to Postgres is about 288,000 rows a day for 50 drivers and would fill Neon's free 0.5 GB in weeks (strategy doc capacity table). HTTP pings would also exhaust the Workers Free request quota.

**Decision.** Live position lives in memory in a `TrackingRoom` Durable Object named by order id (SQLite-backed, allowed on the Free plan). Its logic is the plain class `TrackRoom` in `packages/core`, which the DO wraps; that class is what the unit tests cover. Every ping is broadcast to subscribers first, then at most one point per 30 s is persisted (to the DO's own storage and to `driver_locations`). Idle drivers, who have no delivery room, write through a SQL downsampling gate on the `drivers` row. The dev server and simulator use the same `TrackRoom` in process behind a `TrackPublisher` interface.

**Consequences.** Persisted rows are about one sixth of pings. Hibernation loses the in-memory latest position, which is restored from the last persisted point (up to 30 s stale) until the next ping. Retention job still needed (not built). The DO wrapper (`apps/api/src/tracking-do.ts`) is not covered by automated tests: it needs the Workers runtime; see README for what was and was not exercised.
