# D1 access contract v1

Handoff for [#18](https://github.com/scowalt/steam-value/issues/18) under the [approved #17 preparation plan](https://github.com/scowalt/steam-value/issues/17#issuecomment-6135327372) and [ADR 0004](../adr/0004-move-database-to-cloudflare-d1.md). These names and guarantees record #18's implementation target for #19/#20/#25 and their dependents, **not production authorization**. The held integration now contains local preparation implementations; see the [#27 status/evidence](d1-integrated-rehearsal.md) for current coverage and the still-UNVERIFIED live gates. Source coverage is in the [consumer/schema inventory](d1-consumer-schema-inventory.md); evidence ownership and promotion/freeze gates are in the [acceptance map](d1-acceptance-map.md).

One deep database-access module hides native/HTTP transport, authorization configuration, limits, result conversion and safe errors. Preserve used raw-SQL and Drizzle behavior, not the entire libSQL SDK. No per-table repository rewrite, direct routine D1 REST/account credential, backend default, fallback or dual-writing.

## Names and ownership

| Name/path | Contract and owner |
| --- | --- |
| Worker `Env.DB` | One native `D1Database` binding, Wrangler `binding = "DB"`. No caller-selectable account/database. #19 owns local binding/migration configuration; #20 uses it in the existing Worker. Production database identifier comes only from separately approved #25/#28 provisioning, never a guessed/example ID. |
| `migrations/` | Immutable, ordered SQL history for all seven tables/indexes, starting with `0001_complete_schema.sql`; application-owned (#19), not generated/ignored `drizzle/` as the authoritative history. |
| `src/db/access.ts` | #20 exports `DbValue`, `DbStatement`, `DbResult`, `DbClient`, `DbError`, `toDbError`, `DB_LIMITS`. Portable types/validation/errors, no environment lookup or database on import. |
| `src/db/d1.ts` | #20 exports `createD1Client(binding: D1Database): DbClient`. Uses the supplied native binding, never process environment/Turso. Construction does not execute SQL. |
| `src/db/http.ts` | #20 exports `createHttpClient(config): DbClient` and `createExternalClient(env): DbClient`. Explicit HTTP configuration; external factory reads only the four keys below. No Bun-only APIs, so scheduled Node/Playwright remains supported. |
| `src/db/drizzle.ts` | #20 exports `createDrizzleDb(client: DbClient)` using pinned `drizzle-orm/sqlite-proxy` and existing schema types. |
| `src/db/client.ts` | #20 preserves existing `db` export for all 30 Drizzle scripts, built from `createDrizzleDb(createExternalClient(process.env))`. No SQL/schema initialization. Raw scripts use the external factory, not this import-time singleton, especially the browser script's write-free `--login` branch. |
| `src/db/migrations.ts`, `src/db/testing.ts` | #19 exports explicit `applyMigrations` and fixture `createD1TestHarness` (below). No runtime adapter invokes bootstrap. |
| `src/db/transfer.ts`, `scripts/db-transfer.ts` | #26 owns explicit inventory/export/import/validation/recovery interfaces (below). Legacy libSQL access is permitted only here/documented recovery tooling after cutover. |

These are caller-facing exports, not a requirement for private class/helper layout. #19/#20 coordinate shared Wrangler edits; #20 owns runtime adapters/secret selection, #22 owns job environment templates, #23 catalog callers, #24 manual callers/tool replacements, #27 final runbooks/typecheck coverage. The coordinator serializes overlapping integration merges; do not duplicate modules or change shared names independently.

## Runtime interface

```ts
export type DbValue = number | string | null;
export type DbStatement = string | {
  sql: string;
  args?: readonly DbValue[];
};
export interface DbResult {
  columns: readonly string[];
  rows: readonly Record<string, DbValue>[];
  rowsAffected: number;
}
export interface DbClient {
  execute(statement: DbStatement): Promise<DbResult>;
  batch(statements: readonly DbStatement[], mode?: "read" | "write"): Promise<DbResult[]>;
  close(): void;
}
```

- String statement means no binds; absent `args` means `[]`. Anonymous positional `?` only, in argument order; bind count must match. Only finite numbers (integers must be safe JS integers), strings and null. Reject undefined, NaN/infinity, bigint, binary, arrays/objects, named/numbered binds and unencoded boolean/Date values; never blindly stringify/coerce. Existing raw writers already encode booleans as 0/1. Drizzle handles its booleans and Dates before transport.
- Supported runtime SQL: one `SELECT`, `INSERT`, `UPDATE` or `DELETE` statement, including current joins/subqueries, SQLite JSON functions, `ON CONFLICT` and `RETURNING`. A trailing terminator is allowed; multiple statements are not. Validate with SQL-aware handling of quoted strings/identifiers, not counting `?`/`;` inside literals. CTEs and other unused SQL forms are outside v1. Reject schema/admin SQL (`CREATE`, `ALTER`, `DROP`, `PRAGMA`, `ATTACH`/`DETACH`, extensions), transaction/session controls, dumps and unsupported operation kinds before execution. Explicit native/operator migration interfaces own schema work. This is trusted machine SQL on the fixed binding, not a browser SQL facility.
- `rows` preserve SQL row order, exact column labels and null versus zero/empty string. No adapter re-sorting, deduplication or JSON re-encoding. `columns` is **projection order**, not alphabetical/schema order. Supported projections have unique, non-integer-like labels (all inventoried consumers do); use explicit aliases if introducing ambiguous labels. Empty result sets return `rows: []`; `columns: []` is sufficient when there are no rows, since no existing caller consumes empty-result column metadata.
- Native single execution/batch results must retain ordered projection information. The current binding materializes object properties in projection order for the supported labels; keep that order explicitly in `columns`, validate response shape, and prove reordered projections on isolated D1. Do not assume arbitrary plain objects are positional rows, sort their keys, use private binding APIs, or execute SQL twice to obtain metadata.
- `rowsAffected` is D1 `meta.changes`, nonnegative integer, **not** `rows_written`, `rows_read`, rows returned or an insert ID. Preserve 0/1 counts for conditional leases and `RETURNING` results. No insert-ID/type/streaming metadata is promised.
- `batch` defaults to `"write"`; read mode accepts SELECTs only. Write mode can include SELECTs and DML. An empty public-client batch returns `[]` without execution; nonempty groups execute once. `close()` is an idempotent compatibility no-op, not transaction commit, cancellation or a request to close the Worker binding. Callers must await work normally.

### Drizzle SQLite-proxy translation

Keep `Game`/`NewGame` field names and the existing `db` interface. Convert each returned row to `result.columns.map(column => row[column])` in selected-field order, with no object-key sorting. Single callback methods `all`/`values` return `{ rows: valueRows }`; `get` returns `{ rows: valueRows[0] }` (undefined for no row). `run` retains safe affected-row information without inventing libSQL metadata. No inventoried consumer uses Drizzle `db.batch`; it is not an additional required v1 surface. If supplying its optional proxy batch callback, return results in input order with the pinned mapper's method-specific shape (`get` consumes a single value row, not a row matrix), and use one shared-client native batch, never parallel execute calls.

Let pinned Drizzle column encoders/decoders retain integer boolean 0/1, Date→`floor(milliseconds/1000)`→Date and client defaults/`$onUpdate` binds. Keep `tags`/`offers_json` as JSON text, not objects or double-stringified strings. A `findFirst` or insert `returning()` must recover the same typed fields as before. Interactive Drizzle `transaction()`/savepoints are unsupported; none is currently used. Do not emulate transactions across requests. Representative relational/projected reads, nullable Date/boolean fields and `returning()` must pass through the Worker request seam before claiming compatibility.

## Endpoint, configuration and authorization

**Exact route: `POST /api/internal/db`**, on the existing Worker/custom-domain origin. No GET execution, alternate path, trailing-slash alias, browser SQL UI, CORS credential permission or public bypass. Preserve existing viewer paths/response shapes and Access rules. Unsupported methods/path forms must not execute SQL.

| Shared environment key | Distribution and meaning |
| --- | --- |
| `STEAM_VALUE_DB_URL` | Non-secret **full endpoint URL**, HTTPS, exact `/api/internal/db`, no userinfo/query/fragment. External jobs/tools only. No implicit origin/backend default. |
| `STEAM_VALUE_DB_TOKEN` | Separate application bearer secret, same key/value in external environments and Worker secret. Worker native viewer reads do not send it over HTTP. Only this key belongs in the Worker's selected database-secret set. |
| `STEAM_VALUE_ACCESS_CLIENT_ID` | Cloudflare Access service-token client ID for external callers. Send as `CF-Access-Client-Id`. |
| `STEAM_VALUE_ACCESS_CLIENT_SECRET` | Cloudflare Access service-token secret for external callers. Send as `CF-Access-Client-Secret`. Not a Worker secret. |

`createHttpClient` configuration fields are `url`, `token`, `accessClientId`, `accessClientSecret`, optional `fetch` (defaults to global fetch). `createExternalClient(env)` requires all four environment keys, mapping them once to this configuration. Neither factory contacts the database on construction. No routine `CLOUDFLARE_API_TOKEN`, account ID, database ID or Turso credentials. No automatic fallback if any value/binding is missing. Local fixtures use synthetic credentials and a synthetic HTTPS URL with injected dispatch to the **real** isolated Worker/D1, not a mocked database or an insecure production URL mode.

The external client sends `Authorization: Bearer <application credential>` plus both Access headers, `Content-Type: application/json`, and optional UUID `X-Steam-Value-Request-Id` for correlation. Reject redirects (`redirect: "error"`) rather than forward credentials to a different host/login page. Never print configuration values/headers, URLs containing credentials, SQL parameters, raw upstream bodies or database error objects.

Authorization has two independent layers:

1. Mission-control (#25) owns a narrowly scoped Access application/policy for `/api/internal/db` with **Service Auth**, referencing only externally provisioned non-secret service-token identifiers. A more-specific path app does not inherit the human root policy. Preserve viewer Access/custom domain, disabled workers.dev/preview endpoints and empty cron. Generate no Access secret via a Terraform/OpenTofu service-token resource that puts it in state; approved operator provisioning supplies Doppler separately (#28).
2. Worker (#20) checks its configured `STEAM_VALUE_DB_TOKEN` against the bearer credential before preparing, executing or initializing anything. Missing/invalid/viewer-only credential fails closed; unconfigured bearer or `DB` fails closed. Compare secrets without a length/value timing leak. Cookies, Access viewer JWTs/sessions, or presence of client-supplied Access headers alone are not machine authorization. Do not validate Access by trusting header presence: the edge Service Auth policy performs that validation.

Doppler remains source of truth; only approved operator workflows copy selected secrets into Worker/protected mode-0600 arcane environment files. Steam/ITAD job keys stay external; Steam cookie stays in the Steel profile. `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` were never ordinary D1 configuration and are now retired for the deleted source under [ADR 0007](../adr/0007-retire-turso-after-owner-approved-early-cutover-acceptance.md). The supplied-handle legacy adapter remains an explicit operator interface, not a retained connection or automatic fallback. Do not run baseline secret-download wrappers during preparation. Local tests prove application authorization; they **cannot prove edge Access policy or actual deployment-token capability**. #28 must verify both in the approved environment, including alternate public route rejection.

## Wire format and validation

Strict JSON v1, unknown fields rejected at every envelope/statement level. Serialize the public string shorthand to `{ sql, args: [] }` on the wire; no account/database selectors or administrative operation flags.

```json
{"version":1,"op":"execute","statement":{"sql":"SELECT name FROM games WHERE steam_app_id = ?","args":[42]}}
```

```json
{"version":1,"op":"batch","mode":"read","statements":[{"sql":"SELECT name FROM games WHERE steam_app_id = ?","args":[42]},{"sql":"SELECT checked_at FROM itad_game_map WHERE steam_app_id = ?","args":[42]}]}
```

Execute success (HTTP 200): `{ version: 1, ok: true, requestId, result: DbResult }`. Batch success: `{ version: 1, ok: true, requestId, results: DbResult[] }` in input order. Failure: `{ version: 1, ok: false, requestId, error: { code, message, outcome, statementIndex? } }`. UUID correlation is not an idempotency key, replay ledger or deduplication promise. Accept only a valid UUID correlation header or generate a fresh one; do not echo arbitrary input as diagnostics.

Authorize before body processing/database access. Enforce byte limits on the streamed actual body, not just `Content-Length`; reject unsupported content type/encoding, invalid JSON, wrong version/op/mode, empty wire batch, unknown fields, invalid values/binds and over-limit statements/groups. Validate the **whole** group before executing its first statement. Native callers get the same supported-operation/limit checks; local access is not a bypass. Client validates successful response/envelope/column/value/count/result cardinality rather than accepting HTML, malformed JSON or partial results as success. Responses use `Cache-Control: no-store`.

### Practical bounds: `DB_LIMITS`

These are shared native/client/endpoint v1 bounds, not production size/performance claims. Platform limits still apply independently; no automatic lowering of public viewer page sizes.

| Exported field | Value | Reason/handling |
| --- | --- | --- |
| `maxParams` | 100 per statement | Platform maximum; count all generated binds, including defaults/country/guards. |
| `maxSqlBytes` | 96,000 UTF-8 bytes per statement | Below D1's 100,000-byte SQL limit; not character count. |
| `maxStatements` | 400 per nonempty atomic batch | Accommodates current 200-game offer groups; below Paid 1,000 queries/invocation. This is **not** Free-plan compatibility or evidence of Paid provisioning. |
| `maxRequestBytes` | 4,194,304 (4 MiB) | Entire serialized UTF-8 envelope, including all SQL/args/JSON escaping. |
| `maxStringBytes` | 1,000,000 UTF-8 bytes | Bound scalar argument/result strings; D1 separately limits strings/rows to 2,000,000 bytes. Unsupported live extremes block import/promotion, not silent clipping. |
| `maxRowsPerResult` | 10,000 | Fail an oversized result, never return a successful prefix. |
| `maxResponseBytes` | 8,388,608 (8 MiB) | Entire serialized result envelope across the batch; no duplicate positional/object payload required. |
| `timeoutMs` | 45,000 | External request deadline allows overhead around D1's 30-second query/batch limit; abort is **not** database cancellation. |

Validate input bounds before DB access. Result size can only be known after execution: a rejected oversized write/RETURNING result may already be committed, so report that outcome rather than claiming rollback. A serialization/network failure with no trustworthy outcome remains unknown. Bound result allocation with limited SQL where callers can predict size; response caps alone do not make an unbounded query memory-safe.

The module **never silently splits an atomic group or rewrites arbitrary SQL for pagination**. Consumer owners explicitly partition independent larger work and aggregate complete reads. Prefer bounded, ordered/keyset pages (initially at most 1,000 rows, smaller for wide JSON) with completion checks; preserve specified SQL ordering and every intended row. Multi-page reads are not a shared snapshot unless performed under the explicit frozen-source/export interface. Large `findMany` consumers need deliberate complete paging/aggregation, not a hidden result cap presented as success.

Specific bounds: offer reads use at most **99 IDs plus country**; a 500-game page needs six chunks, all mapping/cache SELECTs in **one** native read batch. Wishlist updates use at most **98 IDs plus flag and implicit timestamp** at pinned Drizzle. Cleanup allows **100 IDs** only when there are no additional binds. A full 31-column parameterized game import allows **3 rows** before fixed binds. Upstream Steam/ITAD batch sizes remain unchanged. Offer mapping deletion/publication groups cannot be split for byte pressure; reject before execution, and let #22 form smaller complete logical groups preserving the guards/atomic pairs. Stop and expose unsupported data extremes, never discard rows/offers.

## Atomicity and read guarantees

- Every nonempty client batch corresponds to **one native `DB.batch(preparedStatements)`** and, externally, one HTTP call. Statements/results retain input order; native transactional rollback on a failed statement is required. No success-prefix results or independently committed calls.
- Read batches use the same native transactional group so chunked mapping/cache reads share a consistent snapshot. Plain `Promise.all(execute(...))`, separate requests or a D1 Session's sequential consistency are not substitutes.
- Use the native primary binding, not Sessions/read replicas. No stale replica reads for leases or read-after-write job state. Separate client calls have no whole-job/request snapshot guarantee: browse+offers, state+coverage, lease+updates+completion, and catalog flush+checkpoint remain separate as at baseline.
- Consumer-visible zero affected rows is meaningful, not an error automatically retried by transport. Preserve existing token/expiry fencing and failure handling; do not claim a transactional whole refresh or fix Steam's unfenced game updates as part of this migration.

## Safe errors and unknown write outcome

`DbError` is the raw client's public rejected-operation error with `code`, safe `message`, `outcome`, `requestId?`, `statementIndex?`. `outcome` is one of `not-applied`, `rolled-back`, `committed`, `unknown`; it describes **write effects**, not whether a read happened. Statement index is zero-based and included only when reliably known. Do not fabricate native error metadata.

`toDbError(error: unknown): DbError` preserves these fields from an existing DbError or a recognized wrapped cause, discards unsafe wrapper details, and otherwise returns a safe generic error with conservative `unknown` outcome. **Pinned Drizzle wraps callback errors in `DrizzleQueryError` whose message contains SQL and parameters.** #20 supplies normalization; #24 must use it at existing Drizzle catch/report/log paths rather than print/store the outer error/message/stack. Unknown-outcome detection must inspect the normalized error, not lose it in an ORM wrapper. Never attach that unsafe wrapper as a loggable cause. This is error handling at existing caller interfaces, not another test seam.

| Code / HTTP status when Worker can reply | Meaning |
| --- | --- |
| `UNAUTHORIZED` / 401 | Missing/invalid machine bearer; `not-applied`. No DB access. |
| `NOT_CONFIGURED` / 503 | Missing required client configuration, Worker bearer or binding; `not-applied`. No fallback/initialization. |
| `INVALID_REQUEST` / 400 (method 405, media type 415) | Unsupported/malformed request/SQL/value; `not-applied`. |
| `LIMIT_EXCEEDED` / 413 | Input/group bound exceeded; `not-applied`, whole group rejected before execution. |
| `SQL_ERROR` / 422 | Confirmed SQL/constraint failure: single statement `not-applied`, failed native batch `rolled-back`. Only claim these outcomes on a definitive native rejection, not an ambiguous infrastructure error. |
| `RESULT_LIMIT` / 413 | Output cannot be delivered within bounds: read `not-applied`; completed successful write/batch `committed`. Never report a successful truncated result. |
| `TRANSPORT_ERROR`, `PROTOCOL_ERROR` / 502 if a reply is possible | Read-only failure, `not-applied`; safe diagnostic, no gateway/body echo. |
| `OUTCOME_UNKNOWN` / 503 if a reply is possible | A write-capable execution may have run/committed; `unknown`. Includes lost response, deadline, reset, invalid/truncated reply or ambiguous native failure after dispatch. |

Return safe categories/messages rather than raw D1/libSQL SQL/parameter-bearing errors/stacks. Preserve recognizable missing-table messages for the fixed inventory, especially **`no such table: sync_state`**, so the current status reader can still return null. Constraint/syntax/configuration failures must remain distinguishable and diagnosable with correlation/code/outcome, without secret/value disclosure. Redact at the module/Worker logging boundary; existing job catch blocks may store `error.message` in state, so that message must already be safe.

No automatic HTTP/database retry in v1, and **no blind retry of a write after dispatch**. A server-reported rejection/rollback is different from no trustworthy response. Client correlation IDs do not make an attempts increment or new insert idempotent. After `unknown` or `committed` error, stop the affected work, inspect state through the supported interface using business keys/checkpoints/lease token, then explicitly resume/reconcile if safe. Do not advance catalog checkpoints, increment failure attempts again, overwrite lease state or advertise successful score/job counts based on an uncertain response. Consumer tickets preserve existing diagnosable failure state without concealing uncertainty; a later scheduled run is not permission for transport-level replay. Reads may be deliberately retried by the caller; provider retry policy remains separate.

## Explicit bootstrap, transfer and recovery interfaces

These are the other already-approved seams, separate from runtime SQL. No request, ordinary deployment, client import or refresh job calls them. No production operation is performed or authorized by this document.

- **#19 bootstrap:** `applyMigrations(binding, migrations)` explicitly applies ordered immutable `{ id, sql, checksum }` migrations to the supplied native/local binding, returning applied/already-applied IDs and a schema fingerprint. Detect changed applied checksums/incompatible existing schema rather than hide drift with `IF NOT EXISTS`. Track migration/internal metadata separately from seven application tables. `scripts/db-migrate.ts --local --persist-to <isolated-directory>` / `bun run db:migrate:local` must be an explicitly local bootstrap, never a default remote push. Remote schema application belongs to the separately approved operator runbook. Preserve client-only games timestamps; label local `sync_state` choice provisional pending authorized source inventory.
- **#19 fixture:** `createD1TestHarness(workerFetch)` explicitly creates disposable isolated real D1, bootstraps the same versioned migrations, and supplies `{ fetch(request), dispose() }` bound to the existing Worker request implementation. No secrets/provider network or production persistence. #20 and consumer tickets exercise external client/behavior through that fetch interface; schema/transfer assertions use their explicit interfaces, not backdoor queries to test business behavior. Private fixture setup need not become production exports.
- **#26 transfer:** `inventorySource(source)`, `exportSnapshot(source, destination, freezeRecord)`, `importSnapshot(target, snapshot)`, `validateSnapshot(target, snapshot)`, `prepareRollback(target, baselineSnapshot, destination)` are the public operation names. `scripts/db-transfer.ts` exposes `inventory`, `export`, `import`, `validate`, `prepare-rollback` explicitly; source/target are operator-supplied handles, not selectors added to `/api/internal/db`. Default to isolated local/synthetic execution; live handles require separately authorized operator action, never discover production from `dev` credentials.
- **Artifact contract:** manifest version 1 identifies source, migration/schema fingerprints, complete application-object/column/default/index/trigger/view inventory, per-table column order/keys/storage types/row counts/content digests, `sqlite_sequence` high-water state, explicitly excluded internal metadata and the freeze/consistent-snapshot evidence. Preserve complete typed values, nulls, JSON strings and seconds outside Git. Validation compares full content/schema and representative viewer/job results, not just counts. Any extra/missing/incompatible object/type or unsupported size is an explicit drift failure; carry authorized changes into reviewed schema/import tooling or stop. The owner/coordinator resolves live drift, including `sync_state.updated_at`; local provisional schema is not permission to overwrite it.
- **Consistency/completion:** export a real consistent source snapshot or an attested frozen source, not unrelated live pages called a snapshot. Import targets a deliberately selected empty/staging database after explicit bootstrap; bounded import batches are **not a whole-import transaction**. Interrupted/failed imports are marked incomplete in the protected receipt, cannot pass validation/promotion, and are restarted/recovered explicitly without destructive defaults or append/duplicate guessing. Validate sequence allocation beyond deleted high-water IDs in isolation.
- **Recovery:** capture a full consistent post-cutover D1 snapshot plus comparison/reconciliation manifest before any rollback. `prepareRollback` must preserve post-cutover changes and report `reconciliation-required`, not auto-write Turso or revert the Worker. Gate any replay/manual reversion on reviewed reconciliation; no blind fallback. Retain read-only Turso and validated exports ≥7 days, then require an explicit owner decision for deletion/credential retirement or continued retention.
- Snapshot/artifact directories are protected (directory mode 0700, files 0600), outside Git/public issues/logs; manifests can contain sensitive data/schema identifiers too. Reports expose only safe summaries/pointers. Tooling must not read/download credentials during local CI. #26 owns exact artifact encoding/CLI help; preserve this operation/receipt contract without creating a general transport SDK.

## Verification handoff and primary references

Owner-approved seams: existing Worker requests with real isolated D1; external client through that same interface; existing pure/injected behavior; explicit bootstrap/transfer/recovery. TDD references read for #18: `/home/scowalt/.agents/skills/tdd/{SKILL,tests,mocking}.md`. Behavior tickets use one red→green vertical slice at these seams. Documentation-only #18 adds no document-layout tests or artificial failing tests.

#19/#20 establish schema/auth/serialization/results/rollback/grouped reads; #21–#24 prove consumer behavior/limits; #26 proves all-table transfer/recovery; #27 consolidates applicable Bun tests, all typechecks (including changed admin/migration code), build, comment/secrets checks and independent review. These are future acceptance evidence, not results supplied by this contract.

Primary sources checked for this contract:

- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) — 100 binds, 100,000 SQL bytes, 2,000,000-byte values/rows, 30-second execution/batch, Paid 1,000 queries/invocation.
- [D1 native batch/primary behavior](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) and [prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/) — ordered transactional results; raw arrays alone omit metadata. [Binding source](https://github.com/cloudflare/workerd/blob/main/src/cloudflare/internal/d1-api.ts) explains current projection-object materialization; it is not license to depend on private APIs.
- [Drizzle SQLite-proxy support](https://orm.drizzle.team/docs/latest-releases/drizzle-orm-v0295), pinned [proxy mapper](https://github.com/drizzle-team/drizzle-orm/blob/0.45.1/drizzle-orm/src/sqlite-proxy/session.ts), [integer encoding](https://github.com/drizzle-team/drizzle-orm/blob/0.45.1/drizzle-orm/src/sqlite-core/columns/integer.ts), [default/update binding](https://github.com/drizzle-team/drizzle-orm/blob/0.45.1/drizzle-orm/src/sqlite-core/dialect.ts), [query-error wrapping](https://github.com/drizzle-team/drizzle-orm/blob/0.45.1/drizzle-orm/src/sqlite-core/session.ts).
- [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) and [path-specific applications](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/) — independent edge Service Auth protection.
- [Worker binding authorization](https://developers.cloudflare.com/workers/authorization/#bindings) — official Worker Editor capability does not prove the actual protected deployment credential works; #28 verifies after approval.
