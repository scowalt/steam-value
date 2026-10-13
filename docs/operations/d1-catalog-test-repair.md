# Native D1 fixture lifecycle repair (#23 convergence)

This record supersedes the unresolved test blocker in the [catalog preparation record](d1-catalog-refresh.md). The accepted integration baseline remains `0bf4735bf4c86087c5d89df47d89cc7860426791`. No unaccepted consumer commits, production operations or promotion approvals are included.

## Reproduction and measured cause

Bun 1.3.11 (`af24e281`), Linux x64, Miniflare 4.20260521.0. All probes used a sanitized environment, disposable loopback D1 and synthetic credentials.

The original catalog workflow followed by the unchanged operator suite failed twice: seven cases passed and one operator rejection timed out at its existing 5,000 ms limit. Reductions showed:

- The catalog workflow plus the first five operator rejections fails; the first four pass.
- Operator-only and catalog-module-loaded-but-workflow-skipped controls pass.
- A native fixture request and awaited disposal reproduce the subsequent process stall without any catalog application logic.
- Bundling the Worker without starting Miniflare passes ten subsequent operator processes.
- An unbundled supplied-handler Miniflare fixture also reproduces the stall. Worker bundling is not necessary.

The stalled operator produces stdout EOF, stderr EOF and its expected diagnostic. The operating system reports its exit, but Bun's `.exited` promise remains unresolved. In the failing syscall trace, Miniflare's fourth workerd pipe is descriptor 24. Disposal closes it. A later operator reuses descriptor 24 as its pidfd, registers it with epoll, and then a delayed second close removes that live pidfd before SIGCHLD. Bun consequently loses the completion notification.

The matched collected-owner trace closes the same control pipe during disposal, then records `close(24) = -1 EBADF` during collection **before** the next `pidfd_open`. All subsequent processes complete. This is a measured late double-close / reused-descriptor failure, not a slow operator, SQL failure or resource-contention attribution. Miniflare spawns workerd through `node:child_process` with four pipes; pinned Bun's compatibility implementation exposes pipes beyond the first three through `node:net.connect({ fd })` while retaining the native subprocess. The observed failure is in that process/extra-pipe ownership boundary. The exact vendor destructor has not been instrumented.

Root confidence is high for the reduced native/operator stall. The coordinator's #24 startup `send`/`epoll_ctl` EBADF evidence is consistent with stale descriptors; #21's intermittent GET 501 is not independently attributed. Those unaccepted trees were inspected read-only, not integrated or represented as verified by this branch.

## Exact shared-fixture change

`src/db/testing.ts` adds three calls to the public `Bun.gc(true)` API:

1. Before `createD1TestHarness()` allocates its Miniflare runtime.
2. Before `createD1WorkerTestHarness()` builds/allocates its runtime.
3. After the shared harness's awaited `runtime.dispose()` completes.

The teardown barrier reaps released owners while their descriptors are still closed. The construction barriers also reap owners released when the previous caller or test callback finishes, before descriptors can be allocated to the next runtime. Teardown-only collection repaired the reduced operator failure but was insufficient: an unfiltered run still hit the existing deadline fixture's teardown timeout. That failed candidate is retained in the evidence inventory; it was not accepted because another traced run happened to pass.

This is a Bun-specific **local test-fixture compatibility mitigation**, not an upstream vendor ownership fix or a guarantee for future Bun/Miniflare versions. The real bundled Worker, native D1, default explicit bootstrap, supplied-handler exceptions, public HTTP interface, migration/operator algorithms and returned harness shape remain unchanged. There are no source patches to dependencies, SDK clones, internal mocks, production logic changes, fallback providers, automatic retries, timeout increases, acceptance filters or arbitrary sleeps.

If the lifecycle regression or an unfiltered run becomes red again, hold acceptance and revisit ownership, including a vendor-native Node subprocess owner if it can preserve these interfaces. Do not weaken the regression or treat an earlier green run as erasure.

## Regression and acceptance evidence

`src/db/testing.test.ts` runs a native Game Catalog query through `createHttpClient()`, lets the fixture scope finish after awaited disposal, and then runs ten independent, write-free operator rejections. Each must produce the unchanged usage diagnostic and resolve its exit. It uses the existing default 5,000 ms timeout and contains no collection calls, private descriptor assertions, mocks or retries. Holding the fixture's scope open made an early test candidate green; the final regression deliberately matches the released-scope boundary of the original mixed failure.

With the three fixture barriers removed, the final regression fails at 5,000 ms, after four operator results. Restoring only the barriers passes it. A discarded forced-collection test candidate also passed the old helper because early collection can itself mitigate the stale owner; collection therefore stays in the fixture, not in the behavioral regression.

The same final source passed three consecutive serial, unfiltered runs:

```sh
env -i PATH="$PATH" HOME="$HOME" WRANGLER_SEND_METRICS=false bun --no-env-file test
```

| Run | Result | Assertions | Files | Duration |
| --- | --- | --- | --- | --- |
| 1 | 106 pass / 0 fail / 0 errors | 636 | 9 | 66.85 s |
| 2 | 106 pass / 0 fail / 0 errors | 636 | 9 | 67.82 s |
| 3 | 106 pass / 0 fail / 0 errors | 636 | 9 | 66.30 s |

Every existing case and assertion remains, including the real 45-second request deadline. `tsconfig.db-access.json` includes the new lifecycle regression. All five existing typecheck projects and the catalog project's sixth check are retained.

Host evidence is in `/tmp/steam-value-d1-23-repair/`:

- `mixed-repro-{1,2}.log`, `min-first-five-{1,2}.log`: original/reduced red loops.
- `probe-native-request.log`, `probe-native-empty.log`, `probe-unbundled.log`, `probe-bundle-only.log`: isolated controls.
- `native-strace-progress.log`, `native-syscalls.2145937`: failing descriptor reuse.
- `collected-owner-progress.log`, `collected-owner-syscalls.log`: collection closes the stale descriptor before pidfd reuse.
- `lifecycle-regression-confirmed-{red,green}.log`: final regression with only the three fixture barriers withdrawn/restored.
- `full-gc-probe-1.log`: rejected teardown-only candidate, 105 pass / 1 fail.
- `full-boundary-gc-probe-{1,2,3}.log`: unfiltered acceptance evidence above.

Local acceptance does not establish production capabilities, edge Access, deployment, live provider behavior, cutover, or correctness of unaccepted #21/#24 trees. All #17 promotion gates remain held.
