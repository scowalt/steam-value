# Steam Value jobs on devinabox

The owner permanently retired Arcane and selected this machine for the D1 migration and replacement external jobs. [ADR 0005](../../docs/adr/0005-replace-arcane-with-devinabox.md) supersedes the old host selection. The website remains on Cloudflare; jobs stay outside the Worker.

## Runtime layout

- Complete application releases: `~/.local/share/steam-value/releases/<commit>/`.
- Selected release: `~/.local/share/steam-value/current`.
- Protected job configuration: `~/.config/steam-value-d1/`, directories mode 0700 and files mode 0600.
- Steam Status: Node 24.20.0, daily at 05:15 America/New_York, ten-minute timeout.
- Offers: Bun, hourly, 45-minute timeout.
- Both timers retain persistent catch-up and up to five minutes of jitter.

On 2026-10-26, the complete `9f31230` application release and four job units are installed locally. Both job timers remain disabled and neither database job has run. On 2026-10-27 the owner completed Steam login. A separate bounded browser-only reopen confirmed the saved sign-in without more human input and exited successfully. The private Steel API remains running; the completed login sessions are released. Keep jobs off until the populated D1 target, replacement CI deployment and actual machine authentication are accepted. Keep the old `steam-value-hydrate.timer` disabled.

The owner selected Woodpecker instead of GitHub Actions and on 2026-10-31 assigned this repository's port here after the shared CI service became ready. Follow the [CI runbook](../../docs/ci/woodpecker.md). Preserve tested-current-main artifact promotion and narrow deployment credentials; do not rerun Actions or use an untested manual deployment.

## Credentials

Both jobs require `STEAM_VALUE_DB_URL`, `STEAM_VALUE_DB_TOKEN`, `STEAM_VALUE_ACCESS_CLIENT_ID` and `STEAM_VALUE_ACCESS_CLIENT_SECRET` from Doppler. Steam Status also needs `STEAM_API_KEY` and `STEAM_ID`; offers need `ITAD_API_KEY`. `browser.env` supplies `STEEL_BASE_URL`, `STEEL_CDP_URL` and `NODE_EXTRA_CA_CERTS` separately, so interactive login receives no database/provider credentials. The status unit loads it after `status.env`. Routine job environments must not contain Turso or Cloudflare operator credentials.

Only the application bearer goes into Worker secrets. Keep the source Turso credentials protected for recovery, outside the ordinary job configuration.

## Replacement browser

Use the separate persistent Steel profile on this machine. The unavailable Arcane profile was not recovered; the owner authenticated the new devinabox profile on 2026-10-27. Keep the API and debugger private. Start browser-accessible local services through Portless with private Tailscale sharing, use its assigned backend ports, and record the actual URLs from `portless list`. Do not expose Steam cookies or debugger access publicly.

The status unit depends on `steam-value-steel.service`. `run-steel.sh` starts the pinned official image through Portless, publishes only the API on its allocated loopback port, and requires private Tailscale sharing. Chrome's raw debugger port is not published. The image is pinned to `sha256:5c10c06375cb1e4833999432f307c816bf72486c8c57667d41b307fb660191fc`; `display-entrypoint.sh` adds its installed Xvfb display for interactive mode. The new profile stays under `~/.local/share/steam-value/steel-profile/`, mode 0700.

Use the actual local HTTPS API and explicit local WSS override for Node automation. Chrome rejects the Tailscale DNS hostname for raw debugger access; keep that check enabled. Trust the local Portless CA through `NODE_EXTRA_CA_CERTS`, not by disabling certificate checks.

The separate human viewer advertises its managed cast socket from Steel's `DOMAIN`. Set that to the actual private Tailscale authority supplied by Portless, not the local hostname. Otherwise the HTML tells a remote user's browser to connect to that user's own `.localhost`, and a server-host UI check can falsely appear to pass. Verify that the served `/v1/sessions/cast` WSS URL shares the private viewer page's authority, not just that HTTP returns 200. The Node client keeps its explicit local override; no raw-CDP Host check is changed. Obtain current local/private URLs from `portless list` after any restart.

The service writes a container ID into its private systemd runtime directory. `stop-steel.ts` checks that ID, image, labels and profile mount, releases the single owned live session, and requires the profile lock to be absent before stopping only its owned container. Shutdown runs before the main process is stopped; a one-time marker prevents duplicate release attempts. Docker signal proxying is disabled so a forwarded signal cannot interrupt that sequence. No restart loop, name-only kill, lock deletion or Docker prune is used.

Readiness requires actual initial-browser page metadata, not just an HTTP200 from the early-starting API. Two successive page checks avoid racing its default browser launch. Each marker poll constructs a fresh `Bun.file`: a reused handle caches the initially missing marker and can cause a false startup timeout even after Chrome is ready. The pinned image also removes Puppeteer's internal listeners before awaiting Chrome close, allowing the following process kill to interrupt normal lock removal. `patch-steel-shutdown.mjs` moves that listener removal after close. It runs before the native API starts, checks the complete original module's SHA256 and requires exactly one patch site; a different module is refused. An anonymous, network-isolated launch/release check passed with zero live sessions and all three profile locks absent. This does not establish Steam authentication. Install the matching patch, display, run, wait and stop helpers together.

`steam-value-steel-login.service` runs the existing Node login mode with only `browser.env`. Its manual login window is four hours (`STEEL_LOGIN_TIMEOUT_MS=14400000`), with a four-hour-five-minute systemd backstop, so an asynchronous handoff does not expire after the script's default 30 minutes. The scheduled Steam Status and offer limits remain ten and 45 minutes. Establish its persistent Steam login before enabling the status timer. Do not put the Steam cookie into job environment files or the Worker.

The first persistent login attempts failed on a missing display and then on old Chromium profile locks. On 2026-10-26 the owner approved removing only `SingletonLock`, `SingletonCookie` and `SingletonSocket`. After stopping the owned service and rechecking the old container and link ownership, those three symlinks were removed. No other profile files or database data were deleted. The approval was for those old links only; do not remove new active locks or automate lock deletion.

Use the owner's actual private native debug-page URL for ordinary account/password sign-in and Steam Guard approval; do not request credentials in chat or send static QR handoffs. A supported local BB view can verify the private page before handoff, but close every agent view before the owner enters credentials. Google Chrome for Testing 156.0.8078.47 is installed in the plugin's private runtime; its original broken executable link is retained outside Git. The existing public Portless CA is trusted in Chrome's user NSS store for SSL only. Certificate checks remain enabled; no raw debugger or arbitrary CDP attachment is used. A displayed login page is not a successful login: wait for the login service's nonzero authenticated counts and successful exit. Keep both job timers disabled until the separate deployment and actual job checks pass.

The 2026-10-26 viewer-origin correction passed the private stream handshake, but browser launch hit an old lock. The approved `2dcdd5d0840c` cleanup completed at20:52Z; its first real-profile shutdown check still failed and left test-owner `8c50d088fffd` links. Anonymous checks then identified the listener-order and readiness issues above. A new specific owner approval authorized only those three test links; removal completed on2026-10-27 at02:46Z, with all other profile files preserved. The first cold start then exposed the cached-marker bug, which is now fixed. Corrected cold startup passed at02:58Z. The four-hour manual login reached Steam's sign-in page; actual local/private endpoints, same-authority private managed WSS and a live rendered private viewer were checked. The agent's verification view was closed before credential handoff. The owner then completed sign-in. The existing login mode validated authenticated Dynamic Store data; a separate browser-only reopen returned matching validated counts without human interaction and exited successfully (status 0) in 5.790 seconds. Native metadata then showed zero live sessions and all three profile lock links absent without further deletion. This verifies saved authentication across browser-session release/reopen, not a completed database migration or a host-reboot test. Actual database jobs remain unverified; both databases and job timers are unchanged. These one-time cleanup approvals are consumed and do not authorize new lock deletion.

## Cutover

Retain the local Turso export and the source database. The existing D1 import and basic verification are already recorded; do not reset, recreate or re-import it from this runbook or CI. Complete the verified Woodpecker rollout, preserve tested-current-main artifact promotion, and align the complete local release with the deployed commit. Verify actual machine authentication and viewer reads, run one offer refresh and one authenticated browser-backed Steam Status refresh, and confirm manual-consumer coverage before accepting coherent cutover and enabling schedules. Browser authentication alone is not successful job migration or authority to start the retention clock.

See the [current cutover record](../../docs/operations/d1-cutover.md). No D1 import, new job start or timer enablement is implied by these templates.
