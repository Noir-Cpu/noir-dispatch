export type Fuel = "diesel" | "petrol_95";
export type Actor = "customer" | "station" | "driver" | "system";
export type OrderState = "placed" | "accepted" | "assigned" | "en_route" | "arrived" | "delivering" | "completed" | "cancelled";

export type Station = { id: string; name: string; lat: number; lng: number; rating: number; prices: Record<Fuel, number> };
export type Driver = { id: string; name: string; status: "offline" | "available" | "busy"; lat: number; lng: number };
export type EventDto = { seq: number; type: string; actor: Actor; actorId: string | null; at: number; data: unknown };
export type OrderDto = {
  id: string;
  state: OrderState;
  stationId: string;
  customerId: string;
  driverId: string | null;
  fuel: Fuel;
  litres: number;
  totalCents: number;
  dropoff: { lat: number; lng: number; label: string };
  note: string | null;
  cancel: { by: Actor; reason: string | null; feeApplies: boolean } | null;
  placedAt: number;
  updatedAt: number;
  payment: { status: string; amountCents: number; refundedCents: number } | null;
  events: EventDto[];
  actions: Record<string, string[]>;
};
export type OrderRow = Omit<OrderDto, "events" | "actions" | "payment">;
export type TrackMessage =
  | { type: "snapshot"; last: TrackPoint | null; status: string | null; track: TrackPoint[] }
  | { type: "position"; point: TrackPoint }
  | { type: "status"; status: string };
export type AppConfig = { deliveryRadiusKm: number; demo: { available: boolean; speed: number } };
export type RouteDto = { route: { points: [number, number][]; source: "osrm" | "straight"; distanceM: number; durationS: number } | null; demo: { startedAt: number; speed: number } | null };
export type DemoStep = {
  state: OrderState;
  done: boolean;
  preparing: boolean;
  speed: number;
  progress: number;
  etaRealS: number | null;
  routeSource: "osrm" | "straight" | null;
  driverId: string | null;
};
export type TrackPoint = { orderId: string; driverId: string; lat: number; lng: number; t: number };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((body as { message?: string; error?: string }).message ?? (body as { error?: string }).error ?? `HTTP ${res.status}`, res.status, (body as { error?: string }).error);
  return body as T;
}

export class ApiError extends Error {
  constructor(message: string, readonly status = 0, /** Machine-readable code from the server, e.g. "out_of_radius", "daily_cap". */ readonly code?: string) {
    super(message);
  }
}

const tokenKey = (id: string) => `dispatch.token.${id}`;
function saveToken(id: string, token: string) {
  try {
    localStorage.setItem(tokenKey(id), token);
  } catch {
    /* private mode: the order still works for this page load only if the token is kept in memory */
    memoryTokens.set(id, token);
  }
}
const memoryTokens = new Map<string, string>();
function tokenHeader(id: string): Record<string, string> {
  let t: string | null | undefined = memoryTokens.get(id);
  try {
    t = localStorage.getItem(tokenKey(id)) ?? t;
  } catch {
    /* ignore */
  }
  return t ? { "x-order-token": t } : {};
}

export const api = {
  stations: () => call<{ stations: Station[] }>("/stations").then((r) => r.stations),
  drivers: () => call<{ drivers: Driver[] }>("/drivers").then((r) => r.drivers),
  orders: (active = true) => call<{ orders: OrderRow[] }>(`/orders${active ? "?active=1" : ""}`).then((r) => r.orders),
  order: (id: string) => call<{ order: OrderDto }>(`/orders/${id}`).then((r) => r.order),
  place: async (body: unknown, key: string) => {
    const r = await call<{ order: OrderDto; orderToken: string | null }>("/orders", { method: "POST", body: JSON.stringify(body), headers: { "idempotency-key": key } });
    if (r.orderToken) saveToken(r.order.id, r.orderToken);
    return r.order;
  },
  // The order token is what proves this browser placed the order. Anonymous customers, no accounts.
  event: (id: string, body: unknown) =>
    call<{ order: OrderDto }>(`/orders/${id}/events`, { method: "POST", body: JSON.stringify(body), headers: tokenHeader(id) }).then((r) => r.order),
  pay: (id: string) => call<unknown>(`/dev/pay/${id}`, { method: "POST", headers: tokenHeader(id) }),
  config: () => call<AppConfig>("/config"),
  route: (id: string) => call<RouteDto>(`/orders/${id}/route`),
  demoStep: (id: string, signal?: AbortSignal) => call<DemoStep>(`/orders/${id}/demo/step`, { method: "POST", headers: tokenHeader(id), signal }),
  me: () => call<{ login: string }>("/ops/me"),
};

export const rand = (bytes = 8) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

export const money = (cents: number) => `R${(cents / 100).toFixed(2)}`;

export const STATE_LABEL: Record<OrderState, string> = {
  placed: "Order placed",
  accepted: "Station accepted",
  assigned: "Driver assigned",
  en_route: "Driver on the way",
  arrived: "Driver has arrived",
  delivering: "Delivering",
  completed: "Delivered",
  cancelled: "Cancelled",
};

export function trackSocket(orderId: string, onMessage: (m: TrackMessage) => void) {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: number | undefined;
  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/orders/${orderId}/track`);
    ws.onmessage = (e) => onMessage(JSON.parse(e.data as string) as TrackMessage);
    ws.onclose = () => {
      if (!closed) retry = window.setTimeout(open, 2000);
    };
  };
  open();
  return () => {
    closed = true;
    window.clearTimeout(retry);
    ws?.close();
  };
}
