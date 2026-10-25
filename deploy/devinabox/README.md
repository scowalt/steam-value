# Steam Value jobs on devinabox

The owner permanently retired Arcane and selected this machine for the D1 migration and replacement external jobs. [ADR 0005](../../docs/adr/0005-replace-arcane-with-devinabox.md) supersedes the old host selection. The website remains on Cloudflare; jobs stay outside the Worker.

## Prepared layout

- Complete application releases: `~/.local/share/steam-value/releases/<commit>/`.
- Selected release: `~/.local/share/steam-value/current`.
- Protected job configuration: `~/.config/steam-value-d1/`, directories mode 0700 and files mode 0600.
- Steam Status: Node 24.20.0, daily at 05:15 America/New_York, ten-minute timeout.
- Offers: Bun, hourly, 45-minute timeout.
- Both timers retain persistent catch-up and up to five minutes of jitter.

These unit files are templates, not installed or enabled services. Do not start them until D1 is populated, the Worker and machine endpoint are deployed, and the four runtime keys are configured. Keep the old `steam-value-hydrate.timer` disabled; it must not run alongside the replacements.

## Credentials

Both jobs require `STEAM_VALUE_DB_URL`, `STEAM_VALUE_DB_TOKEN`, `STEAM_VALUE_ACCESS_CLIENT_ID` and `STEAM_VALUE_ACCESS_CLIENT_SECRET` from Doppler. Steam Status also needs `STEAM_API_KEY`, `STEAM_ID`, `STEEL_BASE_URL` and `STEEL_CDP_URL`; offers need `ITAD_API_KEY`. Routine job environments must not contain Turso or Cloudflare operator credentials.

Only the application bearer goes into Worker secrets. Keep the source Turso credentials protected for recovery, outside the ordinary job configuration.

## Replacement browser

Create a separate persistent Steel profile on this machine. The Arcane profile is unavailable; no authenticated browser session has been recovered. Keep the API and debugger private. Start browser-accessible local services through Portless with private Tailscale sharing, use its assigned backend ports, and record the actual URLs from `portless list`. Do not expose Steam cookies or debugger access publicly.

The status unit depends on `steam-value-steel.service`. That browser service must be installed and its persistent Steam login established before enabling the status timer. Browser login mode does not need database credentials. Do not put the Steam cookie into job environment files or the Worker.

## Cutover

Retain the local Turso export and the source database. Import into the exact existing, confirmed pristine Steam Value D1 database, then use the normal current-main CI artifact to deploy the Worker. Install the complete release and protected environments locally. Run one offer refresh and one authenticated browser-backed Steam Status refresh, then enable their timers. A pending browser login remains an explicit outstanding step, not a successful job migration.

See the [current cutover record](../../docs/operations/d1-cutover.md). No D1 import, new job start or timer enablement is implied by these templates.
