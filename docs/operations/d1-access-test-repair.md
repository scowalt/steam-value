# Integrated #19/#20 request-test repair

Preparation-only evidence for [contract v1](d1-access-contract.md). The repair branch merged integration's #19 commit `3ca52af477c299119eddb4e1504c2b9f26316532` before diagnosis. It preserves the complete migration history, operator scripts, supplied-handler/bootstrap fixture and both database TypeScript projects. The coordinator subsequently authorized extending `src/db/testing.ts` with the shared native fixture. No production credentials, remote database calls, deployments, ticket writes or infrastructure changes were used.

## Reproduction and minimization

The first unfiltered, credential-free run reproduced **73 pass / 8 fail**. The smallest repeatable timeout retained three executed tests and the Worker rankings test module with all its cases filtered out:

```sh
env -i PATH="$PATH" HOME="$HOME" WRANGLER_SEND_METRICS=false \
  bun --no-env-file test \
  src/worker/games.test.ts src/db/migrations.test.ts src/db/request.test.ts \
  --test-name-pattern 'explicit bootstrap makes|result limits|lost or untrustworthy'
```

The lost/untrustworthy-reply case exceeded its unchanged 5000ms timeout and Bun killed a dangling fixture process. Removing the Worker test module, the preceding bootstrap case, or the preceding result-limit case made this minimized run pass. Filtering was diagnostic only; acceptance uses the unfiltered suite.

Before instrumentation, the ranked predictions were:

1. **Fixture lifecycle overlap:** delaying runtime creation until setup would remove the failure if module-scope startup was the cause.
2. **Retained transport state:** ordinary small Worker/D1 requests after fixture disposal and large results would also slow down if the shared host transport was affected.
3. **Retained large responses/body allocation:** removing the large-result case would remove the slowdown if it triggered retained transport/allocation state.
4. **A stuck fault-body reader:** progress would stop at a particular injected response rather than slowing every ordinary request.

## Measured cause and rejected fixes

Sanitized boundary timings showed ordinary Worker/D1 round trips taking approximately **145–165ms** after large results. All fault-loop iterations progressed; the delay occurred during real Worker dispatch, including normal reset writes and verification reads. This contradicts a single stuck injected-response reader. The aggregate timeout killed the shared runtime, producing subsequent transport failures and unknown write outcomes.

Lazy creation, disabled CF metadata fetching, explicit loopback/ephemeral-port configuration, and substitution of #19's callback harness did **not** eliminate the minimized failure. Per-case callback-harness ownership made the minimized loop pass: ordinary requests returned to roughly **7–11ms**, and the complete lost-reply case took **442ms**. However, its unfiltered run still failed **80 pass / 3 fail**: large-result execution, the 400-statement boundary, and deadline teardown remained affected. That falsified fixture isolation as a sufficient repair.

The faulty test seam executed the actual Worker function **in Bun**, passing Miniflare's host-side D1 proxy. That adds cross-runtime binding RPC to native preparation, binding and result handling, which are in-process native operations in production workerd. Large-result state carried across cases in the shared fixture; bulk operations could still amplify the host-proxy overhead in a fresh fixture. This is a demonstrated fixture execution/lifecycle mismatch, not evidence of a production D1 or workerd SQL defect. The lower-level Bun/Miniflare transport implementation responsible for the latency jump is not claimed to be diagnosed.

## Repair and regression evidence

The shared **`createD1WorkerTestHarness(options?)`** in `src/db/testing.ts` bundles the actual `src/worker/index.ts` with the same browser-target/minified build options as production and executes it **inside workerd**. Requests use Miniflare's public `dispatchFetch`; business SQL runs against the native D1 binding within that Worker. Each scenario owns and disposes its runtime and synthetic token. Explicit setup uses #19's unchanged `loadMigrations`/`applyMigrations`, so the whole schema and migration receipts are present. Only the bundle is cached, never runtime or database state. There is no copied endpoint implementation, private binding API, internal mock or retry.

The coordinator requested extraction of the tested native fixture for #21–#24/#26. The shared export and `D1WorkerTestHarness` type retain the existing `fetch`/`clientConfig`/`dispose` shape. The optional `{ bootstrap: false }` is used by the retained no-implicit-schema test. `createD1TestHarness(workerFetch)`, `WorkerFetch`, `D1TestEnv` and `D1TestHarness` remain available for explicit supplied-handler/operator/edge probes. See the [reusable fixture guide](d1-local-bootstrap.md#reusable-workerd1-fixtures) for client/Drizzle setup.

Extraction also exposed a Request-body lifecycle issue in the supplied-handler path: unconditionally reconstructing a supplied Request could tee its stream, leaving oversized-body cancellation waiting on the unconsumed original branch. The existing 5000ms byte-boundary test caught that (**82 pass / 1 fail**). Dispatch now preserves an existing Request when no init override is supplied. Native response adaptation copies headers through their public APIs and bridges byte streams with backpressure/cancellation and reader-lock cleanup, satisfying both Bun/DOM and Worker type projects without SDK casts.

Two Game Catalog scenarios exercise isolation through the external client and actual endpoint, using the same business key with independently known empty initial catalogs. Written before the ownership fix, the second case failed because it observed the first case's row (**1 pass / 1 fail**). Both now pass. Existing large-result, 400-statement, rollback, concurrent snapshot, lost-reply/no-replay and real 45-second deadline tests remain unchanged in their assertions and timeouts.

The deliberate false Content-Length stream uses `createD1TestHarness(worker.fetch)` to invoke the actual exported handler with its real D1 binding: sending that header over HTTP causes framing to expose only the declared byte count, a different condition from a Worker Request whose body is larger than its header. The handler continues to reject actual oversized streamed bytes before SQL. Missing configuration/binding probes likewise call the actual handler directly. The separately unbootstrapped runtime runs the actual bundle without migration setup and retains the no-implicit-schema assertions.

All five projects are wired into normal `bun run typecheck` and therefore `bun run build`: `tsconfig.worker.json`, `tsconfig.web.json`, `tsconfig.browser-sync.json`, `tsconfig.db-tools.json`, and `tsconfig.db-access.json`. Both ticket-specific database scripts remain available.

## Acceptance commands and artifacts

Repeated acceptance runs use the complete suite, with no test filter or timeout override:

```sh
env -i PATH="$PATH" HOME="$HOME" WRANGLER_SEND_METRICS=false \
  bun --no-env-file test

env -i PATH="$PATH" HOME="$HOME" WRANGLER_SEND_METRICS=false \
  bun --no-env-file run build
```

Each successful full run reports **83 pass / 0 fail**, including all 81 original integrated cases and two new isolation scenarios. The extracted shared fixture is verified by the same complete suite, not a private-helper or call-count test: three consecutive final runs (`shared-native-full-2.log`, `-3.log`, `-4.log`) each passed all 83 cases and 513 assertions in **58.50s, 58.10s and 58.40s**. `shared-native-build-3.log` passes the normal five-project build. Frozen-lockfile installation, comment policy and whitespace checks also pass. Native Worker execution reduced the large-result case from the failed approximately 36-second callback run to roughly **374–419ms**, and the boundary case from the failed approximately 39-second callback run to roughly **363–398ms**. After extraction, including the supplied-handler stream probe and its state verification, the complete boundary case takes **553–1109ms** in those final runs. The deadline still takes approximately 45 seconds; no artificial clock or cancellation claim was introduced.

Local diagnostic artifacts are under `/tmp/steam-value-d1-20-repair/`: `full-red-1.log`, `three-case-min-red-2.log`, `three-minus-worker-module.log`, `four-minus-bootstrap-case.log`, `three-case-instrumented-red.log`, `lazy-fixture-probe.log`, `common-harness-probe.log`, `per-case-fixture-probe.log`, `full-green-1.log` (the rejected partial fix, actually 80/3), `regression/isolation-{red,green}.log`, `worker-native-full-*.log`, `worker-native-build-*.log`, `shared-native-extraction-green.log`, `shared-native-full-*.log`, and `shared-native-build-*.log`. Artifact names reflect the chronological candidate, not a substitute for reading its verdict. Tagged diagnostics and throwaway probes are removed from the committed tree.

This evidence does not certify edge Access policy, deployment-token permissions, production data, native-D1 viewer completion or cutover. Those remain separate downstream gates.
