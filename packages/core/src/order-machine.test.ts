import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import {
  ACTORS,
  ORDER_STATES,
  availableActions,
  replay,
  transition,
  type Actor,
  type EventType,
  type OrderEvent,
  type OrderState,
  type OrderView,
} from "./order-machine";

// Independent oracle: (state, event, actor) -> next state, written as a flat list rather than
// the per-event table the implementation uses, so a mistake has to be made twice to slip through.
const PRE = ["placed", "accepted", "assigned", "en_route"] as const;
const ORACLE: [OrderState, EventType, Actor, OrderState][] = [
  ["placed", "station_accepted", "station", "accepted"],
  ["accepted", "driver_assigned", "system", "assigned"],
  ["assigned", "driver_declined", "driver", "accepted"],
  ["en_route", "driver_declined", "driver", "accepted"],
  ["assigned", "driver_unassigned", "system", "accepted"],
  ["en_route", "driver_unassigned", "system", "accepted"],
  ["assigned", "driver_departed", "driver", "en_route"],
  ["en_route", "driver_arrived", "driver", "arrived"],
  ["arrived", "delivery_started", "driver", "delivering"],
  ["delivering", "delivery_completed", "driver", "completed"],
  ...PRE.flatMap((s): [OrderState, EventType, Actor, OrderState][] => [
    [s, "order_cancelled", "customer", "cancelled"],
    [s, "order_cancelled", "station", "cancelled"],
    [s, "order_cancelled", "system", "cancelled"],
  ]),
  ["arrived", "order_cancelled", "system", "cancelled"],
  ["delivering", "order_cancelled", "system", "cancelled"],
  ...(["placed", "accepted", "assigned"] as const).map((s): [OrderState, EventType, Actor, OrderState] => [s, "order_modified", "customer", s]),
  ...PRE.map((s): [OrderState, EventType, Actor, OrderState] => [s, "order_modified", "station", s]),
];
const oracle = (s: OrderState, t: EventType, a: Actor) => ORACLE.find(([fs, ft, fa]) => fs === s && ft === t && fa === a)?.[3];

const point = { lat: -33.92, lng: 18.42, label: "Home" };
const placed = (at = 0): OrderEvent => ({
  type: "order_placed",
  actor: "customer",
  at,
  data: { customerId: "c1", stationId: "s1", fuel: "diesel", litres: 50, totalCents: 100_000, dropoff: point },
});

const DRIVERS = ["d1", "d2", "d3"];

// A payload that is valid for any event type; actor/actorId chosen by the property.
function make(type: EventType, actor: Actor, actorId: string | undefined, at: number, pick: number): OrderEvent {
  const base = { actor, actorId, at };
  switch (type) {
    case "order_placed":
      return { ...placed(at), actor, actorId };
    case "driver_assigned":
      return { type, ...base, data: { driverId: DRIVERS[pick % DRIVERS.length]! } };
    case "order_modified":
      return { type, ...base, data: pick % 2 || actor === "station" ? { note: `n${pick}` } : { dropoff: { ...point, lat: -33.9 - (pick % 5) / 100 } } };
    case "order_cancelled":
    case "driver_declined":
    case "driver_unassigned":
      return { type, ...base, data: { reason: "r" } };
    default:
      return { type, ...base } as OrderEvent;
  }
}

const EVENT_TYPES: EventType[] = [
  "order_placed", "station_accepted", "driver_assigned", "driver_declined", "driver_unassigned", "driver_departed",
  "driver_arrived", "delivery_started", "delivery_completed", "order_cancelled", "order_modified",
];

const wild = fc.record({
  type: fc.constantFrom(...EVENT_TYPES),
  actor: fc.constantFrom(...ACTORS),
  actorId: fc.constantFrom<string | undefined>(undefined, ...DRIVERS),
  pick: fc.nat(20),
});

const FORWARD: EventType[] = ["station_accepted", "driver_assigned", "driver_departed", "driver_arrived", "delivery_started", "delivery_completed"];
const DRIVER_STATES: OrderState[] = ["assigned", "en_route", "arrived", "delivering", "completed"];
let cases = 0;
let steps = 0;
const reached = new Set<OrderState>();

/** Checks one transition against the oracle and the structural invariants. */
function checkStep(view: OrderView | null, e: OrderEvent): OrderView | null {
  steps++;
  const before = view ? structuredClone(view) : null;
  const r = transition(view, e);
  // Purity: the input view is never mutated.
  expect(view).toEqual(before);

  if (!view) {
    expect(r.ok).toBe(e.type === "order_placed" && e.actor === "customer");
    return r.ok ? r.view : null;
  }
  const expected = oracle(view.state, e.type, e.actor);
  if (!r.ok) return view;
  // Accepted => the oracle allowed it, and landed in the oracle's state.
  expect(expected, `${view.state} --${e.type}/${e.actor}--> ${r.view.state}`).toBeDefined();
  expect(r.view.state).toBe(expected);
  expect(r.view.version).toBe(view.version + 1);
  expect(["completed", "cancelled"]).not.toContain(view.state);
  expect(r.view.driverId !== null).toBe(DRIVER_STATES.includes(r.view.state));
  if (r.view.driverId) expect(r.view.declinedBy).not.toContain(r.view.driverId);
  expect(r.view.cancel !== null).toBe(r.view.state === "cancelled");
  reached.add(r.view.state);
  return r.view;
}

describe("order state machine (property-based)", () => {
  it("random event sequences never produce an illegal transition", () => {
    fc.assert(
      fc.property(fc.array(wild, { maxLength: 40 }), (evs) => {
        cases++;
        let view = checkStep(null, placed());
        evs.forEach((w, i) => {
          view = checkStep(view, make(w.type, w.actor, w.actorId, i + 1, w.pick));
        });
      }),
      { numRuns: 3000 },
    );
  });

  // Uniformly random events rarely get past "placed", so also walk only legal moves to reach deep states.
  const legalWalk = fc.array(fc.tuple(fc.nat(50), fc.constantFrom(...DRIVERS), fc.nat(9)), { maxLength: 30 });

  function legalCandidates(view: OrderView, driver: string): OrderEvent[] {
    const out: OrderEvent[] = [];
    for (const actor of ACTORS) {
      for (const type of availableActions(view, actor)) {
        const actorId = actor === "driver" ? (view.driverId ?? driver) : undefined;
        out.push(make(type, actor, actorId, view.version + 1, driver.charCodeAt(1)));
      }
    }
    return out;
  }

  it("legal walks reach every state, obey the oracle, and replay reproduces the state", () => {
    fc.assert(
      fc.property(legalWalk, (steps_) => {
        cases++;
        const log: OrderEvent[] = [placed()];
        let view = checkStep(null, log[0]!)!;
        for (const [n, driver, bias] of steps_) {
          const cands = legalCandidates(view, driver).filter((e) => !(e.type === "driver_assigned" && view.declinedBy.includes((e.data as { driverId: string }).driverId)));
          if (cands.length === 0) break;
          // 60% of steps take forward progress so the walk reaches deep states; the rest are any legal move.
          const forward = cands.filter((c) => FORWARD.includes(c.type));
          const pool = bias < 6 && forward.length > 0 ? forward : cands;
          const e = pool[n % pool.length]!;
          const next = checkStep(view, e);
          if (next && next !== view) {
            log.push(e);
            view = next;
          }
        }
        // Replay of the log, including after a JSON round trip, reproduces the state exactly.
        expect(replay(log)).toEqual(view);
        expect(replay(JSON.parse(JSON.stringify(log)) as OrderEvent[])).toEqual(view);
        // Every prefix replays too (the log is valid at every point).
        for (let i = 1; i <= log.length; i++) expect(replay(log.slice(0, i))).not.toBeNull();
      }),
      { numRuns: 3000 },
    );
    expect([...reached].sort()).toEqual([...ORDER_STATES].sort());
  });

  it("replay of any accepted subsequence of random events matches incremental folding", () => {
    fc.assert(
      fc.property(fc.array(wild, { maxLength: 40 }), (evs) => {
        cases++;
        const accepted: OrderEvent[] = [placed()];
        let view = transition(null, accepted[0]!) as { ok: true; view: OrderView };
        let current = view.view;
        evs.forEach((w, i) => {
          const e = make(w.type, w.actor, w.actorId, i + 1, w.pick);
          const r = transition(current, e);
          if (r.ok) {
            accepted.push(e);
            current = r.view;
          }
        });
        expect(replay(accepted)).toEqual(current);
      }),
      { numRuns: 3000 },
    );
  });

  it("every oracle triple is accepted with a valid payload, and everything else is rejected", () => {
    // Exhaustive over state x type x actor, driving to each state through the legal path.
    const path: Record<OrderState, OrderEvent[]> = {
      placed: [],
      accepted: [make("station_accepted", "station", undefined, 1, 0)],
      assigned: [make("station_accepted", "station", undefined, 1, 0), make("driver_assigned", "system", undefined, 2, 0)],
      en_route: [],
      arrived: [],
      delivering: [],
      completed: [],
      cancelled: [make("order_cancelled", "customer", undefined, 1, 0)],
    };
    const drv = (t: EventType, at: number) => make(t, "driver", "d1", at, 0);
    path.en_route = [...path.assigned, drv("driver_departed", 3)];
    path.arrived = [...path.en_route, drv("driver_arrived", 4)];
    path.delivering = [...path.arrived, drv("delivery_started", 5)];
    path.completed = [...path.delivering, drv("delivery_completed", 6)];
    let checked = 0;
    for (const state of ORDER_STATES) {
      const view = replay([placed(), ...path[state]])!;
      expect(view.state).toBe(state);
      for (const type of EVENT_TYPES) {
        for (const actor of ACTORS) {
          const actorId = actor === "driver" ? "d1" : undefined;
          const r = transition(view, make(type, actor, actorId, 99, 0));
          const want = type === "order_placed" ? undefined : oracle(state, type, actor);
          expect(r.ok, `${state} ${type} ${actor}`).toBe(want !== undefined);
          if (r.ok) expect(r.view.state).toBe(want);
          checked++;
        }
      }
    }
    expect(checked).toBe(8 * 11 * 4);
  });

  afterAll(() => {
    console.info(`[property-run] generated cases: ${cases}, transitions checked: ${steps}, states reached: ${[...reached].sort().join(",")}`);
  });
});

describe("per-actor rules (examples)", () => {
  const at = (events: OrderEvent[]) => replay([placed(), ...events])!;
  it("customer cancelling after departure is charged a fee; before is not", () => {
    const acc = make("station_accepted", "station", undefined, 1, 0);
    const asg = make("driver_assigned", "system", undefined, 2, 0);
    const dep = make("driver_departed", "driver", "d1", 3, 0);
    const c = (events: OrderEvent[]) => transition(at(events), make("order_cancelled", "customer", undefined, 9, 0));
    expect(c([acc, asg])).toMatchObject({ ok: true, view: { cancel: { feeApplies: false } } });
    expect(c([acc, asg, dep])).toMatchObject({ ok: true, view: { cancel: { feeApplies: true }, driverId: null } });
  });
  it("a driver cannot cancel, and only the assigned driver can act", () => {
    const acc = make("station_accepted", "station", undefined, 1, 0);
    const asg = make("driver_assigned", "system", undefined, 2, 0);
    const v = at([acc, asg]);
    expect(transition(v, make("order_cancelled", "driver", "d1", 3, 0))).toMatchObject({ ok: false, error: { code: "forbidden_actor" } });
    expect(transition(v, make("driver_departed", "driver", "d2", 3, 0))).toMatchObject({ ok: false, error: { code: "not_assigned_driver" } });
  });
  it("the station may annotate but not move the drop-off; the customer may not modify once en route", () => {
    const acc = make("station_accepted", "station", undefined, 1, 0);
    const moved = { type: "order_modified", actor: "station", at: 2, data: { dropoff: point } } as OrderEvent;
    expect(transition(at([acc]), moved)).toMatchObject({ ok: false, error: { code: "forbidden_actor" } });
    const asg = make("driver_assigned", "system", undefined, 2, 0);
    const dep = make("driver_departed", "driver", "d1", 3, 0);
    const byCustomer = { type: "order_modified", actor: "customer", at: 4, data: { note: "gate code 12" } } as OrderEvent;
    expect(transition(at([acc, asg, dep]), byCustomer)).toMatchObject({ ok: false, error: { code: "illegal_state" } });
  });
  it("a decline sends the order back to accepted and bars that driver", () => {
    const acc = make("station_accepted", "station", undefined, 1, 0);
    const asg = make("driver_assigned", "system", undefined, 2, 0); // d1
    const v = at([acc, asg, make("driver_declined", "driver", "d1", 3, 0)]);
    expect(v).toMatchObject({ state: "accepted", driverId: null, declinedBy: ["d1"] });
    expect(transition(v, make("driver_assigned", "system", undefined, 4, 0))).toMatchObject({ ok: false });
    expect(transition(v, make("driver_assigned", "system", undefined, 4, 1))).toMatchObject({ ok: true });
  });
});
