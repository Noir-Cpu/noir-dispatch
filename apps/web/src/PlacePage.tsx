import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, money, rand, type Fuel } from "./api";
import { useCustomerId } from "./hooks";
import { LiveMap, type Pin } from "./LiveMap";

// Approximate points around Cape Town for keyboard-friendly selection; the map click sets a custom one.
const SAMPLES = [
  { label: "Newlands, Main Road", lat: -33.972, lng: 18.459 },
  { label: "Woodstock, Albert Road", lat: -33.9273, lng: 18.453 },
  { label: "Camps Bay, Victoria Road", lat: -33.9505, lng: 18.3778 },
  { label: "Table View, Marine Drive", lat: -33.824, lng: 18.489 },
  { label: "Constantia, Spaanschemat River Road", lat: -34.024, lng: 18.423 },
];

export function PlacePage() {
  const nav = useNavigate();
  const customerId = useCustomerId();
  const stations = useQuery({ queryKey: ["stations"], queryFn: api.stations });
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

  const place = useMutation({
    mutationFn: () =>
      api.place({ customerId, customerName: "Web customer", stationId, fuel, litres, dropoff, note: note || undefined }, key.current),
    onSuccess: (o) => nav(`/order/${o.id}`),
  });

  const pins = useMemo<Pin[]>(
    () => [
      ...(stations.data ?? []).map((s) => ({ id: s.id, kind: "station" as const, lat: s.lat, lng: s.lng, label: s.name, selected: s.id === stationId })),
      { id: "dropoff", kind: "dropoff", lat: dropoff.lat, lng: dropoff.lng, label: `Drop-off: ${dropoff.label}` },
    ],
    [stations.data, stationId, dropoff.lat, dropoff.lng, dropoff.label],
  );

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
          {stations.data?.map((s) => (
            <label key={s.id} className="choice">
              <input type="radio" name="station" value={s.id} checked={s.id === stationId} onChange={() => setStationId(s.id)} />
              <span>
                <strong>{s.name}</strong>
                <span className="meta"> rating {s.rating.toFixed(1)} · {money(s.prices[fuel])}/L {fuel === "diesel" ? "diesel" : "petrol 95"}</span>
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
          <span className="hint">Or tap the map to drop a pin.</span>
        </label>

        <LiveMap pins={pins} label="Map of stations and your drop-off point" onPick={(lat, lng) => setCustom({ lat, lng })} />

        <label className="field">
          <span>Note for the driver (optional)</span>
          <input type="text" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>

        <p className="total" aria-live="polite">
          Total <strong>{money(total)}</strong> <span className="meta">({litres} L)</span>
        </p>
        {place.error && <p role="alert" className="error">{(place.error as Error).message}</p>}
        <button className="primary" type="submit" disabled={!station || place.isPending || !(litres > 0)}>
          {place.isPending ? "Placing…" : "Place order"}
        </button>
      </form>
    </div>
  );
}
