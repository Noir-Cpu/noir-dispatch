// Per-route title, robots and canonical, kept in step with the static tags in index.html (which describe "/", the only indexable page).
// Crawlers that run scripts see these; the X-Robots-Tag headers in public/_headers cover the ones that do not.

const ORIGIN = "https://noir-dispatch-api.noir-cpu.workers.dev";
const TITLE_HOME = "DISPATCH: simulated fuel delivery demo with live tracking";

export type RouteMeta = { title: string; indexable: boolean; canonical?: string };

export function metaFor(pathname: string): RouteMeta {
  if (pathname === "/") return { title: TITLE_HOME, indexable: true, canonical: `${ORIGIN}/` };
  if (pathname.startsWith("/order/")) return { title: "Your order | DISPATCH (simulated)", indexable: false };
  if (pathname === "/ops") return { title: "Operations | DISPATCH (simulated)", indexable: false };
  return { title: "Page not found | DISPATCH", indexable: false };
}

function upsert(selector: string, make: () => HTMLElement): HTMLElement {
  let el = document.head.querySelector<HTMLElement>(selector);
  if (!el) {
    el = make();
    document.head.appendChild(el);
  }
  return el;
}

export function applyMeta(m: RouteMeta) {
  document.title = m.title;
  const robots = upsert('meta[name="robots"]', () => Object.assign(document.createElement("meta"), { name: "robots" }));
  robots.setAttribute("content", m.indexable ? "index, follow, max-image-preview:large" : "noindex, nofollow");
  const link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (m.canonical) {
    const l = link ?? (upsert('link[rel="canonical"]', () => Object.assign(document.createElement("link"), { rel: "canonical" })) as HTMLLinkElement);
    l.setAttribute("href", m.canonical);
  } else link?.remove();
}
