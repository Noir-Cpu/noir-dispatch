import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://localhost:8787", trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Serves the built web app and the API from one Worker, as in production.
  webServer: {
    command: "npm run build -w @noir/web && npm run dev -w @noir/api",
    url: "http://localhost:8787/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { WRANGLER_SEND_METRICS: "false" },
  },
});
