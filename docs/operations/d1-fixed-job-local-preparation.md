# Fixed-job native D1 local preparation (#31)

**Local code preparation only. Production remains Turso.** This implements the locally approved alternative for the unfinished native remote-import gate in [#28](https://github.com/scowalt/steam-value/issues/28), under [#17](https://github.com/scowalt/steam-value/issues/17) and [ADR 0004](../adr/0004-move-database-to-cloudflare-d1.md). It does not authorize or implement deployment, remote preview, account operations, actual source access/export, real credential setup, remote SQL, production cutover or resource cleanup.

Read the [existing transfer/recovery contract](d1-transfer-recovery.md), [bootstrap](d1-local-bootstrap.md) and [exact schema reconciliation](d1-observed-schema-reconciliation.md). The existing transfer CLI is still local-only and consumes an actual native D1 binding. No HTTP client is presented as `D1Database` and no general SQL/database-selector/reset endpoint is introduced. The production Worker, viewer/machine endpoint, jobs, Node 24/Playwright/Steel behavior, schedules, dependency versions and deployment configuration are unchanged.

## Host interface and protected artifacts

`src/db/fixed-job-host.ts` exports two operator operations:

| Operation | Contract |
| --- | --- |
| `prepareFixedD1Job(snapshot, destination, options)` | Reload and completely verify an existing protected snapshot; create a new protected job packet. Options fix `runId`, Unix-second `expiresAt` (future, at most one hour from preparation), explicit `targetId`, `intent: empty|staging` and the SHA-256 digest of a dedicated run capability. Returns `{ directory, job, digest }`. |
| `createLocalFixedD1JobRunner(options)` | Reload the actual packet using `jobDirectory`, externally reviewed `reviewedJobDigest`, original `snapshot`, explicit new local `persistTo`, new `receiptPath` and the dedicated `capability`. Authenticate before source/reference-database access; verify every artifact before opening a target. Returns the owned runner below. |

A returned digest identifies a candidate artifact; computing it is **not approval**. The reviewed job must be independently selected before execution. Mutating the returned in-memory `job` cannot bypass the on-disk checks. Re-signing changed group digests does not bypass complete equivalence with the original verified snapshot.

The packet contains:

- `job.json`: a small manifest, bounded to 1,000,000 bytes. It fixes one run/expiry, binding `DB`, logical target/intent, snapshot identity/digest, exact source profile and target/schema/object/metadata/migration fingerprints, complete table summaries and sequence, and ordered group fingerprints/counts/rowid bounds.
- `<index>.json`: canonical bounded typed row groups, outside the Worker build input. These retain every value, storage tag, rowid and target-column order from the verified snapshot.
- On execution, new exclusive `attempt.json`, `worker-entry.ts` and `worker.js`. The attempt records the selected local target path/receipt and prevents reusing that packet. Build inputs contain only the small reviewed manifest and the two immutable migration SQL files, **not the row export**.

Directories are owned mode 0700 outside Git. Files are owned regular single-link mode 0600, opened without symlink following. Existing unsafe modes, links, Git paths, receipts or targets are refused, not chmodded, adopted or overwritten. A failed preparation/build packet is not resumable by replacing files. Preserve it and choose a new explicitly reviewed packet when authorized.

The local factory creates exactly one fresh native `DB` under the new `persistTo/v3/d1` storage. The logical `targetId` is not an attestation of a Cloudflare account/database UUID. Actual remote resource identity and deployment binding configuration are separate future owner gates. There is no account/database discovery or credential lookup in this code.

## Owned runner

Always await disposal in `finally`, including after failure:

| Method | Meaning |
| --- | --- |
| `run()` | One attempt: protected preflight receipt/claim, fixed bootstrap, ordered row groups, sequence reconciliation and complete native data verification, then guarded durable publication. Calling it again returns that attempt's outcome, not a replay. |
| `read({ op: inventory|validate })` | Explicit read inspection while the native owner remains open. No automatic read reconciliation follows an unknown write. |
| `read({ op: page, table, cursor })` | Read only an allowed retained table, starting with `cursor: null`; follow the returned cursor until `complete: true`. Exact-size final pages may require a final empty request. |
| `cancel()` | Fence further host dispatch, await in-flight acknowledgement and outstanding reads, then await actual owned native disposal. Only then return `{ status: cancelled, nativeDisposed: true }`. |
| `dispose()` | Idempotently perform the same ownership close without returning the cancellation receipt. After successful import return, closure is not retroactive cancellation. |

The runner owns an actual local Miniflare/workerd Worker and native D1, using the existing accepted collection/disposal helpers. Internal SDK loopback sockets use allocated ephemeral ports; this is not a browser/development server. No persistent server, public share, manual proxy or remote preview is started.

Cancellation does not promise to undo or interrupt dispatched SQL. It waits for the current operation/acknowledgement to settle. If a reviewed external acknowledgement callback never settles, cancellation remains pending; do not describe that as successful termination or invent a private lifecycle/kill fallback. This local ownership acknowledgement is **not a remote Worker lifetime guarantee**.

`acknowledge` is an optional reviewed transport-acknowledgement seam: it receives the actual already-checked response, operation and optional group index, and returns only `Promise<void>`. It can delay/drop acknowledgement; it cannot return a substitute database success. Tests deliberately lose acknowledgement only after actual native commit and prove that commit through the public request/read interface.

`receiptPublisher` uses the existing `ImportReceiptPublisher` interface/default protected writer. Publication must durably write the selected path before acknowledging. The host then reads the actual protected receipt and requires exact equality. Misdirected or stale publication cannot authorize writes/completion. The real durability → artifact-read → abort → acknowledgement seam is retained, not replaced with a filesystem watcher or fake persistence.

## Fixed request interface

`src/db/fixed-job-worker.ts` constructs `createFixedD1JobWorker(job, migrations)`. The generated dedicated Worker closes over one reviewed artifact and immutable history. Its environment has only the actual native `DB` binding; it contains no account credential, application/viewer/job token, credential constructor or source filesystem/runtime construction.

The only request is `POST /job`, without a query string, using JSON and a separate bearer run capability. The Worker authenticates before any database access. Local synthetic fixture capabilities are not Cloudflare tokens or credential provisioning. Every operation fixes these envelope fields:

- `version: 1`
- `runId`, `targetId`, `intent`, `snapshotDigest`, all exactly matching the compiled artifact
- `op`, restricted below

Unknown fields, operations, SQL/account/database selectors, changed identity/intent/digest, unsupported encoding and expired capabilities refuse. The actual streamed request body is bounded to 4 MiB, regardless of a claimed length. Responses are no-store JSON, bounded to 8 MiB, with fixed safe error categories rather than raw SQL/parameter/provider errors.

| `op` | Additional fields and behavior |
| --- | --- |
| `bootstrap` | No caller SQL. Refuse an initialized or incompatible target; apply the exact two immutable schema stages and receipts in a native group. |
| `rows` | `group: { index, table, rows }`, in canonical order/encoding and matching the fixed digest, count and rowid bounds. Validate before native write preparation. |
| `sequence` | No arbitrary sequence value. Require complete matching table contents, then reconcile only the fixed games sequence, with native preconditions. A sequence already equal to the naturally generated state needs no write. |
| `inventory` | Complete reviewed schema/descriptors and all-table typed content summaries/sequence, or an explicitly uninitialized state. Unknown schema is not hidden or adopted. |
| `page` | Allowed `table`, `cursor: null|safe integer`. Ordered typed rows, exact ordered `columns`, bounded page and completion cursor. |
| `validate` | Complete schema/history, typed content summaries and sequence must match; return `data-verified`, not application/promotion acceptance. |

There is no artifact mutation, reset, truncation, unrelated-job, arbitrary SQL or generic administrative operation. Migration `0001_complete_schema.sql`, appended `0002_retain_legacy_metadata.sql` and the exact legacy-v1 fixture/profile are immutable. The fixed Worker pins both reviewed migration checksums; a future history/profile change requires separate code review, not an operator flag.

## Native ordering, limits and complete validation

Writes use real native `prepare/bind/batch`; reads use real native `raw({ columnNames: true })` on the primary binding, not Sessions/read replicas or REST. Pure/native row, schema and packing logic is shared with the existing importer. Bun filesystem, local schema-reference construction and native runtime ownership stay on the host.

Each fixed data group reserves one statement for a **native transactional precondition**, leaving up to **63 data statements / 64 total**. The existing importer retains its original 64-statement default. All existing 100-parameter, 96,000-byte SQL, 4-MiB work/request, scalar/row and response bounds remain. Full games pack at most three rows per statement (96 binds including rowid); legacy ledger rows can use all 100 binds.

The first statement checks expiry, fixed cumulative table/sequence progress and current schema receipt conditions inside the **same native transaction** as the writes. A mismatch aborts the group before its data statements. Replays/out-of-order groups therefore cannot obtain admission merely by landing in another isolate. Independent actual Worker isolates sharing one native D1 exercise concurrent admission; no isolate-local run flag, persistent coordinator resource or application operation journal supplies ordering.

Counts/sequence predicates are **admission guards, not data validation**. Completion separately reads complete schema objects, ordered xinfo/index/FK/table descriptors, migration receipts, every bounded typed row and sequence. It preserves all seven application tables plus retained `__drizzle_migrations`, exact defaults/constraints/indexes/metadata, NULL-key duplicates, UTF-8/JSON text, storage tags, rowids and deleted AUTOINCREMENT high-water. Unknown objects or incompatible native behavior stop.

Paging uses ordered rowid keysets of at most 64 rows, reduced for wide values, with complete typed-content digests and completion checks. It does not validate only counts/MAX or allocate an unbounded full-table row array. `columns` follows the declared target projection order; legacy physical order/default representation is retained as distinct source evidence rather than falsely claiming raw DDL equality.

Atomicity is **per native group, not whole import**. Bootstrap and later row/sequence groups can commit independently. Neither a session nor an isolate/global variable implies all-writer exclusivity. These controls do not exclude unrelated privileged account/API/database writers: future operations must separately establish target ownership and the required all-writer freeze. Local concurrency tests do not certify remote isolation, edge authentication or production capacity.

## Unknown outcomes, publication and fresh recovery

Before dispatch the actual protected receipt is incomplete with conservative write outcome and last confirmed row progress. Bootstrap is write-capable too. Rows advance only after a trustworthy checked native response and acknowledgement. A real native commit followed by lost response/acknowledgement can leave confirmed rows at zero.

On unknown/cancelled/failed work:

1. Stop. Keep the target, snapshot, packet and protected receipt. Product code never resets or deletes them.
2. Attempt guarded durable failed/incomplete publication. If storage/publication itself fails, do not assume the last save succeeded or promote from a file alone; preserve the operation's failed acknowledgement and obtain controlled inspection.
3. Do not retry/reopen/reset/append/truncate/replay the attempt. A protected exclusive attempt claim and new-target requirement also refuse accidental reuse.
4. Complete read reconciliation is an explicit separate operation and does not retroactively acknowledge an uncertain write or self-promote a receipt.
5. When separately authorized, select a **new** reviewed job/run capability/target identity, new pristine target storage and new receipt, then perform full import/validation. Native local tests demonstrate this recovery, not remote recovery authority.

Cancellation at actual proposed-complete receipt publication is still pre-completion until the real publisher acknowledges and the closing fence passes. It must not return imported success. Cancellation after a successful returned import is not retroactive. No concurrent promotion/validation is authorized while publication acknowledgement remains pending.

The fixed Worker reports `data-verified`; the host publishes `imported`. Neither is viewer/job-validated or promotion-ready. The existing public importer validator still requires its complete native comparisons and reviewed representative `viewer`, `steam-status`, `catalog-facts`, `offers` assertions. Matching counts or an actual fully committed but uncertain target cannot waive that receipt/behavior gate.

## Reproducible local verification

Use Bun without inherited credentials/dotenv. Do not use secret-download wrappers, `.dev.vars`, remote flags, actual source data, deployment or a browser server. The complete full-suite command is:

```sh
env -i PATH="$PATH" HOME="$HOME" WRANGLER_SEND_METRICS=false bun --no-env-file test
```

Acceptance requires **three entirely new serial unfiltered processes at one unchanged candidate**, stopping at a genuine unrelated red, not filtered green substitutes or historical baseline reuse. Also require all seven normal TypeScript projects, explicit every-changed-TypeScript coverage including Worker/host/tests, normal build, unchanged comment checker and its 13 regressions, Gitleaks and actual normal commit hooks/configured identity/signing. Parent owns independent unchanged verification, Standards/Spec reviews, integration and cleanup. Exact run results and unsuccessful attempts belong in protected handoff evidence rather than being inferred from this runbook.

`src/db/fixed-job.test.ts` exercises the three approved seams: unchanged public-importer characterization; actual bundled fixed-job Worker/native requests; and the public host/protected receipt/cancellation interface. Independent literal fixtures cover prepared/legacy typed all-table transfer, actual rollback, cross-isolate ordering, real commit/lost acknowledgement, publication/cancellation, unsafe artifact refusal and fresh recovery. The 389-game proof crosses parameter/group/page bounds without omissions. Test response decoders validate the fields they type while preserving full actual payloads and all original literal comparisons; they do not fabricate native results or weaken strictness/deadlines.

## Later gates remain held

This local runner has **no remote HTTP transport or account/preview lifecycle implementation**. A future transport must use only this fixed-job request/receipt contract, never wrap HTTP/REST as a native D1 binding, and must preserve unknown-outcome/no-replay/cancellation semantics. Exact endpoint/deployment/binding ownership, capability distribution/expiry, cleanup and any required resources need their separate approvals and verified procedures.

Actual account permissions, one-binding database identity, remote native prepare/bind/batch/raw/rollback/read behavior, capacity/size/duration, complete frozen source contents, writer drain, rehearsal, coherent viewer/all-writer cutover and retention are still #28/#29 gates. Local work does not prove them, authorize credential broadening or replace them with counts, an isolate flag, an invented cloud lifetime or a general administrative endpoint. Keep production on Turso; retain source/export and require explicit later retirement decisions as specified in ADR 0004.
