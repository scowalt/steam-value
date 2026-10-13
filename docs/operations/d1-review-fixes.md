# #27 application review fixes

Preparation-only follow-up to [integrated rehearsal](d1-integrated-rehearsal.md). Parent supplied independent reports at `/tmp/steam-value-d1-17-plan/review/{standards,spec}.md`: **0 hard Standards breaches, 3 application judgment smells; no SPEC findings**. Reports are read-only inputs, not edited or rerun by this implementer. Parent authorized one implementer to address all three. Clean starting branch fast-forwarded to accepted integration `f52505b77d12e9772b1e44614da2d44abde1a12d` before changes; latest integration was rechecked before handoff.

**Independent re-review on both axes, parent integration/cleanup/#27 closure and all production approvals remain pending.** Existing production stays Turso and BOTH main merges remain held. No companion/main/research/ticket changes, agent launches/messages, production/Doppler/source/account/secret access, deploy/apply or arcane operations were performed. The [cutover](d1-cutover.md), [credentials](d1-credentials.md) and ≥7-day retention gates are unchanged; #17/#28/#29 cannot close on this code evidence.

## 1. Paired offer-write expectations

Standards pointers: `deal-refresh.ts:19`, 72–84 and 194–200 at the reviewed tip. `WriteGroup` is now an array of typed `{ statement, requireOne }` entries, not parallel SQL/boolean arrays. Mapping invalidation (`requireOne: false`) and mapping upsert (`true`) stay one complete logical group; available retail/bundle entries retain their `true` expectations and order. Packing carries entries together; only validation/UTF-8 sizing/native dispatch projects SQL statements. Ordered native results check their corresponding entry's affected-row expectation.

SQL bytes/arguments, phase-wide preflight, atomic pair boundaries, 400-statement/4-MiB packing, native batch order, lease fencing and unknown/committed write stops are preserved. No statement or logical group is silently split or retried. This is a review-stage refactor, not invented behavior or a private-helper test. The **unchanged** offer module passes 21 cases/82 assertions both before and after (`01-paired-{before,after}.log`), including rollback, byte-heavy publication and fenced late mapping/publication/completion.

## 2. Provider-owned typed, safe diagnostics

Standards pointer: `deal-refresh.ts:161–175`. Prose membership/regex recognition is removed. Small provider-owned `itad-errors.ts` exports `ItadError`/`ItadErrorCode`; the producer selects an existing diagnostic by stable code (plus bounded HTTP status). The safe diagnostic is retained privately, separately from mutable `Error.message`. `ItadError.safeMessage` accepts only a correctly branded instance, never a lookalike name/code/prose error. `ItadClient` now emits these errors for its existing known failures; messages, retry policy, request parameters, provider validation/freshness and public `DealSource` stay unchanged.

The refresh wrapper accepts that provider-owned safe diagnostic, otherwise records/throws the same generic `Offer provider request failed`. It does not expose raw gateway bodies/keys/SQL, attach an unsafe cause, change DB error/outcome handling or identify trust from prose. Trusted synthetic unavailable fixtures now construct the typed error; all original expected messages/assertions remain. A plain exception merely saying a known message is deliberately **untrusted** and redacted, as requested by the review fix.

The contract lives separately from the Bun provider implementation, with erasable Node-compatible TypeScript; native Node 24 services do not acquire a Bun import or parameter-property syntax dependency.

Red → green at the existing injected-provider/actual Worker-D1 refresh seam:

- Three spoofed Error/name/code cases (`ITAD unavailable`, `Invalid ITAD object`, HTTP 401 prose) fail with the old prose recognizer: **0 pass / 3 fail** (`02-provider-spoof-red.log`). The typed contract passes all three with generic persisted safe failure (`02-provider-spoof-green.log`).
- Three actual `ItadClient` fake upstream responses verify known object/JSON/HTTP errors remain useful through native persisted refresh state, distinct from spoofed messages. Another case overwrites a trusted error's public message with untrusted text and verifies its original safe diagnostic is retained. Providers/time are the existing allowed injection interfaces; the DB is not mocked.
- The unfiltered provider/offer modules pass **35 cases / 121 assertions** (`02-provider-focused-green.log`); all seven type projects pass (`02-provider-types.log`).

## 3. Shared test-only framed subprocess bridge

Standards pointers: `request.test.ts:103–130`, `steam-status-refresh.integration.test.ts:206–249`, `refresh-jobs.integration.test.ts:52–95`. `src/db/subprocess-testing.ts` owns newline buffering/streaming UTF-8 decode, optional prefix filtering, request/header reconstruction, actual Worker dispatch/response forwarding, stdin closure and awaited process/reader/stderr cleanup. It requires a supplied child and dispatch function; there is no default network, runtime launch, SQL endpoint or provider in it. Stderr is consumed/discarded, never published. No vendor-private API, fixture collection change, SDK clone, retry, sleep or timeout is introduced.

The three consumers retain their exact child programs, native Node/Bun launches, synthetic environments, provider/time fixtures, frame formats and behavioral assertions. They still use actual external clients through the bundled Worker/native local D1. Runtime-specific completion/result assertions remain at callers. The helper is test-only and typechecked with its test; it is not imported into Worker/browser output or routine jobs.

New functional regression launches a real credential-free child, sends prefixed chunked Unicode through the actual HTTP client/native D1, ignores unrelated human stdout, consumes synthetic stderr and verifies returned **and persisted** data plus exit 0. It uses the unchanged default timeout, not an SDK/layout test. Initial missing-interface red is `03-bridge-red.log`; executable green is `03-bridge-green.log`. With only prefix filtering withdrawn, this same native workflow fails before completion (`03-bridge-prefix-red.log`); restoring it passes (`03-bridge-prefix-green.log`). Two diagnostic probes (late stderr drain and non-streaming decode) happened to pass with this host's buffering; they are retained as probes, **not claimed as red regressions or vendor guarantees**. An initial oversized `-e` argument hit OS `E2BIG`; the child now constructs the known synthetic payload locally instead of placing the payload in argv. No test allowance changed.

All request/Node/job consumers plus the new bridge case pass **37 cases / 304 assertions** unfiltered (`03-consumers-green.log`), including the actual 45-second deadline and native Node 24/Playwright loading. All seven types pass (`03-types.log`).

## Repeated integrated checks

All **214 original tests**, their **1,229 assertions**, and all original timeout allowances remain; eight added cases contribute exactly 17 new assertions. Serial sanitized unfiltered runs on the final code candidate:

| Artifact | Result | Assertions | Files | Duration |
| --- | --- | --- | --- | --- |
| `full-1.log` | 222 pass / 0 fail | 1246 | 18 | 179.97s |
| `full-2.log` | 222 pass / 0 fail | 1246 | 18 | 180.71s |
| `full-3.log` | 222 pass / 0 fail | 1246 | 18 | 182.23s |

`build.log` passes normal build and all **seven** type projects. A fresh compiler file-list union covers **82** added/changed TypeScript files against spec baseline `299c9e20feb23dfb5aaa8913d16eafc94fcfd123`, zero uncovered: previous 78 plus provider producer/error contract and test bridge/test. No new type project or policy exclusion is needed. Comment policy/13 regressions, whitespace, complete staged-index secret/comment checks and normal commit hooks are rechecked at handoff; the final SHA/check results are reported by the implementer.

Protocol/adapters, immutable migrations/transfer, shared native owner/fixture compatibility mitigation, formula, CI/deployment/Worker configuration and arcane units are byte-unchanged from `f52505b`. Migration SHA-256 remains `bcb5a3738c65336b9af697be9816d3039edffd9da0ef627cc50da5ecf5d0a83a`. Bundle inspection finds no test bridge/fixture or legacy Turso/libSQL material, and no machine credential names/endpoint in frontend assets. Actual permissions/Access/deployment/data behavior remain UNVERIFIED.

Protected local logs, diagnostic probes, diff/type audit and final handoff are at `/tmp/steam-value-d1-27-review-fixes/` (directory 0700, files 0600), outside Git. No source data/table artifacts are committed. Parent owns serialized merge, independent **re-review both axes**, any remaining findings through this same implementer, cleanup and #27 closure. No review acceptance or production approval is inferred from these passing local checks.
