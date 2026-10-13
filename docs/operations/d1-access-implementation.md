# D1 runtime access implementation (#20)

Preparation only, governed by [contract v1](d1-access-contract.md), [ADR 0004](../adr/0004-move-database-to-cloudflare-d1.md) and the [acceptance/promotion gates](d1-acceptance-map.md). This is not deployment, edge Access verification, live-data verification or cutover authorization.

## Caller interfaces

- `access.ts` supplies `DbValue`, `DbStatement`, `DbResult`, `DbClient`, `DbError`, `toDbError` and the exact contract `DB_LIMITS`.
- `createD1Client(binding)` uses only the supplied native primary binding. Construction performs no SQL; runtime access never initializes schema. Every nonempty batch executes one native transactional `DB.batch`, including SELECT-only read groups. It does not split, sort or retry work.
- `createHttpClient({ url, token, accessClientId, accessClientSecret, fetch? })` requires an exact credential-free HTTPS `/api/internal/db` URL. The injected fetch accepts a standard `Request`; omitting it uses global fetch. Redirects fail, and both Access headers and the separate bearer credential are sent. The 45-second deadline covers response-body consumption, not just response headers. Abort does not cancel D1 execution.
- `createExternalClient(env)` reads only the four contract keys. Missing configuration fails closed. `src/db/client.ts` preserves the existing `db` export using this factory and `createDrizzleDb`; there is no SQL on import and no Turso fallback.
- `createDrizzleDb(client)` uses pinned SQLite-proxy and existing schema encoders/decoders. It maps values using explicit projection-ordered `columns`, not sorted object keys. `all`/`values` receive matrices; `get` receives one row or undefined. The pinned callback declaration types `rows` as an array even for a missing `get`; the non-null type assertion on its array lookup leaves the required runtime undefined unchanged, proved through actual `.get()` and relational `findFirst` requests. There is no SDK result cast or invented insert-ID/type metadata. `run` carries real `rowsAffected`. Interactive transactions/savepoints remain unsupported, and no optional Drizzle batch callback is supplied.
- `close()` is an idempotent compatibility no-op. Await operations before ending a job.

The Worker handles only exact `POST /api/internal/db`. It compares fixed-size SHA-256 digests of bearer values before processing the body or accessing the binding. Viewer cookies/JWTs and the presence of Access headers do not authorize SQL. Edge Service Auth remains independently owned by #25/#28. Actual streamed bytes are bounded, strict envelopes are checked, and whole groups are validated before execution. SQL validation understands quoted delimiters and comments, rejects named/numbered binds, multiple statements, CTEs, extension/admin/session operations, and strips an optional trailing terminator plus its trailing trivia before native preparation.

Only `STEAM_VALUE_DB_TOKEN` is selected by the Worker-secret script. This preparation did not execute that script, Doppler or any secret-download wrapper. At #20's submission the legacy viewer constructor awaited #21; accepted integration now removes it and uses native D1 for every viewer route. #27 also removes the unused legacy deal-table ensure. See the [final active inventory](d1-consumer-schema-inventory.md#integrated-preparation-status-27) and [integrated evidence](d1-integrated-rehearsal.md). Existing production remains Turso under the held-main-merge policy, not through a prepared-code fallback. Operator migrations are separate and are never called from this endpoint or these clients.

## Errors and outcomes

Normalize caught Drizzle errors with `toDbError(error)` before storing or reporting them. Pinned Drizzle wrappers contain SQL and parameters; normalization follows their cause to the safe database error without retaining the unsafe wrapper as a cause. Unrecognized errors become a generic unknown outcome. Do not print the original error, message or stack.

- Authentication, configuration and input/limit rejection: `not-applied`.
- Definitive native SQL/constraint rejection: `SQL_ERROR`, single `not-applied`, native batch `rolled-back`. Safe messages distinguish constraints and syntax; missing fixed-inventory tables retain recognizable messages such as `no such table: sync_state`. Native failures without definitive SQLite rejection remain conservative.
- Successful execution with undeliverable output: `RESULT_LIMIT`; reads `not-applied`, writes `committed`. No successful truncated prefix is returned.
- Lost, redirected, truncated, malformed or oversized untrustworthy replies, transport reset or deadline after write dispatch: `OUTCOME_UNKNOWN`, `unknown`. Reads instead receive safe transport/protocol/result-limit errors with `not-applied`.
- Correlation UUIDs are not idempotency keys. There are no automatic retries. After `unknown` or `committed` errors, stop affected work and inspect/reconcile state by business keys/checkpoints/lease token before an explicit resume. Do not increment attempts or advance checkpoints speculatively.

Wire replies validate version, status, correlation, exact envelope/result/error fields, outcome consistency, batch cardinality, column labels, scalar values and affected-row counts. All machine responses use `Cache-Control: no-store`. No configuration, raw gateway body, SQL parameter or native error object is logged by the access module.

## Isolated verification

`src/db/request.test.ts` uses the shared `createD1WorkerTestHarness()` from `src/db/testing.ts`, which builds the actual Worker entrypoint with the production browser-target bundler and runs it inside disposable local workerd/D1. Each scenario owns a fresh runtime, synthetic bearer credential and explicitly bootstrapped complete schema. External raw/Drizzle clients use that same real Worker request interface. Boundary fault injection changes replies only after the real Worker/D1 operation; assertions inspect returned results or state through the endpoint, never internal classes/call counts or backdoor business queries. Native Node TypeScript also runs the raw client against the same Worker/D1 through an injected stdio request bridge, without inherited credentials. Fixture sockets use ephemeral loopback ports, CF metadata fetching is disabled, and teardown disposes each runtime. Explicit `.ts` ESM imports and erasable TypeScript keep the scheduled-runtime path supported.

After merging #19 at `3ca52af`, fixture setup uses its `loadMigrations`/`applyMigrations` and complete SQL history instead of the original games-only schema. With the coordinator's authorization, `src/db/testing.ts` now exports `createD1WorkerTestHarness`/`D1WorkerTestHarness` for ordinary request/business tests, while preserving `createD1TestHarness(workerFetch)` for explicit supplied-handler/bootstrap and handler-level edge probes. Both have the same `fetch`/`clientConfig`/`dispose` shape; see the [fixture guide](d1-local-bootstrap.md#reusable-workerd1-fixtures). Using a host callback executes the Worker in Bun against proxied D1 bindings, not within workerd; the [repair record](d1-access-test-repair.md) describes the failing/working lifecycle probes. `createD1WorkerTestHarness({ bootstrap: false })` runs the same actual bundle without setup and proves runtime access does not implicitly create tables. Missing-binding/configuration probes and the deliberately false Content-Length stream still use the actual exported handler; HTTP framing cannot faithfully transport an under-declared Content-Length.

Red → green slices were executed individually for authorization, ordered native results, strict SQL/wire rejection, external raw operations, native batch rollback, input limits, Drizzle mapping/error normalization, result limits, unknown write outcomes, explicit configuration, SQL/credential-header edge cases, and native Node client portability. Additional regression coverage exercises independent Game Catalog scenarios, concurrent grouped reads/writes, the actual 45-second response deadline, unauthorized writes, correlation, safe missing-table errors and ORM-wrapped uncertainty. Original console evidence is under `/tmp/steam-value-d1-20-evidence/`; integrated repair evidence is under `/tmp/steam-value-d1-20-repair/`. Tests and the repair record are the durable evidence.

Commands (no production credentials required):

```sh
bun install --frozen-lockfile
bun test
bun run build
bun run typecheck:db
bun run typecheck:db-access
uv run --no-project --python 3.14 --with-requirements .comment-policy/requirements.txt python .comment-policy/check.py
git diff --check
```

Integrated local preparation checks: **83 Bun tests pass** (all 81 integrated tests retained, plus two independent-catalog scenarios). Normal `typecheck`/`build` includes all five TypeScript projects: Worker, web, browser sync, database tools and database access. `typecheck:db` preserves #19's tools coverage; `typecheck:db-access` preserves #20's adapter/test/selected-secret-script coverage. Production build, frozen-lockfile install, comment policy and whitespace checks pass. These are local preparation results, not production evidence.

Commit hooks additionally check the complete staged index with comment policy and Gitleaks. The deadline test intentionally takes approximately 45 seconds with its existing 60-second test allowance; all other request tests retain the default 5000ms timeout. Time/randomness and D1 are not replaced with internal mocks. No SQL or HTTP retry was introduced to make these checks pass.

No remote D1/Turso calls, production data, provisioning, deployment, infrastructure apply, arcane changes, main promotion, ticket writes/closure or agent launches were performed. Edge policy/deployment-token capability and final native-D1 viewer evidence remain external/downstream gates, not claims from these local tests.
