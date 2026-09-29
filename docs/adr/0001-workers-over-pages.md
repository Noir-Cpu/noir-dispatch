# ADR 0001: Workers with static assets, not Pages

Status: accepted

Durable Objects, Hyperdrive, queue consumers and Workers Logs are available on Workers but not Pages. Starting on Pages means migrating later. The API and built web app deploy as one Worker.

Trade-off: Pages has a simpler git-connected deploy flow; we accept a wrangler-based deploy via GitHub Actions.
