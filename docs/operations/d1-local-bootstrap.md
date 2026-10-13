# Explicit local D1 bootstrap and Worker fixture

[#19](https://github.com/scowalt/steam-value/issues/19) implements the bootstrap/fixture portion of the [access contract](d1-access-contract.md), under the [held preparation gates](d1-acceptance-map.md#promotion-and-writer-freeze-gates). Read the [source inventory](d1-consumer-schema-inventory.md) and [ADR 0004](../adr/0004-move-database-to-cloudflare-d1.md) for scope. This is isolated local preparation, not production provisioning, live schema certification, import validation or cutover authorization.

## Provisional source schema

`migrations/0001_complete_schema.sql` versions seven application tables, the three explicit game indexes, and the source Drizzle unique index `games_steam_app_id_unique`. Pinned Drizzle's offline generation confirms the `games.id` NOT NULL declaration and named unique index; it does not inventory a live database.

- All stored timestamp integers are Unix **seconds**. `release_date` remains text.
- The fifteen nullable game boolean columns default to integer 0; no new NOT NULL or boolean-domain CHECK is invented. `tags` is nullable text without a JSON CHECK.
- `games.created_at` and `games.updated_at` have **no SQL default or automatic SQL update**. Their Date defaults/update callback remain client-only in Drizzle.
- `sync_state.updated_at` provisionally follows the raw service declaration: NOT NULL DEFAULT `(unixepoch())`. Its conflicting nullable/client-default Drizzle declaration remains an unresolved **authorized live drift gate**. Raw TEXT primary-key nullability is retained for operational state tables.
- `offers_json` remains JSON text with `json_valid`, and `kind` permits retail/bundle. A stored `[]` and a checked/null mapping are distinct from missing rows. No game foreign keys/cascades are added; orphan mapping/cache rows remain valid.
- `games` retains AUTOINCREMENT. Bootstrap never resets data or `sqlite_sequence`; deleted-ID high-water state remains intact. Explicit import/restore of high-water state belongs to #26.

**The entire source schema is provisional until separately authorized live inventory.** Extra/missing tables, columns, indexes, triggers, views, defaults, storage types or sequence values must be inventoried and explicitly resolved in #26/#28. Local evidence does not authorize dropping drift or modifying production. After this history is committed, append reviewed migrations rather than editing an applied SQL file.

## Local operator command

No Doppler wrapper, `.dev.vars`, production credentials, account ID, remote D1 call or development server is needed:

```sh
bun install --frozen-lockfile
scratch=$(mktemp -d /tmp/steam-value-d1.XXXXXX)
bun run db:migrate:local --persist-to "$scratch"
bun run db:migrate:local --persist-to "$scratch"
```

Both `--local` and an explicit `--persist-to` directory are required by `scripts/db-migrate.ts`. Unknown/remote flags and missing arguments fail before opening D1. `--help` is write-free. The JSON receipt contains `scope: "isolated-local"`, `schemaStatus: "provisional-source-schema"`, `applied`, `alreadyApplied`, and a SHA-256 `schemaFingerprint`. It contains no credentials or SQL parameters. Remove only your own disposable directory when finished.

The command uses Miniflare/workerd's **real D1 binding**, not libSQL or `bun:sqlite`. It persists under `<directory>/v3/d1`, matching Wrangler-local's binding-only `DB` identity while the production identifier is absent. For explicit local inspection, Wrangler's `d1 execute DB --local --persist-to <directory>` can use the same storage. Do not use remote flags, credential-download wrappers, or a different persistence directory and assume it is the same database.

`wrangler.toml` owns `binding = "DB"`, `database_name = "steam-value"`, `migrations_dir = "migrations"`, and local `remote = false`. **`database_id` is intentionally absent/unprovisioned**, not a guessed/example live ID. Production binding configuration requires separately approved provisioning/promotion. Existing assets, compatibility date, workers.dev and observability controls are unchanged. No request, import of a runtime adapter, build or ordinary deployment calls migrations.

Use the checksum-checking script above, not `wrangler d1 migrations apply`, for this history. Wrangler's ordinary filename ledger is not this bootstrap's immutable checksum/schema receipt. Do not mix bootstrap mechanisms on the same database or adopt an existing untracked schema automatically.

## Explicit native bootstrap API

`src/db/migrations.ts` exports:

- `DbMigration`: immutable `{ id, sql, checksum }`; IDs are strictly increasing four-digit SQL filenames, starting with `0001_complete_schema.sql`.
- `loadMigrations()`: explicitly loads and hashes the checked-in SQL history; no environment lookup or import-time execution.
- `migrationChecksum(sql)`: SHA-256 of the exact UTF-8 SQL bytes, including whitespace.
- `applyMigrations(binding, migrations)`: validates the entire supplied history before applying new work. Returns `MigrationReport` (`applied`, `alreadyApplied`, `schemaFingerprint`).
- `MigrationError`: safe `code`, `message`, optional `migrationId`. Codes: `INVALID_MIGRATION`, `MIGRATION_CHANGED`, `SCHEMA_DRIFT`, `MIGRATION_FAILED`.

Each migration and its receipt share **one native D1 transactional batch**. The first batch also creates `steam_value_migrations`; a failed first migration leaves neither schema nor receipt. Later migrations are separate transactions, not one whole-history transaction. Run under exclusive operator schema ownership; do not race another bootstrap or schema writer. On failure/uncertain interruption, inspect schema and receipts, then resume explicitly; there is no retry, automatic adoption, schema repair, destructive reset or migration inside the runtime SQL endpoint.

Receipts store ID, SQL checksum, application schema JSON and second-based application time. Repeat application checks the applied history and current schema before returning; changed checksums, missing/reordered applied migrations, incompatible metadata or untracked schema are rejected. The fingerprint hashes ordered `sqlite_schema` table/index/trigger/view definitions, including application backing indexes. SQLite storage/statistics tables, `_cf_*` D1 metadata, `d1_migrations` and `steam_value_migrations` are separate from the seven application tables. The fingerprint is **not** a content digest, live inventory or transfer manifest; sequence/content/storage-type validation belongs to #26.

The checked-in bootstrap uses simple SQLite statements. Quoted semicolons and escaped quote delimiters are supported; compound trigger bodies are not a promised parser surface. Any live triggers require explicit inventory and reviewed migration/parser support, never silent omission.

## Shared local native operator owner

`src/db/local-d1.ts` exports `createLocalD1({ persistTo?, databaseNames? })`. Its owned handle returns the actual native `binding` for `DB`, `getBinding(name)` for explicitly declared additional fixture slots, and idempotent `dispose()`. Storage is ephemeral by default or explicitly `<persist-to>/v3/d1`, preserving the migration CLI/Wrangler-local `DB` identity. Construction performs **no application bootstrap**, adds no application tables and discovers no credentials or production selector. Explicit operator code must call `applyMigrations` separately; always await disposal.

The migration CLI, transfer reviewed-schema reference, local transfer persistence and isolated transfer source/target pool use this owner. `collectReleasedD1Owners` and `disposeD1Runtime` centralize the [accepted native ownership boundaries](d1-catalog-test-repair.md) also reused by both Worker fixtures: collect before native allocation and after awaited disposal, including failed setup. They preserve the original fixture interfaces/default bootstrap; no private lifecycle implementation, SDK clone, retry, sleep or timeout increase is needed. The mitigation is local and Bun-specific, not a production initializer or upstream vendor fix.

Operator regression evidence includes no implicit schema, explicit migration, isolated bindings and released-scope disposal followed by ten asynchronous operator process exits. With only collection withheld, the new regression times out at its existing 5,000 ms limit; restoring it passes. [Transfer evidence](d1-transfer-recovery.md#local-commands-and-rehearsal) additionally proves populated persistence/reapplication interoperability, deleted high-water preservation and source/target separation. Native schema/PRAGMA/batch privileges stay outside `/api/internal/db`; ordinary business tests continue through the Worker/client below.

## Reusable Worker/D1 fixtures

`src/db/testing.ts` exposes two fixtures with the same `fetch`/`clientConfig`/`dispose` shape:

- **`createD1WorkerTestHarness(options?)` / `D1WorkerTestHarness`: use this for ordinary request, external-client and downstream #21–#24/#26 business tests.** It bundles the actual `src/worker/index.ts` using the production browser-target/minified build options and dispatches requests inside workerd, where `DB` is native. Default setup explicitly applies the complete immutable migration history. `D1WorkerTestOptions` allows `{ bootstrap: false }` only for intentional missing-schema/no-implicit-DDL probes. The optional `operatorSetup(binding)` callback runs after explicit bootstrap and before requests for [native transfer/import setup](d1-transfer-recovery.md); ordinary business setup still uses the Worker client. Only the bundle is cached per test process; every fixture gets a new runtime, storage and synthetic bearer token.
- **`createD1TestHarness(workerFetch)` / `D1TestHarness`: retain this for explicit supplied-handler/bootstrap, operator and handler-level edge probes.** Supply the actual existing handler, not a duplicate SQL endpoint. It bootstraps the same history and passes a real host-proxied `DB` plus synthetic `STEAM_VALUE_DB_TOKEN` in `D1TestEnv` to the supplied `WorkerFetch`. It runs the handler in Bun, not inside workerd. It is therefore not the ordinary business/request fixture: [integrated testing](d1-access-test-repair.md) found host-proxy bulk/result/lifecycle overhead at that seam.

Both return:

- `fetch(request)` (also accepts URL/init): the fixture's injected request transport. Native dispatch preserves method, headers, body bytes, abort signal and redirect mode, and streams the native response into the local Web Response without SDK casts. Supplied-handler dispatch preserves an existing Request when no init override is supplied, avoiding an unnecessary body clone/tee that can strand cancellation of oversized streams.
- `clientConfig`: synthetic HTTPS endpoint, bearer and Access credentials plus injected `fetch`, ready for `createHttpClient` and `createDrizzleDb`.
- `dispose()`: idempotent cleanup of the isolated Miniflare runtime; no production persistence. Always await it in `finally`/test cleanup.

Ordinary request/business setup:

```ts
import { createD1WorkerTestHarness } from "../../src/db/testing";
import { createHttpClient } from "../../src/db/http";
import { createDrizzleDb } from "../../src/db/drizzle";

const harness = await createD1WorkerTestHarness();
try {
  const client = createHttpClient(harness.clientConfig);
  const db = createDrizzleDb(client);
  const result = await client.execute("SELECT COUNT(*) AS count FROM games");
  console.log(result.rows);
} finally {
  await harness.dispose();
}
```

Own a fresh fixture per scenario and query/seed business state through the Worker/client interface, not raw binding backdoors. Fixtures are independent; native storage is ephemeral. Requests to another origin or after disposal are rejected. The URL is `https://d1-test.invalid/api/internal/db`; it is synthetic and is never contacted publicly. Miniflare uses disposable loopback sockets on ephemeral ports and disables CF metadata fetching. This is not a browser/development server. Local fixtures cannot verify Cloudflare edge Service Auth, deployment credentials, production subscription/capacity or live data drift.

## Verification

```sh
bun test src/db/migrations.test.ts scripts/db-migrate.test.ts
bun run typecheck:db
bun test
bun run build
```

The bootstrap tests exercise real isolated D1 at the explicit native seam: defaults, all-table records, nullable/required keys, JSON/kind constraints, partial/index definitions, sequence preservation, repeatability, changed-applied checksums, incompatible/untracked schema, transactional failure and ordered subsequent migrations. They do not backdoor-query business behavior; consumer tests use the native bundled-Worker request interface. Normal build/typecheck covers both database tools and database access alongside Worker, web and browser sync.

#19's preparation evidence is at `/tmp/steam-value-d1-19-evidence/`: individually captured red→green slices, credential-free Wrangler-local inspection, and actual #20 Worker/external-client smoke tests through this harness. Final local verification passed 64 Bun tests (192 passes with three repetitions), all four typecheck projects, production build, and 13 comment-policy regression tests. Earlier combined-suite runs exposed Bun/workerd startup `EBADF` before SQL execution during repeated process lifecycles. Schema tests now use a different ephemeral D1 binding for each test inside one disposable workerd process, preserving isolation while reducing lifecycle churn; the three-repeat full-suite check passes. No SQL/startup retries or runtime workaround were added. Keep the original diagnostic for #27 if it recurs in other fixtures; the vendor-level cause is not certified. The smoke tests used #20's concurrent working-tree implementation read-only because it was not yet in the integration tip; rerun against the integrated implementation after its merge. #20's integrated repair extends this shared module with `createD1WorkerTestHarness`; its existing 83-test suite exercises that native fixture, including the retained supplied-handler edge probes. See the [repair record](d1-access-test-repair.md) for repeated unfiltered checks and the measured request-seam distinction. #21–#24/#26/#27 own the remaining business/transfer assurance. No live schema/data access, deploy, provisioning, job or arcane operation is part of this verification.
