# ADR 0009: PGlite dev mode, and no authentication in the simulated demo

Status: accepted (auth consequence superseded by ADR 0010)

**Context.** No Neon database exists yet, and reviewers should be able to run the whole thing with `npm install`.

**Decision.** `apps/api/src/dev.ts` runs the same Hono app and engine on Node with PGlite (in memory), the simulator, WebSocket tracking, and the built web app. Playwright runs against it. Production wiring (`src/index.ts`) uses the Neon HTTP driver and Durable Objects. The API takes the acting role (`actor`) from the request body and does not authenticate it, so anyone can act as a station or driver. The system actor is refused at the API. The template's Better Auth wiring was removed rather than left half-connected.

**Consequences.** Fine for a simulation with fake customers; not acceptable for real use. Adding auth means sessions per actor type and checking `actorId` against the session. Listed as an open lead in the README.
