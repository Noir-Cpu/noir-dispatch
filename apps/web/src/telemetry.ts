// Telemetry is off unless a Sentry DSN or PostHog key was set at build time (the deploy workflow passes repository variables; none are set today).
// When it is off, nothing here is downloaded. When it is on, the Content-Security-Policy in public/_headers must also allow the ingest hosts
// in connect-src, or the browser blocks the reports.
export function initTelemetry() {
  if (!import.meta.env.VITE_SENTRY_DSN && !import.meta.env.VITE_POSTHOG_KEY) return;
  void import("./telemetry-impl").then((m) => m.startTelemetry());
}

// Named events only. Never put personal data in properties.
export function track(event: string, properties?: Record<string, string | number | boolean>) {
  if (!import.meta.env.VITE_POSTHOG_KEY) return;
  void import("./telemetry-impl").then((m) => m.track(event, properties));
}
