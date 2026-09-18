# Deploy the Worker application through gated GitHub Actions

Status: accepted

Steam Value's GitHub Actions workflow owns deployment of the `steam-value` Worker script and static assets. Pull requests and pushes run tests, typechecks, and the build without production credentials. A push to `main` may deploy only the `dist` artifact produced by its successful verification job. The production environment supplies a Cloudflare account ID and a token with **Editor access scoped to the existing `steam-value` Worker**; it needs no DNS, Access, R2, Turso, or Worker-creation permission.

Mission-control OpenTofu continues to own the custom domain, disabled workers.dev and preview endpoints, empty cron schedule, and Cloudflare Access application and policy. It observes the existing Worker but no longer owns or uploads its script, static assets, compatibility settings, bindings, or observability configuration. Those runtime settings live in `wrangler.toml`. Turso secret values remain managed outside both repositories and are preserved by ordinary deployments.

## Consequences

- Production deployments are serialized by GitHub Actions and use a protected `production` environment restricted to `main`.
- The deployed Worker version is annotated with the exact Git commit SHA. The deploy job downloads the artifact from its own successful verification job rather than rebuilding it.
- Pull-request jobs cannot read production environment secrets and have no deploy job.
- A failed verification job cannot deploy. A newer queued production run replaces an older queued run; an already-running deployment completes before the newest run starts.
- Application changes must preserve `wrangler.toml` controls, especially `workers_dev = false`, static-asset routing, compatibility date, and observability. Infrastructure changes remain in mission-control.
- Rollback uses Cloudflare Worker version history (`bunx wrangler rollback`) with the same narrowly scoped credential. After an emergency rollback, revert the bad commit on `main`; the resulting green workflow makes source and production converge again.
