# Arcane Steam Status refresh

Steam Value uses a dedicated Steel browser on `arcane` to retain the authenticated Steam session in a Podman volume. The daily sync reads wishlist and ignored state inside that browser, reads ownership and playtime from Steam's API, validates the counts, and writes Steam Status to Turso.

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
