# ADR 0002: The order state machine is a pure module over an append-only log

Status: accepted

**Context.** Customers, stations, drivers and the system all change an order, sometimes at once, and money depends on the result. Bugs here are double-assigned drivers and refunds that never happen.

**Decision.** `packages/core/src/order-machine.ts` is pure: `transition(view, event)` returns the next view or a typed error, with no I/O, clock or randomness. States: placed, accepted, assigned, en_route, arrived, delivering, completed, cancelled. Rules are per state and per actor (customer, station, driver, system):

- Customer and station may cancel until the driver is en route (inclusive). Only the system may cancel once the driver has arrived or is delivering. A driver cannot cancel; a driver can decline, which returns the order to `accepted` and bars that driver from it.
- The customer may change the drop-off point or note until a driver is assigned; the station may only add a note (until en route). Litres, fuel and price are fixed after placement (see ADR 0006).
- A customer cancelling after the driver set off is flagged `feeApplies`.
- A driver event is accepted only from the assigned driver.

Every accepted event is appended to `order_events`; `orders` is a projection that can be rebuilt by `replay`.

**Consequences.** The rules are testable exhaustively and with property-based tests (`order-machine.test.ts`): random and legal-walk sequences never take a transition outside an independently written oracle table, and replay reproduces the state. The engine cannot bypass the machine because `submit` is the only writer. The cost is that every new rule is a change to one table and its oracle, on purpose.
