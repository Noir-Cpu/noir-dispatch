import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/instrument-serif/400.css";
import "@noir/ui/tokens.css";
import "./styles.css";
import { initTelemetry } from "./telemetry";
import { PlacePage } from "./PlacePage";
import { OrderPage } from "./OrderPage";
import { OpsPage } from "./OpsPage";

initTelemetry();

const client = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <p className="banner" role="note">Simulated demo: no fuel is delivered and no real payment is taken.</p>
      <header className="top">
        <span className="mark">DISPATCH</span>
        <nav aria-label="Main">
          <NavLink to="/" end>Order</NavLink>
          <NavLink to="/ops">Operations</NavLink>
        </nav>
      </header>
      <main id="main">{children}</main>
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
