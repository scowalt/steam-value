# Steam Value

A personal game library analyzer that scores Steam games by review quality and time-to-beat. Finds the best-value games in your wishlist and library.

## How It Works

Each game gets a **value score** based on:

- **Review quality** (Steam review %, Bayesian-adjusted for low review counts)
- **Time to beat** (from HowLongToBeat, mild penalty for longer games)
- **Age decay** (2% per year, capped at 50%)

High-rated, shorter games rank higher than mediocre, long ones. The formula is configurable in `src/formula/config.ts`.

## Data Sources

- **Steam API** — reviews, app details, ownership, wishlist, ignored list
- **IsThereAnyDeal** — US/USD discounts across supported stores and active bundles
- **HowLongToBeat** — completion times (manual/batch enrichment)
- **Wikidata** — Steam ID to HLTB ID mappings
- **SteamDB dataset** — local lookup for fast mapping

## Architecture

The always-on web surface runs as a **Cloudflare Worker with Static Assets** at `steam-value.scowalt.com`, protected by Cloudflare Access.

- **Cloudflare Worker**: serves static assets, `GET /api/games`, and `GET /api/sync-state`.
- **Steel on arcane**: keeps a persistent, tailnet-only Steam browser profile and runs the daily Steam Status refresh.
- **Turso**: remains the production SQLite database for both the Worker and admin scripts.
- **Doppler**: remains the source of truth for database and Steam API secrets. Only Turso secrets are mirrored to the Worker.
- **GitHub Actions**: tests and builds every pull request; tested `main` artifacts deploy the Worker script/assets.
- **Mission-control OpenTofu**: owns the custom domain, disabled workers.dev/preview endpoints, empty cron schedule, and Cloudflare Access application.

Operational boundaries:

- **Steam Status** (wishlist, ignored, ownership, playtime): refreshed daily on arcane through a persistent Steel browser plus Steam's owned-games and recently-played APIs.
- **Catalog Facts** (tags, controller support, game modes, release dates): refreshed by occasional external/admin jobs.
- **HowLongToBeat estimates**: manual/batch enrichment only; not run in the Worker.

## Usage

```bash
bun install

# Add a game by Steam App ID
bun add -- 292030        # The Witcher 3

# List all games sorted by value
bun list

# Refresh Steam catalog rows and review scores/counts
bun run catalog:refresh

# Start local Worker dev (writes .dev.vars from Doppler, builds assets, runs Wrangler/Miniflare)
bun web

# Recalculate all scores (after config changes)
bun recalc
```

## Web UI

Browse and filter your game library through the Cloudflare Worker:

- Sort by value score, reviews, or time-to-beat
- Filter: hide early access, hide played, hide MMO, hide ignored
- Filter by co-op mode (any, online, local) and controller support
- Links directly to Steam Store pages
- Shows last Steam Status refresh metadata
- **On sale or in bundle** includes fresh retail discounts and active bundle opportunities from IsThereAnyDeal, combined with all existing filters before pagination
- A dedicated **Deals** column (compact labeled field on mobile) shows the best-price retail offer's **% off**, **In bundle**, or both, linked to the original offers. A dash means no current offer can be shown, not proof that no sale exists
- Check linked providers for price, activation/DRM, voucher and bundle choice/add-on requirements; non-Steam copies are possible. Bundle badges do not imply an individual-game price
- Offers are usable for **24 hours after fetching**, or until an earlier known expiry. Unknown expiry is not a guarantee of checkout availability. Missing or failed responses do not extend freshness; the UI expires badges without displaying a refresh-status panel

Local web development uses Wrangler/Miniflare, not the old Bun server:

```bash
bun web
```

## Tests

```bash
bunx playwright install chromium  # one-time browser setup
bun test
bun run typecheck
```

Tests use local in-memory SQLite and intercepted browser requests, not production APIs or credentials. Desktop/mobile checks do not start a development server.

## Build and Deploy

Every pull request runs tests, typechecks, and a production build in an unprivileged CI workflow. A separate default-branch `workflow_run` workflow receives production credentials only after successful CI on `main`, verifies the tested SHA is still current, and deploys that CI run's exact artifact through the `production` GitHub environment. Deployments are serialized and tagged with the commit SHA.

The environment contains only:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`, with Cloudflare Worker **Editor** access scoped to the existing `steam-value` Worker

The token does not need DNS, Access, R2, Turso, custom-domain, or Worker-creation permission. `wrangler.toml` owns Worker code/assets and runtime settings. Mission-control OpenTofu separately owns the custom domain, Access, disabled workers.dev/preview endpoints, and cron infrastructure; see [ADR 0003](docs/adr/0003-deploy-worker-application-through-github-actions.md).

For local verification only:

```bash
bun install --frozen-lockfile
bunx playwright install chromium
bun test
bun run build
bunx wrangler deploy --dry-run --no-bundle --strict --keep-vars
```

Do not deploy pull-request artifacts manually. For an emergency rollback, an operator with the same Worker-scoped credential can inspect version history and run `bunx wrangler rollback`. Then revert the offending commit on `main` so the next green deployment restores source/production agreement. Worker secrets are preserved by deploys and continue to be synced separately from Doppler when intentionally changed.

## Database

Turso (SQLite) via Drizzle ORM for admin scripts. The Worker uses raw libSQL queries to keep edge runtime behavior explicit.

```bash
bun db:push             # Push schema changes
bun db:setup-worker     # Create Worker sync metadata table and indexes
bun db:studio           # Open Drizzle Studio
```

## Scripts

| Script | Purpose |
|--------|---------|
| `bun add -- <appId>` | Add a game with HLTB verification |
| `bun list` | List all games with scores |
| `bun recalc` | Recalculate all value scores |
| `bun run catalog:refresh` | Upsert Steam catalog rows and refresh review scores/counts |
| `bun run deals:refresh` | Refresh US/USD retail discounts and bundles for ranked games via IsThereAnyDeal |
| `bun web` | Build and run the Worker locally through Wrangler/Miniflare |
| `bun run build` | Build static assets and Worker bundle into `dist/` |
| `bun run secrets:dev` | Write selected Doppler secrets to `.dev.vars` for local Worker dev |
| `bun run secrets:sync` | Upload Turso secrets to Cloudflare Worker secrets |
| `bun run db:setup-worker` | Prepare Turso sync metadata table and Worker indexes |
| `bun run hydrate-daily` | Manual external Steam Status refresh fallback |
| `bun run steam:browser-login` | Open a Steel session for one-time Steam login |
| `bun run steam:browser-sync` | Run the guarded browser-backed Steam Status refresh |

Hydration scripts in `scripts/` bulk-fetch Catalog Facts from Steam, SteamSpy, Wikidata, and HLTB. They remain external/admin jobs and write directly to Turso.

### IsThereAnyDeal offers

Offers are independent Catalog Facts, not Steam Status or a component of Value Score. An hourly job on arcane refreshes only rankable games using exact Steam app-ID mapping (cached for seven days), batches of up to 200 ITAD game IDs, and a complete active-bundle feed. It uses throttling, bounded retries honoring `Retry-After`, and a renewable database lease to prevent overlapping publication. No ITAD requests run in the Worker or browser.

`game_deal_cache` stores separate retail/bundle snapshots so missing retail responses cannot silently become a fresh “no offers” result. `itad_game_map` and `deal_refresh_state` track identity and operational status. `bun run db:setup-worker` creates these tables additively; run it before deploying the updated Worker. The hourly service also ensures its own tables exist. No game-table migration is required.

```bash
bun run deals:refresh --limit 20  # bounded live verification
bun run deals:refresh             # all currently ranked games
```

`GET /api/games?onSale=true` applies sale filtering before pagination; each game includes offer kind, freshness, price and conditions. `GET /api/deal-state` reports last attempt/success, errors, running state and complete fresh coverage. Successful no-offer responses replace disappeared offers; failed/missing responses retain prior data only until its original deadline. An open browser tab also expires displayed offers.

Price data is provided by [IsThereAnyDeal](https://isthereanydeal.com/); original affiliate links are preserved, and voucher requirements remain in the offer API data. The UI shows only compact linked badges and footer attribution. Private personal use is explicitly allowed by the current API documentation (the linked repository terms differ; see [API research](docs/research/isthereanydeal-sale-data.md)). Bundle choice/add-on rules are not fully specified by the API, so inspect provider terms before buying. This is not an affiliated ITAD product or an availability guarantee.

See `deploy/arcane/README.md` for the independent offer service/timer and credential setup.

### Steam catalog refresh

`bun run catalog:refresh` uses official Steam endpoints instead of SteamSpy for the reliability-critical catalog path:

1. `IStoreService/GetAppList` with `include_games=true` supplies the Steam app catalog.
2. `store.steampowered.com/appreviews/<appId>` supplies review totals for each app.
3. Turso rows are upserted for new games above the review threshold, and existing rows refresh `name`, `steam_review_score`, and `steam_review_count`.

The job checkpoints progress in `catalog_refresh_state` and records per-app failures in `catalog_refresh_failures`, so a full-catalog run can resume after interruption. It is safe to rerun.

Defaults:

- `--min-reviews 10` inserts new games with at least 10 total Steam reviews. Existing rows refresh even if their count later falls below the threshold.
- `--review-delay-ms 500` waits between per-app review requests.
- `--retries 5` with `--retry-delay-ms 5000` handles transient Steam failures.
- `--batch-size 200` writes Turso changes in batches.
- `--checkpoint-every 50` persists progress every 50 processed apps.

Useful examples:

```bash
bun run catalog:refresh -- --dry-run --limit-apps 25
bun run catalog:refresh -- --restart                 # fresh full run
bun run catalog:refresh -- --min-reviews 100         # old import threshold
bun run catalog:refresh -- --start-after-app-id 620  # manual resume point
```

After a non-dry refresh that updates existing ratings, run `bun recalc` so value scores use the latest review data.

## Secrets

Managed via Doppler (`steam-value` project):

| Secret | Purpose |
|--------|---------|
| `TURSO_DATABASE_URL` | Turso database URL |
| `TURSO_AUTH_TOKEN` | Turso auth token |
| `STEAM_API_KEY` | Steam Web API key (for owned games) |
| `STEAM_ID` | Your Steam profile ID |
| `ITAD_API_KEY` | IsThereAnyDeal API key for the external offer refresh only |

The primary Steam Status path does not export `steamLoginSecure`. Its HttpOnly cookie stays inside the dedicated Steel browser profile on arcane. The arcane deployment receives only `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `STEAM_API_KEY`, and `STEAM_ID`; see `deploy/arcane/README.md`.

`ITAD_API_KEY` remains in Doppler and arcane's private `deals.env`; it is **not** a Worker secret and is never bundled into frontend assets.

For local Worker dev, run `bun run secrets:dev`. For Cloudflare runtime, run `doppler run --project mission-control --config dev -- bun run secrets:sync` so Wrangler has a Cloudflare API token. Secrets are intentionally kept out of OpenTofu state.

## Tech Stack

- **Runtime**: Cloudflare Workers for the web surface; Bun for local scripts
- **Language**: TypeScript
- **Database**: Turso (SQLite) + Drizzle ORM for admin scripts + raw libSQL in Worker
- **Web**: Cloudflare Worker Static Assets with vanilla HTML/TypeScript
- **Browser automation**: Playwright over a persistent, self-hosted Steel session for Steam Status
