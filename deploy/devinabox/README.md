# Steam Value jobs on devinabox

The owner permanently retired Arcane and selected this machine for the D1 migration and replacement external jobs. [ADR 0005](../../docs/adr/0005-replace-arcane-with-devinabox.md) supersedes the old host selection. The website remains on Cloudflare; jobs stay outside the Worker.

## Runtime layout

- Complete application releases: `~/.local/share/steam-value/releases/<commit>/`.
- Selected release: `~/.local/share/steam-value/current`.
- Protected job configuration: `~/.config/steam-value-d1/`, directories mode 0700 and files mode 0600.
- Steam Status: Node 24.20.0, daily at 05:15 America/New_York, ten-minute timeout.
- Offers: Bun, hourly, 45-minute timeout.
- Both timers retain persistent catch-up and up to five minutes of jitter.

On 2026-10-26, the complete `9f31230` application release and four job units are installed locally. Both job timers remain disabled and neither database job has run. The private Steel API service is installed and running; that alone does not establish a successful Steam login. Keep jobs off until the populated D1 target, replacement CI deployment and actual machine authentication are accepted. Keep the old `steam-value-hydrate.timer` disabled.

The owner selected Woodpecker instead of GitHub Actions. Another agent owns that CI port. Preserve tested-current-main artifact promotion and narrow deployment credentials; do not rerun Actions or use an untested manual deployment.

## Credentials

Both jobs require `STEAM_VALUE_DB_URL`, `STEAM_VALUE_DB_TOKEN`, `STEAM_VALUE_ACCESS_CLIENT_ID` and `STEAM_VALUE_ACCESS_CLIENT_SECRET` from Doppler. Steam Status also needs `STEAM_API_KEY` and `STEAM_ID`; offers need `ITAD_API_KEY`. `browser.env` supplies `STEEL_BASE_URL`, `STEEL_CDP_URL` and `NODE_EXTRA_CA_CERTS` separately, so interactive login receives no database/provider credentials. The status unit loads it after `status.env`. Routine job environments must not contain Turso or Cloudflare operator credentials.

Only the application bearer goes into Worker secrets. Keep the source Turso credentials protected for recovery, outside the ordinary job configuration.

## Replacement browser

Create a separate persistent Steel profile on this machine. The Arcane profile is unavailable; no authenticated browser session has been recovered. Keep the API and debugger private. Start browser-accessible local services through Portless with private Tailscale sharing, use its assigned backend ports, and record the actual URLs from `portless list`. Do not expose Steam cookies or debugger access publicly.

The status unit depends on `steam-value-steel.service`. `run-steel.sh` starts the pinned official image through Portless, publishes only the API on its allocated loopback port, and requires private Tailscale sharing. Chrome's raw debugger port is not published. The image is pinned to `sha256:5c10c06375cb1e4833999432f307c816bf72486c8c57667d41b307fb660191fc`; `display-entrypoint.sh` adds its installed Xvfb display for interactive mode. The new profile stays under `~/.local/share/steam-value/steel-profile/`, mode 0700.

Use the actual local HTTPS API URL for browser connections. Chrome rejects the Tailscale DNS hostname for debugger access; keep that check enabled. Trust the local Portless CA through `NODE_EXTRA_CA_CERTS`, not by disabling certificate checks. API HTTP access was verified at both `https://steam-value-steel-api.localhost` and `https://devinabox.hair-salmon.ts.net:8452`; obtain current URLs from `portless list` after any restart.

The service writes a container ID into its private systemd runtime directory. `stop-steel.ts` checks that ID, image, labels and profile mount before stopping only its owned container. No restart loop, name-only kill or Docker prune is used.

`steam-value-steel-login.service` runs the existing Node login mode with only `browser.env`. Establish its persistent Steam login before enabling the status timer. Do not put the Steam cookie into job environment files or the Worker.

The first persistent login attempts failed on a missing display and then on old Chromium profile locks. On 2026-10-26 the owner approved removing only `SingletonLock`, `SingletonCookie` and `SingletonSocket`. After stopping the owned service and rechecking the old container and link ownership, those three symlinks were removed. No other profile files or database data were deleted. The approval was for those old links only; do not remove new active locks or automate lock deletion.

The login service then reached Steam's sign-in page. A supported local BB browser view displays the native Steel debug page, so the owner can scan its QR code with Steam mobile without sending credentials in chat. Google Chrome for Testing 156.0.8078.47 is installed in the plugin's private runtime; its original broken executable link is retained outside Git. The existing public Portless CA is trusted in Chrome's user NSS store for SSL only. Certificate checks remain enabled; no raw debugger or arbitrary CDP attachment is used. A displayed login page is not a successful login: wait for the login service's nonzero authenticated counts and successful exit. Close the BB view after use, and keep both job timers disabled until the separate deployment and actual job checks pass.

## Cutover

Retain the local Turso export and the source database. Import into the exact existing, confirmed pristine Steam Value D1 database, then use the normal current-main CI artifact to deploy the Worker. Install the complete release and protected environments locally. Run one offer refresh and one authenticated browser-backed Steam Status refresh, then enable their timers. A pending browser login remains an explicit outstanding step, not a successful job migration.

See the [current cutover record](../../docs/operations/d1-cutover.md). No D1 import, new job start or timer enablement is implied by these templates.
