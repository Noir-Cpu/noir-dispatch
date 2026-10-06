# ADR 0010: Anonymous customers and drivers, allow-listed ops, and where the role boundary sits

Status: accepted. Supersedes the "no authentication" consequence of ADR 0009.

**Context.** The public demo must let anyone place an order and try a driver flow without an account, but must not let them act as staff, read every order, or touch each other's orders.

**Decision.**
- **Ops** (order list, driver list, dispatch tick, retention, station actions): Better Auth with GitHub sign-in only. The user's GitHub login is stored as `user.name`; sign-up is refused unless it is in `OPS_ALLOWED_GITHUB` (comma-separated, default just `Noir-Cpu`), and the list is re-checked on every request, so removing a name locks that person out immediately.
- **Customers** are anonymous. Placing an order returns an `orderToken` = HMAC(`ORDER_TOKEN_SECRET`, order id). Cancelling or modifying as a customer, and the demo "pay" button, need that token. Knowing an order id or a customer id is not enough (tested). The token lives in the placing browser's localStorage.
- **Drivers** are anonymous but may only act on an order they hold (the state machine already requires `actorId` to be the assigned driver), and simulated drivers can be driven only with the simulator token or by ops.
- **Station** and **system** actors are unreachable to anonymous callers; `system` is unreachable to everyone through the API.
- **Simulator** holds `SIM_TOKEN`. It may touch only records flagged `is_simulated`, with one deliberate exception: it may accept new orders as stand-in station staff so visitors' orders progress.
- Every role-declaring request passes a per-client rate limit (Workers Rate Limiting binding, 60 requests per 60 s, with an in-memory fallback that is best-effort per isolate).

**Consequences.** Tested at the HTTP layer (`apps/api/src/app.test.ts`). Not tested: the GitHub OAuth round trip and the Better Auth session path (they need a GitHub OAuth app and a database). An order token in localStorage is a bearer secret: anyone who copies it can act on that order, and clearing site data loses the ability to cancel. Customer ids remain labels, not identities.

**Addendum (quality pass): ops are matched by GitHub id, not login.** A GitHub login can be renamed, and a released name can be registered by someone else, so a login allow-list can be taken over by renaming (the new owner of "Noir-Cpu" would match, because the stored `user.name` is just the login). `OPS_ALLOWED_GITHUB_IDS` (comma-separated numeric GitHub user ids, a plain var or a secret) now wins when set: sign-in refuses a GitHub profile whose `id` is not listed before any user row is created, and every request re-checks the id of the linked GitHub `account` row (filled from GitHub's profile, not editable by the user). The login is ignored in that mode. A value that is set but holds no valid id allows nobody (fail closed). With the variable unset or blank the old login rule applies unchanged, so nothing changes until the ids are set. Find an id with `gh api users/<login> --jq .id` (for Noir-Cpu: 61392662). Set it with `npx wrangler secret put OPS_ALLOWED_GITHUB_IDS` (or a `[vars]` line). Tested with a stand-in session (right login, wrong id is refused; renamed login with the right id is allowed) and on the sign-in profile mapping; the real GitHub round trip is still untested.
