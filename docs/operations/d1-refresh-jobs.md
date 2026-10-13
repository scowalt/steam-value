# D1 Steam Status and offer refresh preparation (#22)

Preparation under [ADR 0004](../adr/0004-move-database-to-cloudflare-d1.md), [contract v1](d1-access-contract.md) and the [held integration/freeze gates](d1-acceptance-map.md#promotion-and-writer-freeze-gates). Production remains Turso-backed until separate provisioning, source validation and #28 cutover approval. No credential download, production job, database access, deployment, infrastructure apply or arcane change is part of this evidence.

## Entrypoints and preserved boundaries

- `scripts/sync-steam-status-browser.ts`: intentional Node 24/Playwright exception. Preserve the existing Steel profile path, persistence, HttpOnly cookie check, tailnet CDP/API and daily systemd schedule. `--login` never constructs a database client; no database configuration or SQL is needed for interactive login.
- `scripts/hydrate-daily.ts`: retained manual Bun exported-cookie entrypoint, not the scheduled Steel path. It still uses the same count/authentication/Playtime protections. Its cookie stays outside the Worker and scheduled environments.
- `scripts/refresh-deals.ts`: retained hourly Bun US/USD offer job with optional positive `--limit`, existing 200-game provider batches and unchanged rankings/selection.
- All three construct `createExternalClient(process.env)` for normal refresh work, require the four explicit database keys and have no libSQL construction or fallback. Construction/import performs no SQL. Only separately approved explicit bootstrap creates schema; refresh services never call schema ensures.
- [arcane.env.example](../../deploy/arcane/arcane.env.example) and [deals.env.example](../../deploy/arcane/deals.env.example) are blank protected-environment templates. Install only at approved coherent cutover, in owner-only directories with mode-0600 files. Doppler/protected operator workflows remain the credential source. No routine Cloudflare account credentials, database selectors, ITAD/Steam secrets in the Worker, or exported scheduled-browser cookie.

`SteamStatusOptions` supplies optional `source` (`userData`, `library`) and `now` inputs at the approved provider/time boundary. Normal callers retain the existing Steam fetches and clock. Browser callers still supply authenticated Dynamic Store data and only load the official library. `DealSource` and the existing offer `now` input remain the offer provider/time boundary. These injections do not replace database operations or create another application path.

## Persistence, bounds and atomic groups

Steam Status retains its nonrenewed 15-minute lock, strict `< now` abandoned-lock acquisition, expiry-value-fenced final state, count-drop/authentication rejection and maximum recorded/library/recent Playtime. Rejections leave game markers and previous successful counts untouched. Changed-game groups remain native atomic batches of 200, five binds per statement. Completion checks its affected row before reporting success.

**The Steam game updates themselves remain unfenced, as at baseline.** This preparation is not a Steam lease redesign or a whole-refresh transaction. A late old refresh can still reach game updates; its final state cannot overwrite a replacement lock/success. Tests do not claim otherwise.

Offers retain the renewable UUID-fenced 15-minute lease, `<= now` abandoned-lease acquisition, strict unexpired renewal/publication/completion and affected-row checks. Mapping upserts also require one affected row; deletion may legitimately affect zero or several cached scopes. Failure cleanup matches only the caller's token, so old failures/completions cannot clear replacement state.

Offer logical atomic groups are complete **mapping invalidation + new mapping** pairs and complete available **retail + bundle publication** pairs per game. Independently valid groups are packed into one native transactional batch up to 400 statements and the exact serialized UTF-8 4 MiB request ceiling. Every group is validated before any batch in that phase executes. Packing never splits a pair, clips JSON, drops work or changes the 200-game upstream fetch batch. Normal small 200-game phases retain one native batch; byte-heavy independent groups may require several transactions, not one whole-provider-batch/whole-refresh promise. An individually unsupported group fails before publication; previously successful data is not renewed speculatively.

Catalog/status selection uses complete ordered keyset pages of at most 1,000 rows instead of an unbounded result. Steam uses game ID; offers preserve score-descending/Steam-App-ID-ascending ordering and `--limit`. Pagination is not a new whole-job snapshot guarantee. Read, acquisition, update groups and completion remain separate as at baseline.

Freshness stays strict `checked_at > now - 86400`, offer `validUntil > now`, and mapping refresh at seven days. Missing retail leaves its checked-at unchanged; successful `[]` replaces prior sales. Bundles are independently verified, checked/null mappings are distinct from absent mappings, and mapping changes invalidate old cached scopes across countries. No ranking formula, game selection, catalog checkpoint, schedule or refresh behavior is redesigned.

## Uncertain writes

There are no database/HTTP retries. Safe `DbError` code/outcome/correlation survives recognized wrappers via `toDbError`; raw SQL, parameter-bearing Drizzle wrappers, upstream bodies and credential-bearing exceptions are never stored or printed. Known Steam/ITAD validation messages remain safe and diagnosable; unrecognized provider failures become fixed generic provider messages. The [#27 review fix](d1-review-fixes.md) makes ITAD diagnostics provider-owned typed errors/codes, not prose-string trust: lookalike untyped errors are redacted, and a trusted error's mutable public message cannot replace its safe diagnostic. Node 24 compatibility and all original expected messages remain covered. Steel response bodies and unhandled Playwright stacks are not logged.

A confirmed database rejection/rollback or provider failure can record failure under the existing lock/token fence. **An `unknown` or `committed` write error stops immediately instead of attempting failure cleanup, renewing/clearing the lock, advancing counters, retrying the batch or returning successful work.** The lease may remain until inspection/expiry. A lost completion reply can mean success is already persisted; the caller still receives an uncertain error, not guessed success.

Before explicit resume, an authorized operator must:

1. Keep affected writers stopped/drained; timer catch-up is not an uncertainty-resolution procedure.
2. Inspect `GET /api/sync-state` or `GET /api/deal-state`, and relevant game/mapping/cache rows through the supported authenticated client. Correlation IDs assist diagnosis, not deduplication.
3. Compare business keys, Steam lock expiry or offer token, checked-at timestamps, markers and cached scopes with the attempted work. Account for independent earlier committed groups and the unfenced Steam-update limitation. Do not blindly clear state or replay attempts.
4. Reconcile/validate the persisted outcome and explicitly authorize a resumed refresh. A later ordinary refresh reads current persisted business state; it is not transport-level replay of a lost request.

During preparation this procedure uses only synthetic local fixtures. Production inspection/resume remains separately authorized. Never paste credentials, SQL arguments, raw provider responses or protected artifacts into issues/logs.

## Verification seams and commands

New focused tests avoid edits to #21's `games.test.ts`:

- `src/services/steam-status-refresh.integration.test.ts`: persisted authentication/incomplete/empty/count-drop rejection, Playtime, success/failure, overlap/exact expiry, abandoned late completion, unknown/committed game writes and unknown acquisition/completion, missing-schema/no-DDL, native rollback, complete 10,005-game processing and native Node 24/Playwright module compatibility.
- `src/services/deal-refresh.integration.test.ts`: persisted success/empty/missing/failure, 24-hour/provider expiry, seven-day mapping/null behavior, 209-game/400-statement boundaries, complete 10,005 ranked-game processing, escaped UTF-8 byte-heavy publication, unsplittable-data rejection, overlap/abandoned/expired/replaced leases, mapping/publication/completion fencing, native pair rollback and unknown/committed mapping/publication write stops.
- `scripts/refresh-jobs.integration.test.ts`: actual manual/hourly entrypoints run in a credential-free child with synthetic four-key configuration, fixed time and fake Steam/ITAD responses. Only database requests are bridged to the actual isolated Worker/D1; every other unexpected network request fails closed. No scheduled/remote job is run.

Every scenario owns `createD1WorkerTestHarness()` and uses `createHttpClient` through the bundled actual Worker/native D1. Setup/observations use supported client/state/deal interfaces, not private bindings or call counts. Fault injection changes boundary requests/replies around actual native execution; assertions verify persisted rollback/fencing/uncertain outcomes. There are no increased timeouts, SQL/startup retries, real provider credentials or substituted databases.

```sh
env -i PATH="$PATH" HOME="$HOME" WRANGLER_SEND_METRICS=false bun --no-env-file test
env -i PATH="$PATH" HOME="$HOME" WRANGLER_SEND_METRICS=false bun --no-env-file run build
uv run --no-project --python 3.14 --with-requirements .comment-policy/requirements.txt python .comment-policy/check.py
uv run --no-project --python 3.14 --with-requirements .comment-policy/requirements.txt python -m unittest discover -s .comment-policy -p 'test_*.py'
git diff --check
```

The normal browser-sync type project includes all three changed jobs and focused tests, alongside the existing Worker/web/database projects. Red→green slice logs and complete-suite/build/policy logs are captured under `/tmp/steam-value-d1-22-evidence/`. Final branch/SHA and executed check totals are in the implementer handoff; local evidence does not satisfy edge Access, real deployment credentials, Paid capacity, live schema/data validation or cutover gates.

## Verified integrated local preparation

Merged accepted integration `44698212110d001ac44d321ce06d853c6fdf3287`, containing #21's native viewer/read migration and #23's [shared lifecycle repair](d1-catalog-test-repair.md). Resolved only the four known overlaps: `src/services/{steam-status-sync,deal-refresh}.ts` and `scripts/{sync-steam-status-browser,refresh-deals}.ts`. Retained their shared `DbClient`/`DbValue`, factory and runtime-init-removal intent alongside #22's provider/time inputs, safe errors, paging, leases and atomic groups. The merged viewer/read files and shared fixture are byte-identical to integration; the four owned service/entrypoint files are byte-identical to the pre-merge #22 version. No unrelated algorithm or infrastructure changes were made during resolution.

Three consecutive serial **unfiltered** runs pass after this merge, including all 38 new refresh/job cases, existing native viewer tests, catalog/operator/lifecycle regression and real 45-second deadline:

| Run/artifact | Tests | Assertions | Files | Duration |
| --- | --- | --- | --- | --- |
| `integrated-full-1.log` | 155 pass / 0 fail | 953 | 12 | 90.61 s |
| `integrated-full-2.log` | 155 pass / 0 fail | 953 | 12 | 90.72 s |
| `integrated-full-3.log` | 155 pass / 0 fail | 953 | 12 | 90.71 s |

`integrated-build-1.log` passes the normal build, including **all six** Worker/web/browser-sync/database-tools/database-access/catalog type projects. `integrated-owned-jobs-types.log` separately passes strict checking of all three owned jobs and their service dependencies. Policy checks cover 148 files with zero violations; all 13 policy regression tests, whitespace and staged Gitleaks checks pass. Native Node 24/Playwright loading and actual manual/hourly entrypoints with fake providers pass within each complete suite. Protected templates contain only blank values for the four external database keys plus the applicable external provider keys; the daily/hourly units, Node 24 runtime and Steel cookie/profile remain unchanged.

No fixture edits, retries, timeout changes, acceptance filters or discarded tests were needed in #22. Earlier red evidence below remains historical, not current acceptance. Final branch/SHA and staged-hook evidence belong to the implementer handoff. **No local preparation blocker remains for #22; production/edge/live-data/cutover approvals remain held.**

## Historical integrated blockers before the shared repair

**Initially not verified complete.** At integration `0bf4735`, the three owned jobs and their service dependencies pass an explicit strict TypeScript check, policy checks pass, and the earlier complete 114-test suite passed. The first expanded unfiltered suite reports **116 pass / 2 fail** (`full-final-1.log`): hook timeouts in the new Node compatibility case and the existing #20 request-deadline case. Follow-up coverage explicitly verifies both unknown and committed Steam game writes and both uncertain offer mapping outcomes: **four behavior cases pass**, with 33 other cases filtered out (`14-uncertain-behavior.log`), not acceptance evidence for the complete suite.

The last pre-repair expanded unfiltered suite reports **119 pass / 2 fail** across 121 tests (`full-final-2.log`): hook timeouts in `new mappings with missing retail remain partial rather than successful empty retail` (5.265 seconds) and the existing #20 `a request deadline exposes an unknown committed write without cancellation or replay` (50.234 seconds, including its intended 45-second deadline). The Node compatibility case passes in this run. All tests remain present with their original/default timeout allowances. Do not treat filtered or earlier smaller passing runs as final acceptance.

Before the repair, the repeatable focused command was the unfiltered Steam Status integration module, or all three new focused files together. Two focused runs reported 34 pass / 1 fail. Minimizing to either half of the Steam scenarios, the two uncertain-state cases plus Node, or the large-catalog case plus Node made the failure disappear. No claim is made that every element of a minimal reproducer or the vendor cause has been identified.

Tagged temporary boundary instrumentation (`node-instrumented-red.log`) shows the Node child and every real Worker/D1 request completing in roughly 0.55 seconds, 4–8ms ordinary native requests, successful persisted assertions and child exit 0. The hook then stalls at `harness.dispose()` past its unchanged 5-second allowance. A later unfiltered probe also reproduced workerd `Broken pipe; fd = 3` during a following fixture's setup, before business SQL. These are fixture lifecycle failures, not a demonstrated refresh SQL defect. The previously recorded [bootstrap/request-fixture lifecycle hazards](d1-access-test-repair.md) remain relevant, but that does not certify this new cause.

Explicit stdout cancellation/stderr draining did not establish a repair; no SQL/startup retry, fixture replacement, production workaround or timeout increase was added. Temporary instrumentation is removed. Evidence includes `focused-final-1.log`, `focused-reproduce-2.log`, `node-minimize-*.log`, `node-instrumented-red.log`, `node-stdout-cancel-probe.log`, `node-stderr-drain-probe.log`, `node-cleanup-full-1.log` and `full-final-1.log`. The coordinator assigned the shared lifecycle/CLI mixed-suite repair to #23. This consumer branch does not duplicate the harness, use vendor-private patches or widen timeouts. That single accepted repair was subsequently merged and the complete acceptance repeated above.

Normal `typecheck`/`build` was also blocked pending #21's integration: the old Worker/game-deals/existing-games-test libSQL types do not accept the new `DbClient`. #21's committed compatible type/init-removal hunks must be preserved alongside this implementation; its read functions/tests remain untouched here. Every type project/build and the complete suite were subsequently rerun after merging those changes, as recorded above. No production operation or ticket write was needed or authorized to resolve either preparation blocker.
