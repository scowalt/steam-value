# Arcane Steam Status refresh

Steam Value uses a dedicated Steel browser on `arcane` to retain the authenticated Steam session in a Podman volume. The daily refresh reads wishlist and ignored state inside that browser, reads ownership plus both library and recent Playtime from Steam's API, and validates counts before changing game markers. The recent-playtime feed covers free games omitted from the owned-games response.

**D1 preparation only:** these job templates describe the prepared external client, not the currently installed production jobs. Production stays Turso-backed until the separately approved #28 freeze, validated import, coherent consumer switch and deployment. Do not install these changes, download credentials, start services or alter timers as preparation. See [ADR 0004](../../docs/adr/0004-move-database-to-cloudflare-d1.md), the [promotion/freeze gates](../../docs/operations/d1-acceptance-map.md#promotion-and-writer-freeze-gates) and [refresh verification](../../docs/operations/d1-refresh-jobs.md).

## Services

- `steel-browser-steam-value.service`: tailnet-only Steel API on `100.97.172.16:3002` and CDP on `100.97.172.16:9224`
- `steam-value-status-sync.service`: guarded, one-shot Steam Status refresh
- `steam-value-status-sync.timer`: daily run around 5:15 AM America/New_York
- `steel-steam-value-user-data`: persistent Chrome profile; treat it as a Steam credential

After approved cutover, runtime configuration lives in `%h/.config/steam-value/arcane.env` with mode `0600` in an owner-only configuration directory. [arcane.env.example](arcane.env.example) contains the four external database keys and official Steam API keys. Doppler/protected operator workflows remain the source of credentials; examples contain no values.

`STEAM_VALUE_DB_URL` is the explicit HTTPS endpoint ending in exact `/api/internal/db`, without credentials, query or fragment. `STEAM_VALUE_DB_TOKEN` is the separate application bearer secret; `STEAM_VALUE_ACCESS_CLIENT_ID` and `STEAM_VALUE_ACCESS_CLIENT_SECRET` are the Cloudflare Access service token. All four are required; there is no Turso fallback, account API token or database selector. Only the application bearer belongs in Worker secrets. Access credentials, Steam API keys and ITAD keys stay external. The HttpOnly Steam cookie stays inside the persistent volume, never in these environments or the Worker.

The dedicated image in `steel-browser/Dockerfile` extends arcane's known-good Chrome-based Steel image with a loopback CDP proxy. Both the Steel API and CDP listener bind only to arcane's Tailscale address.

## One-time login

During authorized browser operations, run `node scripts/sync-steam-status-browser.ts --login` with the Steel environment loaded. Open the printed `STEEL_LOGIN_URL` from a tailnet-connected browser, complete Steam Guard, and wait for nonzero authenticated counts. This branch never constructs a database client and needs no database credentials. The script intentionally uses Node 24 because Bun 1.3.11 hangs while Playwright attaches to the self-hosted CDP endpoint. Preserve the pinned Node service runtime, Steel profile path, cookie check, persistence and tailnet-only listeners.

## Operations (separately authorized, not preparation commands)

Explicitly bootstrap/validate D1 before installing the prepared consumers. Refresh services and ordinary deployments do not create tables. Keep both timers paused and active services drained throughout the final export/import/validation and coherent code/configuration switch; lease expiry is not a writer freeze.

```bash
systemctl --user status steel-browser-steam-value.service
systemctl --user status steam-value-status-sync.timer
systemctl --user start steam-value-status-sync.service
journalctl --user -u steam-value-status-sync.service -n 100 --no-pager
```

An absent browser cookie fails before database client construction. Incomplete/unauthenticated data, an empty official library or suspicious count drops preserve game markers and prior successful counts; a refresh that acquired the lock records safe failure state. Repeat the authorized one-time login when needed; do not weaken the guards. Recorded Playtime never decreases, including recently played free games and games that leave the library.

## IsThereAnyDeal offer refresh

Independent of the above browser and the long-running catalog import:

- `steam-value-deals-refresh.service`: Bun refresh of US/USD retail discounts and active bundles for ranked games.
- `steam-value-deals-refresh.timer`: hourly, persistent catch-up after reboot, with up to five minutes of jitter.
- `%h/.config/steam-value/deals.env`: mode `0600`, contains the four external database keys plus `ITAD_API_KEY`, mirrored through an approved Doppler/protected operator workflow. Use [deals.env.example](deals.env.example); no Steam cookie/API credentials or Cloudflare account API token.

Register an app at https://isthereanydeal.com/apps/my/ and keep the key in Doppler; never add it to the Worker, browser assets, command-line arguments or git. The job has no Steam cookie/browser access.

At approved cutover, install the tested code and its complete dependency tree together, including `src/db/{access,http}.ts`, the refresh/provider/service modules and the scripts. Do not copy only the old four-module set or replace a checkout while any writer is running. Preserve Bun for the offer/manual jobs, Node 24 for browser Steam Status, and the existing service timeouts/daily/hourly persistent schedules. Install the unit files under `~/.config/systemd/user/`, provision protected environments, and resume only after validation and coordinated switch approval:

```bash
systemctl --user daemon-reload
systemctl --user start steam-value-deals-refresh.service
systemctl --user enable --now steam-value-deals-refresh.timer
systemctl --user status steam-value-deals-refresh.timer
journalctl --user -u steam-value-deals-refresh.service -n 50 --no-pager
```

The prepared refresh uses a renewable, token-fenced D1 lease through the authenticated Worker endpoint. Failed runs exit nonzero. For confirmed provider failures or database rejection/rollback, check `GET /api/deal-state` and the safe job error before the next scheduled refresh. **For unknown or committed write errors, stop and reconcile persisted state before explicitly resuming; do not blindly replay the job or clear its lease.** Correlation IDs are not idempotency keys. See the [reconciliation procedure](../../docs/operations/d1-refresh-jobs.md#uncertain-writes).

Each source snapshot expires at exactly 24 hours, with earlier known offer expirations enforced by API and UI. Missing retail leaves its original checked-at unchanged, even with fresh bundles; successful `[]` replaces disappeared sales. Source mappings, including unmatched games, are rechecked at seven days. This job never changes `games`, the catalog checkpoint, schedules or rankings. The older `hydrate-daily.ts` remains a manual exported-cookie entrypoint using the same external client; it is not the scheduled Steel path and its cookie must not enter the Worker or scheduled environment.
