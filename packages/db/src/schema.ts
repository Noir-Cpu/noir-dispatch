import { sql } from "drizzle-orm";
import { bigserial, boolean, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// lat/lng are plain numeric, not PostGIS geometry (ADR 0003): PGlite runs the same schema in tests.
const coord = (name: string) => numeric(name, { precision: 9, scale: 6, mode: "number" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  isSimulated: boolean("is_simulated").notNull().default(false),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export const stations = pgTable("stations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  lat: coord("lat").notNull(),
  lng: coord("lng").notNull(),
  rating: numeric("rating", { precision: 2, scale: 1, mode: "number" }).notNull(),
  /** Cents per litre by fuel type. */
  prices: jsonb("prices").$type<Record<string, number>>().notNull(),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export const drivers = pgTable(
  "drivers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    status: text("status").notNull().default("offline"),
    lat: coord("lat").notNull(),
    lng: coord("lng").notNull(),
    locationAt: ts("location_at"),
    isSimulated: boolean("is_simulated").notNull().default(false),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [index("drivers_status_idx").on(t.status)],
);

export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id").notNull().references(() => customers.id),
    stationId: text("station_id").notNull().references(() => stations.id),
    idempotencyKey: text("idempotency_key").notNull(),
    /** Placed by the simulator. Only these are ever deleted by the cleanup job. */
    isSimulated: boolean("is_simulated").notNull().default(false),
    // Projection of the event log. order_events is the source of truth; replay rebuilds these.
    state: text("state").notNull(),
    version: integer("version").notNull(),
    fuel: text("fuel").notNull(),
    litres: numeric("litres", { precision: 8, scale: 2, mode: "number" }).notNull(),
    totalCents: integer("total_cents").notNull(),
    dropoffLat: coord("dropoff_lat").notNull(),
    dropoffLng: coord("dropoff_lng").notNull(),
    dropoffLabel: text("dropoff_label").notNull(),
    note: text("note"),
    driverId: text("driver_id").references(() => drivers.id),
    declinedBy: jsonb("declined_by").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    cancel: jsonb("cancel").$type<{ by: string; reason: string | null; feeApplies: boolean } | null>(),
    placedAt: ts("placed_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [uniqueIndex("orders_customer_key_uq").on(t.customerId, t.idempotencyKey), index("orders_state_idx").on(t.state)],
);

export const orderEvents = pgTable(
  "order_events",
  {
    orderId: text("order_id").notNull().references(() => orders.id),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    actor: text("actor").notNull(),
    actorId: text("actor_id"),
    at: ts("at").notNull(),
    data: jsonb("data"),
  },
  // (order, seq) is the optimistic-concurrency guard: two writers cannot both append event N.
  (t) => [primaryKey({ columns: [t.orderId, t.seq] })],
);

export const driverLocations = pgTable(
  "driver_locations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    driverId: text("driver_id").notNull().references(() => drivers.id),
    orderId: text("order_id"),
    lat: coord("lat").notNull(),
    lng: coord("lng").notNull(),
    recordedAt: ts("recorded_at").notNull(),
  },
  (t) => [index("driver_locations_driver_time_idx").on(t.driverId, t.recordedAt), index("driver_locations_order_idx").on(t.orderId)],
);

export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => orders.id),
    provider: text("provider").notNull(),
    intentId: text("intent_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    status: text("status").notNull(),
    refundId: text("refund_id"),
    refundedCents: integer("refunded_cents").notNull().default(0),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("payments_order_uq").on(t.orderId),
    uniqueIndex("payments_intent_uq").on(t.intentId),
    uniqueIndex("payments_idem_uq").on(t.idempotencyKey),
  ],
);

/** At most one charge per payment, enforced by the primary key. */
export const paymentCharges = pgTable("payment_charges", {
  paymentId: text("payment_id").primaryKey().references(() => payments.id),
  amountCents: integer("amount_cents").notNull(),
  eventId: text("event_id").notNull(),
  chargedAt: ts("charged_at").notNull(),
});

export const paymentWebhookEvents = pgTable("payment_webhook_events", {
  eventId: text("event_id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: ts("received_at").notNull(),
});

// Better Auth tables (GitHub sign-in for the ops console only).
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: ts("created_at").defaultNow().notNull(),
  updatedAt: ts("updated_at").defaultNow().notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_userId_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [index("account_userId_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at").defaultNow().notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);
