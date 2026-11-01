# Steam Value

A personal game library analyzer that ranks Steam games by review quality and HowLongToBeat Estimates. Recorded Playtime and Steam Status remain separate from public Catalog Facts.

## Source, licensing and contributions

Original code is [MIT-licensed](LICENSE); third-party code and provider data retain their own [licenses and notices](THIRD_PARTY_NOTICES.md). Use the canonical [GitHub repository](https://github.com/scowalt/steam-value), its issues and PRs for all development. See [CONTRIBUTING.md](CONTRIBUTING.md) for credential-free setup and review.

The target is a public repository with **GitHub-hosted Actions for all CI and CD**, not a permanent Woodpecker/private-development lane. The [local migration patch and approval-gated handoff](docs/ci/github-actions.md) are prepared; hosted retirement, activation and publication must be completed separately. Source publication does not expose the owner's Steam Status, authenticated Steel profile, D1 database, backups, credentials or Access-protected viewer. Never add those resources or real account fixtures to Git.

## D1 in production

**Operational cutover accepted on 2026-10-31.** The website and external consumers use D1; actual authenticated website, machine, manual-tool and refresh-job checks passed. Jobs run on **devinabox**; Arcane is permanently retired.

| Surface | Current arrangement |
| --- | --- |
| Database | Existing protected `steam-value` D1 contains all seven application tables, legacy ledger and versioned migration metadata |
| Website | Cloudflare Worker uses its native D1 binding; replacement GitHub Actions exact-artifact CD is prepared, with hosted handoff still pending |
| External jobs/manual tools | Shared D1 clients use HTTPS `POST /api/internal/db`, Access Service Auth **and** a separate application bearer |
| Credentials | Doppler supplies selected application/provider credentials; the publisher installs the application bearer and removes only the two retired Turso secret names |
| Recovery | The owner waived the original seven-day wait, removed the export directory and approved the verified Turso database deletion; neither is a rollback source |

[ADR 0007](docs/adr/0007-retire-turso-after-owner-approved-early-cutover-acceptance.md) records the early-retirement decision. Preserve current D1 data before any future recovery. The original export was paged/non-atomic and received basic schema/count/rowid/sequence/representative-record checks, not a full-content comparison. Pre-existing Catalog Facts gaps remain separate backfill work.

See the [cutover record and recovery boundaries](docs/operations/d1-cutover.md), [devinabox procedures](deploy/devinabox/README.md), and [#17](https://github.com/scowalt/steam-value/issues/17)/[#29](https://github.com/scowalt/steam-value/issues/29) for current evidence. Earlier [inventory](docs/operations/d1-consumer-schema-inventory.md) and [rehearsal](docs/operations/d1-integrated-rehearsal.md) documents are historical preparation records, not active deployment holds.

## How it works

Value Score combines Bayesian-adjusted Steam review quality, a mild HowLongToBeat time penalty, and 2% annual age decay capped at 50%. The formula/configuration in `src/formula/` is unchanged by D1.

Sources: Steam API (reviews/details/ownership/wishlist/ignored/Playtime), IsThereAnyDeal (US/USD retail discounts/bundles), HowLongToBeat (manual/batch estimates), Wikidata mappings and a local SteamDB dataset.

The always-on viewer is a **Cloudflare Worker with Static Assets** at `steam-value.scowalt.com`, protected by human Cloudflare Access. It serves `/api/games`, `/api/city-builders`, `/api/sync-state`, `/api/deal-state` and `/api/health`. External SQL access is machine-only, never a browser SQL UI. `workers.dev` and preview URLs stay explicitly disabled; Worker cron stays empty.

- Steam Status is scheduled daily on **devinabox**, using intentional **Node 24/Playwright** and a persistent, private Steel profile. The Steam HttpOnly cookie stays in that profile. Its daily timer is enabled after a successful real authenticated run.
- Catalog Facts enrichment remains occasional external/admin work; HowLongToBeat enrichment remains manual/batch. The hourly offer timer is enabled on devinabox with Bun after successful real runs. No provider requests or new refresh actions run in the Worker/browser.
- Doppler remains the credential source; routine D1 jobs receive application credentials, not Cloudflare account credentials.
- This application owns code/assets, binding and immutable SQL history. Mission-control owns the domain, Access and protected D1 resource; no ordinary request/deployment initializes schema.

See [ADRs](docs/adr/0004-move-database-to-cloudflare-d1.md) and [GLOSSARY.md](GLOSSARY.md).

## Isolated setup and verification

Bun is the default toolchain; preserve the scheduled Node 24 exception. No Turso account, Doppler download, provider or production credential is needed:

```sh
bun install --frozen-lockfile
bunx playwright install chromium
scratch=$(mktemp -d /tmp/steam-value-d1.XXXXXX)
bun --no-env-file run db:migrate:local --persist-to "$scratch"
bun --no-env-file run db:inspect --local --persist-to "$scratch"
bun --no-env-file test
bun --no-env-file run typecheck
bun --no-env-file run build
```

Tests run the **actual bundled Worker/native local D1**, external raw/Drizzle clients through it, deterministic provider/time fixtures, explicit bootstrap/transfer/recovery and intercepted browser HTTP. No development server is started. Normal typecheck/build covers all seven projects: Worker, web, browser sync, database tools/access, catalog and manual consumers, including the rehearsal runner. The Bun/Miniflare released-pipe compatibility mitigation is local-only; retain its [regressions and failure history](docs/operations/d1-catalog-test-repair.md).

For a populated synthetic end-to-end rehearsal, choose a **new** protected directory outside Git:

```sh
umask 077
parent=$(mktemp -d /tmp/steam-value-d1-rehearsal.XXXXXX)
bun --no-env-file run db:rehearse --local --destination "$parent/evidence"
```

This verifies 500 games/all seven tables, native viewer 100/500 pages, typed data, deleted-ID high-water/orphans, synthetic jobs and chunked maintenance, full export/import/validation, post-cutover preservation and fresh recovery restore. Artifacts stay mode-0700 directories/mode-0600 files outside Git. Keep failed/incomplete artifacts for inspection; remove only your own disposable artifacts when appropriate. It is **not** a live-data rehearsal or rollback approval.

### Optional browser development

Use the explicit local bootstrap above and only synthetic local data/configuration. Do not use `bun web`, `worker:dev` or `secrets:dev` for isolated preparation: those convenience aliases download Doppler credentials. `dev` does not mean an isolated database. Do not reuse a production `.dev.vars` or `.env`.

Start any browser-accessible server only through Portless with private Tailscale sharing, letting Portless choose the backend port:

```sh
export D1_LOCAL_DIR="$scratch"
PORTLESS_TAILSCALE=1 portless run --tailscale sh -c 'bunx wrangler dev --port "$PORT" --persist-to "$D1_LOCAL_DIR"'
```

Then run `portless list`, verify and use its actual local/private Tailscale URLs; never guess a port, use a public tunnel, manually run Tailscale serve or stop the shared proxy. If Portless/private sharing is unavailable, stop. Local viewer reads need no machine credential; any local machine testing must use a separately prepared synthetic bearer, never downloaded production credentials.

## Database and administration

The complete authoritative history is `migrations/`, **not** the two-table Drizzle model. Runtime adapters never create tables. Setup reapplication checks checksums/schema and preserves data/sequence; it is not a reset or adoption mechanism. Read the [bootstrap](docs/operations/d1-local-bootstrap.md), [manual tools](docs/operations/d1-manual-tools.md) and [transfer/recovery](docs/operations/d1-transfer-recovery.md) guides.

| Command | Prepared behavior |
| --- | --- |
| `db:migrate:local`, `db:push`, `db:setup-worker` | Explicit complete bootstrap, requires `--local --persist-to`; no remote default |
| `db:generate --name <name> --sql-file <reviewed-file>` | Validate a reviewed candidate on disposable native D1 and append immutable SQL; never apply production |
| `db:studio`, `db:inspect` | Read-only CLI schema/counts/bounded samples, explicit local or authorized application scope; replaces direct-Turso Studio |
| `db:transfer --help` | Explicit inventory/export/import/validate/prepare-rollback; local CLI or separately approved supplied operator handles |
| `db:rehearse --local --destination <new-private-directory>` | Synthetic complete request/client/transfer/recovery rehearsal only |

Remote schema application is a separately approved native operator workflow, not arbitrary SQL on the machine endpoint. Interrupted imports remain incomplete and unpromotable; preserve them and restore into a **fresh explicitly bootstrapped target**, never append/replay/reset by default.

## Viewer capabilities

The viewer uses self-hosted **0build** dark-theme components with vanilla TypeScript. Both the rankings and city-builder views share pinned local CSS; no runtime CDN or frontend framework is required. See the [integration, license and update guide](docs/ui/0build.md).

The viewer retains Value Score/review/time ranking, filters for early access/played/MMO/ignored state, co-op modes, controller support, single-player, Steam links, Steam Status metadata and the city-builder view. Populated 100- and 500-game pages are supported without reducing public limits.

**On sale or in bundle** combines with existing filters before pagination. The Deals column shows linked retail % off/bundle badges (mobile compact fields) and footer attribution. A dash means no usable offer, not proof no sale exists. Offers expire strictly at 24 hours or earlier provider expiration; open tabs also expire badges. Successful empty responses remove disappeared sales; missing/failed responses never renew freshness. Country/kind caches, seven-day mappings and renewable token-fenced leases remain distinct from Steam Status and Value Score.

Check provider terms for activation/DRM, vouchers and bundle choice/add-on conditions. Affiliate links remain unchanged. This is not an affiliated ITAD product or an availability guarantee. See [ITAD research](docs/research/isthereanydeal-sale-data.md) and the [devinabox runbook](deploy/devinabox/README.md).

## Scheduled and historical tools

Every historical entrypoint remains; [all 30 Drizzle tools and their status](docs/operations/d1-manual-tools.md#full-consumer-status) and the [complete constructor/entrypoint audit](docs/operations/d1-consumer-schema-inventory.md) list readers, inserts, enrichment, wishlist/ownership, recalculation and intentional cleanup. Provider-driven tools were not run during preparation.

Doppler convenience aliases (`add`, `list`, `recalc`, `catalog:refresh`, `deals:refresh`, `import`, `hydrate:tags`, `hydrate-daily`) remain for **separately authorized** external work. They do not establish database isolation. Direct Bun scripts accept an explicitly prepared protected environment. `steam:browser-sync` / `steam:browser-login` intentionally run Node; login does not construct a database client. `filter-english --remove`, `remove-ignored` and `remove-played` remain explicit destructive administration, never scheduled/bootstrap work.

Official catalog refresh retains Steam's `IStoreService/GetAppList` and all-language/all-purchase-type app reviews, thresholds, checkpoints/failures/resume and historical SteamSpy aliases. Defaults remain 10 minimum reviews, 500ms review delay, five provider retries with 5000ms delay, 200-change native groups (maximum 400 statements), checkpoint every 50 apps. `--dry-run`, `--restart`, `--min-reviews`, `--start-after-app-id` and `--limit-apps` remain available. Recalculate after review changes. Provider retries are not database retries: an unknown/committed write error requires persisted-state reconciliation before explicitly resuming; do not blindly rerun failure-attempt increments.

## Credentials (names only)

See [distribution and protection](docs/operations/d1-credentials.md). `.env.example` and devinabox templates contain blank names only. Do not fill them with secrets in Git or invoke download/sync wrappers during isolated preparation.

| Names | Destination after approved cutover |
| --- | --- |
| `STEAM_VALUE_DB_URL` | External clients, explicit credential-free HTTPS exact `/api/internal/db` URL |
| `STEAM_VALUE_DB_TOKEN` | External clients and selected Worker secret only |
| `STEAM_VALUE_ACCESS_CLIENT_ID`, `STEAM_VALUE_ACCESS_CLIENT_SECRET` | External clients only; dedicated Access service token |
| `STEAM_API_KEY`, `STEAM_ID` | External Steam tools/status environment |
| `STEAM_LOGIN_SECURE` | Retained manual exported-cookie tools only, never Worker/scheduled Steel job |
| `ITAD_API_KEY` | External offers environment only |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Approved deployment/operator environments, never routine jobs |

## Build, promotion and recovery

[GitHub Actions](docs/ci/github-actions.md) is the sole target CI/CD controller. PRs use GitHub-hosted runners without protected environments or secrets. Successful main verification, including comment policy, gates publication of **that run/attempt's exact tested artifact** to the existing private R2 bucket; serialized deployment checks current main repeatedly and never rebuilds. The artifact writer and production credentials are in separate main-only environments. The production credential remains Worker **Editor** scoped to the existing `steam-value` Worker; no D1 provisioning, DNS, Access or Worker-creation privileges are added. Only the separate `STEAM_VALUE_DB_TOKEN` goes into Worker secrets. Doppler remains authoritative; no broad Doppler token is needed in Actions.

The prepared workflow is verification-only unless the repository variable `STEAM_VALUE_RELEASE_CONTROLLER` is explicitly set to `github-actions`. [ADR 0008](docs/adr/0008-prepare-public-source-actions-handoff.md) requires draining/retiring this repository's Woodpecker webhook/registration before the approved main merge and Actions activation. Current remote main still uses the old controller until that handoff; do not push/merge this patch as an uncoordinated intermediate deployment. Old [Woodpecker](docs/ci/legacy-woodpecker/) and [Actions](docs/ci/legacy-actions/) definitions are archived as documentation, not active fallback lanes. Public visibility, complete hosted CI/CD acceptance and retirement of all private-runner entrypoints are required to finish the migration.

`wrangler.toml` retains Static Assets, disabled workers.dev/preview URLs, observability and compatibility settings. Its D1 ID identifies the existing target that passed the import checks; local development remains `remote = false`. No deploy/request migration hook exists. Do not deploy an integration/PR artifact manually or use deployment as a substitute for database initialization and validation.

The [cutover runbook](docs/operations/d1-cutover.md) preserves the original plan and actual execution record. Turso and the original export have been removed under the owner's explicit early-retirement waiver; do not recreate or resume old source tooling. Worker-version rollback alone is **not** data rollback: preserve current D1, obtain a new recovery decision, validate the intended destination and coordinate every reader/writer. The supplied-handle legacy transfer adapter remains available as operator tooling, not a configured connection or automatic fallback.

Account-level financial budgets/alerts belong to the owner; no application budget pause or guaranteed fixed bill is added.
