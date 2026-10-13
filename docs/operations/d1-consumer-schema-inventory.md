# D1 consumer and schema inventory

Source baseline: `299c9e20feb23dfb5aaa8913d16eafc94fcfd123`. Line ranges below refer to that commit. Integration seed `709f5a3` changes only accepted ADR/supersession documentation. This is the source inventory for [#18](https://github.com/scowalt/steam-value/issues/18), not a live database inventory or evidence of cutover.

Authority: [#17 specification](https://github.com/scowalt/steam-value/issues/17), [approved preparation plan](https://github.com/scowalt/steam-value/issues/17#issuecomment-6135327372), [approval record](https://github.com/scowalt/steam-value/issues/17#issuecomment-6135423331), [ADR 0004](../adr/0004-move-database-to-cloudflare-d1.md). [ADR 0001](../adr/0001-host-web-surface-on-cloudflare-with-turso.md), [ADR 0002](../adr/0002-run-steam-status-from-persistent-steel-browser.md), [ADR 0003](../adr/0003-deploy-worker-application-through-github-actions.md) still govern hosting, Steel/browser credentials, schedules and gated deployment. Use [GLOSSARY.md](../../GLOSSARY.md) terminology. The [access contract](d1-access-contract.md) and [acceptance map/gates](d1-acceptance-map.md) are the downstream implementation handoff.

## Historical construction and raw-SQL entrypoints

At the source baseline, eight non-test libSQL constructors existed; changing only the shared Drizzle client would miss seven. R = reads, W = writes (including schema/state writes). Ticket numbers identify implementation ownership, not completion.

| Source pointer | Current access and entrypoints | Owner |
| --- | --- | --- |
| [src/db/client.ts](../../src/db/client.ts):1–10 | Import-time libSQL singleton wrapped by Drizzle; all 30 scripts below. No initialization SQL on import. | #20 adapter; #24 consumers |
| [src/worker/index.ts](../../src/worker/index.ts):26–70 | Cached web libSQL client; R via `GET /api/games`, `/api/city-builders`, `/api/sync-state`, `/api/deal-state`. `/api/health` constructs a client but queries nothing. | #20 binding/endpoint; #21 reads |
| [scripts/sync-steam-status-browser.ts](../../scripts/sync-steam-status-browser.ts):36–77 | Daily Node/Playwright W via `syncSteamStatusFromUserData`; closes client. `--login` never constructs a database client. Preserve this intentional Node exception and Steel profile. | #22 |
| [scripts/hydrate-daily.ts](../../scripts/hydrate-daily.ts):5–16 | Manual Steam Status W via `syncSteamStatus`, using exported-cookie credentials; not the scheduled Steel path. | #22 |
| [scripts/refresh-deals.ts](../../scripts/refresh-deals.ts):15–27 | Hourly Bun W via `refreshGameDeals`, optional `--limit`; closes client. | #22 |
| [scripts/refresh-steam-catalog.ts](../../scripts/refresh-steam-catalog.ts):600–617 | Manual Catalog Facts R/W, owns catalog initialization/checkpoints/failures. `--dry-run` skips DDL and every write, but still reads/fetches providers. | #23 |
| [scripts/recalculate.ts](../../scripts/recalculate.ts):16,37–62 | Full-game Drizzle R **and a second raw client W**, score batches of 200. Both must use the same D1 database; preserve [Value Score formula](../../src/formula/index.ts):73–83. | #24 |
| [scripts/setup-worker-db.ts](../../scripts/setup-worker-db.ts):6–20 | Explicit schema W: sync/deal tables plus three game indexes; assumes `games` exists, omits catalog tables. | #19 migrations; #24 replacement |

Injected consumers currently typed to libSQL:

- [src/worker/games.ts](../../src/worker/games.ts):80–218 — browse/filter/order/pagination, offer enrichment, city-builder weighting/sorting (#21).
- [src/services/game-deals.ts](../../src/services/game-deals.ts):7–86 — deal DDL, grouped mapping/cache reads, refresh state and coverage (#19 DDL; #21 reads).
- [src/services/deal-refresh.ts](../../src/services/deal-refresh.ts):19–133 — DDL, lease acquisition/renewal, mapping/cache publication and fenced success/error state (#22).
- [src/services/steam-status-sync.ts](../../src/services/steam-status-sync.ts):79–240,295–368,440–473 — DDL, locks/state, full-game status read, changed-row batches and completion/failure (#22; #21 state read).
- [scripts/refresh-steam-catalog.ts](../../scripts/refresh-steam-catalog.ts):185–283,399–418,450–596 — catalog DDL, resume, upserts/checkpoints/failures/completion (#23).

## All shared Drizzle consumers

This baseline manifest lists all 30 consumers that import `src/db/client.ts`, operate on `games`, and belong to #24. Preserve historical/manual entrypoints; “analyze” and “verify” are not necessarily read-only.

| Script (under `scripts/`) and line range | Access to preserve |
| --- | --- |
| [list.ts](../../scripts/list.ts):11 | R: full `findMany`, SQL score/name ordering, JS display/filter. |
| [stats.ts](../../scripts/stats.ts):4 | R: full `findMany`, statistics/ranking. |
| [top10.ts](../../scripts/top10.ts):5 | R: full `findMany`, JS ranking. |
| [top10-filtered.ts](../../scripts/top10-filtered.ts):5 | R: full read, HowLongToBeat Estimate threshold/ranking. |
| [top10-unfiltered.ts](../../scripts/top10-unfiltered.ts):4 | R: full read/ranking. |
| [find-bad-hltb.ts](../../scripts/find-bad-hltb.ts):4 | R: full read, suspicious estimates. |
| [add-game.ts](../../scripts/add-game.ts):63,169–186 | W: `findFirst(steamAppId)`, single insert **with `returning()`**, Catalog Facts/estimates/score/endless flag. |
| [add-from-steamdb.ts](../../scripts/add-from-steamdb.ts):25,83–106 | W: existing-ID projection, sequential inserts including modes/controller/ignored flag. Ignored local `src/data/steamdb-raw.json` is required, not tracked. |
| [add-batch.ts](../../scripts/add-batch.ts):123,143–156 | W: existing lookup, sequential single-game inserts from curated list. |
| [add-batch3.ts](../../scripts/add-batch3.ts):65,86–112 | W: lookup/inserts, full read for final count. |
| [add-batch4.ts](../../scripts/add-batch4.ts):119,143–157,193 | W: same. |
| [analyze-top-games.ts](../../scripts/analyze-top-games.ts):43,68–83,121 | W: lookup, insert **with `returning()`**, full report read. |
| [analyze-100-games.ts](../../scripts/analyze-100-games.ts):123,149–165,204 | W: same, including endless flag. |
| [analyze-batch2.ts](../../scripts/analyze-batch2.ts):129,155–171,207 | W: same. |
| [hydrate-controller.ts](../../scripts/hydrate-controller.ts):28,75–78 | W: null-controller read ordered by score; nullable controller update per ID. |
| [hydrate-early-access.ts](../../scripts/hydrate-early-access.ts):8,19–22 | W: full read, changed boolean update per ID. |
| [hydrate-game-info.ts](../../scripts/hydrate-game-info.ts):8,28–31 | W: full read, early-access/controller update per ID. |
| [hydrate-game-info-fast.ts](../../scripts/hydrate-game-info-fast.ts):29,76–79 | W: same database work, faster provider-fetch path. |
| [hydrate-game-modes.ts](../../scripts/hydrate-game-modes.ts):8,40–55 | W: full read, ten mode/MMO boolean updates per ID. |
| [hydrate-release-dates.ts](../../scripts/hydrate-release-dates.ts):8,28–31 | W: full read, missing release-date string update per ID. |
| [hydrate-tags.ts](../../scripts/hydrate-tags.ts):37–40,60–63 | W: null-tags read, optional limit, JSON-text update per ID. |
| [hydrate-ownership.ts](../../scripts/hydrate-ownership.ts):11,24–27 | W: full read, ownership/nullable Playtime update per ID; distinct older semantics from guarded daily refresh. |
| [sync-wishlist.ts](../../scripts/sync-wishlist.ts):17,24–37 | W: full read, two unbounded wishlist true/false `IN` updates. |
| [hydrate-hltb.ts](../../scripts/hydrate-hltb.ts):9–11,27–36 | W: missing-estimate/non-endless read, estimate update per Steam ID; no recalculation. |
| [verify-hltb-batch.ts](../../scripts/verify-hltb-batch.ts):55–60,100–110 | W normally: missing-estimate read/update per Steam ID. `--dry-run` skips mutations; checkpoints are logs, not database state. |
| [fix-hltb.ts](../../scripts/fix-hltb.ts):28,51–59 | W: repeated full reads/name matching, estimate **and Value Score** correction per ID. |
| [recalculate.ts](../../scripts/recalculate.ts):16,37–62 | W through the second raw client; shared Drizzle supplies full-game read. |
| [filter-english.ts](../../scripts/filter-english.ts):16,69–73 | R normally/preview; W with `--remove`: unbounded ID-list delete. |
| [remove-ignored.ts](../../scripts/remove-ignored.ts):18–25,36–37 | W: projected full read and selected-ID delete; no preview flag. |
| [remove-played.ts](../../scripts/remove-played.ts):18–25,36–37 | W: same for upstream Playtime. |

## Aliases, tooling and non-consumers

- [import-steamspy-catalog.ts](../../scripts/import-steamspy-catalog.ts):2–9 and [refresh-steamspy-catalog.ts](../../scripts/refresh-steamspy-catalog.ts):2–9 delegate to official catalog `main`, including flags/initialization/writes (#23). `bun run import` invokes the first. They are not unused old imports.
- [package.json](../../package.json):7–26 wraps add/list/recalc/catalog/deals/import/hydrate-tags/hydrate-daily/browser sync. `doppler ... --config dev` does **not** establish an isolated database.
- [drizzle.config.ts](../../drizzle.config.ts):3–10 plus `db:generate`, `db:push`, `db:studio`, `db:setup-worker`: generation knows only two tables; push is direct Turso schema W; Studio directly inspects Turso. `drizzle/` is ignored; no versioned SQL exists at baseline. #19 supplies complete `migrations/`; #24 supplies documented, working D1-safe generation/setup/inspection replacements. No routine account API credentials or continued Turso default.
- [scripts/cloudflare-secrets.ts](../../scripts/cloudflare-secrets.ts):3–96 and `web`/`worker:dev`/`secrets:dev`/`secrets:sync` wrappers download Turso secrets, write `.dev.vars` or upload Worker secrets (#20 selection; #27 runbooks). Do not use these baseline wrappers for isolated verification or run them during preparation.
- [deploy/arcane/README.md](../../deploy/arcane/README.md), [arcane.env.example](../../deploy/arcane/arcane.env.example), [.env.example](../../.env.example), [README.md](../../README.md) contain direct-Turso setup/credential guidance (#22 job templates; #27 final runbooks). Preserve the Steam cookie in Steel, never in the Worker/new database credential set.
- No application database access in `scripts/{lookup-hltb,search-hltb,test-wikidata,test-wikidata-bmw,sync-hltb-map,steam-login,steam-get-refresh-token}.ts`, scraper/provider lookup modules or [build-worker.ts](../../scripts/build-worker.ts). `sync-hltb-map` writes local JSON; legacy login tools handle credentials, not tables. [src/web/app.ts](../../src/web/app.ts) uses the human HTTP interface, not SQL. These tools were not executed for this inventory.
- Test-only ninth constructor: [src/worker/games.test.ts](../../src/worker/games.test.ts):31–45 (`file::memory:` libSQL, incomplete games DDL plus deal initialization). #19/#21 replace relevant database assurance with isolated real D1, not a production consumer.

## Seven application tables: source declarations only

These candidates are **not certified live schema**. Five tables exist only as raw DDL; `sync_state` has conflicting declarations. All stored timestamp integers below are Unix **seconds**. Drizzle timestamp-mode fields decode to `Date`; raw Worker DTOs expose numeric seconds. `release_date` stays text. JSON stays text, including offer deadlines/nulls in [deal-types.ts](../../src/services/deal-types.ts):5–18.

| Table and declaration pointer | Columns, constraints and defaults |
| --- | --- |
| `games` — [schema.ts](../../src/db/schema.ts):3–38 | 31 columns: INTEGER `id` PK AUTOINCREMENT; unique/non-null INTEGER `steam_app_id`; non-null TEXT `name`. Nullable INTEGER `steam_review_score`, `steam_review_count`, `hltb_id`, `playtime_minutes`; nullable REAL `hltb_main`, `hltb_main_extra`, `hltb_completionist`, `value_score`; nullable TEXT `controller_support`, `release_date`, `tags`. Fifteen nullable INTEGER boolean fields listed below, SQL default 0. Nullable INTEGER `created_at`, `updated_at`: **client-only** Date defaults/update callback, no declared SQL time default. No tags JSON CHECK. |
| `sync_state` — [steam-status-sync.ts](../../src/services/steam-status-sync.ts):79–94; also [schema.ts](../../src/db/schema.ts):40–55 | TEXT PK `key`; nullable INTEGER `last_attempt_at`, `last_success_at`, `lock_expires_at`; nullable TEXT `last_error`. INTEGER `is_running`, `ignored_count`, `wishlist_count`, `owned_count`, `games_updated`, `games_removed` NOT NULL DEFAULT 0. Raw INTEGER `updated_at` **NOT NULL DEFAULT (unixepoch())** versus nullable Drizzle timestamp with client-only default/update. Used key `steam_status`. **Unresolved live drift gate**, not permission to guess. |
| `catalog_refresh_state` — [refresh-steam-catalog.ts](../../scripts/refresh-steam-catalog.ts):188–203 | TEXT PK `key`; INTEGER `last_app_id`, `min_reviews`, `apps_seen`, `processed_count`, `inserted_count`, `updated_count`, `skipped_count`, `unchanged_count`, `failed_count` NOT NULL DEFAULT 0. Nullable INTEGER `started_at`, `completed_at`; nullable TEXT `last_error`; INTEGER `updated_at` NOT NULL DEFAULT (unixepoch()). Used key `steam_official_catalog`. |
| `catalog_refresh_failures` — same:204–210 | INTEGER PK `steam_app_id`; TEXT `name`, `error` NOT NULL; INTEGER `attempts` NOT NULL DEFAULT 0; INTEGER `last_attempt_at` NOT NULL DEFAULT (unixepoch()). Preserve attempts increments, not replacement with 1. |
| `itad_game_map` — [game-deals.ts](../../src/services/game-deals.ts):9–11 | INTEGER PK `steam_app_id`; nullable TEXT `itad_id` (null = checked/unmapped, not absent); INTEGER `checked_at` NOT NULL. |
| `game_deal_cache` — same:12–17 | Composite PK `(steam_app_id,country,kind)`; INTEGER `steam_app_id`, TEXT `country`, TEXT `kind` all NOT NULL; `kind` CHECK retail/bundle; INTEGER `checked_at` NOT NULL; TEXT `offers_json` NOT NULL CHECK `json_valid`. Successful `[]` is data, not a failed/missing fetch. No declared FK/cascade to games. |
| `deal_refresh_state` — same:18–21 | TEXT PK `country`; nullable INTEGER `last_attempt_at`, `last_success_at`, `lock_expires_at`; nullable TEXT `last_error`, `lock_token`; INTEGER `games_checked` NOT NULL DEFAULT 0. US currently used; retain all source countries. |

Exact game boolean columns (15): `is_endless`, `is_on_wishlist`, `is_early_access`, `is_owned`, `is_ignored`, `has_single_player`, `has_multiplayer`, `has_co_op`, `has_online_co_op`, `has_local_co_op`, `has_pvp`, `has_online_pvp`, `has_local_pvp`, `has_crossplatform`, `is_mmo`. None is explicitly NOT NULL. TEXT primary-key declarations must retain actual SQLite nullability rather than infer NOT NULL from the label “PK”.

Explicit indexes in [setup-worker-db.ts](../../scripts/setup-worker-db.ts):14–20:

1. `idx_games_browse_default ON games(value_score DESC) WHERE value_score IS NOT NULL AND is_endless = 0 AND is_ignored = 0`.
2. `idx_games_browse_owned_playtime ON games(playtime_minutes, value_score DESC) WHERE value_score IS NOT NULL AND is_endless = 0`.
3. `idx_games_steam_app_id ON games(steam_app_id)` (separate from unique-key backing index).

Preserve PK/unique backing indexes and `sqlite_sequence` AUTOINCREMENT high-water state, even if higher than `MAX(id)`. Separate D1/migration/internal metadata from application tables. Source contains no other index/FK/trigger/view definitions; this is **not** evidence of their absence in production. Do not discard orphan mapping/cache rows during import.

Bootstrap is fragmented: Drizzle push creates two declared tables; setup ensures sync/three deal tables/indexes; non-dry catalog runs ensure their two tables. `CREATE IF NOT EXISTS` does not reconcile incompatible existing definitions. #19 must make bootstrap explicit and complete; #22/#23 remove runtime ensures.

## Used SQL/result capabilities and limit hazards

[Contract v1](d1-access-contract.md) defines the replacement, not a general libSQL clone.

- Raw usage: `execute(sql)` / `execute({sql,args})`, anonymous positional `?` with finite numbers, strings and null; booleans explicitly become 0/1. Readers consume named `.rows`, row zero/empty arrays, and distinguish null from zero. `rowsAffected` determines locks/renewal/publication/completion; it is not rows scanned/written. No direct insert-ID/column-type metadata use; `returning()` consumes row fields.
- Drizzle: relational `findMany/findFirst`, full/projected `select`, sequential single-row inserts (four `returning()` callers), per-ID updates, `inArray` updates/deletes. Boolean 0/1 and Date↔seconds conversions/defaults remain in Drizzle; defaults/`$onUpdate` add binds. Pinned versions in [bun.lock](../../bun.lock): libSQL 0.17.0 / Drizzle 0.45.1. SQLite-proxy callbacks require **positional selected-field order**, not plain D1 objects. Pinned Drizzle also wraps query errors with SQL/parameters in the message: #20 supplies `toDbError`, #24 normalizes existing catch/report/log paths (see contract references).
- No used named binds, BLOB/bigint, streaming, interactive transactions/savepoints, `executeMultiple`, `migrate` or Drizzle `db.batch`. Scheduled scripts use `close()`. Do not add unused SDK capabilities.
- Atomic write groups: Steam changed-game groups of 200, **5 binds/statement** ([steam-status-sync.ts](../../src/services/steam-status-sync.ts):462–469); score groups of 200, **2** ([recalculate.ts](../../scripts/recalculate.ts):44–58); catalog upserts **4**, default batch/checkpoint 200/50 ([refresh-steam-catalog.ts](../../scripts/refresh-steam-catalog.ts):450–477,664–668); offer groups up to **400 statements** from 200 games, cache deletion **4**, mapping upsert **6**, cache upsert **8**, including lease guards ([deal-refresh.ts](../../src/services/deal-refresh.ts):64–114). Provider batch size is not a bind count.
- Grouped offer reads use one `batch(...,"read")` for mapping/cache ([game-deals.ts](../../src/services/game-deals.ts):35–66); chunked statements must stay in one native transactional batch. Browse SELECT and offer group are separate, as are coverage/state reads, Steam lock/read/write groups/final state, and catalog flush/checkpoint. No whole-request or whole-job snapshot/transaction is promised.

| Hazard | Required downstream behavior |
| --- | --- |
| Offer cache query has country + N IDs = N+1 binds; populated 100/500 pages currently overflow. | #21: chunks of **99 IDs maximum**, mapping/cache statements in one read batch, recombine into original game order; do not lower public 500 limit. |
| Wishlist updates include flag + implicit timestamp + N IDs = N+2. | #24: **98 IDs maximum** at pinned Drizzle version, both true/false lists; count generated binds. |
| Three cleanup deletes have unbounded `IN` lists. | #24: **100 IDs maximum** with no extra binds; process every intended row, preserve preview/destructive semantics. |
| Literal full games import has 31 binds/row. | #26: at most **3 rows/statement** (93) before extra binds, or low-bind single-row statements; bound SQL bytes for dumps too. |
| Catalog `--batch-size` unbounded; offer JSON/group bodies can exceed limits. | #22/#23/#24/#26: bound independent work by contract bytes/count/time, never silently split a promised atomic group or change upstream fetching. |
| Full-table reads throughout manual tools/status/catalog/city-builders; offer/JSON scans, large browse offsets. | #21–#24: explicit complete pagination/aggregation where necessary; no generic silent result truncation. Measure synthetic extremes; live sizes/durations remain unknown. |

Existing semantics to retain: renewable UUID-fenced 15-minute offer lease; mapping-change deletion/publication atomic together; missing retail does not renew checked-at; independent bundles; freshness strictly `checked_at > now−86400` and `validUntil > now`; seven-day mappings. Steam uses a nonrenewed 15-minute expiry lock, fences final state by expiry but **does not fence game update groups**. Preserve these existing limitations, not a lease redesign. Catalog failure attempt increments are non-idempotent; provider retries are not permission to retry uncertain database writes. Missing `sync_state` currently maps to null via a recognizable error.

## Verification inventory and missing evidence

- [worker/games.test.ts](../../src/worker/games.test.ts):31–143: injected libSQL browse/offers/refresh tests, filters, empty/missing/unmapped, freshness/expiry, mapping age, 209-game provider batching, error/overlap/abandoned lease. No Worker fetch, faithful full schema, or populated 100/500 browse-page test.
- [steam-status-sync.test.ts](../../src/services/steam-status-sync.test.ts):27–87: pure count/authentication/drop and Playtime decisions, not persisted state/lock assurance.
- [refresh-steam-catalog.test.ts](../../scripts/refresh-steam-catalog.test.ts):4–124: pure parsing/normalization/change planning, not persisted checkpoint/failure/resume.
- [itad-client.test.ts](../../src/services/itad-client.test.ts):23–101: deterministic external HTTP/time fixtures, not database behavior.
- [deal-display.test.ts](../../src/web/deal-display.test.ts):32–298: pure rendering and intercepted headless-browser HTTP, mock pagination; no server/DB. No dedicated formula test at baseline.
- No real-D1 authorization/client/Drizzle/rollback/grouped-read-concurrency/full-schema-transfer/recovery/destructive-multi-chunk/city-builder database coverage exists at baseline. These are downstream evidence requirements, not claims made by documentation.
- [package.json](../../package.json):10–11 checks exactly [tsconfig.worker.json](../../tsconfig.worker.json), [tsconfig.web.json](../../tsconfig.web.json), [tsconfig.browser-sync.json](../../tsconfig.browser-sync.json). Most manual/shared-client/catalog/admin/migration code is not covered; Bun transpilation is not typechecking. #27 adds deliberate coverage.
- [CI](../../.github/workflows/ci.yml):20–38 tests/builds without production credentials. [Deploy](../../.github/workflows/deploy.yml):14–59 enforces tested/current main, serialization, exact artifact and Worker-scoped credential with `--keep-vars`; no schema migration. [wrangler.toml](../../wrangler.toml) has no baseline D1 binding. [Lefthook](../../lefthook.yml) checks staged secrets/comments, not types/tests. Preserve [comment policy](../../.comment-policy/README.md); no SQL-migration exemption.

## Integrated preparation status (#27)

Prepared integration audit starts from `2d8a075a24fc9bc5d2c88793d1b81f7ca7b69c53`, after #21–#26 closed with independent blocker verification. This section updates implementation status; the historical baseline above remains the capability/writer manifest, **not actual production inventory**. Existing production stays Turso. Both application and companion main merges remain held until separately approved provisioning/cutover. See [integrated evidence](d1-integrated-rehearsal.md), [credentials](d1-credentials.md) and [cutover/retention procedures](d1-cutover.md). Independent final Standards/Spec review and cleanup/closure remain parent-owned.

| Active surface | Prepared access / coverage |
| --- | --- |
| Worker `index.ts`, viewer `games.ts`, game/state/deal readers | Native `createD1Client(env.DB)` only. Existing human routes plus exact machine POST; no cached libSQL client, runtime schema initialization or fallback. Worker type project plus native request/viewer regression. |
| `src/db/client.ts` and every one of the 30 scripts above | One shared `createExternalClient(process.env)` for raw and SQLite-proxy access; explicit complete readers, bounded insert/wishlist/delete groups and safe ORM errors in `manual.ts`. All 30 preserved in `tsconfig.manual.json`; see [per-entrypoint status](d1-manual-tools.md#full-consumer-status). |
| `recalculate.ts` | Shared raw/ORM client, unchanged formula and independent 200-game atomic updates; no second constructor/destination. |
| Scheduled browser Steam Status, manual `hydrate-daily`, hourly `refresh-deals` | Four-key external factory and native groups; no ensures/DDL. Browser-sync types/tests include actual Bun entrypoints and Node 24/Playwright compatibility. `--login` is write-free and does not construct a DB client. Units/Steel/profile/schedules are unchanged. |
| Catalog `refresh-steam-catalog`, both SteamSpy aliases / `import` | Shared external factory, complete keyset reads and bounded native flushes; checkpoint/failure/resume and dry-run retained. Catalog type project covers all entrypoints/tests. |
| Setup/generation/inspection aliases | Explicit complete migrations/local native operator owner and read-only local or approved application inspection; no Turso push/Studio default. Offline `drizzle.config.ts` is credential-free and only a two-table model draft, not authoritative DDL. Manual/tools type projects cover these replacements. |
| Inventory/export/import/validate/recovery | Supplied native/source handles in `transfer.ts`, local-only CLI. The only remaining non-test `@libsql/client` import is **type-only** for the explicit read-only legacy source adapter; no constructor or environment lookup. Production handles/runner require separate approval. |
| `db:rehearse` | New explicitly local synthetic 500-game/all-seven-table actual Worker + raw/Drizzle + transfer/recovery workflow, included with its test in database-tools types. No source/account/provider discovery or deployment. |
| Secret wrappers / environments | `.env.example` and both arcane examples now contain blank prepared four-key names plus applicable provider keys. Only `STEAM_VALUE_DB_TOKEN` is selected for Worker sync. Wrappers still explicitly use Doppler `dev` and are privileged data/secret operations, not isolated setup. Browser cookie stays in Steel; legacy names remain documented only for current production and approved recovery. |
| CI/runtime/deployment | Original unprivileged CI and default-branch successful-current-main exact artifact/serialization/Worker Editor workflow are byte-unchanged from the spec baseline. No deploy/migration hook. Application `workers_dev = false`, explicit `preview_urls = false`; companion `enabled = false`, `previews_enabled = false`, empty cron preserved. Actual edge/credential behavior remains UNVERIFIED. |

The unused exported `ensureDealTables` function had no caller after convergence. #27 removes it and its legacy SDK type import; its duplicated runtime DDL is not an operator replacement. Complete immutable `migrations/0001_complete_schema.sql` remains authoritative and byte-unchanged. Application DDL now lives only in immutable history and explicit migration metadata/operator generation; no active request/job/imported runtime adapter performs bootstrap. `@libsql/client` remains a dependency for separately supplied legacy operator handles, not ordinary application access.

A seven-project `tsc --listFilesOnly` union checked every added/changed TypeScript file against baseline `299c9e20feb23dfb5aaa8913d16eafc94fcfd123`: **78 files, zero uncovered** (including transitive dependencies and the new runner/test). Normal `typecheck`/`build` invokes all seven; Bun transpilation alone is not counted. This is an audit, not an SDK/document-layout test. The subsequent [review-fix audit](d1-review-fixes.md) covers 82 files/zero uncovered, adding the provider producer/error contract and shared test bridge/test while retaining all seven projects. Build script and unrelated historical non-database tools were not rewritten/retired. Full tests retain v1 bounds, ordered ORM results, strong native read groups, affected-row leases and unknown-write/no-replay cases.

**Still UNVERIFIED:** the complete actual source schema/data/default/size/duration inventory, actual installed/manual/out-of-repo writers, Paid/eligibility/permissions, edge Access precedence and alternate-route rejection, actual Worker Editor binding deployment and every production data/provider/job/admin check. Source-only inspection and a synthetic all-table restore do not waive those approval gates or authorize #17/#28/#29 closure.

## Live-source drift and freeze gates

See [promotion/freeze gates](d1-acceptance-map.md#promotion-and-writer-freeze-gates). Source-only inspection cannot certify live completeness, schema equivalence, performance, subscription, installed jobs or a freeze.

Before final import, #26 tooling and separately authorized #28 operations must inventory **all** `sqlite_schema` objects, `table_xinfo`, index definitions/columns/partial predicates, FK/nullability/default declarations, triggers/views, internal metadata and `sqlite_sequence`. Capture all-table contents/keys/storage types, JSON/null/time/boolean conventions, maximum scalar/row/statement/response sizes, row counts and representative query durations. Diff against this baseline. Explicitly resolve `sync_state.updated_at`; identify extra/missing tables/columns/indexes/triggers/views and any unsafe integer values. Preserve authorized extra application objects through reviewed versioned schema/import changes or stop for the coordinator/owner; never auto-normalize/drop drift, synthesize SQL time defaults, or mark a mismatch acceptable merely because row counts match. Local #19 bootstrap is provisional until this comparison passes.

Before final snapshot, pause both persistent timers **and drain their services** ([status timer](../../deploy/arcane/steam-value-status-sync.timer), [status service](../../deploy/arcane/steam-value-status-sync.service), [offers timer](../../deploy/arcane/steam-value-deals-refresh.timer), [offers service](../../deploy/arcane/steam-value-deals-refresh.service)); services can run 10/45 minutes, timers jitter five minutes/catch up after downtime. Drain every W script above, catalog aliases, schema/setup/inspection mutation tooling, long enrichment/recalculation/analysis/cleanup and any out-of-repo writers. Actual arcane inventory is still unknown. Leases are not a global freeze; stopping timers does not drain processes.

Freeze includes implicit initialization and state writes: Steam ensure **before** lock/validation (:142–166); offers ensure **before** overlap rejection (:21–31); non-dry catalog ensure/state setup **before** provider fetch (:612–627). Rejected/no-change/error runs can still write locks, errors, counters, checkpoints and DDL. Baseline viewer GETs and shared-client import do not write. Do not introduce automatic initialization in requests/deploys. Keep the freeze through final export/import/all-table validation and coherent reader/writer switch; coordinate persistent-timer catch-up only after validation. No live-source read, remote migration, deploy, service operation or credential download is authorized by this inventory.
