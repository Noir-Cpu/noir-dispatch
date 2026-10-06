import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { distanceToGo } from "@noir/core/motion";
import { api, money, STATE_LABEL, trackSocket, type OrderDto, type OrderState, type TrackPoint } from "./api";
import { useDemo } from "./demo";
import { clock, km } from "./hooks";
import { LiveMap, type MapLine, type Pin } from "./LazyMap";
import { MapLegend, MapSummary, type LegendItem } from "./MapLegend";

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
  const lastState = useRef<OrderState | null>(null);
  // While the demo runs, its steps report state changes, so the 3 s order poll is switched off (less to fetch, less database time).
  const demo = useDemo(id, (s) => {
    if (s.state !== lastState.current) void qc.invalidateQueries({ queryKey: ["order", id] });
    if (s.routeSource) void qc.invalidateQueries({ queryKey: ["route", id] });
  });
  const order = useQuery({
    queryKey: ["order", id],
    queryFn: () => api.order(id),
    refetchInterval: (q) => (q.state.data && TERMINAL.has(q.state.data.state) ? false : demo.running ? false : 3000),
  });
  const stations = useQuery({ queryKey: ["stations"], queryFn: api.stations });
  const config = useQuery({ queryKey: ["config"], queryFn: api.config, staleTime: Infinity });
  const [live, setLive] = useState<TrackPoint | null>(null);

  const o = order.data;
  lastState.current = o?.state ?? null;
  const watching = !!o && !TERMINAL.has(o.state) && ["assigned", "en_route", "arrived", "delivering"].includes(o.state);
  // The road route exists only for orders that ran the demo. Fetched once (it never changes) and again when a step reports it.
  const routeQ = useQuery({ queryKey: ["route", id], queryFn: () => api.route(id), enabled: !!o && (watching || demo.status !== "idle"), staleTime: Infinity });
  const route = useMemo(() => routeQ.data?.route?.points.map(([lat, lng]) => ({ lat, lng })) ?? null, [routeQ.data]);
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
  const driverLive = live && watching ? live : null;
  const pins = useMemo<Pin[]>(() => {
    if (!o) return [];
    const out: Pin[] = [{ id: "dropoff", kind: "dropoff", lat: o.dropoff.lat, lng: o.dropoff.lng, label: `Drop-off: ${o.dropoff.label}` }];
    if (station) out.push({ id: "station", kind: "station", lat: station.lat, lng: station.lng, label: `Station: ${station.name}` });
    if (driverLive) out.push({ id: "driver", kind: "driver", lat: driverLive.lat, lng: driverLive.lng, label: `Driver ${driverLive.driverId}`, route });
    return out;
  }, [o, station, driverLive, route]);

  const lines = useMemo<MapLine[]>(() => {
    if (!o || TERMINAL.has(o.state)) return [];
    if (route) return [{ id: "route", kind: "route", points: route }];
    // No road data (simulator orders, or the routing service was unavailable): say so on the map with a dashed straight line.
    const from = driverLive ?? station;
    return from ? [{ id: "straight", kind: "straight", points: [from, o.dropoff] }] : [];
  }, [o, route, driverLive, station]);

  const fitTo = useMemo(() => [...(station ? [station] : []), ...(o ? [o.dropoff] : []), ...(driverLive ? [driverLive] : [])], [station, o, driverLive]);

  // Polite announcements for screen readers, only when something changes that matters: the state, and the driver coming within 2 km, 1 km and 500 m.
  // (The "Live: driver ..." line updates every few seconds and is deliberately not a live region.)
  const [announce, setAnnounce] = useState("");
  const said = useRef(new Set<number>());
  useEffect(() => {
    if (o) setAnnounce(STATE_LABEL[o.state]);
    said.current.clear();
  }, [o?.state]);
  const toGo = driverLive && o ? distanceToGo(route, driverLive, o.dropoff) : null;
  useEffect(() => {
    if (toGo === null) return;
    for (const t of [500, 1000, 2000]) {
      if (toGo <= t && !said.current.has(t)) {
        said.current.add(t);
        setAnnounce(`The driver is within ${km(t)} of your drop-off.`);
        break;
      }
    }
  }, [toGo]);

  if (order.isPending) return <p className="meta">Loading order…</p>;
  if (!o) return <p role="alert" className="error">Order not found.</p>;

  const legend: LegendItem[] = [
    { kind: "station", label: "Station" },
    { kind: "dropoff", label: "Your drop-off" },
    ...(driverLive ? ([{ kind: "driver", label: "Driver (arrow shows heading)" }] as LegendItem[]) : []),
    ...(lines.length ? ([route ? { line: "route", label: routeQ.data?.route?.source === "osrm" ? "Road route" : "Straight-line route (road routing unavailable)" } : { line: "straight", label: "Straight line (no road data)" }] as LegendItem[]) : []),
  ];
  const stepIndex = STEPS.indexOf(o.state);
  const distance = driverLive ? km(distanceToGo(route, driverLive, o.dropoff)) : null;
  const canCancel = o.actions.customer?.includes("order_cancelled");
  const canModify = o.actions.customer?.includes("order_modified");
  const needsPayment = o.payment?.status === "requires_payment" && o.state !== "cancelled";

  return (
    <div className="stack">
      <p className="meta">Order {o.id.slice(-8)}</p>
      <h1>{STATE_LABEL[o.state]}</h1>
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>

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
          {distance ? `, ${distance} from you${route ? " by road" : ""}` : ", waiting for first position"}
        </p>
      )}

      <LiveMap pins={pins} lines={lines} label="Map of your delivery" fitTo={fitTo} fitKey={`d${driverLive ? 1 : 0}`} />
      <MapLegend items={legend} />
      <MapSummary
        items={[
          { role: "Driver", text: driverLive ? `${distance} from the drop-off${route ? " by road" : " in a straight line"}` : watching ? "waiting for the first position" : o.state === "completed" ? "delivered" : "not on the way yet" },
          { role: "Station", text: station?.name ?? o.stationId },
          { role: "Drop-off", text: o.dropoff.label },
        ]}
      />
      <p className="attribution-note meta">Simulated driver, no real fuel. {route ? (routeQ.data?.route?.source === "osrm" ? "Road route from OpenStreetMap's public routing demo server (OSRM)." : "Straight line: road routing was unavailable for this order.") : "No road data for this order: the driver moves in a straight line."} Map data OpenStreetMap contributors.</p>

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

      {o.payment?.status === "succeeded" && !TERMINAL.has(o.state) && config.data?.demo.available && (
        <section className="panel stack" aria-labelledby="demo">
          <h2 id="demo">Run demo</h2>
          <p>
            No real driver is coming, so this plays the station and a simulated driver for you. It only runs while this tab is open and visible, and it stops by
            itself when the delivery finishes.
          </p>
          <div className="row">
            {demo.running ? (
              <button type="button" onClick={demo.stop}>Pause demo</button>
            ) : (
              <button type="button" className="primary" onClick={demo.start}>Run demo</button>
            )}
          </div>
          <p className="meta" data-testid="demo-speed">
            Demo speed: {config.data.demo.speed}x. One real second is {config.data.demo.speed} simulated seconds, so a trip the router puts at 10 minutes takes about {Math.round((10 * 60) / config.data.demo.speed)} s here.
            {demo.last?.routeSource ? ` Route: ${demo.last.routeSource === "osrm" ? "road route (OpenStreetMap routing demo server)" : "straight line (road routing unavailable)"}.` : ""}
          </p>
          {demo.last && demo.running && (
            <>
              <label className="meter">
                <span className="meta">Demo progress</span>
                <progress max={1} value={demo.last.progress} />
              </label>
              {demo.last.etaRealS !== null && <p className="meta">Driver arrives in about {Math.max(1, Math.round(demo.last.etaRealS))} s at demo speed.</p>}
              {demo.last.preparing && <p className="meta">Looking up the road route…</p>}
            </>
          )}
          <p role="status" aria-live="polite" className="meta">{demo.message}</p>
        </section>
      )}

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
