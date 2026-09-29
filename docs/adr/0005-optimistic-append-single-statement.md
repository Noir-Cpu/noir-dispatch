# ADR 0005: Optimistic event append in one SQL statement

Status: accepted

**Context.** Production uses the Neon HTTP driver, which has no interactive transactions. Two writers can still race (station accepts while customer cancels; two orders claim one driver).

**Decision.** `appendEvent` is one statement: a CTE updates `orders` where `version = expected` and inserts the `order_events` row `select ... from` that update. If the version moved, zero rows come back and the engine reloads and retries (up to 5 times). `(order_id, seq)` is also the primary key of `order_events`, and a trigger rejects updates and deletes. Driver assignment first *claims* the driver with `update drivers set status='busy' where status='available' returning id`; the loser tries the next-ranked driver. Payments use the same idea: the charge is inserted from an `update payments ... where status='requires_payment'`, and `payment_charges` has one row per payment at most.

**Consequences.** No locks and no long transactions; the price is retries under contention and a rule that every mutating store method must be a single statement. The projection cannot drift from the log by a half-applied write. Tested by the racing-orders test and the 10-way concurrent webhook test.
