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
- **HowLongToBeat** — completion times (scraped via Playwright)
- **Wikidata** — Steam ID to HLTB ID mappings
- **SteamDB dataset** — local lookup for fast mapping

## Usage

```bash
bun install

# Add a game by Steam App ID
bun add -- 292030        # The Witcher 3

# List all games sorted by value
bun list

# Start the web UI
bun web                  # http://localhost:3000

# Recalculate all scores (after config changes)
bun recalc
```

## Web UI

Browse and filter your game library at `http://localhost:3000`:

- Sort by value score, reviews, or time-to-beat
- Filter: hide early access, hide played, hide MMO, hide ignored
- Filter by co-op mode (any, online, local) and controller support
- Links directly to Steam Store pages
- Auto-syncs wishlist/ownership every 5 minutes

## Database

Turso (SQLite) via Drizzle ORM.

```bash
bun db:push     # Push schema changes
bun db:studio   # Open Drizzle Studio
```

## Scripts

| Script | Purpose |
|--------|---------|
| `bun add -- <appId>` | Add a game with HLTB verification |
| `bun list` | List all games with scores |
| `bun recalc` | Recalculate all value scores |
| `bun web` | Start the web UI |

Hydration scripts in `scripts/` bulk-fetch data from Steam and HLTB.

## Secrets

Managed via Doppler (`steam-value` project):

| Secret | Purpose |
|--------|---------|
| `TURSO_DATABASE_URL` | Turso database URL |
| `TURSO_AUTH_TOKEN` | Turso auth token |
| `STEAM_API_KEY` | Steam Web API key (for owned games) |
| `STEAM_ID` | Your Steam profile ID |
| `STEAM_LOGIN_SECURE` | Steam login cookie (for wishlist/ignored sync) |

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript
- **Database**: Turso (SQLite) + Drizzle ORM
- **Web**: Bun.serve() with vanilla HTML/TypeScript
- **Scraping**: Playwright (HLTB pages)
