# ADR 0003: lat/lng as numeric now, PostGIS as the production upgrade

Status: accepted

**Context.** The strategy doc calls for PostGIS (service-area polygons, station lookups). Tests run against PGlite, an in-process Postgres, so CI and the dev server need no database service. PGlite ships some extensions but PostGIS is not one of them.

**Decision.** Store coordinates as `numeric(9,6)` (about 0.1 m). Matching ranks drivers in application code: the nearest few by haversine go to the ETA provider. Events carry coordinates rounded to the same precision so replay equals the projection exactly.

**Consequences.** No service-area polygons and no indexed nearest-neighbour query: at 50 drivers, sorting in memory is fine; at thousands it would not be. **Upgrade path:** enable PostGIS on Neon, add `geography(Point)` generated columns with GiST indexes, and replace the shortlist step in `rankDrivers` with `ORDER BY location <-> pickup LIMIT k`. Tests for that step would then need a real Postgres with PostGIS (a CI service container).
