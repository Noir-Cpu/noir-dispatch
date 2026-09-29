import * as Sentry from "@sentry/react";
import posthog from "posthog-js";

const sentryDsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const posthogKey = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const posthogHost = import.meta.env.VITE_POSTHOG_HOST as string | undefined;

export function initTelemetry() {
  if (sentryDsn) {
    Sentry.init({ dsn: sentryDsn, tracesSampleRate: 0 });
  }
  if (posthogKey) {
    posthog.init(posthogKey, {
      api_host: posthogHost,
      // Cookieless by default: nothing is stored in the browser, so no consent banner is needed.
      persistence: "memory",
      autocapture: false,
      disable_session_recording: true,
      person_profiles: "identified_only",
      capture_pageview: "history_change",
    });
  }
}

// Named events only. Never put personal data in properties.
export function track(event: string, properties?: Record<string, string | number | boolean>) {
  if (posthogKey) posthog.capture(event, properties);
}
