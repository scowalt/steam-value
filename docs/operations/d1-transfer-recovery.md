# Explicit D1 transfer and data-aware recovery (#26)

Preparation under [#17](https://github.com/scowalt/steam-value/issues/17), [ADR 0004](../adr/0004-move-database-to-cloudflare-d1.md), [contract v1](d1-access-contract.md) and the [held approval gates](d1-acceptance-map.md#promotion-and-writer-freeze-gates). Read the [source inventory](d1-consumer-schema-inventory.md), [bootstrap guide](d1-local-bootstrap.md) and the [request-fixture](d1-access-test-repair.md) and [native ownership repair](d1-catalog-test-repair.md) records. **No actual source data/schema has been obtained or inventoried.** Source completeness, `sync_state.updated_at`, extra objects, production sizes/durations, credentials and provisioning remain #28 approval gates.

## Handles, not a runtime administration endpoint

`src/db/transfer.ts` exports the five approved operations:

| Operation | Evidence and boundary |
| --- | --- |
| `inventorySource(source, destination?)` | Complete reviewed schema plus bounded all-table typed content inventory/digests/sequence. An optional destination writes a private inventory and completion receipt; nothing is logged. |
| `exportSnapshot(source, destination, freezeRecord)` | New protected snapshot directory, all seven table files, complete manifest and export receipt. A second full schema/content/sequence inventory must match before completion. |
| `importSnapshot(target, snapshot)` | Preflight integrity of every file, reviewed bootstrap/history, explicit empty/staging intent and pristine target. Bounded independent native batches, durable incomplete receipt before writes. Never append/retry/reset. |
| `validateSnapshot(target, snapshot)` | Completed matching import receipt, complete schema/typed content/sequence equality, then required representative behavior assertions and a second content check. Only this can mark the import validated. |
| `prepareRollback(source, baselineSnapshot, destination)` | Full frozen post-cutover snapshot, complete row delta and reconciliation-required receipt. Never reverts code or writes Turso. |

Snapshot arguments accept the returned `{ directory, manifest }` handle or a directory path. Operations always reload the on-disk manifest and verify protected files; an in-memory manifest cannot bypass checks.

`createD1TransferSource(binding, options)` and `createD1TransferTarget(binding, options)` take explicit native/operator bindings. They do not discover a database or initialize schema. The target adds `intent`, a **new** `receiptPath`, optional `AbortSignal` and a trusted `verifyBehavior` callback. Explicit `applyMigrations` on the selected target must happen first. Target intent is not permission to overwrite a populated database; even an empty table with a deleted-ID sequence is not pristine.

`createLegacyTransferSource(client, options)` adapts an **already supplied** libSQL client to a source-only read handle. Its SDK import is type-only; there is no libSQL constructor, credential lookup, connection on import or write/replay method in this tooling. Construction/closure of a separately authorized, read-only source client belongs only in the protected #28 transfer/rollback operator runner. Never use this adapter from ordinary jobs or instantiate a legacy SDK client during preparation/tests. Adapter tests inject an SDK-shaped read boundary backed by synthetic real local D1, with no legacy constructor, network or credential access; projected labels are used rather than assuming row-property enumerability. Routine jobs retain the four application-only keys in the access contract, not account/provider/Turso credentials.

`src/db/local-d1.ts` owns the small shared operator seam: `createLocalD1({ persistTo?, databaseNames? })` returns an actual native `binding` for `DB`, `getBinding(name)` for explicitly declared isolated fixture slots, and owned idempotent `dispose()`. Without persistence it is ephemeral; explicit persistence is exactly `<persist-to>/v3/d1`. The factory performs **no bootstrap**, creates no application tables and looks up no credentials. The migration CLI explicitly calls `applyMigrations` afterward; factory construction is not migration authorization.

`collectReleasedD1Owners()` and `disposeD1Runtime()` centralize the accepted Bun/Miniflare ownership barriers: collection before native allocation and after awaited disposal. Both existing Worker fixtures reuse this same boundary, including failed setup cleanup, without changing their defaults/interfaces. This is the documented local compatibility mitigation, not an upstream fix or a production behavior change. Do not duplicate it in transfer tests, patch dependencies or mask exits with synchronous subprocess capture.

The transfer library's only internally opened database is disposable local D1 used to derive the reviewed schema from immutable migrations. That reference, the isolated source/target fixture pool and `openLocalTransferHandle` all use the shared owner. The latter preserves its `{ binding, dispose }` interface and deliberately selected **local** storage, matching #19's `DB` identity, with no bootstrap. Neither helper can select a production account/database. The CLI is local-only; approved live runners must supply native/source handles explicitly. **No schema, PRAGMA, inventory or import selector has been added to `/api/internal/db`.**

## Frozen-source evidence and fail-closed drift

V1 accepts an attested held writer freeze, or an immutable copy whose consistent origin and lack of writers are independently established. It does not implement a generic libSQL transaction/backup API or make independently paged live reads consistent.

A `FreezeRecord` identifies the exact source and freeze record, Unix-second freeze time, evidence pointer, paused/drained writer lists, `manualWritersDrained: true` and `holdsUntilRelease: true`. Missing, mismatched, malformed, future or unheld evidence rejects before export. The source handle and export argument must describe the same record. **The operator must establish the freeze; writing this JSON does not pause anything.** Two matching scans detect observed violations, including a changed cell with unchanged counts, but cannot establish operational quiescence or detect every interleaving/net-zero write.

For approved source work in #28:

1. Inventory installed scheduled, manual and out-of-repo writers, including initialization/error/lease/checkpoint/schema writes. Use the [writer inventory](d1-consumer-schema-inventory.md#live-source-drift-and-freeze-gates), not a lease as a global freeze.
2. Pause both persistent timers and drain their services; drain all catalog aliases, enrichment, recalculation, ownership/wishlist/cleanup/setup work. Record actual acknowledgements. Preparation does none of these operations.
3. Supply a read-only source client/native handle and protected freeze record. Run inventory into a new private directory. Resolve every mismatch with the coordinator/owner before final export. Rehearse only with separately approved data access.
4. Hold the freeze through final export, explicit bootstrap/import, complete validation and coherent viewer/**all-writer** switch. Do not resume timer catch-up early or promote on a health check/export completion/imported receipt.

On schema drift, inventory/export with a destination also attempts a protected `schema-drift.json` containing all observed object definitions, table/column/index/FK descriptors, the reviewed schema and any unavailable descriptors. This is an **unresolved** diagnostic, not an importable/completed manifest. Unknown application contents remain untouched at the source; the tool never pretends an omitted extra table was exported. If diagnostic collection/storage itself fails, stop using the incomplete receipt and obtain separately authorized operator inspection rather than infer absence.

Inventory compares against a fresh local application of the unchanged versioned migration history: every `sqlite_schema` table/index/trigger/view definition; ordered `table_xinfo` columns/storage declarations/nullability/defaults/PK positions/hidden flags; table flags; FK declarations; index uniqueness/origin/partial flags and complete `index_xinfo` columns/order/collation. Raw SQL retains CHECK constraints and partial predicates. SQL/schema differences, even formatting differences, are conservative drift failures, not automatic normalization. Extra/missing triggers/views/objects are never dropped or silently carried into an incompatible target. Authorized changes require reviewed schema/tooling changes and an appended migration, not edits to committed SQL/checksums.

Known internal exclusions are **exact schema objects**, not prefix globs: the local `_cf_METADATA` table, `steam_value_migrations`, and its backing index. The manifest inventories their definitions separately; migration ID/checksum/schema receipts must match immutable history when present. A legacy source without this ledger records `sourceMigrationHistory: null`, not an invented history. `sqlite_sequence` is separately inventoried **and its data preserved**, not excluded. Other provider/statistics/Wrangler/libSQL metadata, including unfamiliar `_cf_*` objects, currently stops as unresolved drift for #28; no guessed metadata definition grants an exemption. Application backing indexes are included.

## Artifact encoding, bounds and receipts

All artifact directories must be owned, mode **0700**, outside every Git working tree; files must be regular, owned, mode **0600**, with no symlink/hardlink alias. Readers reject unsafe modes rather than silently chmod an existing artifact. Export/inventory destinations and import receipts must be new: no overwrite, destructive default or reset. Use protected operator storage, never a repository/ignored directory, public logs/issues, browser assets or an unapproved tailnet share. Manifests and receipts may also be sensitive. CLI diagnostics emit only fixed safe categories and summary/pointers, never SQL/binds, raw provider errors, credentials or data.

Manifest version 1 records source scope/identity, provisional schema status, schema/migration fingerprints and history, complete application schema descriptors, excluded metadata, freeze evidence, per-table column order/keys/storage-type histograms/counts/content digests/byte maxima and complete `games` sequence state. Each `<table>.jsonl` line is canonical JSON:

```json
{"rowid":7,"values":[["integer",7],["text","synthetic"],["null",null],["real",12.5]]}
```

That abbreviated encoding example is not a game row. Real files contain **every** column in schema order. Tags/offers are original JSON **text**, not parsed/re-encoded objects. Rowid is retained as well as all declared keys, preserving duplicate nullable TEXT-PK rows and deterministic restoration/delta identity. Every application row is retained, including orphan operational/cache rows, checked/null mappings, successful `[]`, all countries, nullable booleans, seconds, client-only game timestamps and deleted AUTOINCREMENT high-water state.

Only null, SQLite integer/real finite safe numeric values and UTF-8 text are supported. BLOB/bigint/unsafe integer/nonfinite/negative-zero or over-bound data stops explicitly, leaving the source untouched. Scalar text is bounded at 1,000,000 UTF-8 bytes, raw/encoded rows at 2,000,000 bytes. Reads use ordered rowid keyset pages of at most 64, reduced for wide rows, with completion checks. No all-table row array is allocated. File reading/digest/delta comparison streams bounded records. Corruption, noncanonical rows, duplicate/out-of-order rowids, missing files, unexpected schema or unsupported sequence state rejects; matching counts alone is insufficient.

Import uses single-row statements (32 binds for a full 31-column game plus rowid, below 100), at most 64 statements and below the 4 MiB serialized-work bound per native group; it never builds a literal unbounded dump. Integer/real tags govern explicit casts, including integer `sqlite_sequence` updates. Atomicity is **per native group, not whole import**. There is no transport/database retry.

Receipts are synced and atomically replaced in the protected directory. Before dispatch the import remains `status: incomplete`, with last **confirmed** per-table row progress and conservative `writeOutcome: partial-or-unknown`. A lost native reply may have committed even with confirmed count zero. Signal cancellation is checked between groups, not promised to cancel dispatched SQL. A crash leaves the previously durable incomplete receipt; missing/malformed receipts are also unpromotable. Success becomes `imported`, **not validated**. Failed validation removes a previous validated status and records a safe failed validation category. A validation receipt is evidence for a frozen state, not permission to skip fresh checks after later writes.

Recovery from failure/interruption: preserve the partial target, snapshot and receipt for inspection. Select and bootstrap a **new** isolated/staging target, choose a new receipt, re-run the entire verified import, then validate. Reapplying bootstrap is checksum/schema-checked and retains existing data/sequence; it does not clean a partial import. Re-import into the partial/populated target is rejected. Any disposal of the old target is a separate explicit operator decision; this tool has no cleanup/reset command.

## Representative behavior is mandatory

Full content/sequence equality is necessary but not sufficient. `verifyBehavior` must run assertions against the selected imported target using the existing Worker/request and external client seams, returning exactly these successful check identifiers only **after** assertions pass:

```ts
{ passed: ["viewer", "steam-status", "catalog-facts", "offers"] }
```

The callback is trusted reviewed operator code, not an authentication mechanism or an option to self-attest without testing. Verify representative browse/order/filter/typed Drizzle results, Steam Status seconds/booleans/state/lease fields, Catalog Facts checkpoint/failure attempts and offer JSON/null/empty/country results. Preserve read-only validation; a second full content scan rejects a callback that modified data. Consumer #21–#24/#27 owns the complete viewer/job/large-page/lease regression suite and hosted #28 verification, not a promise that sample queries prove every job.

`createD1WorkerTestHarness({ operatorSetup })` explicitly imports through the native transfer seam **before requests** into the very same isolated D1 used by the actual bundled Worker. The callback is fixture setup, not a runtime binding backdoor or second SQL endpoint. Tests then assert the actual public `GET /api/games` response and use `createHttpClient(harness.clientConfig)`/`createDrizzleDb` for typed job/behavior/allocation observations, always disposing the harness. Ordinary consumer setup remains through the client.

CLI `validate` without a verifier checks the complete data/schema first, then stops with `BEHAVIOR_REQUIRED`; it cannot mark promotion-ready on counts. Its optional `--verify-with` requires an owned mode-0600 reviewed module outside Git exporting a default async verifier that receives a shared native `DbClient`. This is an explicit local operator extension, not loaded on import or discovered from environment. Full request-level evidence uses the shared native Worker fixture or the approved target Worker client. Never print callback errors/results/data.

## Local commands and rehearsal

No secrets, provider access, Doppler, `.dev.vars`, remote flags or browser/development server are needed:

```sh
bun install --frozen-lockfile
bun --no-env-file scripts/db-transfer.ts --help
bun --no-env-file test src/db/transfer.test.ts scripts/db-transfer.test.ts
bun --no-env-file run typecheck
bun --no-env-file run build
```

Example empty local procedural rehearsal (the tests above use **populated all-table** synthetic snapshots):

```sh
umask 077
source_dir=$(mktemp -d /tmp/steam-value-transfer-source.XXXXXX)
target_dir=$(mktemp -d /tmp/steam-value-transfer-target.XXXXXX)
artifacts=$(mktemp -d /tmp/steam-value-transfer-artifacts.XXXXXX)
bun --no-env-file scripts/db-migrate.ts --local --persist-to "$source_dir"
bun --no-env-file scripts/db-migrate.ts --local --persist-to "$target_dir"
bun --no-env-file -e 'await Bun.write(Bun.argv[1], JSON.stringify({mode:"frozen-writers", sourceId:"local-source", recordId:"isolated-local", frozenAt:Math.floor(Date.now()/1000), evidence:"isolated local database; no scheduled/manual writers started", writersPaused:["local-operator"], writersDrained:["local-operator"], manualWritersDrained:true, holdsUntilRelease:true}))' "$artifacts/source-freeze.json"
bun run db:transfer inventory --local --persist-to "$source_dir" --id local-source --freeze-record "$artifacts/source-freeze.json" --destination "$artifacts/inventory"
bun run db:transfer export --local --persist-to "$source_dir" --id local-source --freeze-record "$artifacts/source-freeze.json" --destination "$artifacts/snapshot"
bun --no-env-file -e 'const value=await Bun.file(Bun.argv[1]).json(); value.sourceId="local-target"; await Bun.write(Bun.argv[2], JSON.stringify(value))' "$artifacts/source-freeze.json" "$artifacts/target-freeze.json"
bun run db:transfer import --local --persist-to "$target_dir" --id local-target --freeze-record "$artifacts/target-freeze.json" --intent staging --snapshot "$artifacts/snapshot" --receipt "$artifacts/import.json"
bun run db:transfer validate --local --persist-to "$target_dir" --id local-target --freeze-record "$artifacts/target-freeze.json" --snapshot "$artifacts/snapshot" --receipt "$artifacts/import.json"
```

The last command deliberately stops at the required behavior gate without a reviewed verifier. Supply `--verify-with <private-reviewed-module>` or use an explicitly configured API target/Worker fixture with actual assertions to complete validation. Never interpret an empty procedural example as populated migration evidence. Retain the artifacts until explicitly deciding to remove only your own disposable local directories.

Tests exercise positive seven-table typed restore, NULL-key duplicates, orphans, all defaults/keys/index inventory, UTF-8/JSON/seconds/Drizzle booleans, 259 full-game rows crossing pages/groups, sequence 900→901 (including a game-empty/deleted-only catalog), same-count corruption/mutation, freeze violations, incompatible objects/internal metadata/history, unsupported sizes/storage/integer extremes, protected file/directory/symlink/hardlink rules, pre-dispatch cancellation, cancellation after a committed group, lost post-commit native reply, incomplete validation refusal and fresh explicit restore. Native faults are injected only at the external binding reply/cancellation boundary **after real isolated D1 executes**, not with a mocked database. The ordinary shared request fixture/assertions/timeouts are preserved. Longer combined operator/CLI rehearsals declare 15-second allowances because they run multiple real bootstraps/scans/processes; no request test timeout or SQL retry was changed.

After merging accepted integration `44698212110d001ac44d321ce06d853c6fdf3287` (including the `32e4f6e` ownership repair), local verification passes **60 transfer/bootstrap/lifecycle tests / 235 assertions**, all **six** TypeScript projects and the production build. Three independent serial **unfiltered** full runs each pass **151 tests / 971 assertions / 11 files**, retaining the real 45-second request deadline and every original timeout/assertion. Comment policy and its **13** regressions and staged secret checks also pass. This verifies the integrated local tree, not production promotion or unmerged consumer changes.

The new released-scope native operator regression proves no implicit application schema, explicit checksum bootstrap, independent bindings and ten subsequent asynchronous process exits. With only the shared collection boundary withdrawn it fails at the unchanged **5,000 ms** limit; restoring the boundary passes. Positive persistence evidence seeds native row 700, deletes allocation 900 and retains an orphan mapping, closes the owner, reapplies the explicit migration CLI, then exports through a reopened native handle: row/typed UTF-8/JSON/boolean/seconds and high-water 900 remain, while a separately selected target stays empty. CLI capture again uses asynchronous `Bun.spawn`/`.exited`, not the earlier diagnostic `spawnSync` candidate.

Earlier red runs (`EBADF`, control-pipe failure and teardown timeout) and discarded diagnostic candidates remain under `/tmp/steam-value-d1-26-evidence/`; they were not accepted as repairs. The measured cause and exact compatibility boundary are recorded in the [shared repair](d1-catalog-test-repair.md). New red→green/persistence/full-suite/build evidence is in its `shared-native/` subdirectory, with owned directories **0700** and files **0600**. Durable tests are the reproducible evidence; no source snapshot/receipt is checked into Git. Initial worktree was clean at integration `0bf4735bf4c86087c5d89df47d89cc7860426791`; shared-file overlap remains coordinated with the merger. Immutable migration `0001_complete_schema.sql` retains SHA-256 `bcb5a3738c65336b9af697be9816d3039edffd9da0ef627cc50da5ecf5d0a83a`.

### Recheck with accepted refresh jobs (#22)

Merged latest accepted integration `4c59cce9249fc46558c4efe489221fe15729a119` into #26. The shared native owner, migration CLI adoption, operator/default bootstrap and test callbacks are byte-identical to `5cd9772247b54a4dd6795bd52dec8fb34dadf6c3`; no transfer algorithms, interfaces or migration bytes changed. The full suite now includes all 38 accepted Steam Status/offer/job cases, including native Node 24/Playwright loading and fake-provider manual/hourly entrypoints.

| Protected artifact | Unfiltered result | Assertions | Files | Duration |
| --- | --- | --- | --- | --- |
| `jobs-integration/full-1.log` | 189 pass / 0 fail | 1109 | 14 | 138.52 s |
| `jobs-integration/full-2.log` | 189 pass / 0 fail | 1109 | 14 | 139.69 s |
| `jobs-integration/full-3.log` | 189 pass / 0 fail | 1109 | 14 | 141.70 s |

`jobs-integration/build-six-projects.log` passes the normal six-project typecheck and production build. Comment policy checks 154 files without violations; all 13 policy regressions, whitespace and secret checks pass. Evidence remains owned mode-0700 directories/mode-0600 files under `/tmp/steam-value-d1-26-evidence/`. These are local preparation checks only; every live-source, deployment, cutover and retention approval remains held.

## Manual rollback and retention gates

Freeze/drain **again** before rollback preparation and use a new attestation for the actual post-cutover D1 source. Supply the approved final baseline snapshot and a new protected destination:

```sh
bun run db:transfer prepare-rollback --local --persist-to <isolated-post-cutover-directory> --id <label> --freeze-record <private-freeze-file> --snapshot <baseline-directory> --destination <new-recovery-directory>
```

For approved live D1 use the explicit native/operator API, not this local command/any runtime SQL selector. Preparation preserves the full post-cutover manifest/table files plus `reconciliation.jsonl` and `rollback-receipt.json`. A streaming merge compares every baseline/current row (including deleted rows, attempts, orphan records and key changes), records full before/after typed rows, per-table added/deleted/changed counts, both manifest digests and sequence change. Delta identity is preserved rowid; reviewers must use the recorded declared keys/complete values when reconciling. The delta is **not an automatically replayable SQL plan**.

Every completed preparation returns `reconciliation-required`, even with no observed changes, and `automaticReversion: false`. Partial recovery preparation remains incomplete. Preserve post-cutover updates and explicitly review/reconcile the delta into the intended destination, validate restored full schema/content and representative behavior, then obtain/coordinate manual reader/**all-writer** reversion. Neither ordinary Worker version rollback nor keeping Turso is database rollback. No automatic fallback, dual-write, Turso replay or Worker revert is implemented.

#28 must establish source/resource/subscription/edge-Access/deployment-token/cutover approvals, actual-source drift resolution, installed writer freeze and authenticated final data/job evidence. #27 must consolidate all consumers and independent review. #29 retains Turso read-only and validated exports for **at least seven days** from the recorded cutover, then requires an explicit owner decision for deletion/credential retirement or continued retention. This tooling performs no retention deletion, provider operation, deploy/apply, arcane/main mutation, ticket write or agent launch. Local evidence cannot waive any of those gates.
