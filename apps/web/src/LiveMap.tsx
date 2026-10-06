import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import { planGlide, type Glide } from "@noir/core/motion";
import { cumulativeM, pointAtM, projectOnPolyline, remainingFrom } from "@noir/core/polyline";
import { markerBox, markerSvg, type MarkerKind } from "./markers";

export type LatLng = { lat: number; lng: number };
export type Pin = {
  id: string;
  kind: MarkerKind;
  lat: number;
  lng: number;
  label: string;
  selected?: boolean;
  /** Driver pins only: the road the driver is on. The marker glides along it between pings and the part still to go is drawn. */
  route?: LatLng[] | null;
};
export type MapCircle = { id: string; lat: number; lng: number; radiusKm: number; emphasis?: boolean };
export type MapLine = { id: string; points: LatLng[]; kind: "route" | "straight" };

const LINE_STYLE: Record<MapLine["kind"], L.PolylineOptions> = {
  route: { color: "#0b57d0", weight: 5, opacity: 0.35, lineCap: "round", lineJoin: "round" },
  straight: { color: "#333333", weight: 3, opacity: 0.8, dashArray: "2 8", lineCap: "round" },
};
const REMAINING_STYLE: L.PolylineOptions = { color: "#0b57d0", weight: 5, opacity: 0.95, lineCap: "round", lineJoin: "round" };

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// No inline style="" attributes in the markup: the page's Content-Security-Policy forbids them. Heading is applied through the DOM (el.style) instead.
function icon(p: Pin) {
  const b = markerBox(p.kind);
  return L.divIcon({
    className: `pin pin-${p.kind}${p.selected ? " pin-selected" : ""}`,
    html: `<div class="pin-body">${markerSvg(p.kind, 32)}</div>`,
    iconSize: [b.w, b.h],
    iconAnchor: [b.ax, b.ay],
  });
}
const zOffset = (k: MarkerKind) => (k === "driver" ? 1000 : k === "dropoff" ? 500 : k === "driver-idle" ? 300 : 0);

type Anim = {
  cur: LatLng;
  target: LatLng;
  heading: number;
  glide: Glide | null;
  start: number;
  dur: number;
  lastPing: number;
  active: boolean;
  route: LatLng[] | null;
  cum: number[] | null;
  lastRem: number;
};

/**
 * Leaflet map on OpenStreetMap tiles. The map is a visual aid only: everything it shows is also in text on the page (legend and
 * a text summary), so it is not the only way to get the information.
 *
 * Driver markers never jump: each new position starts a glide from where the marker is drawn now, along the route polyline when
 * there is one (straight otherwise), over about the time between pings, driven by requestAnimationFrame. With
 * prefers-reduced-motion the marker moves to the new position at once.
 */
export function LiveMap({
  pins,
  label,
  fitTo,
  fitKey,
  onPick,
  circles = [],
  lines = [],
  centerRef,
  describedBy,
}: {
  pins: Pin[];
  label: string;
  /** Points the view should include. Refitted whenever `fitKey` changes (and once at the start), never on every update. */
  fitTo?: LatLng[];
  fitKey?: string;
  onPick?: (lat: number, lng: number) => void;
  circles?: MapCircle[];
  lines?: MapLine[];
  /** Filled with a function that returns the point at the middle of the map, so a button can drop the pin there (the keyboard and no-drag way to choose a point). */
  centerRef?: { current: (() => LatLng) | null };
  /** id of text that explains how to use the map with a keyboard. */
  describedBy?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef(new Map<string, L.Marker>());
  const anims = useRef(new Map<string, Anim>());
  const iconKeys = useRef(new Map<string, string>());
  const circleLayers = useRef(new Map<string, L.Circle>());
  const lineLayers = useRef(new Map<string, L.Polyline>());
  const remLayers = useRef(new Map<string, L.Polyline>());
  const raf = useRef(0);
  const fittedOnce = useRef(false); // the first fit jumps; later ones may animate

  const fittedKey = useRef<string | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    // Leaflet's own zoom, pan and fade animations are switched off for people who asked for less motion.
    const calm = reducedMotion();
    const m = L.map(el.current!, { center: [-33.94, 18.5], zoom: 10, keyboard: true, zoomAnimation: !calm, fadeAnimation: !calm, markerZoomAnimation: !calm, inertia: !calm });
    // Tiles start loading as soon as the map exists, for the default view (the Cape Town area most orders are in), so the request does not
    // wait for station data. The first fit below is skipped until the caller has its points, so the view is not first sent somewhere
    // else (and its tiles fetched) and then moved.
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) => pick.current?.(e.latlng.lat, e.latlng.lng));
    // Keyboard: arrow keys pan and +/- zoom (Leaflet), Enter drops the pin at the cross in the middle.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && pick.current && e.target === m.getContainer()) {
        e.preventDefault();
        const c = m.getCenter();
        pick.current(c.lat, c.lng);
      }
    };
    m.getContainer().addEventListener("keydown", onKey);
    if (centerRef) centerRef.current = () => ({ lat: m.getCenter().lat, lng: m.getCenter().lng });
    map.current = m;
    const mk = markers.current, an = anims.current, ci = circleLayers.current, li = lineLayers.current, re = remLayers.current, ik = iconKeys.current;
    return () => {
      cancelAnimationFrame(raf.current);
      m.getContainer().removeEventListener("keydown", onKey);
      if (centerRef) centerRef.current = null;
      m.remove();
      map.current = null;
      for (const x of [mk, an, ci, li, re, ik]) x.clear();
      fittedKey.current = null;
      fittedOnce.current = false;
    };
  }, []);

  // Draw the part of the route still ahead of the driver; throttled, it is the only per-frame polyline work.
  const drawRemaining = (id: string, a: Anim, force = false) => {
    const m = map.current;
    if (!m) return;
    if (!a.route || !a.cum) {
      remLayers.current.get(id)?.remove();
      remLayers.current.delete(id);
      return;
    }
    const t = performance.now();
    if (!force && t - a.lastRem < 120) return;
    a.lastRem = t;
    const s = projectOnPolyline(a.route, a.cur, a.cum).s;
    const pts = remainingFrom(a.route, s, a.cum).map((p) => [p.lat, p.lng] as [number, number]);
    let layer = remLayers.current.get(id);
    if (!layer) {
      layer = L.polyline(pts, { ...REMAINING_STYLE, interactive: false }).addTo(m);
      remLayers.current.set(id, layer);
    } else layer.setLatLngs(pts);
  };

  const frame = () => {
    raf.current = 0;
    const now = performance.now();
    let more = false;
    for (const [id, a] of anims.current) {
      if (!a.active) continue;
      const f = a.dur > 0 ? (now - a.start) / a.dur : 1;
      const pos = a.glide ? a.glide.at(f) : { ...a.target, heading: a.heading };
      a.cur = { lat: pos.lat, lng: pos.lng };
      a.heading = pos.heading;
      const mk = markers.current.get(id);
      mk?.setLatLng([pos.lat, pos.lng]);
      const body = mk?.getElement()?.querySelector<HTMLElement>(".pin-body");
      if (body) body.style.transform = `rotate(${pos.heading}deg)`;
      drawRemaining(id, a);
      if (f >= 1) {
        a.active = false;
        drawRemaining(id, a, true);
      } else more = true;
    }
    if (more) raf.current = requestAnimationFrame(frame);
  };

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const live = new Set(pins.map((p) => p.id));
    for (const [id, mk] of markers.current) {
      if (!live.has(id)) {
        mk.remove();
        markers.current.delete(id);
        anims.current.delete(id);
        remLayers.current.get(id)?.remove();
        remLayers.current.delete(id);
        iconKeys.current.delete(id);
      }
    }
    const t = performance.now();
    for (const p of pins) {
      const isDriver = p.kind === "driver" || p.kind === "driver-idle";
      let mk = markers.current.get(p.id);
      if (!mk) {
        mk = L.marker([p.lat, p.lng], { icon: icon(p), keyboard: false, interactive: true, zIndexOffset: zOffset(p.kind) }).addTo(m);
        mk.bindTooltip(p.label);
        markers.current.set(p.id, mk);
      } else {
        mk.getTooltip()?.setContent(p.label);
      }
      if (!isDriver) {
        mk.setLatLng([p.lat, p.lng]);
        // Rebuild the icon only when its look changes (selected ring), not on every render.
        const key = `${p.kind}|${p.selected ? 1 : 0}`;
        if (iconKeys.current.get(p.id) !== key) {
          iconKeys.current.set(p.id, key);
          mk.setIcon(icon(p));
        }
        continue;
      }
      let a = anims.current.get(p.id);
      const route = p.route && p.route.length >= 2 ? p.route : null;
      if (!a) {
        const cum = route ? cumulativeM(route) : null;
        // Start facing along the road if there is one.
        const heading = route && cum ? pointAtM(route, projectOnPolyline(route, p, cum).s, cum).heading : 0;
        const body = mk.getElement()?.querySelector<HTMLElement>(".pin-body");
        if (body) body.style.transform = `rotate(${heading}deg)`;
        a = { cur: { lat: p.lat, lng: p.lng }, target: { lat: p.lat, lng: p.lng }, heading, glide: null, start: t, dur: 0, lastPing: t, active: false, route, cum, lastRem: 0 };
        anims.current.set(p.id, a);
        drawRemaining(p.id, a, true);
        continue;
      }
      if (route !== a.route && !(route && a.route && route.length === a.route.length && route[0] === a.route[0])) {
        a.route = route;
        a.cum = route ? cumulativeM(route) : null;
      }
      if (p.lat !== a.target.lat || p.lng !== a.target.lng) {
        const dur = Math.min(6000, Math.max(600, t - a.lastPing));
        a.lastPing = t;
        a.target = { lat: p.lat, lng: p.lng };
        if (reducedMotion()) {
          a.cur = a.target;
          a.glide = null;
          a.active = false;
          mk.setLatLng([p.lat, p.lng]);
          drawRemaining(p.id, a, true);
        } else {
          a.glide = planGlide(a.route, a.cur, a.target, a.heading);
          a.start = t;
          a.dur = dur;
          a.active = true;
        }
      } else if (!a.active) drawRemaining(p.id, a, true);
    }
    if (!raf.current && [...anims.current.values()].some((a) => a.active)) raf.current = requestAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const live = new Set(circles.map((c) => c.id));
    for (const [id, c] of circleLayers.current) if (!live.has(id)) (c.remove(), circleLayers.current.delete(id));
    for (const c of circles) {
      const style: L.CircleOptions = c.emphasis
        ? { radius: c.radiusKm * 1000, color: "#0b57d0", weight: 3, dashArray: "8 6", fillColor: "#0b57d0", fillOpacity: 0.1, interactive: false }
        : { radius: c.radiusKm * 1000, color: "#0b57d0", weight: 1, opacity: 0.45, fillColor: "#0b57d0", fillOpacity: 0.03, interactive: false };
      const old = circleLayers.current.get(c.id);
      if (old) {
        old.setLatLng([c.lat, c.lng]);
        old.setRadius(style.radius!);
        old.setStyle(style);
      } else circleLayers.current.set(c.id, L.circle([c.lat, c.lng], style).addTo(m));
      if (c.emphasis) circleLayers.current.get(c.id)!.bringToBack();
    }
  }, [circles]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const live = new Set(lines.map((l) => l.id));
    for (const [id, l] of lineLayers.current) if (!live.has(id)) (l.remove(), lineLayers.current.delete(id));
    for (const l of lines) {
      const pts = l.points.map((p) => [p.lat, p.lng] as [number, number]);
      const old = lineLayers.current.get(l.id);
      if (old) {
        old.setLatLngs(pts);
        old.setStyle(LINE_STYLE[l.kind]);
      } else lineLayers.current.set(l.id, L.polyline(pts, { ...LINE_STYLE[l.kind], interactive: false }).addTo(m));
    }
  }, [lines]);

  // Fit once, then again only when the caller says the subject changed (a driver appeared, another station chosen).
  useEffect(() => {
    const m = map.current;
    if (fitTo && fitTo.length === 0) return; // the caller is still waiting for its data: keep the default view rather than fit to a partial picture
    const pts = fitTo && fitTo.length > 0 ? fitTo : pins.map((p) => ({ lat: p.lat, lng: p.lng }));
    if (!m || pts.length === 0) return;
    const key = fitKey ?? "once";
    if (fittedKey.current === key) return;
    fittedKey.current = key;
    m.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng] as [number, number])).pad(0.25), { maxZoom: 15, animate: !reducedMotion() && fittedOnce.current });
    fittedOnce.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, fitTo?.length, pins.length > 0]);

  return (
    <div className="map-wrap">
      <div ref={el} className="map" role="region" aria-label={label} aria-describedby={describedBy} />
      {onPick && <span className="crosshair" aria-hidden="true" />}
    </div>
  );
}
