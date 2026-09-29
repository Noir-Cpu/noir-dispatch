import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type {
  Actor,
  Customer,
  Driver,
  DriverStatus,
  LocationPoint,
  OrderEvent,
  OrderRecord,
  OrderView,
  Payment,
  PaymentStatus,
  Station,
  Store,
  StoredEvent,
} from "@noir/core";
import type { Db } from "./client";
import * as t from "./schema";

const iso = (ms: number) => new Date(ms).toISOString();
const rows = <T>(res: unknown) => (res as { rows: T[] }).rows;
const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

function toView(o: typeof t.orders.$inferSelect): OrderView {
  return {
    state: o.state as OrderView["state"],
    version: o.version,
    customerId: o.customerId,
    stationId: o.stationId,
    fuel: o.fuel as OrderView["fuel"],
    litres: o.litres,
    totalCents: o.totalCents,
    dropoff: { lat: o.dropoffLat, lng: o.dropoffLng, label: o.dropoffLabel },
    note: o.note,
    driverId: o.driverId,
    declinedBy: o.declinedBy,
    cancel: o.cancel ? { by: o.cancel.by as Actor, reason: o.cancel.reason, feeApplies: o.cancel.feeApplies } : null,
    placedAt: o.placedAt.getTime(),
    updatedAt: o.updatedAt.getTime(),
  };
}

const toPayment = (p: typeof t.payments.$inferSelect): Payment => ({
  id: p.id,
  orderId: p.orderId,
  provider: p.provider,
  intentId: p.intentId,
  idempotencyKey: p.idempotencyKey,
  amountCents: p.amountCents,
  currency: p.currency,
  status: p.status as PaymentStatus,
  refundId: p.refundId,
  refundedCents: p.refundedCents,
});

const toDriver = (d: typeof t.drivers.$inferSelect): Driver => ({
  id: d.id,
  name: d.name,
  status: d.status as DriverStatus,
  lat: d.lat,
  lng: d.lng,
  locationAt: d.locationAt?.getTime() ?? null,
});

export class DrizzleStore implements Store {
  constructor(private readonly db: Db) {}

  async upsertCustomer(c: Customer) {
    await this.db.insert(t.customers).values(c).onConflictDoUpdate({ target: t.customers.id, set: { name: c.name } });
  }
  async getCustomer(id: string) {
    const [r] = await this.db.select().from(t.customers).where(eq(t.customers.id, id));
    return r ? { id: r.id, name: r.name } : null;
  }

  async upsertStation(s: Station) {
    const v = { id: s.id, name: s.name, lat: s.lat, lng: s.lng, rating: s.rating, prices: s.prices };
    await this.db.insert(t.stations).values(v).onConflictDoUpdate({ target: t.stations.id, set: v });
  }
  private toStation(r: typeof t.stations.$inferSelect): Station {
    return { id: r.id, name: r.name, lat: r.lat, lng: r.lng, rating: r.rating, prices: r.prices as Station["prices"] };
  }
  async getStation(id: string) {
    const [r] = await this.db.select().from(t.stations).where(eq(t.stations.id, id));
    return r ? this.toStation(r) : null;
  }
  async listStations() {
    return (await this.db.select().from(t.stations).orderBy(asc(t.stations.id))).map((r) => this.toStation(r));
  }

  async upsertDriver(d: Driver) {
    const v = { id: d.id, name: d.name, status: d.status, lat: d.lat, lng: d.lng, locationAt: d.locationAt === null ? null : new Date(d.locationAt) };
    await this.db.insert(t.drivers).values(v).onConflictDoUpdate({ target: t.drivers.id, set: v });
  }
  async getDriver(id: string) {
    const [r] = await this.db.select().from(t.drivers).where(eq(t.drivers.id, id));
    return r ? toDriver(r) : null;
  }
  async listDrivers(filter?: { status?: DriverStatus }) {
    const q = this.db.select().from(t.drivers);
    const r = await (filter?.status ? q.where(eq(t.drivers.status, filter.status)) : q).orderBy(asc(t.drivers.id));
    return r.map(toDriver);
  }
  async setDriverStatus(id: string, to: DriverStatus, from?: DriverStatus) {
    const res = await this.db.execute(
      sql`update drivers set status = ${to} where id = ${id} ${from ? sql`and status = ${from}` : sql``} returning id`,
    );
    return rows(res).length === 1;
  }

  async insertOrder(i: { id: string; idempotencyKey: string; view: OrderView; event: OrderEvent; payment: Payment }) {
    const v = i.view;
    const e = i.event;
    const p = i.payment;
    const res = await this.db.execute(sql`
      with o as (
        insert into orders (id, customer_id, station_id, idempotency_key, state, version, fuel, litres, total_cents,
          dropoff_lat, dropoff_lng, dropoff_label, note, driver_id, declined_by, cancel, placed_at, updated_at)
        values (${i.id}, ${v.customerId}, ${v.stationId}, ${i.idempotencyKey}, ${v.state}, ${v.version}, ${v.fuel}, ${v.litres},
          ${v.totalCents}, ${v.dropoff.lat}, ${v.dropoff.lng}, ${v.dropoff.label}, ${v.note}, null, '[]'::jsonb, null,
          ${iso(v.placedAt)}::timestamptz, ${iso(v.updatedAt)}::timestamptz)
        on conflict (customer_id, idempotency_key) do nothing
        returning id
      ), e as (
        insert into order_events (order_id, seq, type, actor, actor_id, at, data)
        select id, 1::int, ${e.type}, ${e.actor}, ${e.actorId ?? null}, ${iso(e.at)}::timestamptz, ${json(e.data)}::jsonb from o
      ), p as (
        insert into payments (id, order_id, provider, intent_id, idempotency_key, amount_cents, currency, status)
        select ${p.id}, id, ${p.provider}, ${p.intentId}, ${p.idempotencyKey}, ${p.amountCents}::int, ${p.currency}, ${p.status} from o
      )
      select id from o`);
    const created = rows<{ id: string }>(res);
    if (created.length === 1) return { created: true, id: i.id };
    const [existing] = await this.db
      .select({ id: t.orders.id })
      .from(t.orders)
      .where(and(eq(t.orders.customerId, v.customerId), eq(t.orders.idempotencyKey, i.idempotencyKey)));
    return { created: false, id: existing!.id };
  }

  async getOrder(id: string): Promise<OrderRecord | null> {
    const [r] = await this.db.select().from(t.orders).where(eq(t.orders.id, id));
    return r ? { id: r.id, view: toView(r) } : null;
  }
  async listOrders(filter?: { active?: boolean; states?: string[] }) {
    const conds = [];
    if (filter?.active) conds.push(notInArray(t.orders.state, ["completed", "cancelled"]));
    if (filter?.states) conds.push(inArray(t.orders.state, filter.states));
    const r = await this.db.select().from(t.orders).where(and(...conds)).orderBy(asc(t.orders.placedAt), asc(t.orders.id));
    return r.map((o) => ({ id: o.id, view: toView(o) }));
  }

  async appendEvent(orderId: string, expectedVersion: number, event: OrderEvent, next: OrderView) {
    const res = await this.db.execute(sql`
      with u as (
        update orders set state = ${next.state}, version = ${next.version}, dropoff_lat = ${next.dropoff.lat},
          dropoff_lng = ${next.dropoff.lng}, dropoff_label = ${next.dropoff.label}, note = ${next.note},
          driver_id = ${next.driverId}, declined_by = ${JSON.stringify(next.declinedBy)}::jsonb,
          cancel = ${json(next.cancel)}::jsonb, updated_at = ${iso(next.updatedAt)}::timestamptz
        where id = ${orderId} and version = ${expectedVersion}
        returning id
      )
      insert into order_events (order_id, seq, type, actor, actor_id, at, data)
      select id, ${next.version}::int, ${event.type}, ${event.actor}, ${event.actorId ?? null}, ${iso(event.at)}::timestamptz, ${json(event.data)}::jsonb from u
      returning seq`);
    return rows(res).length === 1;
  }

  async listEvents(orderId: string): Promise<StoredEvent[]> {
    const r = await this.db.select().from(t.orderEvents).where(eq(t.orderEvents.orderId, orderId)).orderBy(asc(t.orderEvents.seq));
    return r.map((e) => ({
      seq: e.seq,
      event: { type: e.type, actor: e.actor, actorId: e.actorId ?? undefined, at: e.at.getTime(), data: e.data ?? undefined } as OrderEvent,
    }));
  }

  async recordLocationIfDue(p: LocationPoint, intervalMs: number) {
    const res = await this.db.execute(sql`
      with u as (
        update drivers set lat = ${p.lat}, lng = ${p.lng}, location_at = ${iso(p.t)}::timestamptz
        where id = ${p.driverId}
          and (location_at is null or location_at <= ${iso(p.t)}::timestamptz - make_interval(secs => ${intervalMs / 1000}))
        returning id
      )
      insert into driver_locations (driver_id, order_id, lat, lng, recorded_at)
      select id, ${p.orderId}::text, ${p.lat}::numeric, ${p.lng}::numeric, ${iso(p.t)}::timestamptz from u
      returning id`);
    return rows(res).length === 1;
  }
  async listLocations(f: { driverId?: string; orderId?: string }): Promise<LocationPoint[]> {
    const conds = [];
    if (f.driverId) conds.push(eq(t.driverLocations.driverId, f.driverId));
    if (f.orderId) conds.push(eq(t.driverLocations.orderId, f.orderId));
    const r = await this.db.select().from(t.driverLocations).where(and(...conds)).orderBy(asc(t.driverLocations.recordedAt), asc(t.driverLocations.id));
    return r.map((l) => ({ driverId: l.driverId, orderId: l.orderId, lat: l.lat, lng: l.lng, t: l.recordedAt.getTime() }));
  }

  async getPaymentByOrder(orderId: string) {
    const [r] = await this.db.select().from(t.payments).where(eq(t.payments.orderId, orderId));
    return r ? toPayment(r) : null;
  }
  async getPaymentByIntent(intentId: string) {
    const [r] = await this.db.select().from(t.payments).where(eq(t.payments.intentId, intentId));
    return r ? toPayment(r) : null;
  }
  async recordCharge(i: { intentId: string; amountCents: number; eventId: string; at: number }) {
    const res = await this.db.execute(sql`
      with u as (
        update payments set status = 'succeeded', updated_at = now()
        where intent_id = ${i.intentId} and status = 'requires_payment' and amount_cents = ${i.amountCents}
        returning id, amount_cents
      )
      insert into payment_charges (payment_id, amount_cents, event_id, charged_at)
      select id, amount_cents, ${i.eventId}, ${iso(i.at)}::timestamptz from u
      returning payment_id`);
    return rows(res).length === 1;
  }
  async setPaymentStatus(intentId: string, to: PaymentStatus, from: PaymentStatus) {
    const res = await this.db.execute(
      sql`update payments set status = ${to}, updated_at = now() where intent_id = ${intentId} and status = ${from} returning id`,
    );
    return rows(res).length === 1;
  }
  async markRefunded(i: { paymentId: string; refundId: string; refundedCents: number }) {
    const res = await this.db.execute(sql`
      update payments set status = 'refunded', refund_id = ${i.refundId}, refunded_cents = ${i.refundedCents}, updated_at = now()
      where id = ${i.paymentId} and status = 'succeeded' returning id`);
    return rows(res).length === 1;
  }
  async countCharges(paymentId?: string) {
    const res = await this.db.execute(
      paymentId ? sql`select count(*)::int as n from payment_charges where payment_id = ${paymentId}` : sql`select count(*)::int as n from payment_charges`,
    );
    return rows<{ n: number }>(res)[0]!.n;
  }
  async recordWebhookEvent(eventId: string, type: string, at: number) {
    const res = await this.db.execute(
      sql`insert into payment_webhook_events (event_id, type, received_at) values (${eventId}, ${type}, ${iso(at)}::timestamptz) on conflict do nothing returning event_id`,
    );
    return rows(res).length === 1;
  }
  async countWebhookEvents() {
    return rows<{ n: number }>(await this.db.execute(sql`select count(*)::int as n from payment_webhook_events`))[0]!.n;
  }
}
