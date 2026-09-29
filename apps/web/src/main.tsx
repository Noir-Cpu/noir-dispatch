import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/instrument-serif/400.css";
import "@noir/ui/tokens.css";
import "./styles.css";
import { initTelemetry } from "./telemetry";

initTelemetry();
import { Account } from "./Account";

const client = new QueryClient();

function Health() {
  const { data, isPending } = useQuery({
    queryKey: ["health"],
    queryFn: () => fetch("/api/health").then((r) => r.json() as Promise<{ ok: boolean }>),
  });
  return <p className="meta">API: {isPending ? "checking…" : data?.ok ? "ok" : "down"}</p>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <main>
        <p className="meta">[ 000 ]</p>
        <h1>NOIR Template</h1>
        <Health />
        <Account />
      </main>
    </QueryClientProvider>
  </StrictMode>,
);
