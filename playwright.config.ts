import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://localhost:8787", trace: "on-first-retry" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] }, testMatch: /.*a11y.*\.spec\.ts/ },
  ],
  // Local dev server: in-memory PGlite, the simulator running 20x faster than real time, web app served from dist.
  webServer: {
    command: "npm run build -w @noir/web && npm run dev:local -w @noir/api",
    url: "http://localhost:8787/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { SIM_TIME_SCALE: "20", SIM_DRIVERS: "20", SIM_ORDERS_PER_HOUR: "30" },
  },
});
