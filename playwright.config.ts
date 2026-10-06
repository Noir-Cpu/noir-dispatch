import { defineConfig, devices } from "@playwright/test";

// The demo project has its own server. Its port can be moved (DEMO_PORT) when something else on the machine already holds 8788.
const DEMO_PORT = process.env.DEMO_PORT ?? "8788";

export default defineConfig({
  testDir: "e2e",
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://localhost:8787", trace: "on-first-retry" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /(demo|a11y-phone)\.spec\.ts/ },
    { name: "phone", use: { ...devices["Pixel 7"] }, testMatch: /.*a11y.*\.spec\.ts/ },
    // "Run demo" needs an order nobody else moves, so it gets its own server with the background simulator off.
    { name: "demo", use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${DEMO_PORT}` }, testMatch: /demo\.spec\.ts/ },
  ],
  // Local dev server: in-memory PGlite, the simulator running 20x faster than real time, web app served from dist.
  webServer: [
    {
      command: "npm run build -w @noir/web && npm run dev:local -w @noir/api",
      url: "http://localhost:8787/api/health",
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: { SIM_TIME_SCALE: "20", SIM_DRIVERS: "20", SIM_ORDERS_PER_HOUR: "30" },
    },
    {
      // Same app, no simulator, straight-line routes (ROUTE_PROVIDER is not set, so tests never call the public OSRM server).
      command: "npm run dev:local -w @noir/api",
      url: `http://localhost:${DEMO_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { PORT: DEMO_PORT, SIM: "0" },
    },
  ],
});
