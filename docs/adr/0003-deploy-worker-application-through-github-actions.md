# Deploy the Worker application through gated GitHub Actions

Status: accepted for gated application deployment and infrastructure ownership; database/credential details superseded by [ADR 0004](./0004-move-database-to-cloudflare-d1.md). Production database cutover remains pending.

Steam Value's GitHub Actions workflows own deployment of the `steam-value` Worker script and static assets. The unprivileged CI workflow runs pull-request and push code without production credentials. A separate `workflow_run` workflow, whose definition GitHub loads from the default branch, receives production credentials only after successful CI on `main`; it downloads that CI run's `dist` artifact and rejects a commit that is no longer current `main`. The production environment supplies a Cloudflare account ID and a token with **Editor access scoped to the existing `steam-value` Worker**; it needs no DNS, Access, R2, Turso, or Worker-creation permission.

Mission-control OpenTofu continues to own the custom domain, disabled workers.dev and preview endpoints, empty cron schedule, and Cloudflare Access application and policy. It observes the existing Worker but no longer owns or uploads its script, static assets, compatibility settings, bindings, or observability configuration. Those runtime settings live in `wrangler.toml`. Turso secret values remain managed outside both repositories and are preserved by ordinary deployments.

## Consequences

- Production deployments are serialized by GitHub Actions. Only a successful CI `workflow_run` whose head branch is `main` can enter the privileged deploy workflow.
- The deployed Worker version is annotated with the exact Git commit SHA. The deploy job downloads the triggering CI run's artifact rather than rebuilding it.
- Pull-request code executes only in the unprivileged CI workflow. Editing that workflow in a same-repository pull request cannot add a step to the default-branch `workflow_run` workflow or obtain its production environment secrets.
- A failed verification job cannot deploy. The deploy workflow also compares the tested SHA with current `main`, preventing delayed or manually rerun old CI runs from rolling production back.
- Application changes must preserve `wrangler.toml` controls, especially `workers_dev = false`, static-asset routing, compatibility date, and observability. Infrastructure changes remain in mission-control.
- Rollback uses Cloudflare Worker version history (`bunx wrangler rollback`) with the same narrowly scoped credential. After an emergency rollback, revert the bad commit on `main`; the resulting green workflow makes source and production converge again.
