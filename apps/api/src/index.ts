import * as Sentry from "@sentry/cloudflare";
import { app, type Env } from "./app";

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN_API,
    // Errors only: traces go to Grafana.
    tracesSampleRate: 0,
  }),
  app,
);
