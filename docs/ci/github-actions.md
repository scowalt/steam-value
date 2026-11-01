# GitHub Actions handoff

**Target: the public `scowalt/steam-value` repository is the sole development home, with GitHub Issues/PRs and GitHub-hosted Actions for all CI/CD. No permanent private development mirror or Woodpecker publishing lane remains.** Runtime data, authentication and private audit evidence are not development infrastructure and remain private.

The owner approved local implementation and the coordinated hosted migration on 2026-11-01, including the listed CI credential configuration, gated deployment and public visibility after final audits. [Issue #42](https://github.com/scowalt/steam-value/issues/42) records actual execution and acceptance; approval alone is not evidence of completion. The existing remote main operates under [ADR 0006](../adr/0006-run-ci-and-tested-artifact-deployment-on-woodpecker.md) until the handoff. [ADR 0008](../adr/0008-prepare-public-source-actions-handoff.md) records the replacement. Do not push/merge merely to try it: current remote main pushes deploy through Woodpecker. This patch archives its configurations and removes its production-helper path, so delivery must be coordinated with retirement, not treated as an independently deployable intermediate change.

## Verification without publication

The replacement `CI` workflow runs on PRs and main pushes, on GitHub-hosted Ubuntu 24.04 x86-64 runners. The standalone comment-policy workflow retains push/PR coverage. Actions are pinned to upstream commit objects; Bun/Gitleaks use `.mise.toml`, Node uses 24.20.0, and uv uses 0.11.32. Shared Actions caches and persisted checkout credentials are disabled.

Publication is off unless the **repository-level variable** `STEAM_VALUE_RELEASE_CONTROLLER` equals exactly `github-actions`. An absent/different value runs the ordinary `verify` job without an environment or secrets; `verify-main` and `deploy` are skipped. The canonical repository, push event and `refs/heads/main` must also match. Forks, PRs, tags, manual events and `workflow_run` events cannot enter the publisher in the supplied definitions. There is no privileged PR-target workflow or separate legacy release controller.

Both verification jobs call [the same composite action](../../.github/actions/verify/action.yml): checkout identity logging, isolated toolchain setup, comment policy and its regression tests, frozen install, disposable-runner Chromium installation, all Bun tests and the full typecheck/build. Only one verification job runs for an event. Integrated policy gates artifact creation directly; the separate policy workflow is not the sole barrier. Keep both policy commands identical.

The active-main path is a separate job so **all PR verification stays outside secret-bearing environments**, not just outside a secret-bearing step. Server-side environment restrictions described below are required: YAML conditions and helper checks are defense in depth, not credential authorization. Same-repository main-push collaborators remain trusted to modify executable code/workflows. Review and protect those changes accordingly.

## Exact artifacts and deployment

`verify-main` uses the `artifact-publication` environment. Only after all policy/test/build steps and a fresh current-main check does it upload `dist` to the existing private R2 bucket. No GitHub-hosted build artifact is published. The deployment job depends on successful `verify-main`, checks current main, installs locked deployment tools, and downloads that exact artifact into a new directory. It never rebuilds.

Actions objects use:

```text
steam-value/github-actions/<run-id>/<run-attempt>/<commit>.json
steam-value/github-actions/<run-id>/<run-attempt>/<commit>.json.sha256
```

The version-2 envelope binds canonical repository, provider, run, attempt and commit, preserves binary bytes, validates SHA-256 and the seven-day lifetime, and rejects corrupt/empty/unsafe/conflicting paths or an existing restore destination. There is no older-run/provider/attempt fallback. **Rerun the entire workflow**, not only failed deployment jobs: a new attempt cannot reuse a previous attempt's output. Inspect any failed or uncertain production mutation before authorizing a rerun.

Old Woodpecker version-1 objects remain private at their original keys and expire under the existing lifecycle. The Actions publisher neither consumes nor rewrites them. Woodpecker configurations/bootstrap are retained only in [historical documentation](legacy-woodpecker/); production helpers now require GitHub Actions and explicit activation. No bucket, backup or infrastructure state is created or changed. Prefixes are not authorization boundaries. The writer retains bucket-wide Object Read & Write and the reader Object Read only; integrity relies on trusted writers, not digital signatures.

Production uses a separate `production` environment and job-level `production` concurrency with `cancel-in-progress: false`. Whole-workflow cancellation is limited to superseded PRs. GitHub concurrency may replace older pending runs; it is not a FIFO guarantee or a lock shared with Woodpecker. Running deployments are not automatically canceled.

Before installing the application bearer and immediately before Wrangler deployment, current main is checked again. `ci/retired-secrets.ts` retains its narrow behavior: inspect names, require the application bearer, check main before deleting either of the two retired Turso names, preserve all others and verify readback; already-absent names are a read-only no-op. No broad cleanup or automatic retries are added.

Wrangler retains `--no-bundle --strict --keep-vars`, the tested commit message/tag, current Static Assets, disabled workers.dev/preview URLs, Access, observability and native D1 binding. CI performs no schema migrations, account sync, database initialization or reset. The retired Turso database/export are not recreated. External devinabox services and schedules are outside this handoff.

## Required hosted configuration — not provisioned

Before supplying any credentials, configure **both** `artifact-publication` and `production` with a selected **branch** rule for exactly `main`, and **no tag rules**. Do not allow `refs/pull/*/merge`. Do not select “protected branches only” as a substitute: GitHub permits all branches with that option when no branch protections exist. Preserve existing protections and any required reviewers; an environment name alone does not require approval. An owner review gate for the first promotion can be added with separate approval. If the account plan cannot enforce the required restrictions while private, stop rather than weaken them.

Keep all selected values in environment secrets, **not repository-wide secrets**. Doppler remains authoritative; provision only the named subset through an approved operator process, never a broad Doppler token or values copied into source/logs.

| Environment | GitHub secret names | Scope/source |
| --- | --- | --- |
| Both | `STEAM_VALUE_CI_ARTIFACT_ENDPOINT`, `STEAM_VALUE_CI_ARTIFACT_BUCKET`, `STEAM_VALUE_CI_ARTIFACT_REGION` | Existing private artifact bucket's Doppler bindings |
| `artifact-publication` only | `STEAM_VALUE_CI_ARTIFACT_WRITE_ACCESS_KEY`, `STEAM_VALUE_CI_ARTIFACT_WRITE_SECRET_KEY` | Existing bucket-only writer |
| `production` only | `STEAM_VALUE_CI_ARTIFACT_READ_ACCESS_KEY`, `STEAM_VALUE_CI_ARTIFACT_READ_SECRET_KEY` | Existing bucket-only reader |
| `production` only | `CLOUDFLARE_API_TOKEN` | Existing `STEAM_VALUE_CI_CLOUDFLARE_API_TOKEN`: Editor for only the existing Worker |
| `production` only | `CLOUDFLARE_ACCOUNT_ID` | Existing `STEAM_VALUE_CI_CLOUDFLARE_ACCOUNT_ID` |
| `production` only | `STEAM_VALUE_DB_TOKEN` | Application bearer; the only application credential installed into Worker secrets |

The current-main reader uses the built-in, job-scoped `github.token` with `contents: read`; it does not require a new personal token or transfer the Woodpecker Contents-reader credential. Existing GitHub secret **names** are not proof of their values, validity or scope. No Steam, Access machine, D1 operator, state, backup or Turso credentials belong in Actions.

## Approval-gated delivery and single-controller handoff

1. Approve the reviewed patch and remote delivery separately. Keep repository visibility private, the release-controller variable absent/off, and legacy Deploy disabled. Record current heads, protections, workflow states and queued/running publishers. [Legacy workflow files](legacy-actions/) are preserved outside `.github/workflows`; never re-enable the old Deploy workflow or use it as the new controller.
2. With explicit approval, deliver a branch/PR and enable only replacement verification and comment-policy Actions. Prove credential-free hosted PR verification. Do not give public fork traffic access to Woodpecker, even with an approval prompt. Do not merge to main before the approved promotion fence is in place.
3. Coordinate a main-promotion freeze and drain started deployments. Disable only this repository's Woodpecker webhook/registration before the approved main merge; keep the running Worker, native D1, Access and external jobs intact. The merged tree contains no active `.woodpecker` configuration or bootstrap. Validate resulting-main Actions with publication still off. Do not cancel a started deployment or change another repository/shared runner.
4. Obtain approval for environment restrictions and the narrowly scoped credential bindings. Verify saved metadata without logging values. Before activation, reconfirm that this repository's Woodpecker webhook/registration remains disabled and no queued/running publisher remains. Do not delete historical runs, evidence or artifacts. This disconnection must occur before public PRs are possible.
5. Only after explicit handoff/deployment approval, set the repository release-controller variable to `github-actions` and authorize a **whole-workflow rerun of the current main push** (or another approved current-main push). This is the first publishing action, not a harmless validation. Verify the artifact's exact provider/run/attempt/SHA, one serialized promotion, and preserved native D1/Access behavior. Hosted success and production acceptance are separate from local tests.
6. Keep visibility private until the separate final publication review/approval. Refresh source/ref/metadata/log/artifact/license evidence at the exact revision, resolve any in-scope uninspected package surfaces, confirm private-runner entrypoints are disabled, then apply an explicitly approved visibility change. Check anonymous source access, protections, workflow/fork settings and no unexpected runs. Runtime data/profile/viewer access does not become public.

If handoff fails, turn off the Actions release-controller variable and drain started Actions promotions; keep the already deployed application running. Repair and validate the Actions path rather than leaving a permanent Woodpecker fallback. Any emergency reversal requires a separate owner decision and coordinated source/configuration restoration from history; the archived files are not runnable rollback instructions. Never enable both as a retry strategy, redeploy an untested artifact, or treat Worker rollback as D1 rollback. Retain private artifacts/evidence and report the blocker.

Completion requires a public canonical repository for all source/issues/PRs, successful hosted PR/main verification and exact-artifact CD, no active Woodpecker hook/registration/configuration for this repository, and no private-runner access from forks. Merely enabling Actions or publishing the source does not complete the migration.

## Verification and limits

Local preparation uses credential-free environments and `bun --no-env-file`: focused `ci` tests, full tests, typecheck/build, comment-policy checks and regressions, plus `actionlint`. Regression coverage includes main/fork/PR/event/activation checks, provider/run/attempt isolation, rejection of legacy publisher identities, artifact expiry/integrity/path failures, current-main checks, no rebuild, policy ordering, hosted-only runners and shipped licenses. Browser tests use synthetic isolated contexts; never the authenticated Steel profile. `--with-deps` is for disposable CI runners, not shared-host package installation.

Do not dispatch workflows, access live provider data or read secret values to perform local preparation. For hosted Actions status, use the PR head SHA and `gh run list --commit`; do not use unavailable Checks/statusCheckRollup or claim Actions-only evidence proves every protection requirement.

Primary references: [GitHub environments and branch restrictions](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), [secure use and hosted runners](https://docs.github.com/en/actions/reference/security/secure-use), and [repository visibility consequences](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility).
