import { markerSvg, type MarkerKind } from "./markers";

export type LegendItem = { kind: MarkerKind; label: string } | { line: "route" | "straight" | "radius"; label: string };

/** Visible key under the map. The glyphs are the same artwork as the markers, each with a text label (never colour alone). */
export function MapLegend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="legend" aria-label="Map key">
      {items.map((it) => (
        <li key={it.label}>
          {"kind" in it ? (
            <span className="legend-glyph" dangerouslySetInnerHTML={{ __html: markerSvg(it.kind, 24) }} />
          ) : (
            <svg className="legend-line" width="34" height="14" viewBox="0 0 34 14" aria-hidden="true" focusable="false">
              {it.line === "route" && <line x1="2" y1="7" x2="32" y2="7" stroke="#0b57d0" strokeWidth="4" strokeLinecap="round" />}
              {it.line === "straight" && <line x1="2" y1="7" x2="32" y2="7" stroke="#444" strokeWidth="3" strokeDasharray="2 6" strokeLinecap="round" />}
              {it.line === "radius" && <ellipse cx="17" cy="7" rx="14" ry="5.5" fill="#0b57d0" fillOpacity="0.12" stroke="#0b57d0" strokeWidth="2" strokeDasharray="5 3" />}
            </svg>
          )}
          <span>{it.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** The same facts as the map, as text, for people who cannot see or use it. Each entry reads "Role: detail". */
export function MapSummary({ items, label = "Map in words" }: { items: { role: string; text: string }[]; label?: string }) {
  return (
    <ul className="map-summary" aria-label={label}>
      {items.map((i) => (
        <li key={i.role + i.text}>
          <strong>{i.role}:</strong> {i.text}
        </li>
      ))}
    </ul>
  );
}
