# D1 manual consumers and explicit administration

Preparation for [#24](https://github.com/scowalt/steam-value/issues/24) under approved [#17](https://github.com/scowalt/steam-value/issues/17). Branch baseline: integration `0bf4735bf4c86087c5d89df47d89cc7860426791`. The [access contract](d1-access-contract.md), [consumer inventory](d1-consumer-schema-inventory.md), [bootstrap guide](d1-local-bootstrap.md), [native request-fixture repair](d1-access-test-repair.md) and [promotion/freeze gates](d1-acceptance-map.md#promotion-and-writer-freeze-gates) remain authoritative. Nothing here authorizes production access, secrets, provisioning, migration application, providers, jobs, deployment, arcane changes or promotion to main.

## Access, results and failure handling

All 30 historical entrypoints remain. They use the existing [shared client](../../src/db/client.ts), exporting `client` and `db` from the **same** `createExternalClient(process.env)` instance. Recalculation no longer creates a separate Turso client. Routine tools need exactly these database keys, plus their unchanged provider-specific keys where applicable:

- `STEAM_VALUE_DB_URL`: full HTTPS `/api/internal/db` endpoint.
- `STEAM_VALUE_DB_TOKEN`: application bearer credential.
- `STEAM_VALUE_ACCESS_CLIENT_ID` and `STEAM_VALUE_ACCESS_CLIENT_SECRET`: Access service-token credentials.

No ordinary manual tool reads Turso credentials or Cloudflare account API credentials. Existing Doppler convenience aliases remain for routine tools; **do not execute them during isolated preparation**, and do not assume `dev` selects an isolated database. Direct Bun entrypoints accept an explicitly prepared protected environment. Only explicit transfer/recovery tooling owned by #26 may retain Turso access.

[Manual operations](../../src/db/manual.ts) reuse the shared SQLite-proxy factory and original schema encoders/decoders. Relational first/full reads, projected field order, nullable booleans, Date-to-seconds conversion, client defaults/automatic update timestamps, JSON text, and `returning()` retain their types. Provider fetching, curated lists, ownership/Playtime decisions, enrichment fields and the Value Score formula are unchanged.

Database operations normalize SQL/client errors with `toDbError` **before** the script's existing per-item catch/report paths. Outer CLI reporting prints only normalized code/outcome/message/correlation. Recoverable, definite rejections retain the existing continue/count behavior; unknown or committed-but-undeliverable write outcomes stop the affected tool before more work or success accounting. Never print a `DrizzleQueryError`, its SQL/parameters/cause, or retry an uncertain write. Inspect business-key state through the supported interface before explicitly reconciling/resuming.

## Complete reads and mutation guarantees

- `readAllGames` deliberately aggregates ordered relational pages, initially 500 rows. Existing SQL ordering is retained with `id ASC` as a stable tie-breaker; previously unordered reads use ID order. `readAllRows` lets projected readers specify the same stable order on every page, without adding fields to the projection.
- Explicit total limits (for example tags `--limit`) span pages rather than cap one result. A confirmed **read-only** `RESULT_LIMIT/not-applied` reduces page size and repeats the same offset. No transport/SQL error or write is retried. A single unsupported row fails explicitly; no successful prefix is returned.
- Multi-page reads are **not a whole-catalog snapshot**. Run maintenance under appropriate exclusive writer ownership if stable catalog membership/order is required. Frozen consistent exports remain #26's explicit transfer seam.
- `insertGames` uses at most three complete 31-column games per statement (conservative maximum 93 binds, including every default). All statements for one supplied input execute in **one native atomic batch**, with typed `returning()` rows in input order. Existing provider-driven scripts still supply one independent game at a time; their entire loops are not newly advertised as transactions.
- Wishlist chunk size is computed from the generated statement's fixed binds: flag plus implicit timestamp leaves **98 IDs**. Both true/false lists share one native batch, strengthening the former two-statement boundary rather than committing chunk prefixes. Empty upstream wishlists remain no-change operations.
- Cleanup deduplicates selected IDs and binds at most **100 IDs** per DELETE. Every chunk shares one native batch. It does not delete mappings/cache or change the selection/provider semantics.
- Atomic groups are never split across HTTP calls. The shared client validates the whole group against 400 statements, SQL/scalar/request/response byte bounds. Unsupported groups fail before execution; late constraints roll back earlier chunks. An over-limit insert input is rejected, not silently partitioned into transactions. Operators may only partition genuinely independent work explicitly; do not weaken a promised cleanup/wishlist transaction to accommodate an unsupported catalog.
- Recalculation retains independent **200-game atomic groups**, original raw score/timestamp UPDATE and unchanged `calculateGameValueScore`. Known failures count the failed group; uncertain outcomes stop before later groups. Raw and ORM access share the same client/database.

## Full consumer status

All paths below are under `scripts/`; every row is migrated and included in [tsconfig.manual.json](../../tsconfig.manual.json). Provider-driven CLIs were **not** executed; observable database behavior is verified with synthetic catalog data at the approved maintenance/actual Worker/native-D1/Drizzle seams.

| Entrypoint | Status and preserved behavior |
| --- | --- |
| [list.ts](../../scripts/list.ts) | Complete read; SQL score/name order, original display/ranking filters. |
| [stats.ts](../../scripts/stats.ts) | Complete statistics/ranking read. |
| [top10.ts](../../scripts/top10.ts) | Complete read, original JS ranking. |
| [top10-filtered.ts](../../scripts/top10-filtered.ts) | Complete read, original >5-hour estimate filter/ranking. |
| [top10-unfiltered.ts](../../scripts/top10-unfiltered.ts) | Complete read, original unfiltered ranking. |
| [find-bad-hltb.ts](../../scripts/find-bad-hltb.ts) | Complete read, original suspicious-estimate report. |
| [add-game.ts](../../scripts/add-game.ts) | Relational first; bounded insert with all typed returning fields; all flags retained. |
| [add-from-steamdb.ts](../../scripts/add-from-steamdb.ts) | Complete existing-ID projection; independent insert, modes/controller/ignored fields. Ignored local `src/data/steamdb-raw.json` still required. |
| [add-batch.ts](../../scripts/add-batch.ts) | Historical curated batches/lookup/independent insert retained. |
| [add-batch3.ts](../../scripts/add-batch3.ts) | Historical list/lookup/independent insert; complete final count. |
| [add-batch4.ts](../../scripts/add-batch4.ts) | Historical list/lookup/independent insert; complete final count. |
| [analyze-top-games.ts](../../scripts/analyze-top-games.ts) | Lookup/returning insert plus complete report reads. |
| [analyze-100-games.ts](../../scripts/analyze-100-games.ts) | Lookup/returning insert/endless flag plus complete report read. |
| [analyze-batch2.ts](../../scripts/analyze-batch2.ts) | Lookup/returning insert/endless flag plus complete report read. |
| [hydrate-controller.ts](../../scripts/hydrate-controller.ts) | Complete null-controller score-ordered read; nullable per-ID update. |
| [hydrate-early-access.ts](../../scripts/hydrate-early-access.ts) | Complete read; changed boolean update. |
| [hydrate-game-info.ts](../../scripts/hydrate-game-info.ts) | Complete read; early-access/controller update. |
| [hydrate-game-info-fast.ts](../../scripts/hydrate-game-info-fast.ts) | Same database fields; original faster provider path/retries retained. |
| [hydrate-game-modes.ts](../../scripts/hydrate-game-modes.ts) | Complete read; original ten mode/MMO boolean updates. |
| [hydrate-release-dates.ts](../../scripts/hydrate-release-dates.ts) | Complete read; missing-date text updates. |
| [hydrate-tags.ts](../../scripts/hydrate-tags.ts) | Complete null-tags read with explicit total limit; original JSON encoding. |
| [hydrate-ownership.ts](../../scripts/hydrate-ownership.ts) | Complete read; original older ownership/nullable Playtime semantics. |
| [sync-wishlist.ts](../../scripts/sync-wishlist.ts) | Complete read; 98-ID chunks, flag/timestamp binds, empty guard, atomic set/clear. |
| [hydrate-hltb.ts](../../scripts/hydrate-hltb.ts) | Complete missing-estimate/non-endless read; original estimate updates, no recalculation. |
| [verify-hltb-batch.ts](../../scripts/verify-hltb-batch.ts) | Complete candidate read, existing `--limit`, `--dry-run`, verbose/checkpoint behavior. |
| [fix-hltb.ts](../../scripts/fix-hltb.ts) | Complete repeated name-match reads; original estimate/Value Score corrections. |
| [recalculate.ts](../../scripts/recalculate.ts) | Complete ORM read and coherent raw writes, 200-game groups and original algorithm. |
| [filter-english.ts](../../scripts/filter-english.ts) | Complete read; preview/default remains write-free; only `--remove` invokes atomic cleanup. |
| [remove-ignored.ts](../../scripts/remove-ignored.ts) | Complete projected read; explicit destructive invocation retains no-preview CLI contract. |
| [remove-played.ts](../../scripts/remove-played.ts) | Complete projected read; explicit destructive invocation retains no-preview CLI contract. |

**Intentional cleanup is admin work:** `filter-english --remove`, `remove-ignored` and `remove-played` remain deliberately destructive commands, never ordinary initialization or part of scheduled refresh. Review their selected games and coordinate writer ownership before invoking them. Their selection semantics and original flags are not silently changed. No cleanup command was run against a live database.

## Working operator replacements

The four historical package names remain, with explicit D1-safe replacements rather than Turso defaults or no-ops. They contain **no Doppler wrapper**:

| Historical command | Replacement |
| --- | --- |
| `db:generate` | `scripts/db-generate.ts`: validates complete immutable history plus reviewed candidate SQL on disposable native D1, then appends the next numbered SQL file without overwriting history. |
| `db:push` | `scripts/db-migrate.ts`: explicit local checksum/schema-aware migration application; requires `--local --persist-to`. Not Drizzle schema diff/push. |
| `db:setup-worker` / `scripts/setup-worker-db.ts` | Same explicit bootstrap implementation/receipt as `db:push`, including all seven tables/indexes, not the old partial runtime ensures. |
| `db:studio` (also `db:inspect`) | `scripts/db-inspect.ts`: read-only schema/index definitions, all-seven-table counts and optional bounded samples; explicit local or application scope. CLI JSON replaces direct-Turso browser Studio/SQL mutation. |

### Generation

`migrations/` is authoritative for all seven tables. Prepare reviewed SQLite SQL in a local file, then:

```sh
bun run db:generate --name add_operator_note --sql-file /absolute/path/reviewed-candidate.sql
```

`--migrations-dir <directory>` supports an explicitly selected isolated history for rehearsal. Generation applies existing history plus candidate only to a disposable real D1 binding; a failed candidate produces no file and safe diagnostics. The receipt gives ID/checksum/schema fingerprint/path. Previous history is rechecked and existing filenames are not overwritten. This is validation of a **draft**, not approval or application to persistent/production data. Use exclusive operator ownership of history, review the generated file, and commit through the normal preparation/promotion gates.

[drizzle.config.ts](../../drizzle.config.ts) is credential-free `sqlite`, with offline ORM-model drafts in ignored `drizzle/model-drafts/`. It models the existing two ORM tables only, **not** the authoritative seven-table migration history; direct `drizzle-kit push/studio` are not supported D1 operations. Do not substitute a two-table model diff for complete generation or edit an applied migration. The provisional `sync_state.updated_at` drift gate is unchanged.

### Local setup/push and inspection

```sh
scratch=$(mktemp -d /tmp/steam-value-d1-manual.XXXXXX)
bun run db:push --local --persist-to "$scratch"
bun run db:setup-worker --local --persist-to "$scratch"
bun run db:studio --local --persist-to "$scratch"
bun run db:inspect --local --persist-to "$scratch" --table games --limit 50 --offset 0
```

The same `<directory>/v3/d1` storage/DB identity is used as #19 bootstrap. Setup reapplication checks history/schema and reports already-applied IDs; no reset/adoption/automatic drift repair. Inspection never bootstraps a missing database. Samples explicitly return only the requested page (`limit` 1–1000); use `--offset` for another page. Table selection is restricted to the seven application tables, not arbitrary SQL. Counts cover all rows regardless of the sample bound.

`bun run db:inspect --application [--table games --limit 50 --offset 0]` uses only the four application/Access keys through the Worker route. It is read-only but still requires separately authorized remote access; **do not run it during preparation**. Operator output can contain real schema and game data; keep it private and out of public logs/artifacts. There is no public SQL UI or routine account-credential requirement.

All commands have credential-free `--help`. Missing scope/persistence, unsupported flags (including `--remote`), or missing application credentials fail closed. Remote schema application is **not** a routine endpoint operation: it remains the explicit native `applyMigrations` operator API and separately approved #28 runbook/capability. Runtime requests, builds and ordinary deploys never call it.

## Verification and boundaries

The added [manual behavior suite](../../src/db/manual.test.ts) uses `createD1WorkerTestHarness()` plus `createHttpClient`/`createDrizzleDb`, synthetic catalogs and boundary-only transport fault injection. It proves 10,001 complete results, stable/filtered/limited/projected reads, adaptive wide-JSON reads, 205 inserts with Date/boolean/JSON/returning fidelity, 123 wishlist-set plus 112-clear games, 205 cleanup selections, late-insert rollback, cleanup preflight, over-limit atomic rejection, enrichment/Playtime fidelity, batch first/absent/projected mapping, 404 raw/ORM recalculation updates across three 200-game groups, and lost-response stop without replay/later-group writes.

[Operator tests](../../scripts/db-manual-tools.test.ts) exercise explicit native bootstrap/generation/local inspection, historical setup repeatability, failed-generation nonpublication/safe errors, no implicit bootstrap, remote-flag rejection and missing application configuration. Existing request/authorization/rollback/deadline tests remain unchanged. Tests do not execute providers or live CLIs.

```sh
env -i PATH="$PATH" HOME="$HOME" WRANGLER_SEND_METRICS=false bun --no-env-file test
env -i PATH="$PATH" HOME="$HOME" WRANGLER_SEND_METRICS=false bun --no-env-file run build
```

The first complete unfiltered #24 run on base `0bf4735` passed **105 tests / 584 assertions** in 68.20 seconds. All five existing TypeScript projects remain; normal typecheck/build adds the broad manual/operator project. Minimal transitive type fixes retain the previously effective controller method (remove only its shadowed duplicate) and established regex/array bounds, with no provider algorithm change. Red/green slices and unfiltered/build/policy evidence are in `/tmp/steam-value-d1-24-evidence/` for the coordinator; final branch/commit/merged-integration evidence is supplied in the handoff.

Concurrent #21 viewer/read, #22 job, #23 catalog and #26 transfer business files are not edited by #24. Source schema remains provisional; live drift/performance, edge Service Auth, deployment-token capability, production provisioning/cutover and retention remain separate unmet owner gates. Preparation-only checks do not close #17 or authorize main promotion.
