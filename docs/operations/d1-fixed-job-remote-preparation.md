# Fixed-job HTTPS preparation (#32)

This is application code and isolated local verification, not a deployment, import authorization, cloud-identity certificate, or production cutover. Production remains Turso. [The approved design](../adr/0004-move-database-to-cloudflare-d1.md), [local preparation](d1-fixed-job-local-preparation.md), [transfer/recovery](d1-transfer-recovery.md), and the coordinator's protected approved operator plan remain authoritative. Infrastructure, actual captured control-plane proof, staging, freeze, real native/HTTP/viewer/job checks, promotion, retention and resource cleanup belong to #28. No account discovery, credential discovery, control-plane client, preview session, resource creation/deletion, or general SQL endpoint is implemented here.

## Interfaces

`src/db/fixed-job-host.ts` retains `prepareFixedD1Job` and `createLocalFixedD1JobRunner` and adds:

- `buildFixedD1JobWorker({ jobDirectory, reviewedJobDigest, destination })`: read only the protected `job.json` and immutable migration history; validate its independently selected digest and invocation budget; exclusively create a new protected build directory. Returns `scriptPath`, SHA-256 `scriptDigest`, UTF-8 `scriptBytes`, `jobDigest`, compatibility metadata and directory. The output also includes protected `artifact.json` and `worker-entry.ts`. Two builds with identical reviewed inputs produce identical script bytes. Group files, original snapshot rows and plaintext capability are not build inputs. The compiled Worker uses only its fixed manifest, immutable migrations and native `DB`; it contains no host filesystem, Bun runtime, Miniflare, account or application credential.
- `createRemoteFixedD1JobRunner(options)`: validate the original protected snapshot, every original group and job manifest, independently reviewed job digest, dedicated capability, expiry and deployment selection before making any request. Returns `run`, explicit `read`, `cancel`, and `dispose` as below. No local persistence path or HTTP-as-D1 adapter is accepted.

Remote options include the existing `jobDirectory`, `reviewedJobDigest`, `snapshot`, new `receiptPath`, `capability`, and optional existing `acknowledge` / `receiptPublisher` seams, plus:

| Field | Required selection |
| --- | --- |
| `deploymentRecordPath` | Original protected immutable deployment ownership record, outside Git. |
| `reviewedDeploymentDigest` | Independently reviewed SHA-256 of `JSON.stringify(record)`, not a digest automatically approved by the runner. |
| `approvedDeployment` | Independently approved exact `accountId`, `databaseId`, `workerName`, HTTPS `endpoint`, `scriptDigest`, and `captureDigest`. |
| `workerArtifactPath` | Protected actual dedicated script bytes matching the independently approved and recorded digest/byte length. |
| `transport` | Optional `(request: Request) => Promise<Response>` seam. Default is standard `fetch`; tests inject transport to an actual bundled Miniflare/native Worker. It supplies no database result adapter. |

The record has exactly these fields (identifiers below are synthetic):

```json
{
  "version": 1,
  "kind": "fixed-d1-deployment",
  "accountId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "databaseId": "30000000-0000-4000-8000-000000000032",
  "workerName": "operator-selected-unique-fixed-worker",
  "endpoint": "https://operator-selected-owned-endpoint.invalid/job",
  "scriptDigest": "<independently reviewed actual script SHA-256>",
  "captureDigest": "<independently reviewed captured control-plane evidence SHA-256>",
  "binding": {
    "name": "DB",
    "databaseId": "30000000-0000-4000-8000-000000000032"
  },
  "runId": "10000000-0000-4000-8000-000000000032",
  "targetId": "operator-selected-pristine-target",
  "intent": "staging",
  "expiresAt": 1700000000,
  "capabilityDigest": "<fixed job's dedicated capability SHA-256>",
  "jobDigest": "<independently reviewed original job digest>",
  "scriptBytes": 1
}
```

This example is deliberately non-executable/expired. The record and expected selection must bind the actual approved account, database ID, unique Worker name, only selected `DB` binding, exact owned HTTPS endpoint, deployed script/job hashes and fixed run/target/intent/capability/expiry. `captureDigest` references the coordinator's protected **actual verified deployment metadata**, not an invented provider response. The operator must independently establish its provenance and control-plane proof, including the actual script and binding configuration. A matching JSON record, synthetic fixture, caller-supplied ID, `artifact.json`, or locally computed hash alone does **not** establish cloud identity. This code only pins/checks the eligible reviewed record and bytes; it cannot certify an actual deployment or authorization to use it.

Protected artifact rules are unchanged: owned 0700 directories outside Git; owned, non-symlink, regular, single-link 0600 files, exclusive creation without following links. Refuse unsafe inputs without chmod/adoption. The selected record and actual script are rechecked at acquisition and before every request; the approved identity is copied at construction. No redirect, HTTP URL, credentials in URL, query, fragment, alternate port, local/IP target or caller selector is accepted. Routine requests carry only the dedicated run bearer and JSON content type, never account, viewer, application/job or Access credentials. Actual expiry must match the fixed job and remain within one hour.

## Attempt, transport and cancellation

Both factories use the same guarded attempt/publication/dispatch module. The remote runner exclusively claims the original packet's `attempt.json`. Independent factories cannot replace that claim; native guards additionally enforce pristine bootstrap and cumulative progress across isolates. No watcher, fake publisher, application operation journal or memory-only lock substitutes for the claim.

`run()` performs one bootstrap, ordered reviewed groups, fixed sequence reconciliation and complete native validation. Requests use only the existing fixed `POST /job` envelope. Request bodies are measured and bounded to 4 MiB; the Worker bounds the actual streamed body. The remote host incrementally reads responses to the 8 MiB limit and awaits cancellation of an oversized/failed reader. Redirect mode is explicitly `error`; redirect statuses, changed response URL, bad media, invalid protocol, malformed responses and provider/transport exceptions fail with fixed safe errors. No raw SQL/provider diagnostics or bearer are logged. Native `prepare/bind/batch/raw` stay inside the Worker.

`read({ op: inventory|validate })` is explicit inspection, not automatic reconciliation. `read({ op: page, table, cursor })` admits only retained tables and a null/safe-integer keyset cursor. Remote page responses must have the exact declared column order, complete typed values, at most 64 rows, strict rowid/cursor progress and a boolean completion signal. Follow every page to `complete: true`, including a possible final empty page. No full-table array is allocated.

`cancel()` fences subsequent dispatch, waits for the actual in-flight request, bounded body read and acknowledgement, then drains outstanding explicit reads. Only then it returns:

```json
{"status":"cancelled","resourceOutcome":"retained"}
```

There is deliberately no `nativeDisposed`, SQL rollback, Worker revocation or cloud deletion assertion. `dispose()` performs the same host close without an acknowledgement result. It does not call a control-plane cleanup endpoint. Local cancellation still returns the original `{ status: "cancelled", nativeDisposed: true }` only after actual local runtime disposal. Cancellation after successful returned import is not retroactive.

Actual durable publication, protected receipt read/equality, abort fence and acknowledgement remain ordered. A dispatched write without a trustworthy acknowledgement leaves an incomplete receipt with `partial-or-unknown`, last confirmed progress and a retained target. This includes lost acknowledgements after real commits and cancellation during proposed-complete publication. Stop without retry, reopening, reset, replay, append, delete or automatic read reconciliation. Subsequent `run()` observes the same attempt result. Recovery requires a separately authorized pristine **new** target/database, new reviewed job/run/capability/deployment record and new receipt. Keep unknown targets and evidence for the coordinator. `data-verified` / `imported` are not viewer/job verification or promotion acceptance.

## Native invocation budget

[Cloudflare's D1 limits](https://developers.cloudflare.com/d1/platform/limits/) specify **1,000 D1 queries per Paid invocation**. The separate newer Workers 10,000-subrequest limit is not this budget. This is not a claim about actual deployed capacity, elapsed time or other undocumented limits.

`src/db/fixed-job-native.ts` adds a separate full-verification path for fixed-job inventory/sequence/validation. The original `transfer-native.ts`, its 64-row paging, default importer packing/limits, SQL and public contracts remain byte-unchanged. Full verification uses at most 256 rows and a conservative 2 MiB native result budget per internal page (one quarter of the existing response limit), never an unbounded table array. Its size bound is `6 * bytes + 128 * columns + 512` per row, covering worst-case JSON escaping and native projection metadata. The reviewed manifest's complete maximum serialized row size supplies the conservative preflight bound; actual native size/count bounds supply the runtime plans.

Before any bootstrap/target write, the fixed job must fit an explicit conservative estimate: 64 reserved queries plus, per table, two bound queries and `floor(count / boundedPageRows) + 1` complete keyset reads. Admit at most 960 queries, retaining headroom below 1,000. Refuse unsupported row-byte or invocation-query work before target access. Each full scan first budgets all actual table plans, then bounds every page and number of page requests. A native expression rejects a row that outgrows its observed byte bound before returning its projected data. Exact scan counts and a second size/count observation detect growth rather than following an unbounded tail. Counts/MAX are sizing and growth guards only, **never content acceptance**.

Complete verification still compares ordered schema objects, all xinfo/index/FK/table descriptors, exact excluded metadata and immutable migration receipts, every typed value/rowid/content digest/storage summary, and the complete sequence including deleted high-water. The original per-group native expiry/order/schema/progress transaction guards remain: at most 64 total statements, at most 63 data statements. There is no isolate flag or whole-import atomicity claim.

The new native test uses actual synthetic 84,249 games, 26,377 deals and 13,575 ITAD rows plus retained ledger/all other tables, mixed storage/nulls and deleted high-water. Its expected complete inventory comes through the unchanged public scanner; group digests consume those same actual bounded native fixture pages without a second redundant fixture scan. An instrumented real primary binding observes executed `raw` and native batch statements, not fake SQL/SDK successes. The genuine original red observed 1,961 queries for inventory; the new local path observed inventory/sequence/validate at 514/516/513. Those are **local observations only**. Additional actual-native tests exercise wide Unicode/escaping/types/nulls, byte/query overbudget refusal before bootstrap, growth before sequence writes and unchanged complete public pages.

The remote tests use the actual reproducible artifact and bundled native Worker, real commit/lost acknowledgement, actual batch rollback, retained-target recovery, response bounds, protected publication/attempts, cancellation/read drain, endpoint/auth/identity/artifact refusals and old-factory characterization. The existing 327 cases, assertions, deadlines, migrations, profiles and filesystem/public-writer helpers remain unchanged. Final acceptance requires three new serial complete unfiltered clean-environment processes at one unchanged candidate, all seven normal type projects with actual changed-file coverage, normal build, unchanged policy plus 13 regressions, configured scanner and actual normal commit hooks/identity. Protected implementation handoff records the actual results; independent verifier/merger and Standards/Spec acceptance, integration and cleanup remain separate coordinator gates.
