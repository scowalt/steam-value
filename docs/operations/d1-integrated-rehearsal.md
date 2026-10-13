# Integrated synthetic D1 preparation evidence (#27)

**Verified locally; independent final review and every production approval remain pending.** Under the approved [#17 plan](https://github.com/scowalt/steam-value/issues/17#issuecomment-6135327372), this work starts in a clean dedicated worktree at accepted integration `2d8a075a24fc9bc5d2c88793d1b81f7ca7b69c53`. #21–#26 blockers were closed with independent blocker verification before this start. Historical acceptance results in their operation records remain historical; this record rechecks their combined tree.

Parent's initial independent reviews subsequently reported no SPEC findings and 0 hard Standards breaches/3 application judgment smells. The single implementer's [review-fix evidence](d1-review-fixes.md) addresses all three, retains all 214 original cases/assertions/timeouts and records three 222-pass runs; independent re-review/parent acceptance remains pending. The initial preparation results below remain historical evidence, not overwritten by the follow-up.

Existing production remains **Turso**. Hold BOTH `integration/d1-migration-17` and mission-control `integration/steam-value-d1-17` off main until separately approved provisioning/cutover and validated final frozen import. No production/Doppler/account/source/secret access, deployment/apply, arcane operation, main change/push, ticket write/closure, agent launch/message or worktree cleanup was performed.

Companion preparation was inspected **read-only** at `/tmp/steam-value-d1-17-plan/mission-control-integration`, tip `da48a80ab04707bc89de4f3f57ab021a0fab1370`, baseline `f7e77d094e5b66b93d5a3a773a67bcb327466e19`. Protected primary-only D1, exact Service Auth path/selected token UUIDs, non-secret outputs and existing disabled subdomain/previews/empty cron are present. Its documented local five mock-provider plan tests/guard checks are prior blocker evidence, **not rerun or represented as new external verification here**. No backend initialization, live plan/apply or dirty canonical checkout operation occurred.

## Reproduce without credentials or providers

```sh
bun install --frozen-lockfile
umask 077
parent=$(mktemp -d /tmp/steam-value-d1-rehearsal.XXXXXX)
env -i PATH="$PATH" HOME="$HOME" WRANGLER_SEND_METRICS=false \
  bun --no-env-file run db:rehearse --local --destination "$parent/evidence"
```

`db:rehearse` is an explicit **synthetic local-only operator workflow**, not remote migration. Missing/local-implicit/remote scope and missing destination fail before artifact/runtime creation. It creates disposable real D1 with `createD1WorkerTestHarness`, which builds the actual production Worker entrypoint and runs it inside workerd. HTTP/raw/Drizzle consumers all use that same request seam. Native bindings are used only for the explicitly approved inventory/import/validation/recovery interfaces via fixture `operatorSetup`; no business observation bypasses the Worker client.

The runner injects synthetic Steam/library, offer and catalog providers at the existing interfaces and existing controlled time inputs; it never constructs a live provider or reads runtime credentials. It adds no endpoint implementation, internal collaborator mock, SDK-layout/document-layout test or production migration hook. Only the new workflow is assembled; schema/transport/migration/transfer/job/manual algorithms are reused unchanged.

Destinations must be **new protected directories outside every Git tree**, with directories 0700 and files 0600. The transfer interfaces enforce ownership/modes/symlink/hardlink/integrity restrictions. The runner retains private inventory, baseline/export receipt, import/validation receipt, post-cutover recovery/delta/receipt, fresh restore/validation receipt and safe summary. Failed/incomplete artifacts remain for inspection; no destructive reset/replay/automatic cleanup is provided. Tests remove only their own disposable synthetic temp artifacts. No table files/receipts or data are committed.

## One continuous, populated rehearsal

1. Insert 500 complete typed games through real SQLite-proxy/native atomic insert groups, with known numeric/real/null/boolean/Date/JSON/text values; seed all seven tables through the raw HTTP client. Preserve duplicate nullable TEXT-PK state rows, orphan catalog/mapping/cache rows and GB scopes. Allocate/delete game 900, leaving high-water 900 rather than max visible ID 500.
2. Assert actual native `GET /api/games` populated 100/500 ordered pages, every page's fresh deals, on-sale selection, city-builder weighting, raw state endpoints and typed relational/complete Drizzle results. Assert seconds/Date conversions, nullable booleans/estimates, operational counters/failure attempts and orphan/null/empty/country values independently of transfer digests.
3. Freeze the awaited synthetic writers, inventory/export every typed cell/schema/index/sequence through existing transfer APIs. Import to a **fresh** explicitly bootstrapped Worker D1 target; read-only representative assertions plus a second complete scan produce `validated`, not merely `imported`. Import points to that very same native Worker database.
4. Against the imported target, run real services with injected providers/time: Steam success and authentication rejection preserving Playtime/success state; abandoned offer-lease acquisition, overlap rejection, 500-game native publication, provider failure preserving prior success and missing retail preserving its original checked-at; catalog checkpoint resume with an orphan failure increment **3 → 4** and a new game. No real Steam/ITAD/browser work occurs.
5. Apply manual wishlist set/clear across 500 rows (98-ID bound with flag/timestamp), insert **205** typed games returning IDs 901–1105, and intentionally delete all 205 across 100-ID groups. The new catalog allocation is **1106**, proving deleted allocation state survives maintenance, not just visible row counts.
6. Freeze again and `prepareRollback` against the original baseline. Capture the complete post-cutover state/typed deltas without touching the source or reverting code. The receipt is **`reconciliation-required`, `automaticReversion: false`**, with game/failure/state/cache changes and high-water change.
7. Import the complete preserved post-cutover snapshot into another **fresh** native Worker D1, validate full typed equality plus actual Worker/client behavior, and verify high-water 1106. This is a fresh **D1 recovery restore**, not automatic Turso reconciliation/replay. Actual rollback still requires an approved reviewed reconciliation decision. Re-inventory the original frozen source to prove it remained unchanged.

Known baseline rows: `games=500`, `sync_state=3`, `catalog_refresh_state=1`, `catalog_refresh_failures=1`, `itad_game_map=501`, `game_deal_cache=1001`, `deal_refresh_state=2`. The recovery restore retains the same counts except `games=501`; the delta records content changes even where row counts are unchanged. All original source/default/drift assumptions remain provisional.

## Red → green and timing

Two vertical slices at the approved explicit local rehearsal seam:

- Scope rejection: the unimplemented runner fails the safe usage assertion (`01-scope-red.log`); explicit local/destination validation passes the same assertions (`01-scope-green.log`).
- Complete rehearsal: the guarded but unimplemented valid path fails (`02-rehearsal-red.log`); the integrated existing interfaces produce the validated baseline/recovery/restore and protected receipts (`02-rehearsal-green.log`). Assertions use known literals, receipts and actual request/client outcomes, not call counts or internal adapter classes.

The first new combined test candidate had a 15-second allowance and timed out after its writer phase. A standalone public CLI run completed successfully. Targeted phase timings measured ~25–26 seconds: seed 0.6s, inventory/export 3.7s cumulative, first complete import 11.0s, validation 12.6s, writers 13.4s, rollback preparation 15.3s, second complete import 22.3s, validation 24.0s, disposal 25.4s. This is measured complete-import work, not a stuck request/descriptor or a justification to weaken existing tests. The **new combined test** therefore declares 30 seconds. Every one of the existing 212 tests, assertions and timeouts remains unchanged; no startup/SQL/transport retry, fixture change, sleep, accepted filter or dependency patch was introduced. Tagged temporary timing instrumentation was removed. Earlier failed candidates/probes remain evidence.

The existing measured Bun/Miniflare pipe/pidfd mitigation and shared local operator owner remain byte-unchanged from accepted integration. Their released-scope regressions and actual 45-second request deadline run in every full suite. See the [repair record](d1-catalog-test-repair.md) and [shared native owner](d1-local-bootstrap.md#shared-local-native-operator-owner); a recurrence must hold acceptance, not widen timeouts or ignore a red run.

## Regression and coverage audit

| Capability | Retained observable seam/evidence |
| --- | --- |
| Fail-closed authorization, strict v1 inputs/results/bounds, ordered projection/Date/boolean/JSON fidelity, safe errors | `src/db/request.test.ts`, actual bundled Worker/D1 and external raw/Drizzle client; unauthorized requests preserve state; selectors/admin SQL rejected |
| Native atomic rollback and strong grouped reads; concurrent refresh fencing/rowsAffected; unknown write without replay | Request tests and Steam Status/offer integration tests through actual client, boundary faults only after/before real operations; no internal mocks |
| Viewer/ranking/filter/city-builder/country/freshness, populated 100/500 pages | `src/worker/games.test.ts`, plus new full transfer/import/recovery viewer probes |
| Steam safeguards/Playtime/late completion, leases/empty-vs-missing/expiry/failure, runtime/schedules | Both refresh integration files and real entrypoint tests, Node 24/Playwright compatibility; installed production remains UNVERIFIED |
| Catalog complete reads/flushes/resume/failures/byte bounds/provider behavior/aliases | Existing catalog behavior tests; new imported-target checkpoint/failure progress |
| All historical manual reads/enrichment/recalc/returning/wishlist/cleanup | Existing manual suite incl. 10,001 reads, 404 recalculation updates and uncertainty; new 500/205-row integrated maintenance |
| Seven-table schema/defaults/indexes/high-water/drift/complete content, failed/interrupted import and fresh recovery | Existing bootstrap/transfer/operator suites plus new full native Worker import → writers → rollback capture → validated restore |
| Types/admin/tooling | All seven normal type projects; `tsc --listFilesOnly` union covers **78 added/changed TypeScript files**, zero uncovered, against spec baseline including new runner/test |

Final active constructor/DDL/env/entrypoint audit is in the [inventory](d1-consumer-schema-inventory.md#integrated-preparation-status-27). The unused legacy `ensureDealTables`/SDK import is removed; no ordinary constructor or runtime DDL remains. The only non-test libSQL reference is type-only for a supplied explicit legacy source handle. Immutable migration SHA-256 remains `bcb5a3738c65336b9af697be9816d3039edffd9da0ef627cc50da5ecf5d0a83a`.

README/setup/blank environment names, secret distribution and arcane freeze/drain/coherent-switch/reconciliation/≥7-day retention guidance now distinguish preparation from existing production. Application configuration explicitly disables both `workers_dev` and `preview_urls`, agreeing with the companion's disabled alternative routes. No subscription/budget pause/financial alert, UI/ranking/provider/schedule redesign, routine account token or automatic schema/deploy hook was added.

## Repeated local checks

Sanitized, serial **unfiltered** full runs on the final code candidate:

| Artifact | Tests | Assertions | Files | Duration |
| --- | --- | --- | --- | --- |
| `full-1.log` | 214 pass / 0 fail | 1229 | 17 | 178.54s |
| `full-2.log` | 214 pass / 0 fail | 1229 | 17 | 177.24s |
| `full-3.log` | 214 pass / 0 fail | 1229 | 17 | 177.37s |

Frozen-lockfile install passes. `types-final.log` passes all seven type projects; `build.log` repeats all seven and builds production Worker/assets. Comment policy and all **13** regressions pass; whitespace passes. Bundle inspection finds no legacy Turso/libSQL or synthetic-fixture material in production output and no machine credential names/endpoint in browser assets. Complete-index comment/Gitleaks checks and normal commit hooks are required at the handoff; exact final SHA/check evidence is reported by the implementer, not inferred here.

Host evidence remains protected at `/tmp/steam-value-d1-27-evidence/`: red/green logs, timing probes, synthetic standalone artifacts, three full logs, type coverage JSON, build/policy/regression/inventory/bundle/staged-hook logs. Durable tests/runbooks are reproducible evidence; this temporary path is not a required production dependency or a public data artifact.

CI/deploy workflows are byte-unchanged from `299c9e20feb23dfb5aaa8913d16eafc94fcfd123`: PR CI unprivileged; default-branch privileged workflow requires successful current-main CI, uses that run's exact tested artifact, serializes production and retains narrow existing Worker Editor/`--keep-vars`. No deployment was executed and actual credential capability is not established by static inspection.

## Exact remaining gates

- **Parent:** independently run Standards + Spec review against application/companion baselines, have one implementer fix all findings, rerun acceptance, serialize the integration merge, preserve research/dirty companion work, own ticket evidence/closure and implementer cleanup. No external review is claimed complete here.
- **#28 / owner:** separately approve subscription if needed, protected resource/Access/credential operations, actual-source data/schema/writer inventory/drift resolution and remote operator execution/rehearsal, deployment capability/edge verification and maintenance-window final import/coherent cutover. Actual Paid/eligibility/permissions/Access and production data/provider/job/admin verification remain **UNVERIFIED**. Do not release either main hold based on local checks.
- **#29 / owner:** record successful cutover/retention start, retain read-only Turso plus validated exports ≥7 days, preserve/reconcile D1 changes before rollback, then explicit deletion/credential-retirement or continued-retention decision.

Code-only completion cannot close #17/#28/#29. Full step-by-step [plan/provision/freeze/drain/import/validate/switch/recovery/retention procedures](d1-cutover.md) and [credential ownership](d1-credentials.md) state stop conditions; no production operation, financial budget feature or unrelated capability retirement is implied by this handoff.
