// Pure order state machine. No I/O, no clock, no randomness: same events in, same state out.
// The append-only event log is the source of truth; `OrderView` is a fold over it.

export const ORDER_STATES = [
  "placed",
  "accepted",
  "assigned",
  "en_route",
  "arrived",
  "delivering",
  "completed",
  "cancelled",
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export const ACTORS = ["customer", "station", "driver", "system"] as const;
export type Actor = (typeof ACTORS)[number];

export const FUELS = ["diesel", "petrol_95"] as const;
export type Fuel = (typeof FUELS)[number];

export type LatLng = { lat: number; lng: number };
export type Dropoff = LatLng & { label: string };

export type OrderEvent =
  | {
      type: "order_placed";
      actor: Actor;
      actorId?: string;
      at: number;
      data: {
        customerId: string;
        stationId: string;
        fuel: Fuel;
        litres: number;
        totalCents: number;
        dropoff: Dropoff;
        note?: string;
      };
    }
  | { type: "station_accepted"; actor: Actor; actorId?: string; at: number; data?: undefined }
  | { type: "driver_assigned"; actor: Actor; actorId?: string; at: number; data: { driverId: string } }
  | { type: "driver_declined"; actor: Actor; actorId?: string; at: number; data?: { reason?: string } }
  | { type: "driver_unassigned"; actor: Actor; actorId?: string; at: number; data?: { reason?: string } }
  | { type: "driver_departed"; actor: Actor; actorId?: string; at: number; data?: undefined }
  | { type: "driver_arrived"; actor: Actor; actorId?: string; at: number; data?: undefined }
  | { type: "delivery_started"; actor: Actor; actorId?: string; at: number; data?: undefined }
  | { type: "delivery_completed"; actor: Actor; actorId?: string; at: number; data?: undefined }
  | { type: "order_cancelled"; actor: Actor; actorId?: string; at: number; data?: { reason?: string } }
  | { type: "order_modified"; actor: Actor; actorId?: string; at: number; data: { dropoff?: Dropoff; note?: string } };

export type EventType = OrderEvent["type"];

export type OrderView = {
  state: OrderState;
  /** Number of events applied. Doubles as the optimistic-concurrency version. */
  version: number;
  customerId: string;
  stationId: string;
  fuel: Fuel;
  litres: number;
  totalCents: number;
  dropoff: Dropoff;
  note: string | null;
  driverId: string | null;
  /** Drivers who declined this order; matching must skip them. */
  declinedBy: string[];
  cancel: { by: Actor; reason: string | null; feeApplies: boolean } | null;
  placedAt: number;
  updatedAt: number;
};

export type TransitionError = {
  code: "no_order" | "already_placed" | "terminal" | "illegal_state" | "forbidden_actor" | "invalid_data" | "not_assigned_driver";
  message: string;
};
export type TransitionResult = { ok: true; view: OrderView } | { ok: false; error: TransitionError };

type Rule = {
  from: readonly OrderState[];
  actors: readonly Actor[];
  /** Next state; "same" leaves it unchanged (modifications). */
  to: OrderState | "same";
};

const NON_TERMINAL_PRE_ARRIVAL = ["placed", "accepted", "assigned", "en_route"] as const;

// One row per event type. Cancel and modify rules differ per actor, so they get an
// extra per-actor table below; every other event has a single rule.
const RULES: Record<Exclude<EventType, "order_placed" | "order_cancelled" | "order_modified">, Rule> = {
  station_accepted: { from: ["placed"], actors: ["station"], to: "accepted" },
  driver_assigned: { from: ["accepted"], actors: ["system"], to: "assigned" },
  driver_declined: { from: ["assigned", "en_route"], actors: ["driver"], to: "accepted" },
  driver_unassigned: { from: ["assigned", "en_route"], actors: ["system"], to: "accepted" },
  driver_departed: { from: ["assigned"], actors: ["driver"], to: "en_route" },
  driver_arrived: { from: ["en_route"], actors: ["driver"], to: "arrived" },
  delivery_started: { from: ["arrived"], actors: ["driver"], to: "delivering" },
  delivery_completed: { from: ["delivering"], actors: ["driver"], to: "completed" },
};

const CANCEL_FROM: Record<Actor, readonly OrderState[]> = {
  customer: NON_TERMINAL_PRE_ARRIVAL,
  station: NON_TERMINAL_PRE_ARRIVAL,
  driver: [],
  system: [...NON_TERMINAL_PRE_ARRIVAL, "arrived", "delivering"],
};

const MODIFY_FROM: Record<Actor, readonly OrderState[]> = {
  customer: ["placed", "accepted", "assigned"],
  station: NON_TERMINAL_PRE_ARRIVAL,
  driver: [],
  system: [],
};

/** Only the customer may move the drop-off point; the station may only annotate. */
const MODIFY_FIELDS: Record<Actor, readonly ("dropoff" | "note")[]> = {
  customer: ["dropoff", "note"],
  station: ["note"],
  driver: [],
  system: [],
};

const fail = (code: TransitionError["code"], message: string): TransitionResult => ({ ok: false, error: { code, message } });

const isTerminal = (s: OrderState) => s === "completed" || s === "cancelled";

const validLatLng = (p: LatLng) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

export function transition(view: OrderView | null, event: OrderEvent): TransitionResult {
  if (event.type === "order_placed") {
    if (view) return fail("already_placed", "order already exists");
    const d = event.data;
    if (event.actor !== "customer") return fail("forbidden_actor", "only a customer places an order");
    if (!(d.litres > 0) || !Number.isFinite(d.litres) || !(d.totalCents >= 0) || !Number.isInteger(d.totalCents) || !validLatLng(d.dropoff)) {
      return fail("invalid_data", "litres must be positive, total a non-negative integer, dropoff a valid point");
    }
    return {
      ok: true,
      view: {
        state: "placed",
        version: 1,
        customerId: d.customerId,
        stationId: d.stationId,
        fuel: d.fuel,
        litres: d.litres,
        totalCents: d.totalCents,
        dropoff: d.dropoff,
        note: d.note ?? null,
        driverId: null,
        declinedBy: [],
        cancel: null,
        placedAt: event.at,
        updatedAt: event.at,
      },
    };
  }

  if (!view) return fail("no_order", "order has not been placed");
  if (isTerminal(view.state)) return fail("terminal", `order is ${view.state}`);

  const base = { ...view, version: view.version + 1, updatedAt: event.at };

  if (event.type === "order_cancelled") {
    if (!CANCEL_FROM[event.actor].includes(view.state)) {
      return fail(CANCEL_FROM[event.actor].length === 0 ? "forbidden_actor" : "illegal_state", `${event.actor} cannot cancel in ${view.state}`);
    }
    const feeApplies = event.actor === "customer" && view.state === "en_route";
    return {
      ok: true,
      view: { ...base, state: "cancelled", driverId: null, cancel: { by: event.actor, reason: event.data?.reason ?? null, feeApplies } },
    };
  }

  if (event.type === "order_modified") {
    if (!MODIFY_FROM[event.actor].includes(view.state)) {
      return fail(MODIFY_FROM[event.actor].length === 0 ? "forbidden_actor" : "illegal_state", `${event.actor} cannot modify in ${view.state}`);
    }
    const changes = Object.keys(event.data).filter((k) => (event.data as Record<string, unknown>)[k] !== undefined);
    if (changes.length === 0) return fail("invalid_data", "modification changes nothing");
    if (changes.some((k) => !(MODIFY_FIELDS[event.actor] as readonly string[]).includes(k))) {
      return fail("forbidden_actor", `${event.actor} cannot change ${changes.join(", ")}`);
    }
    if (event.data.dropoff && !validLatLng(event.data.dropoff)) return fail("invalid_data", "invalid dropoff");
    return {
      ok: true,
      view: { ...base, dropoff: event.data.dropoff ?? view.dropoff, note: event.data.note ?? view.note },
    };
  }

  const rule = RULES[event.type];
  if (!rule.actors.includes(event.actor)) return fail("forbidden_actor", `${event.actor} cannot ${event.type}`);
  if (!rule.from.includes(view.state)) return fail("illegal_state", `${event.type} not allowed in ${view.state}`);

  if (event.actor === "driver" && event.actorId !== view.driverId) {
    return fail("not_assigned_driver", "only the assigned driver may act");
  }

  const next: OrderView = { ...base, state: rule.to === "same" ? view.state : rule.to };
  switch (event.type) {
    case "driver_assigned":
      if (!event.data?.driverId) return fail("invalid_data", "driverId required");
      if (view.declinedBy.includes(event.data.driverId)) return fail("invalid_data", "driver previously declined this order");
      next.driverId = event.data.driverId;
      break;
    case "driver_declined":
      next.declinedBy = [...view.declinedBy, view.driverId!];
      next.driverId = null;
      break;
    case "driver_unassigned":
      next.driverId = null;
      break;
  }
  return { ok: true, view: next };
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly error: TransitionError,
    readonly index: number,
  ) {
    super(`event ${index}: ${error.code}: ${error.message}`);
  }
}

/** Rebuild the order from its log. Throws if the log itself is illegal. */
export function replay(events: readonly OrderEvent[]): OrderView | null {
  let view: OrderView | null = null;
  events.forEach((e, i) => {
    const r = transition(view, e);
    if (!r.ok) throw new IllegalTransitionError(r.error, i);
    view = r.view;
  });
  return view;
}

/** Event types an actor could send now, ignoring payload validity. For UI buttons and API hints. */
export function availableActions(view: OrderView, actor: Actor): EventType[] {
  if (isTerminal(view.state)) return [];
  const out: EventType[] = [];
  for (const [type, rule] of Object.entries(RULES) as [keyof typeof RULES, Rule][]) {
    if (rule.actors.includes(actor) && rule.from.includes(view.state)) out.push(type);
  }
  if (CANCEL_FROM[actor].includes(view.state)) out.push("order_cancelled");
  if (MODIFY_FROM[actor].includes(view.state)) out.push("order_modified");
  return out;
}
