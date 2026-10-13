# Catalog refresh preparation (#23)

The catalog CLI and historical `import-steamspy-catalog` / `refresh-steamspy-catalog` aliases now use the shared D1 external client. This is preparation under [#17's held promotion gates](d1-acceptance-map.md#promotion-and-writer-freeze-gates), not authorization to run a live catalog job, access production data, provision, deploy or cut over.

## Runtime behavior

- Configure the four application database keys from the [access contract](d1-access-contract.md), plus `STEAM_API_KEY` for the official Steam provider. There is no routine libSQL factory, Turso fallback, account credential or schema initialization in these entrypoints. Apply the complete migrations explicitly through the [bootstrap workflow](d1-local-bootstrap.md).
- Official fetching retains `IStoreService/GetAppList/v1/`, its default 50,000-app page size and cursor/limit behavior, and the all-language/all-purchase-type `appreviews` summary endpoint. Provider delays, timeouts and linear retries remain separate from database execution. HTTP status, invalid JSON and transport failures are diagnosable without echoing response bodies, URLs containing keys or raw transport errors.
- Existing catalog comparisons aggregate ordered, 1,000-row Steam-app-ID keyset pages until the final short/empty page. They do not assume a successful 10,000-row prefix is the full Game Catalog. These separate reads are not a whole-catalog snapshot; unsupported result sizes stop the job, not silently omit rows.
- Each upsert still binds four values and changes only name/reviews/update time on conflict. Other Catalog Facts, Steam Status, Playtime, HowLongToBeat Estimates, Value Score and creation time are preserved. Defaults remain 200 changes per atomic write group and checkpoints every 50 processed apps.
- `--batch-size` accepts at most 400 statements. Each flush remains one atomic shared-client batch. The shared client counts every bind, scalar/SQL byte bound and the entire serialized request against 4 MiB. An oversized requested group is rejected intact, never split into independent commits. This does not lower upstream Steam page sizes or discard intended work.
- Provider failures increment the per-app failure record once per attempted processing, including existing attempts, and contribute to the completed run's counters. Completed runs reset progress on the next ordinary invocation; incomplete runs resume from their stored app ID. Explicit restart/cursor behavior remains available. Completion stores the full `apps_seen` total even when no periodic checkpoint was needed.
- `--dry-run` performs reads/fetches/comparisons but never initializes, checkpoints, upserts, increments failure attempts, records run errors or marks completion. It ignores the saved cursor unless an explicit start-after flag is given. Both historical aliases delegate to the same CLI/job function, including this behavior.

## Failure and reconciliation boundary

Confirmed database rejection (`not-applied`) or native rollback (`rolled-back`) stops the run and records the safe error without advancing its confirmed checkpoint/counters. Known official app-list failures similarly leave an incomplete, diagnosable run. There are no database retries.

A rejected operation with `unknown` or `committed` write outcome stops immediately. No follow-up state/error write, checkpoint, completion, failure-attempt increment or later app processing is performed. The rejected `DbError` retains its code, outcome and request ID. A lost response may nevertheless have committed a game, failure increment, checkpoint or completion.

**Before invoking a resume/restart after such an outcome, inspect persisted state through the supported authenticated client and explicitly reconcile the affected business keys, failure attempts and counters.** Do not infer rollback from a CLI error or replay an uncertain attempts increment. Catalog flush, failure recording, checkpoint and completion are separate operations as before; the job is not one transaction and request IDs are not idempotency keys. A stopped run does not automatically reconcile a partially acknowledged refresh.

## Verification surface

`main(argv, { client, provider })` and the aliases exercise the approved CLI/injected-provider/job seam. Tests use a fresh `createD1WorkerTestHarness()` and `createHttpClient()` for each workflow, with deterministic Steam fixtures. HTTP boundary faults either consume and lose the actual native response, produce a real committed result-limit error, or cause a native constraint rollback. No database/adapter internals are mocked and no business tests assert statement counts for their own sake.

Coverage includes thresholds and preserved non-review fields, failure attempts and completion, interrupted resume/cumulative counters, catalog-table write-free dry-run, aliases, 10,001 existing games, 1,001 writes across full 400-statement groups, UTF-8 scalar/request byte rejection, native rollback, uncertain game/failure/checkpoint outcomes, empty resumed work/restart, and official fetching/retry/error diagnostics.

Catalog checks are added through `tsconfig.catalog.json` / `typecheck:catalog`; normal `typecheck` and `build` retain all five existing projects and include the new sixth project. Shared package/type changes must be reconciled with the other consumer branches during serialized integration.

Credential-free local commands used for verification:

```sh
env -i PATH="$PATH" HOME="$HOME" WRANGLER_SEND_METRICS=false bun --no-env-file test scripts/refresh-steam-catalog.test.ts
env -i PATH="$PATH" HOME="$HOME" WRANGLER_SEND_METRICS=false bun --no-env-file run typecheck
env -i PATH="$PATH" HOME="$HOME" WRANGLER_SEND_METRICS=false bun --no-env-file run build
```

Original catalog red/green evidence remains in `/tmp/steam-value-d1-23-evidence/`. The first submission was blocked despite all 25 catalog cases passing: its final unfiltered run reported 101 pass / 4 fail / 1 error in the unchanged operator/native-request fixtures. The subsequent [native fixture lifecycle repair](d1-catalog-test-repair.md) reproduces a late double-close of a workerd pipe after its descriptor is reused, adds shared fixture cleanup barriers and a released-scope regression, and records three consecutive unfiltered 106/106 passes without altering existing assertions or timeouts. Earlier failed candidates are retained, not erased. See the earlier [request-test repair record](d1-access-test-repair.md) for related history. This is local preparation evidence, not edge Access, production capability/data, deployment or cutover approval.
