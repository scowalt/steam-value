# ADR 0002: Run Steam Status from a persistent Steel browser

Status: accepted for browser, authentication, and scheduling; database destination superseded by [ADR 0004](./0004-move-database-to-cloudflare-d1.md). Production database cutover remains pending.

Steam Value will refresh account-specific Steam Status from a dedicated Steel browser on `arcane`, replacing the Cloudflare Worker cron and exported `steamLoginSecure` secret described in ADR 0001.

The Steel API is bound only to arcane's Tailscale address. Its dedicated Podman volume stores the Chrome user-data directory, including the HttpOnly Steam session cookie. A systemd timer starts a Playwright client daily; the client reads authenticated Dynamic Store data inside the browser, fetches ownership and playtime from Steam's official API, validates counts, and updates Turso.

The refresh rejects missing authenticated fields, a Dynamic Store response with zero owned apps, an empty official owned-games response, or a greater-than-80% drop from a previously nontrivial wishlist, ignored, or owned count. Rejected refreshes record an error without modifying game status.

This keeps the login cookie out of Doppler and Cloudflare while accepting that Steam may occasionally require an interactive Steam Guard reauthentication through Steel's tailnet-only debugger.
