# Host the web surface on Cloudflare while keeping Turso

Status: superseded for Steam Status scheduling by [ADR 0002](./0002-run-steam-status-from-persistent-steel-browser.md).

Steam Value will move its always-on web surface to a Cloudflare Worker with Static Assets protected by Cloudflare Access, while continuing to use Turso as the database. Cloudflare will run the viewer/API plus a daily Steam Status refresh; Catalog Facts enrichment remains an occasional external job and HowLongToBeat enrichment remains manual, because long-running batch work and Playwright/login flows do not fit free Cloudflare Workers cleanly.

## Consequences

- Doppler remains the source of truth for secrets, but selected secrets are synced into Cloudflare Worker secrets for runtime use.
- External admin jobs write directly to the production Turso database, with backups before large catalog jobs.
- The hosted UI exposes browsing and Steam Status refresh only; it does not trigger bulk Catalog Facts or HowLongToBeat jobs.
- The Worker API uses raw libSQL queries instead of Drizzle to keep the edge bundle small and make query/index behavior explicit; Bun admin scripts may continue using Drizzle.
- Mission-control OpenTofu owns the Cloudflare Worker deployment, including script/assets, routes, cron trigger, DNS, and Access policy; Wrangler is not the primary deployment mechanism.
- Worker secrets are the exception to full OpenTofu ownership: Doppler remains the source of truth and syncs selected secrets into Cloudflare outside Terraform so secret values do not live in OpenTofu state.
- The Cloudflare Worker becomes the only web/API implementation; the Bun web server is removed rather than kept as a parallel local implementation.
