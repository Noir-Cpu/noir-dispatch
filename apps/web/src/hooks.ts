import { useEffect, useRef, useState } from "react";
import { trackSocket, type TrackMessage, type TrackPoint } from "./api";

/** Live positions for a set of deliveries: one WebSocket per order, as in production (one room per delivery). */
export function useLivePositions(orderIds: string[]) {
  const [pos, setPos] = useState<Record<string, TrackPoint>>({});
  const sockets = useRef(new Map<string, () => void>());
  const key = [...orderIds].sort().join(",");

  useEffect(() => {
    const want = new Set(key ? key.split(",") : []);
    for (const [id, close] of sockets.current) {
      if (!want.has(id)) {
        close();
        sockets.current.delete(id);
      }
    }
    for (const id of want) {
      if (sockets.current.has(id)) continue;
      sockets.current.set(
        id,
        trackSocket(id, (m: TrackMessage) => {
          const p = m.type === "position" ? m.point : m.type === "snapshot" ? m.last : null;
          if (p) setPos((prev) => ({ ...prev, [id]: p }));
        }),
      );
    }
  }, [key]);

  useEffect(
    () => () => {
      for (const close of sockets.current.values()) close();
      sockets.current.clear();
    },
    [],
  );
  return pos;
}

export function useCustomerId() {
  const [id] = useState(() => {
    try {
      const existing = localStorage.getItem("dispatch.customerId");
      if (existing) return existing;
      const fresh = `web-${crypto.randomUUID().slice(0, 8)}`;
      localStorage.setItem("dispatch.customerId", fresh);
      return fresh;
    } catch {
      return `web-${crypto.randomUUID().slice(0, 8)}`;
    }
  });
  return id;
}

export const km = (m: number) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
export function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(h));
}
export const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
