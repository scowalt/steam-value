# Arcane Steam Status refresh

Steam Value uses a dedicated Steel browser on `arcane` to retain the authenticated Steam session in a Podman volume. The daily sync reads wishlist and ignored state inside that browser, reads ownership plus both library and recent playtime from Steam's API, validates the counts, and writes Steam Status to Turso. The recent-playtime feed covers free games that Steam omits from the owned-games response.

## Services

- `steel-browser-steam-value.service`: tailnet-only Steel API on `100.97.172.16:3002` and CDP on `100.97.172.16:9224`
- `steam-value-status-sync.service`: guarded, one-shot Steam Status refresh
- `steam-value-status-sync.timer`: daily run around 5:15 AM America/New_York
- `steel-steam-value-user-data`: persistent Chrome profile; treat it as a Steam credential

Runtime secrets live in `%h/.config/steam-value/arcane.env` with mode `0600`. Only Turso and the official Steam API credentials are copied there; the browser's HttpOnly Steam cookie remains inside the persistent volume.

The dedicated image in `steel-browser/Dockerfile` extends arcane's known-good Chrome-based Steel image with a loopback CDP proxy. Both the Steel API and CDP listener bind only to arcane's Tailscale address.

## One-time login

Run `node scripts/sync-steam-status-browser.ts --login` with the service environment loaded. Open the printed `STEEL_LOGIN_URL` from a tailnet-connected browser, complete Steam Guard, and wait for the command to report nonzero authenticated counts. This script uses Node because Bun 1.3.11 hangs while Playwright attaches to the self-hosted CDP endpoint.

## Operations

```bash
systemctl --user status steel-browser-steam-value.service
systemctl --user status steam-value-status-sync.timer
systemctl --user start steam-value-status-sync.service
journalctl --user -u steam-value-status-sync.service -n 100 --no-pager
```

If Steam authentication expires, the refresh fails before database writes. Repeat the one-time login; do not weaken or bypass the count guards.

## IsThereAnyDeal offer refresh

Independent of the above browser and the long-running catalog import:

- `steam-value-deals-refresh.service`: Bun refresh of US/USD retail discounts and active bundles for ranked games.
- `steam-value-deals-refresh.timer`: hourly, persistent catch-up after reboot, with up to five minutes of jitter.
- `%h/.config/steam-value/deals.env`: mode `0600`, contains only `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `ITAD_API_KEY` mirrored from Doppler `steam-value/dev`.

Register an app at https://isthereanydeal.com/apps/my/ and keep the key in Doppler; never add it to the Worker, browser assets, command-line arguments or git. The job has no Steam cookie/browser access.

Deploy only the new script (`scripts/refresh-deals.ts`) and its four service modules (`deal-types.ts`, `game-deals.ts`, `deal-refresh.ts`, `itad-client.ts`) under `src/services/`; do not replace a checkout while its catalog import is running. Install the two `steam-value-deals-refresh.*` unit files under `~/.config/systemd/user/`, provision the environment file securely, then:

```bash
systemctl --user daemon-reload
systemctl --user start steam-value-deals-refresh.service
systemctl --user enable --now steam-value-deals-refresh.timer
systemctl --user status steam-value-deals-refresh.timer
journalctl --user -u steam-value-deals-refresh.service -n 50 --no-pager
```

The refresh uses a renewable, token-fenced Turso lease. Failed runs exit nonzero; the next hourly run retries. Check `GET /api/deal-state` for failure/freshness/coverage. Each source snapshot expires after 24 hours, with earlier known offer expirations enforced by both API and UI. A missing retail response leaves that source unknown/stale, even when current bundle coverage is available. Source mappings are rechecked weekly, including unmatched games. This job never changes the `games` table or the catalog checkpoint, and does not recalculate rankings.
