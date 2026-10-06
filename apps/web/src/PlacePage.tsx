import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { rangeAdvice, stationRanges } from "@noir/core/delivery";
import { destinationPoint } from "@noir/core/polyline";
import { ApiError, api, money, rand, type Fuel } from "./api";
import { useCustomerId } from "./hooks";
import { LiveMap, type MapCircle, type Pin } from "./LiveMap";
import { MapLegend, MapSummary } from "./MapLegend";

// Approximate points for keyboard-friendly selection; tapping the map sets a custom one. The last is deliberately far from every
// station, so a visitor can see what happens outside the delivery radius.
const SAMPLES = [
  { label: "Newlands, Main Road", lat: -33.972, lng: 18.459 },
  { label: "Woodstock, Albert Road", lat: -33.9273, lng: 18.453 },
  { label: "Camps Bay, Victoria Road", lat: -33.9505, lng: 18.3778 },
  { label: "Table View, Marine Drive", lat: -33.824, lng: 18.489 },
  { label: "Constantia, Spaanschemat River Road", lat: -34.024, lng: 18.423 },
  { label: "Muizenberg, Main Road", lat: -34.105, lng: 18.469 },
  { label: "Mitchells Plain, Lentegeur Road", lat: -34.039, lng: 18.615 },
  { label: "Durbanville, Wellington Road", lat: -33.833, lng: 18.647 },
  { label: "Stellenbosch, Dorp Street", lat: -33.9355, lng: 18.858 },
  { label: "Somerset West, Main Road", lat: -34.082, lng: 18.85 },
  { label: "Paarl, Main Road", lat: -33.732, lng: 18.961 },
  { label: "Franschhoek, Huguenot Road", lat: -33.9136, lng: 19.121 },
];

export function PlacePage() {
  const nav = useNavigate();
  const customerId = useCustomerId();
  const stations = useQuery({ queryKey: ["stations"], queryFn: api.stations });
  const config = useQuery({ queryKey: ["config"], queryFn: api.config, staleTime: Infinity });
  const radiusKm = config.data?.deliveryRadiusKm ?? 12;
  const [stationId, setStationId] = useState("st-claremont");
  const [fuel, setFuel] = useState<Fuel>("diesel");
  const [litres, setLitres] = useState(40);
  const [sample, setSample] = useState(0);
  const [custom, setCustom] = useState<{ lat: number; lng: number } | null>(null);
  const [note, setNote] = useState("");
  const key = useRef(rand()); // one idempotency key per form: a double click or retry cannot place two orders

  const station = stations.data?.find((s) => s.id === stationId);
  const dropoff = custom ? { ...custom, label: "Custom point on map" } : SAMPLES[sample]!;
  const total = station ? Math.round(station.prices[fuel] * litres) : 0;

  // Which stations can reach this pin, nearest first, and what to tell the visitor when the chosen one cannot.
  const ranges = useMemo(() => stationRanges(stations.data ?? [], dropoff, radiusKm), [stations.data, dropoff.lat, dropoff.lng, radiusKm]);
  const advice = useMemo(() => (stations.data ? rangeAdvice(stations.data, stationId, dropoff, radiusKm) : null), [stations.data, stationId, dropoff.lat, dropoff.lng, radiusKm]);
  const outOfRange = !!advice && !advice.ok && !!advice.chosen;
  const suggestion = advice?.nearestInRange?.station;

  const place = useMutation({
    mutationFn: () =>
      api.place({ customerId, customerName: "Web customer", stationId, fuel, litres, dropoff, note: note || undefined }, key.current),
    onSuccess: (o) => nav(`/order/${o.id}`),
    // A different pin or station is a different order: it needs its own idempotency key.
    onError: (e) => {
      if ((e as ApiError).code === "out_of_radius") key.current = rand();
    },
  });

  const pins = useMemo<Pin[]>(
    () => [
      ...(stations.data ?? []).map((s) => ({ id: s.id, kind: "station" as const, lat: s.lat, lng: s.lng, label: s.name, selected: s.id === stationId })),
      { id: "dropoff", kind: "dropoff", lat: dropoff.lat, lng: dropoff.lng, label: `Drop-off: ${dropoff.label}` },
    ],
    [stations.data, stationId, dropoff.lat, dropoff.lng, dropoff.label],
  );
  const circles = useMemo<MapCircle[]>(
    () => (stations.data ?? []).map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, radiusKm, emphasis: s.id === stationId })),
    [stations.data, stationId, radiusKm],
  );
  // Fit the chosen station's whole circle and the pin; refit when the chosen station changes, not on every pin move.
  const fitTo = useMemo(
    () => (station ? [dropoff, ...[0, 90, 180, 270].map((b) => destinationPoint(station, b, radiusKm * 1000))] : [dropoff]),
    [station, dropoff.lat, dropoff.lng, radiusKm],
  );

  const serverMessage = place.error && !(place.error as ApiError).code?.startsWith("out_of_radius") ? (place.error as Error).message : null;
  // The server says the same thing as the form in the same words; show it if the form's own check was bypassed or the radius changed.
  const rejected = place.error && (place.error as ApiError).code === "out_of_radius" ? (place.error as Error).message : null;

  return (
    <div className="stack">
      <h1>Order fuel</h1>
      <p className="lede">Pick a station, say where to bring it, and watch the driver come to you. This is a simulation: no fuel moves and no money is charged.</p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          place.mutate();
        }}
      >
        <fieldset>
          <legend>Station</legend>
          {stations.isPending && <p className="meta">Loading stations…</p>}
          {ranges.map(({ station: s, distanceKm, inRange }) => (
            <label key={s.id} className={`choice${inRange ? "" : " out"}`}>
              <input type="radio" name="station" value={s.id} checked={s.id === stationId} disabled={!inRange && s.id !== stationId} onChange={() => setStationId(s.id)} />
              <span>
                <strong>{s.name}</strong>
                <span className="meta">
                  {" "}
                  {inRange ? `${distanceKm.toFixed(1)} km from your pin` : `out of range: ${distanceKm.toFixed(1)} km from your pin, limit ${radiusKm} km`} · rating {s.rating.toFixed(1)} ·{" "}
                  {money(s.prices[fuel])}/L {fuel === "diesel" ? "diesel" : "petrol 95"}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="row">
          <label className="field">
            <span>Fuel</span>
            <select value={fuel} onChange={(e) => setFuel(e.target.value as Fuel)}>
              <option value="diesel">Diesel</option>
              <option value="petrol_95">Petrol 95</option>
            </select>
          </label>
          <label className="field">
            <span>Litres</span>
            <input type="number" min={5} max={200} step={1} value={litres} onChange={(e) => setLitres(Number(e.target.value))} />
          </label>
        </div>

        <label className="field">
          <span>Drop-off</span>
          <select
            value={custom ? "custom" : String(sample)}
            onChange={(e) => {
              if (e.target.value !== "custom") {
                setCustom(null);
                setSample(Number(e.target.value));
              }
            }}
          >
            {custom && <option value="custom">Custom point on map</option>}
            {SAMPLES.map((s, i) => (
              <option key={s.label} value={i}>
                {s.label}
              </option>
            ))}
          </select>
          <span className="hint">Or tap the map to drop a pin. Franschhoek is outside every station&apos;s {radiusKm} km radius, if you want to see what that looks like.</span>
        </label>

        <LiveMap pins={pins} circles={circles} label="Map of stations, their delivery radius and your drop-off point" onPick={(lat, lng) => setCustom({ lat, lng })} fitTo={fitTo} fitKey={`${stationId}|${custom ? "c" : sample}|${stations.data?.length ?? 0}`} />
        <MapLegend
          items={[
            { kind: "station", label: "Station" },
            { kind: "dropoff", label: "Your drop-off" },
            { line: "radius", label: `Delivery radius, ${radiusKm} km in a straight line from the station` },
          ]}
        />
        <MapSummary
          items={[
            { role: "Drop-off", text: dropoff.label },
            { role: "Chosen station", text: advice?.chosen ? `${advice.chosen.station.name}, ${advice.chosen.distanceKm.toFixed(1)} km away, ${advice.chosen.inRange ? "inside" : "outside"} the ${radiusKm} km radius` : "none" },
            { role: "Stations that can deliver here", text: `${ranges.filter((r) => r.inRange).length} of ${ranges.length}` },
          ]}
        />

        {(outOfRange || rejected) && (
          <div className="notice" role="alert" data-testid="range-message">
            <p>{rejected ?? advice?.message}</p>
            {suggestion && suggestion.id !== stationId && (
              <button type="button" onClick={() => setStationId(suggestion.id)}>
                Use {suggestion.name}
              </button>
            )}
          </div>
        )}

        <label className="field">
          <span>Note for the driver (optional)</span>
          <input type="text" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>

        <p className="total" aria-live="polite">
          Total <strong>{money(total)}</strong> <span className="meta">({litres} L)</span>
        </p>
        {serverMessage && <p role="alert" className="error">{serverMessage}</p>}
        <button className="primary" type="submit" disabled={!station || place.isPending || !(litres > 0) || outOfRange}>
          {place.isPending ? "Placing…" : outOfRange ? "Choose a station in range" : "Place order"}
        </button>
      </form>
    </div>
  );
}
