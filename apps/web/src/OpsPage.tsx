import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ApiError, api, money, STATE_LABEL, type OrderRow } from "./api";
import { authClient } from "./auth-client";
import { clock, useLivePositions } from "./hooks";
import { LiveMap, type Pin } from "./LiveMap";
import { MapLegend, MapSummary } from "./MapLegend";

const LIVE_STATES = new Set(["assigned", "en_route", "arrived", "delivering"]);

export function OpsPage() {
  const me = useQuery({ queryKey: ["ops-me"], queryFn: api.me, retry: false });
  if (me.isPending) return <p className="meta">Checking sign-in…</p>;
  if (me.error) {
    const signedOut = me.error instanceof ApiError && me.error.status === 401;
    return (
      <div className="stack">
        <h1>Operations</h1>
        <p>{signedOut ? "The operations console is restricted to allow-listed GitHub accounts." : "Could not check your sign-in."}</p>
        <button className="primary" onClick={() => void authClient.signIn.social({ provider: "github", callbackURL: "/ops" })}>
          Sign in with GitHub
        </button>
      </div>
    );
  }
  return <OpsConsole login={me.data.login} />;
}

function OpsConsole({ login }: { login: string }) {
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const orders = useQuery({ queryKey: ["ops-orders", showAll], queryFn: () => api.orders(!showAll), refetchInterval: 5000 });
  const drivers = useQuery({ queryKey: ["drivers"], queryFn: api.drivers, refetchInterval: 5000 });
  const stations = useQuery({ queryKey: ["stations"], queryFn: api.stations });
  const detail = useQuery({ queryKey: ["order", selected], queryFn: () => api.order(selected!), enabled: !!selected, refetchInterval: 5000 });

  const rows = orders.data ?? [];
  const activeRows = rows.filter((o) => LIVE_STATES.has(o.state) && o.driverId);
  const live = useLivePositions(activeRows.map((o) => o.id));
  const liveByDriver = new Map(Object.values(live).map((p) => [p.driverId, p]));
  // Road routes for deliveries that ran the demo (null for the rest). Fetched once each; they never change.
  const routeQs = useQueries({ queries: activeRows.map((o) => ({ queryKey: ["route", o.id], queryFn: () => api.route(o.id), staleTime: Infinity })) });
  const routeByDriver = new Map<string, { lat: number; lng: number }[]>();
  activeRows.forEach((o, i) => {
    const pts = routeQs[i]?.data?.route?.points;
    if (o.driverId && pts) routeByDriver.set(o.driverId, pts.map(([lat, lng]) => ({ lat, lng })));
  });

  const counts = useMemo(() => {
    const d = drivers.data ?? [];
    return {
      active: rows.filter((o) => o.state !== "completed" && o.state !== "cancelled").length,
      available: d.filter((x) => x.status === "available").length,
      busy: d.filter((x) => x.status === "busy").length,
      offline: d.filter((x) => x.status === "offline").length,
    };
  }, [rows, drivers.data]);

  const pins = useMemo<Pin[]>(() => {
    const out: Pin[] = (stations.data ?? []).map((s) => ({ id: `st-${s.id}`, kind: "station", lat: s.lat, lng: s.lng, label: s.name }));
    for (const d of drivers.data ?? []) {
      if (d.status === "offline") continue;
      const p = liveByDriver.get(d.id);
      out.push({ id: `dr-${d.id}`, kind: d.status === "busy" ? "driver" : "driver-idle", lat: p?.lat ?? d.lat, lng: p?.lng ?? d.lng, label: `${d.name} (${d.status})`, route: routeByDriver.get(d.id) ?? null });
    }
    for (const o of rows) if (o.state !== "completed" && o.state !== "cancelled") out.push({ id: `or-${o.id}`, kind: "dropoff", lat: o.dropoff.lat, lng: o.dropoff.lng, label: `${o.id.slice(-6)}: ${o.dropoff.label}`, selected: o.id === selected });
    return out;
  }, [stations.data, drivers.data, rows, selected, live, routeQs.map((q) => q.dataUpdatedAt).join(",")]);

  return (
    <div className="stack wide">
      <h1>Operations</h1>
      <p className="meta">Signed in as {login}</p>
      <dl className="kpis" aria-label="Summary">
        <div><dt>Active orders</dt><dd data-testid="kpi-active">{counts.active}</dd></div>
        <div><dt>Drivers available</dt><dd>{counts.available}</dd></div>
        <div><dt>Drivers busy</dt><dd>{counts.busy}</dd></div>
        <div><dt>Drivers offline</dt><dd>{counts.offline}</dd></div>
      </dl>

      <LiveMap pins={pins} label="Map of active orders, stations and drivers" fitKey="ops" />
      <MapLegend
        items={[
          { kind: "station", label: "Station" },
          { kind: "dropoff", label: "Drop-off of an active order" },
          { kind: "driver", label: "Driver on a delivery (arrow shows heading)" },
          { kind: "driver-idle", label: "Driver waiting for a job" },
          { line: "route", label: "Road still to drive" },
        ]}
      />
      <MapSummary
        label="Map in words"
        items={[
          { role: "Stations", text: `${stations.data?.length ?? 0}` },
          { role: "Active orders (drop-offs)", text: `${counts.active}` },
          { role: "Drivers on a delivery", text: `${counts.busy}` },
          { role: "Drivers waiting", text: `${counts.available}` },
        ]}
      />

      <div className="row">
        <label className="check">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Include finished orders
        </label>
      </div>

      <div className="scroll" tabIndex={0} role="region" aria-label="Orders table">
        <table>
          <caption className="sr-only">Orders</caption>
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">State</th>
              <th scope="col">Station</th>
              <th scope="col">Driver</th>
              <th scope="col">Total</th>
              <th scope="col">Placed</th>
              <th scope="col">Log</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7}>No orders yet.</td></tr>
            )}
            {rows.map((o: OrderRow) => (
              <tr key={o.id} className={o.id === selected ? "selected" : ""}>
                <th scope="row">{o.id.slice(-8)}</th>
                <td><span className={`badge s-${o.state}`}>{STATE_LABEL[o.state]}</span></td>
                <td>{stations.data?.find((s) => s.id === o.stationId)?.name ?? o.stationId}</td>
                <td>{o.driverId ?? "none"}</td>
                <td>{money(o.totalCents)}</td>
                <td>{clock(o.placedAt)}</td>
                <td>
                  <button aria-pressed={o.id === selected} onClick={() => setSelected(o.id === selected ? null : o.id)}>
                    {o.id === selected ? "Hide" : "Show"}<span className="sr-only"> event log for order {o.id.slice(-8)}</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && detail.data && (
        <section className="panel" aria-labelledby="evlog">
          <h2 id="evlog">Event log: {detail.data.id.slice(-8)}</h2>
          <p className="meta">Append-only. Payment {detail.data.payment?.status.replaceAll("_", " ")}. Each row is one order_events record.</p>
          <div className="scroll" tabIndex={0} role="region" aria-label="Event log table">
            <table>
              <thead>
                <tr><th scope="col">#</th><th scope="col">Time</th><th scope="col">Event</th><th scope="col">Actor</th><th scope="col">Data</th></tr>
              </thead>
              <tbody>
                {detail.data.events.map((e) => (
                  <tr key={e.seq}>
                    <td>{e.seq}</td>
                    <td>{clock(e.at)}</td>
                    <td><code>{e.type}</code></td>
                    <td>{e.actor}{e.actorId ? ` (${e.actorId})` : ""}</td>
                    <td><code>{e.data ? JSON.stringify(e.data) : ""}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
