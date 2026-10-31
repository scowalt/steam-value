# Move the database to Cloudflare D1

Status: accepted and implemented; operational cutover was accepted on 2026-10-31. [ADR 0007](./0007-retire-turso-after-owner-approved-early-cutover-acceptance.md) records the owner's one-off early-retirement exception to the original retention policy below. Supersedes the Turso database/external-access choices in [ADR 0001](./0001-host-web-surface-on-cloudflare-with-turso.md) and the database/credential details in [ADR 0002](./0002-run-steam-status-from-persistent-steel-browser.md) and [ADR 0003](./0003-deploy-worker-application-through-github-actions.md). Their hosting, browser, scheduling, and gated application-deployment decisions remain in force.

Move Steam Value's database from Turso to Cloudflare D1 on the account-wide Workers Paid plan rather than adding a project-only Hetzner VM. Preserve the existing Worker, Static Assets, Cloudflare Access, and external jobs. [ADR 0005](./0005-replace-arcane-with-devinabox.md) replaces the original Arcane job host with devinabox because Arcane is permanently retired. D1 retains the SQLite query engine and fits the managed Cloudflare web architecture without introducing another server to operate.

## Confirmed scope and boundaries

- Migrate every existing database reader and scheduled or manual writer, preserving existing data and application behavior. The database includes seven application tables, not just the two declared in Drizzle; preserve their keys, constraints, defaults, timestamps, JSON data, and indexes.
- Keep Steam Status, Catalog Facts, deals, and manual enrichment work outside the Worker as they are today. Preserve the Steel browser and authentication boundaries in [ADR 0002](./0002-run-steam-status-from-persistent-steel-browser.md).
- Mission-control owns the D1 database resource. This repository owns versioned SQL migrations and the Worker binding. Database provisioning remains separate from ordinary Worker deployments, preserving the infrastructure/application split in [ADR 0003](./0003-deploy-worker-application-through-github-actions.md).
- Complete and confirm the design before implementation. Prepare and test the migration before requesting separate approval for any subscription change, production database creation, or production cutover.
- Budget management and financial alerts are owned by the operator at the Cloudflare account level and are outside this application migration spec. Do not add application spend caps, budget-based refresh shutdown, or budget-pause alerting as migration requirements. This replaces the earlier strict-ceiling proposal; it does not claim a guaranteed $5 account bill.

## Agreed cutover and rollback policy

- Use a planned maintenance window. Pause and drain every scheduled or manual database writer during the final consistent export, import, validation, and switch. Do not introduce dual-writing or promise zero downtime.
- Keep the viewer reading Turso until D1 is validated; a brief viewer interruption during the switch is acceptable.
- Retain Turso without further writes and retain a validated export for at least seven days. Deleting Turso requires explicit approval.
- Rollback is manual and data-aware. Once D1 has accepted new writes, preserve and reconcile those changes before reverting; ordinary Worker version rollback is not a database rollback.

## External-job access

Use a machine-authenticated database endpoint on the existing Worker, restricted to its Steam Value D1 binding. External jobs and manual scripts use application credentials rather than Cloudflare account API credentials. Preserve the existing human-facing API behavior; the new endpoint is for trusted tools, not browser users. Ordinary viewer authentication alone must not authorize database operations. Doppler and protected environment mechanisms remain the source of secrets; secret values stay out of repositories, infrastructure state, and logs.

The native D1 binding documents transactional batch rollback. The inspected REST references do not establish equivalent batch guarantees or single-database token isolation. A binding-backed endpoint avoids relying on those unverified properties, at the cost of owning an internal API and its authentication. Preserve used client/result semantics through tested adapters, not an assumption of complete libSQL compatibility.

## Verification and approval

The complete migration spec is published as [GitHub issue #17](https://github.com/scowalt/steam-value/issues/17), labelled `ready-for-agent`.

Use the existing Worker request interface as the primary integration seam, backed by real isolated local D1. Exercise external clients through that same interface and extend existing browse, offer, Steam Status, and Catalog Facts behavior tests. Verify authorization, parameter/result fidelity, transaction and lease behavior, supported large pages, and full-schema import/export and recovery; deployment success alone is not migration evidence.

The accepted design does not authorize production mutations. Follow the issue workflow's implementation-plan approval before coding, and retain the separate approval gates for subscription changes, production database creation, cutover, and Turso deletion. Stage preparation so ordinary deployment cannot promote an empty or unvalidated database. The original Turso-until-approved-cutover hold has been fulfilled; historical preparation holds are not current production instructions.
