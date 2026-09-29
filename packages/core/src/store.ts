import type { Fuel, OrderEvent, OrderView } from "./order-machine";

export type DriverStatus = "offline" | "available" | "busy";

export type Customer = { id: string; name: string; isSimulated?: boolean };
export type Station = { id: string; name: string; lat: number; lng: number; rating: number; prices: Record<Fuel, number> };
export type Driver = { id: string; name: string; status: DriverStatus; lat: number; lng: number; locationAt: number | null; isSimulated?: boolean };
export type OrderRecord = { id: string; view: OrderView; isSimulated: boolean };
export type StoredEvent = { seq: number; event: OrderEvent };

export type PaymentStatus = "requires_payment" | "succeeded" | "failed" | "canceled" | "refunded";
export type Payment = {
  id: string;
  orderId: string;
  provider: string;
  intentId: string;
  idempotencyKey: string;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  refundId: string | null;
  refundedCents: number;
};

export type LocationPoint = { driverId: string; orderId: string | null; lat: number; lng: number; t: number };

/**
 * Persistence seam. Implemented on Drizzle (Neon HTTP in production, PGlite in dev and tests).
 * Every mutating method is a single statement so it works on the Neon HTTP driver, which has no
 * interactive transactions; "guarded" methods return false when their precondition no longer holds.
 */
export interface Store {
  upsertCustomer(c: Customer): Promise<void>;
  getCustomer(id: string): Promise<Customer | null>;
  upsertStation(s: Station): Promise<void>;
  getStation(id: string): Promise<Station | null>;
  listStations(): Promise<Station[]>;

  upsertDriver(d: Driver): Promise<void>;
  getDriver(id: string): Promise<Driver | null>;
  listDrivers(filter?: { status?: DriverStatus }): Promise<Driver[]>;
  /** Move a driver from `from` to `to` only if currently `from`. This is the claim that prevents double-booking. */
  setDriverStatus(id: string, to: DriverStatus, from?: DriverStatus): Promise<boolean>;

  /**
   * Create order, first event and payment together. Returns created=false with the existing id when
   * (customerId, idempotencyKey) was already used.
   */
  insertOrder(i: {
    id: string;
    idempotencyKey: string;
    isSimulated?: boolean;
    view: OrderView;
    event: OrderEvent;
    payment: Payment;
  }): Promise<{ created: boolean; id: string }>;
  getOrder(id: string): Promise<OrderRecord | null>;
  listOrders(filter?: { active?: boolean; states?: string[] }): Promise<OrderRecord[]>;
  /** Append event `expectedVersion + 1` and update the projection, only if the order is still at `expectedVersion`. */
  appendEvent(orderId: string, expectedVersion: number, event: OrderEvent, next: OrderView): Promise<boolean>;
  listEvents(orderId: string): Promise<StoredEvent[]>;

  /** Downsampling gate: writes only if the driver has no stored point within `intervalMs` before `p.t`. */
  recordLocationIfDue(p: LocationPoint, intervalMs: number): Promise<boolean>;
  listLocations(f: { driverId?: string; orderId?: string }): Promise<LocationPoint[]>;

  getPaymentByOrder(orderId: string): Promise<Payment | null>;
  getPaymentByIntent(intentId: string): Promise<Payment | null>;
  /** requires_payment -> succeeded plus one ledger charge, atomically. False if already charged or not payable. */
  recordCharge(i: { intentId: string; amountCents: number; eventId: string; at: number }): Promise<boolean>;
  setPaymentStatus(intentId: string, to: PaymentStatus, from: PaymentStatus): Promise<boolean>;
  markRefunded(i: { paymentId: string; refundId: string; refundedCents: number }): Promise<boolean>;
  countCharges(paymentId?: string): Promise<number>;
  /** Retention: delete driver_locations older than `beforeMs`. Returns rows deleted. */
  deleteLocationsBefore(beforeMs: number): Promise<number>;
  /** Cleanup: delete finished simulated orders (and their events, payments, points) last updated before `beforeMs`. */
  deleteSimulatedOrders(beforeMs: number): Promise<number>;
  recordWebhookEvent(eventId: string, type: string, at: number): Promise<boolean>;
  countWebhookEvents(): Promise<number>;
}
