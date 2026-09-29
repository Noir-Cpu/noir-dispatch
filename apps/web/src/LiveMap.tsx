import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";

export type Pin = { id: string; kind: "station" | "dropoff" | "driver" | "driver-busy"; lat: number; lng: number; label: string; selected?: boolean };

const ICON_SIZE: Record<Pin["kind"], number> = { station: 16, dropoff: 16, driver: 14, "driver-busy": 14 };

function icon(p: Pin) {
  const s = ICON_SIZE[p.kind];
  return L.divIcon({ className: `pin pin-${p.kind}${p.selected ? " pin-selected" : ""}`, html: "<span></span>", iconSize: [s, s], iconAnchor: [s / 2, s / 2] });
}

/**
 * Leaflet map on OpenStreetMap tiles. The map is a visual aid only: everything it shows is also in text
 * on the page, so it is not the sole way to get the information (keyboard and screen reader users).
 */
export function LiveMap({ pins, label, fit = true, onPick }: { pins: Pin[]; label: string; fit?: boolean; onPick?: (lat: number, lng: number) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef(new Map<string, L.Marker>());
  const fitted = useRef(false);
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    const m = L.map(el.current!, { center: [-33.94, 18.5], zoom: 11, keyboard: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) => pick.current?.(e.latlng.lat, e.latlng.lng));
    map.current = m;
    const seen = markers.current;
    return () => {
      m.remove();
      map.current = null;
      seen.clear();
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const live = new Set(pins.map((p) => p.id));
    for (const [id, mk] of markers.current) {
      if (!live.has(id)) {
        mk.remove();
        markers.current.delete(id);
      }
    }
    for (const p of pins) {
      let mk = markers.current.get(p.id);
      if (!mk) {
        mk = L.marker([p.lat, p.lng], { icon: icon(p), keyboard: false, interactive: true }).addTo(m);
        mk.bindTooltip(p.label);
        markers.current.set(p.id, mk);
      } else {
        mk.setLatLng([p.lat, p.lng]);
        mk.setIcon(icon(p));
        mk.getTooltip()?.setContent(p.label);
      }
    }
    if (fit && !fitted.current && pins.length > 0) {
      fitted.current = true;
      m.fitBounds(L.latLngBounds(pins.map((p) => [p.lat, p.lng] as [number, number])).pad(0.3), { maxZoom: 14 });
    }
  }, [pins, fit]);

  return <div ref={el} className="map" role="region" aria-label={label} />;
}
