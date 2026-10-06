import {
  TrackHub,
  type TrackPublisher,
  WebhookIgnored,
  WebhookSignatureError,
  DELIVERY_RADIUS_KM,
  isDemoDriverId,
  rangeAdvice,
  rankDrivers,
  transition,
  withinRadius,
  type Actor,
  type Dropoff,
  type EtaProvider,
  type EventType,
  type Fuel,
  type OrderEvent,
  type OrderRecord,
  type OrderView,
  type PaymentProvider,
  type Store,
  type StoredEvent,
  type Payment,
  type TransitionError,
} from "@noir/core";

export type EngineConfig = {
  currency: string;
  /** Kept when a customer cancels after the driver has set off. Product rule, not a measurement. */
  cancelFeeCents: number;
  /** Orders still placed/accepted after this long are cancelled by the system (sweep). */
  maxWaitMs: number;
  /** Persist one driver point per this many ms. Strategy doc capacity table: 30 s. */
  downsampleMs: number;
  /** Straight-line km from the chosen station within which an order may be placed or moved. Default DELIVERY_RADIUS_KM. */
  deliveryRadiusKm: number;
};

export type EngineMetric =
  | { type: "assignment"; orderId: string; ms: number; assigned: boolean }
  | { type: "reassign"; orderId: string };

export type EngineDeps = {
  store: Store;
  payments: PaymentProvider;
  eta: EtaProvider;
  clock?: () => number;
  newId?: () => string;
  hub?: TrackPublisher;
  config?: Partial<EngineConfig>;
  metrics?: (m: EngineMetric) => void;
  /** Wall clock for latency metrics; the order clock may be simulated. */
  perfNow?: () => number;
};

export type SubmitInput = { type: EventType; actor: Actor; actorId?: string; data?: unknown };
export type SubmitResult = { ok: true; view: OrderView } | { ok: false; error: TransitionError | { code: "conflict" | "not_found"; message: string } };

export type PlaceInput = {
  customerId: string;
  stationId: string;
  fuel: Fuel;
  litres: number;
  dropoff: Dropoff;
  note?: string;
  idempotencyKey: string;
  /** Flags the order (and only the order) as simulator traffic, so cleanup may delete it. */
  isSimulated?: boolean;
};

export type OrderDetail = { id: string; isSimulated: boolean; view: OrderView; events: StoredEvent[]; payment: Payment | null };

// Coordinates are stored as numeric(9,6) (about 0.1 m), so events carry the same precision and replay matches the projection exactly.
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const roundDropoff = (d: Dropoff): Dropoff => ({ ...d, lat: round6(d.lat), lng: round6(d.lng) });

export class Engine {
  readonly store: Store;
  readonly hub: TrackPublisher;
  readonly config: EngineConfig;
  private readonly clock: () => number;
  private readonly newId: () => string;
  private readonly perfNow: () => number;

  constructor(private readonly deps: EngineDeps) {
    this.store = deps.store;
    this.clock = deps.clock ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.perfNow = deps.perfNow ?? (() => performance.now());
    this.config = { currency: "ZAR", cancelFeeCents: 5_000, maxWaitMs: 15 * 60_000, downsampleMs: 30_000, deliveryRadiusKm: DELIVERY_RADIUS_KM, ...deps.config };
    this.hub =
      deps.hub ??
      new TrackHub({
        downsampleMs: this.config.downsampleMs,
        persist: (p) => void this.store.recordLocationIfDue(p, 0).catch(() => {}), // best effort: a failed write must not break live tracking
      });
  }

  // ---- orders ---------------------------------------------------------------------------------

  async placeOrder(input: PlaceInput): Promise<{ order: OrderDetail; created: boolean; clientSecret: string | null }> {
    const station = await this.store.getStation(input.stationId);
    if (!station) throw new EngineError("unknown_station", "station not found");
    await this.assertInRadius(station, input.dropoff);
    const totalCents = Math.round(station.prices[input.fuel] * input.litres);
    const at = this.clock();
    const event: OrderEvent = {
      type: "order_placed",
      actor: "customer",
      actorId: input.customerId,
      at,
      data: {
        customerId: input.customerId,
        stationId: input.stationId,
        fuel: input.fuel,
        litres: input.litres,
        totalCents,
        dropoff: roundDropoff(input.dropoff),
        note: input.note,
      },
    };
    const r = transition(null, event);
    if (!r.ok) throw new EngineError(r.error.code, r.error.message);

    const idem = `order:${input.customerId}:${input.idempotencyKey}`;
    const id = this.newId();
    const intent = await this.deps.payments.createIntent({ orderId: id, amountCents: totalCents, currency: this.config.currency, idempotencyKey: idem });
    const res = await this.store.insertOrder({
      id,
      idempotencyKey: input.idempotencyKey,
      isSimulated: input.isSimulated,
      view: r.view,
      event,
      payment: {
        id: `pay_${id}`,
        orderId: id,
        provider: this.deps.payments.name,
        intentId: intent.id,
        idempotencyKey: idem,
        amountCents: totalCents,
        currency: this.config.currency,
        status: "requires_payment",
        refundId: null,
        refundedCents: 0,
      },
    });
    return { order: (await this.detail(res.id))!, created: res.created, clientSecret: res.created ? intent.clientSecret : null };
  }

  /** Throws out_of_radius (HTTP 422 with the radius in the message) when the point is too far from the station. */
  private async assertInRadius(station: { id: string; name: string; lat: number; lng: number }, point: { lat: number; lng: number }) {
    const radiusKm = this.config.deliveryRadiusKm;
    if (withinRadius(station, point, radiusKm)) return;
    const a = rangeAdvice(await this.store.listStations(), station.id, point, radiusKm);
    throw new EngineError("out_of_radius", a.message ?? `That drop-off is outside our ${radiusKm} km delivery radius.`, {
      radiusKm,
      distanceKm: a.chosen ? Math.round(a.chosen.distanceKm * 10) / 10 : null,
      nearestInRange: a.nearestInRange ? { id: a.nearestInRange.station.id, name: a.nearestInRange.station.name, distanceKm: Math.round(a.nearestInRange.distanceKm * 10) / 10 } : null,
    });
  }

  async detail(id: string): Promise<OrderDetail | null> {
    const rec = await this.store.getOrder(id);
    if (!rec) return null;
    const [events, payment] = await Promise.all([this.store.listEvents(id), this.store.getPaymentByOrder(id)]);
    return { id, isSimulated: rec.isSimulated, view: rec.view, events, payment };
  }

  /**
   * The only way to change an order after placement. Validates against the pure state machine, appends
   * with an expected-version guard (retrying on races), then runs side effects for the new state.
   */
  async submit(orderId: string, input: SubmitInput): Promise<SubmitResult> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const rec = await this.store.getOrder(orderId);
      if (!rec) return { ok: false, error: { code: "not_found", message: "order not found" } };
      const moved = input.type === "order_modified" ? (input.data as { dropoff?: Dropoff } | undefined)?.dropoff : undefined;
      if (moved) {
        const st = await this.store.getStation(rec.view.stationId);
        if (st) {
          try {
            await this.assertInRadius(st, moved);
          } catch (e) {
            if (e instanceof EngineError) return { ok: false, error: { code: "invalid_data", message: e.message } };
            throw e;
          }
        }
      }
      const data = input.type === "order_modified" && (input.data as { dropoff?: Dropoff })?.dropoff
        ? { ...(input.data as object), dropoff: roundDropoff((input.data as { dropoff: Dropoff }).dropoff) }
        : input.data;
      const event = { ...input, data, at: this.clock() } as OrderEvent;
      const r = transition(rec.view, event);
      if (!r.ok) return r;
      if (await this.store.appendEvent(orderId, rec.view.version, event, r.view)) {
        await this.afterTransition(orderId, rec.view, r.view, event);
        return { ok: true, view: r.view };
      }
    }
    return { ok: false, error: { code: "conflict", message: "too many concurrent updates" } };
  }

  private async afterTransition(orderId: string, prev: OrderView, next: OrderView, event: OrderEvent) {
    await this.hub.setStatus(orderId, next.state);

    if (prev.driverId && prev.driverId !== next.driverId) {
      // Driver leaves the job (declined, unassigned, cancelled) or finishes it (completed keeps the id on the view).
      await this.store.setDriverStatus(prev.driverId, "available", "busy");
    }
    if (next.state === "completed" && next.driverId) await this.store.setDriverStatus(next.driverId, "available", "busy");

    if (next.state === "cancelled") {
      await this.settleCancelled(orderId, next);
      await this.hub.close(orderId);
    } else if (next.state === "completed") {
      await this.hub.close(orderId);
    }
    if (next.state === "cancelled" || next.state === "completed") {
      if (prev.driverId) await this.dispatchPending(); // the freed driver may suit a waiting order
      return;
    }
    if (next.state === "accepted") {
      if (event.type === "driver_declined" || event.type === "driver_unassigned") this.deps.metrics?.({ type: "reassign", orderId });
      await this.tryAssign(orderId);
    }
  }

  // ---- dispatch -------------------------------------------------------------------------------

  /** Assign the best available driver by ETA to an accepted, paid order. Returns the driver id or null. */
  async tryAssign(orderId: string): Promise<string | null> {
    const t0 = this.perfNow();
    const done = (driverId: string | null) => {
      this.deps.metrics?.({ type: "assignment", orderId, ms: this.perfNow() - t0, assigned: driverId !== null });
      return driverId;
    };
    const rec = await this.store.getOrder(orderId);
    if (!rec || rec.view.state !== "accepted") return null;
    const payment = await this.store.getPaymentByOrder(orderId);
    if (payment?.status !== "succeeded") return null;
    const station = await this.store.getStation(rec.view.stationId);
    if (!station) return null;

    let free = (await this.store.listDrivers({ status: "available" })).filter((d) => d.locationAt !== null);
    // Demo drivers belong to the on-demand demo: nobody else drives them, so only demo orders may be given one.
    if (free.some((d) => isDemoDriverId(d.id)) && !(await this.store.getDemo(orderId))) free = free.filter((d) => !isDemoDriverId(d.id));
    const ranked = await rankDrivers({ candidates: free, pickup: station, eta: this.deps.eta, exclude: rec.view.declinedBy });
    for (const cand of ranked) {
      // Claim first: two orders racing for one driver, only one update matches status = 'available'.
      if (!(await this.store.setDriverStatus(cand.driverId, "busy", "available"))) continue;
      const r = await this.submit(orderId, { type: "driver_assigned", actor: "system", data: { driverId: cand.driverId } });
      if (r.ok) return done(cand.driverId);
      await this.store.setDriverStatus(cand.driverId, "available", "busy");
      if (r.error.code !== "conflict") break; // order moved on (cancelled, already assigned)
    }
    return done(null);
  }

  /** Retry assignment for every paid, accepted, unassigned order. Call on a timer and when drivers free up. */
  async dispatchPending(): Promise<number> {
    let n = 0;
    for (const o of await this.store.listOrders({ states: ["accepted"] })) if (await this.tryAssign(o.id)) n++;
    return n;
  }

  /** System cancels orders that waited too long for a station or a driver. */
  async sweep(): Promise<string[]> {
    const cutoff = this.clock() - this.config.maxWaitMs;
    const cancelled: string[] = [];
    for (const o of await this.store.listOrders({ states: ["placed", "accepted"] })) {
      if (o.view.updatedAt > cutoff) continue;
      const r = await this.submit(o.id, {
        type: "order_cancelled",
        actor: "system",
        data: { reason: o.view.state === "placed" ? "station_timeout" : "no_driver_available" },
      });
      if (r.ok) cancelled.push(o.id);
    }
    return cancelled;
  }

  // ---- drivers --------------------------------------------------------------------------------

  async driverOnline(driverId: string, pos: { lat: number; lng: number }) {
    const d = await this.store.getDriver(driverId);
    if (!d) throw new EngineError("unknown_driver", "driver not found");
    await this.store.upsertDriver({ ...d, ...pos, status: "available", locationAt: this.clock() });
    await this.dispatchPending();
  }

  async driverOffline(driverId: string) {
    // Offline first, so the release that follows an unassign cannot hand the driver straight back out.
    await this.store.setDriverStatus(driverId, "offline");
    for (const o of await this.store.listOrders({ active: true })) {
      if (o.view.driverId === driverId && ["assigned", "en_route"].includes(o.view.state)) {
        await this.submit(o.id, { type: "driver_unassigned", actor: "system", data: { reason: "driver_offline" } });
      }
    }
  }

  /**
   * Live position. Goes to the delivery's room when the driver has an order (broadcast, then downsampled
   * persist); otherwise straight to the store behind the same downsampling gate.
   */
  async recordLocation(p: { driverId: string; orderId?: string | null; lat: number; lng: number; t?: number }) {
    const t = p.t ?? this.clock();
    if (p.orderId) {
      await this.hub.publish({ orderId: p.orderId, driverId: p.driverId, lat: p.lat, lng: p.lng, t });
    } else {
      await this.store.recordLocationIfDue({ driverId: p.driverId, orderId: null, lat: p.lat, lng: p.lng, t }, this.config.downsampleMs);
    }
  }

  // ---- retention ------------------------------------------------------------------------------

  /** Delete raw location points older than `locationDays`, and finished simulated orders older than `simulatedHours`. */
  async runRetention(o: { locationDays?: number; simulatedHours?: number } = {}) {
    const now = this.clock();
    const locations = await this.store.deleteLocationsBefore(now - (o.locationDays ?? 7) * 86_400_000);
    const simulatedOrders = await this.store.deleteSimulatedOrders(now - (o.simulatedHours ?? 24) * 3_600_000);
    // Per-client demo counters (one row per client per day) are only useful for the day they count.
    const demoUsage = await this.store.deleteDemoUsageBefore(new Date(now - 2 * 86_400_000).toISOString().slice(0, 10));
    return { locations, simulatedOrders, demoUsage };
  }

  /** The engine's clock (virtual in tests and the simulator). */
  now() {
    return this.clock();
  }

  get paymentProvider() {
    return this.deps.payments.name;
  }

  get signatureHeader() {
    return this.deps.payments.signatureHeader;
  }

  // ---- payments -------------------------------------------------------------------------------

  async handleWebhook(rawBody: string, signature: string | null): Promise<{ status: "processed" | "duplicate" | "ignored" }> {
    let event;
    try {
      event = await this.deps.payments.verifyWebhook(rawBody, signature, this.clock());
    } catch (e) {
      if (e instanceof WebhookIgnored) return { status: "ignored" };
      throw e;
    }
    const payment = await this.store.getPaymentByIntent(event.intentId);
    if (!payment) {
      await this.store.recordWebhookEvent(event.id, event.type, this.clock());
      return { status: "ignored" };
    }
    let processed = false;
    if (event.type === "payment_intent.succeeded") {
      // The guarded update inserts the charge; a replay (same or new event id) matches no row.
      processed = await this.store.recordCharge({ intentId: event.intentId, amountCents: event.amountCents, eventId: event.id, at: this.clock() });
      if (processed) await this.afterPaid(payment.orderId);
    } else {
      processed = await this.store.setPaymentStatus(event.intentId, "failed", "requires_payment");
      if (processed) await this.submit(payment.orderId, { type: "order_cancelled", actor: "system", data: { reason: "payment_failed" } });
    }
    const firstDelivery = await this.store.recordWebhookEvent(event.id, event.type, this.clock());
    return { status: processed ? "processed" : firstDelivery ? "ignored" : "duplicate" };
  }

  private async afterPaid(orderId: string) {
    const rec = await this.store.getOrder(orderId);
    if (!rec) return;
    if (rec.view.state === "cancelled") {
      // Money arrived after the order was cancelled: hand it straight back.
      await this.refund(orderId, 0);
    } else if (rec.view.state === "accepted") {
      await this.tryAssign(orderId);
    }
  }

  private async settleCancelled(orderId: string, view: OrderView) {
    const pay = await this.store.getPaymentByOrder(orderId);
    if (!pay) return;
    if (pay.status === "requires_payment") {
      if (await this.store.setPaymentStatus(pay.intentId, "canceled", "requires_payment")) await this.deps.payments.cancelIntent(pay.intentId);
    } else if (pay.status === "succeeded") {
      await this.refund(orderId, view.cancel?.feeApplies ? this.config.cancelFeeCents : 0);
    }
  }

  private async refund(orderId: string, feeCents: number) {
    const pay = await this.store.getPaymentByOrder(orderId);
    if (!pay || pay.status !== "succeeded") return;
    const amountCents = Math.max(0, pay.amountCents - feeCents);
    const r = await this.deps.payments.refund({ intentId: pay.intentId, amountCents, idempotencyKey: `refund:${orderId}` });
    await this.store.markRefunded({ paymentId: pay.id, refundId: r.refundId, refundedCents: r.amountCents });
  }
}

export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Extra machine-readable fields for the API error body. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export { WebhookSignatureError };
export type { OrderRecord };
