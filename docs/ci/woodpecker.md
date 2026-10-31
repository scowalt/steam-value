# Steam Value CI on Woodpecker

Use the existing [Woodpecker service](https://woodpecker.scowalt.com) on native Linux x86-64. [ADR 0006](../adr/0006-run-ci-and-tested-artifact-deployment-on-woodpecker.md) records the owner-approved provider change. The source reuses the previously reviewed local artifact/current-main helpers, adapted to the current D1 release and x86 runner; it does not adopt the old pre-D1 application tree or ARM-only bootstrap.

## Workflows

| Workflow | Events | Work |
| --- | --- | --- |
| `verify` | PRs; main pushes | Comment policy and its regression suite, frozen Bun install, Chromium with disposable-container OS dependencies, all Bun tests, all type checks and Worker/static build. Main alone uploads its resulting `dist`. |
| `no-comments` | All branch/tag pushes and PRs | Original uv/Python comment checker and its regression suite. |
| `deploy` | Main pushes after both checks succeed | Fresh current-main check, frozen dependency install, exact-run artifact download, current-main check, application-bearer installation, final current-main check and original Wrangler deployment flags. |

Artifact publication is gated within `verify` itself: the unchanged comment-policy commands run before tests/build, and only a successful main push may upload. The standalone `no-comments` workflow still reports policy checks for all supported events. A configuration regression test keeps the two policy steps identical and requires fail-fast ordering before artifact publication. Main pipeline 4 demonstrated that a dependent deployment workflow could start after failed verification; the cause of that scheduler behavior was not established. Explicit success filters document intent, but are not the sole barrier: without a successful policy/test/build sequence, there is no exact-run artifact to restore and no Worker publication. Do not replace this barrier with dependency ordering alone.

The default Git clone is explicitly pinned with merged-PR behavior. Logs record actual checkout commit/tree/parents. Main artifact creation requires HEAD equal to `CI_COMMIT_SHA`. All workflows use the existing `ci_os=linux`, `platform=linux/amd64` agent. Images are digest-pinned; `ci/bun.sh` verifies official Bun 1.3.11 and Gitleaks 8.30.1 x86 release checksums. Keep package/runtime locks and the existing hooks intact. Node in the pinned image supports Wrangler; the scheduled Steam Status job retains its separate Node 24.20.0 runtime.

Set repository visibility private, timeout 20 minutes, fork approval, PR support and only `pull_request` in `cancel_previous_pipeline_events`. Leave approval allowlists empty, native deploy events disabled and all Trusted flags false. The twenty-minute per-workflow clocks and whole-PR cancellation retain the earlier accepted port trade-offs. Production uses `concurrency: {limit: 1, group: production}` and is not canceled by new pushes. No manual/tag/non-main/deploy event is a new publishing entrypoint.

## Exact tested artifacts

Workflows do not share a workspace. The existing dedicated private R2 Standard bucket `steam-value-ci-artifacts` stores the envelope and checksum at `steam-value/<pipeline-number>/<commit>.json` and `.json.sha256`. The envelope includes repository/run/commit identity, timestamps, each visible regular file's exact binary bytes and SHA256. Restoring rejects missing/empty/corrupt/expired/future/wrong-run artifacts, unsafe/duplicate paths and an already-existing destination. It never searches for latest/older artifacts or rebuilds.

The consumer validity period is seven days; the provisioned whole-bucket lifecycle expires objects after 604800 seconds and aborts incomplete multipart uploads after 86400 seconds. Physical deletion is asynchronous, not an exact seven-day guarantee. Envelope/checksum integrity relies on trusted storage writers; it is not a digital signature. The artifact writer has bucket-wide Object Read & Write, including listing/deletion; the separate reader has bucket-wide Object Read only, including listing. The prefix is not an authorization boundary. Neither credential may administer buckets or access state, backups or other buckets.

The bucket was provisioned separately by Mission Control under `opentofu/steam-value-ci-artifacts/`, with managed public access disabled. Do not recreate it, modify its state, or use a backend/operator credential as an artifact credential.

## Credential bindings

Doppler `steam-value/dev` is authoritative. Bind only these selected values into Woodpecker, each with server-side events restricted to **push**. Do not grant PR access. Missing legitimate values/scopes block main publication, not a reason to substitute broader credentials or read secret values from GitHub.

| Woodpecker name | Doppler name |
| --- | --- |
| `steam_value_artifact_endpoint` | `STEAM_VALUE_CI_ARTIFACT_ENDPOINT` |
| `steam_value_artifact_bucket` | `STEAM_VALUE_CI_ARTIFACT_BUCKET` |
| `steam_value_artifact_region` | `STEAM_VALUE_CI_ARTIFACT_REGION` |
| `steam_value_artifact_write_access_key` | `STEAM_VALUE_CI_ARTIFACT_WRITE_ACCESS_KEY` |
| `steam_value_artifact_write_secret_key` | `STEAM_VALUE_CI_ARTIFACT_WRITE_SECRET_KEY` |
| `steam_value_artifact_read_access_key` | `STEAM_VALUE_CI_ARTIFACT_READ_ACCESS_KEY` |
| `steam_value_artifact_read_secret_key` | `STEAM_VALUE_CI_ARTIFACT_READ_SECRET_KEY` |
| `steam_value_contents_read_token` | `STEAM_VALUE_CI_CONTENTS_READ_TOKEN` |
| `steam_value_cloudflare_api_token` | `STEAM_VALUE_CI_CLOUDFLARE_API_TOKEN` |
| `steam_value_cloudflare_account_id` | `STEAM_VALUE_CI_CLOUDFLARE_ACCOUNT_ID` |
| `steam_value_db_token` | `STEAM_VALUE_DB_TOKEN` |

The GitHub token is fine-grained Contents read-only for only `scowalt/steam-value`. The Cloudflare token is Editor for only the existing `steam-value` Worker; preserve its existing scope, not all Workers or D1/DNS/Access/R2 administration. Only `STEAM_VALUE_DB_TOKEN` is sent to Worker secret storage. Keep Access machine credentials and Steam/provider credentials exclusively in their existing runtime environments.

Same-repository push collaborators are trusted as recorded in ADR 0006. YAML filters and per-step secret placement do not independently protect against a trusted collaborator rewriting push YAML. Do not enable Trusted flags or claim a GitHub production-environment equivalent to disguise this distinction.

## Publisher handover and acceptance

The owner requires no more GitHub Actions execution. Before publishing the port, disable the three legacy workflows through their supported workflow-state controls, preserve their files, and verify no legacy deployment is queued/running. Do not cancel started deployments. GitHub and Woodpecker concurrency groups are not a shared lock. After real native PR/main verification and required-check inspection, disable Actions at repository level. Preserve unrelated repository protections.

Activate only this repository, verify saved settings and push-only secret metadata, and obtain a real PR run. Publish main only after the required credentials are available. Confirm the resulting main run uploads and deploys the same artifact, rejects stale main, and annotates the exact commit; local tests/lint are not deployment evidence. Do not use direct untested deployment or a missing-secret retry loop. Original workflow files remain disabled rollback references, not concurrent publishers.

The Worker deploys with `--no-bundle --strict --keep-vars --message "GitHub commit $CI_COMMIT_SHA" --tag "$CI_COMMIT_SHA"`. `wrangler.toml` retains Static Assets, disabled workers.dev/preview URLs, the populated native D1 binding and observability. No schema/app-data migrations run in CI. Align the complete external-job release with the verified deployed commit, then check actual website and machine access, run real offer/Steam Status jobs and verify other consumers before enabling schedules. Keep Turso/export retained; CI success alone does not accept coherent cutover or start the retention clock.

## Local checks

The production-sized capacity and mixed-width integration tests have five-minute outer test deadlines for synthetic fixture preparation, multiple complete native verification requests, public-page/bootstrap checks and cleanup. Each real request still enforces the unchanged 45-second deadline, 960-query budget, 256-row page bound and 2 MiB page bound. Both tests' previous two-minute totals proved insufficient on the shared runner: mixed-width failed in main pipeline4, and the sibling capacity test failed in main pipeline11. Controlled delays in fixture setup reproduced both outer timeouts while completed native requests remained within their own bounds. This test-only allowance neither raises production limits nor skips assertions; it is not a blanket increase for the rest of the suite.

Use the normal frozen install, `bun test`, `bun run build`, and both commands in [.comment-policy/README.md](../../.comment-policy/README.md). CI adapter tests and strict types are included in those commands. Lint `.woodpecker/` with the installed version-matched Woodpecker 3.19 CLI. Browser tests use isolated synthetic contexts, not the authenticated Steel profile. Do not install browser OS packages on the shared host; that step belongs in disposable CI containers.
