import { StrictMode, Suspense, lazy, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, NavLink, Route, Routes, useLocation } from "react-router-dom";
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/instrument-serif/400.css";
import "@noir/ui/tokens.css";
import "./styles.css";
import { initTelemetry } from "./telemetry";
import { PlacePage } from "./PlacePage";
import { applyMeta, metaFor } from "./pageMeta";

// The order page and the console are separate chunks: the landing page does not download code for screens it never shows
// (the console also carries the sign-in client).
const OrderPage = lazy(() => import("./OrderPage").then((m) => ({ default: m.OrderPage })));
const OpsPage = lazy(() => import("./OpsPage").then((m) => ({ default: m.OpsPage })));

initTelemetry();
// Start fetching the map code now, in parallel with rendering, on the pages that show a map (it is still a separate chunk, so / does not wait for it on /ops or 404).
if (location.pathname === "/" || location.pathname.startsWith("/order/")) void import("./LiveMap");

const client = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

/** Title and robots per route, and, after a navigation inside the app, focus moved to the content with the new page announced (a screen reader gets no page load otherwise). */
function RouteEffects() {
  const { pathname } = useLocation();
  const first = useRef(true);
  const [announce, setAnnounce] = useState("");
  useEffect(() => {
    const m = metaFor(pathname);
    applyMeta(m);
    if (first.current) {
      first.current = false;
      return;
    }
    setAnnounce(m.title);
    const main = document.getElementById("main");
    main?.focus({ preventScroll: false });
    window.scrollTo({ top: 0 });
  }, [pathname]);
  return <p className="sr-only" role="status" aria-live="polite">{announce}</p>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <RouteEffects />
      <a className="skip" href="#main">Skip to content</a>
      <p className="banner" role="note">Simulated demo: no fuel is delivered and no real payment is taken.</p>
      <header className="top">
        <span className="mark">DISPATCH</span>
        <nav aria-label="Main">
          <NavLink to="/" end>Order</NavLink>
          <NavLink to="/ops">Operations</NavLink>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        <Suspense fallback={<p className="meta">Loading…</p>}>{children}</Suspense>
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <Shell>
          <Routes>
            <Route path="/" element={<PlacePage />} />
            <Route path="/order/:id" element={<OrderPage />} />
            <Route path="/ops" element={<OpsPage />} />
            <Route path="*" element={<p>Page not found.</p>} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
