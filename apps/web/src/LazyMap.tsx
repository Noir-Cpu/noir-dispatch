import { Suspense, lazy } from "react";
import type { LiveMap as LiveMapImpl } from "./LiveMap";

export type { LatLng, MapCircle, MapLine, Pin } from "./LiveMap";

// Leaflet and its stylesheet (about 40 KB gzipped) load only when a page actually shows a map, and after the first paint of the page
// around it, so the form and the headline are not waiting for map code.
const Impl = lazy(() => import("./LiveMap").then((m) => ({ default: m.LiveMap })));

export function LiveMap(props: Parameters<typeof LiveMapImpl>[0]) {
  return (
    <Suspense fallback={<div className="map map-loading" role="region" aria-label={props.label} aria-busy="true"><p className="meta">Loading map…</p></div>}>
      <Impl {...props} />
    </Suspense>
  );
}
