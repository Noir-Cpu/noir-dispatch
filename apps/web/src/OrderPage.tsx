import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api, money, STATE_LABEL, trackSocket, type OrderDto, type OrderState, type TrackPoint } from "./api";
import { clock, haversine, km } from "./hooks";
import { LiveMap, type Pin } from "./LiveMap";

const STEPS: OrderState[] = ["placed", "accepted", "assigned", "en_route", "arrived", "delivering", "completed"];
const TERMINAL = new Set<OrderState>(["completed", "cancelled"]);

function describeEvent(e: OrderDto["events"][number]) {
  const d = e.data as { reason?: string; driverId?: string; note?: string } | null;
  const base: Record<string, string> = {
    order_placed: "Order placed",
    station_accepted: "Station accepted the order",
    driver_assigned: `Driver ${d?.driverId ?? ""} assigned`,
    driver_declined: "Driver declined; finding another",
    driver_unassigned: "Driver removed from the job; finding another",
    driver_departed: "Driver set off",
    driver_arrived: "Driver arrived",
    delivery_started: "Delivery started",
    delivery_completed: "Delivery completed",
    order_cancelled: `Cancelled by ${e.actor}${d?.reason ? ` (${d.reason.replaceAll("_", " ")})` : ""}`,
    order_modified: "Order details changed",
  };
  return base[e.type] ?? e.type;
}

export function OrderPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const order = useQuery({
    queryKey: ["order", id],
    queryFn: () => api.order(id),
    refetchInterval: (q) => (q.state.data && TERMINAL.has(q.state.data.state) ? false : 3000),
  });
  const stations = useQuery({ queryKey: ["stations"], queryFn: api.stations });
  const [live, setLive] = useState<TrackPoint | null>(null);

  const o = order.data;
  const watching = !!o && !TERMINAL.has(o.state) && ["assigned", "en_route", "arrived", "delivering"].includes(o.state);
  useEffect(() => {
    if (!watching) return;
    return trackSocket(id, (m) => {
      if (m.type === "position") setLive(m.point);
      else if (m.type === "snapshot" && m.last) setLive(m.last);
      else if (m.type === "status") void qc.invalidateQueries({ queryKey: ["order", id] });
    });
  }, [watching, id, qc]);

  const act = useMutation({
    mutationFn: (body: unknown) => api.event(id, body),
    onSuccess: (next) => qc.setQueryData(["order", id], next),
  });
  const pay = useMutation({ mutationFn: () => api.pay(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["order", id] }) });
  const [note, setNote] = useState("");

  const station = stations.data?.find((s) => s.id === o?.stationId);
  const pins = useMemo<Pin[]>(() => {
    if (!o) return [];
    const out: Pin[] = [{ id: "dropoff", kind: "dropoff", lat: o.dropoff.lat, lng: o.dropoff.lng, label: `Drop-off: ${o.dropoff.label}` }];
    if (station) out.push({ id: "station", kind: "station", lat: station.lat, lng: station.lng, label: station.name });
    if (live && watching) out.push({ id: "driver", kind: "driver-busy", lat: live.lat, lng: live.lng, label: `Driver ${live.driverId}` });
    return out;
  }, [o, station, live, watching]);

  if (order.isPending) return <p className="meta">Loading order…</p>;
  if (!o) return <p role="alert" className="error">Order not found.</p>;

  const stepIndex = STEPS.indexOf(o.state);
  const distance = live && watching ? km(haversine(live, o.dropoff)) : null;
  const canCancel = o.actions.customer?.includes("order_cancelled");
  const canModify = o.actions.customer?.includes("order_modified");
  const needsPayment = o.payment?.status === "requires_payment" && o.state !== "cancelled";

  return (
    <div className="stack">
      <p className="meta">Order {o.id.slice(-8)}</p>
      <h1 aria-live="polite">{STATE_LABEL[o.state]}</h1>

      {o.state === "cancelled" ? (
        <p>
          Cancelled by {o.cancel?.by}
          {o.cancel?.reason ? ` (${o.cancel.reason.replaceAll("_", " ")})` : ""}.
          {o.payment?.status === "refunded" && ` Refunded ${money(o.payment.refundedCents)}${o.cancel?.feeApplies ? " (cancellation fee kept)" : ""}.`}
        </p>
      ) : (
        <ol className="steps" aria-label="Progress">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === stepIndex ? "step" : undefined} className={i < stepIndex ? "done" : i === stepIndex ? "current" : ""}>
              {STATE_LABEL[s]}
            </li>
          ))}
        </ol>
      )}

      {watching && (
        <p className="live" aria-live="off">
          <span className="dot" aria-hidden="true" /> Live: driver {o.driverId}
          {distance ? `, ${distance} from you` : ", waiting for first position"}
        </p>
      )}

      <LiveMap pins={pins} label="Map of your delivery" fit />
      <p className="attribution-note meta">Simulated driver on a made-up route. Map data OpenStreetMap contributors.</p>

      <section className="panel" aria-labelledby="summary">
        <h2 id="summary">Summary</h2>
        <dl>
          <dt>Station</dt>
          <dd>{station?.name ?? o.stationId}</dd>
          <dt>Fuel</dt>
          <dd>{o.litres} L {o.fuel === "diesel" ? "diesel" : "petrol 95"}</dd>
          <dt>Drop-off</dt>
          <dd>{o.dropoff.label}</dd>
          <dt>Total</dt>
          <dd>{money(o.totalCents)}</dd>
          <dt>Payment</dt>
          <dd data-testid="payment-status">{o.payment?.status.replaceAll("_", " ")}</dd>
          {o.note && (
            <>
              <dt>Note</dt>
              <dd>{o.note}</dd>
            </>
          )}
        </dl>
        {needsPayment && (
          <div className="stack">
            <p>Test payment: this button plays the payment provider and sends a signed webhook. No card is charged.</p>
            <button className="primary" onClick={() => pay.mutate()} disabled={pay.isPending}>
              Pay {money(o.totalCents)} with test card
            </button>
          </div>
        )}
      </section>

      {(canCancel || canModify) && (
        <section className="panel stack" aria-labelledby="change">
          <h2 id="change">Change or cancel</h2>
          {canModify && (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                act.mutate({ actor: "customer", type: "order_modified", data: { note } }, { onSuccess: () => setNote("") });
              }}
            >
              <label className="field grow">
                <span>Note for the driver</span>
                <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
              </label>
              <button type="submit" disabled={!note || act.isPending}>Update note</button>
            </form>
          )}
          {canCancel && (
            <>
              {o.state === "en_route" && <p className="meta">The driver has set off, so a cancellation fee of R50.00 is kept.</p>}
              <button className="danger" onClick={() => act.mutate({ actor: "customer", type: "order_cancelled", data: { reason: "customer_request" } })} disabled={act.isPending}>
                Cancel order
              </button>
            </>
          )}
          {act.error && <p role="alert" className="error">{(act.error as Error).message}</p>}
        </section>
      )}

      <section className="panel" aria-labelledby="history">
        <h2 id="history">History</h2>
        <ol className="log">
          {o.events.map((e) => (
            <li key={e.seq}>
              <time className="meta">{clock(e.at)}</time> {describeEvent(e)}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
