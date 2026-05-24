---
id: TASK-1
title: Move Steam Value web app to Cloudflare Worker
status: Done
assignee:
  - '@pi'
created_date: '2026-05-23 01:35'
updated_date: '2026-05-23 02:06'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Migrate the always-on Steam Value web surface from the Bun server to a Cloudflare Worker with Static Assets, protected by Cloudflare Access, while keeping Turso as the database and preserving external admin job workflows.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 steam-value.scowalt.com is protected by Cloudflare Access and serves the Steam Value UI
- [x] #2 Cloudflare Worker serves static assets and implements GET /api/games, POST /api/sync, and a daily scheduled Steam Status refresh
- [x] #3 Worker uses raw libSQL queries against the existing Turso database, not Drizzle
- [x] #4 Steam Status sync metadata is persisted in Turso and shown in the UI
- [x] #5 Existing external/admin scripts continue to work against Turso
- [x] #6 The Bun web server implementation is removed
- [x] #7 Local web development runs through Wrangler/Miniflare
- [x] #8 Cloudflare Worker script/assets/routes/cron/DNS/Access are managed through mission-control OpenTofu
- [x] #9 Secrets are synced from Doppler to Cloudflare outside OpenTofu
- [x] #10 README documents architecture, local development, deploy flow, secret sync, and external job boundaries
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Establish Worker build/dev foundation: add Wrangler/Cloudflare Worker dependencies and config for local dev, compile the browser app/static assets, and keep deployment artifacts predictable for OpenTofu.
2. Replace the Bun web server with a Worker entrypoint: implement static asset serving, GET /api/games with raw libSQL SQL, POST /api/sync, and scheduled daily Steam Status refresh.
3. Refactor Steam Status sync for cross-runtime use: pass explicit env/client dependencies instead of process.env/Drizzle, batch Turso updates where practical, and persist sync metadata/lock state in Turso.
4. Update the UI minimally: rename sync copy to Refresh Steam Status, show last successful refresh / last error, and preserve existing filters, offset pagination, and load-more behavior.
5. Remove the Bun web server path and update package scripts so local web dev runs through Wrangler/Miniflare while admin scripts continue using Bun + Turso.
6. Add mission-control OpenTofu resources for the Cloudflare Worker script/assets/routes/cron/DNS/Access while keeping secrets out of Terraform state; document the Doppler-to-Cloudflare secret sync command/script.
7. Document the final architecture and operations in README, including external Catalog Facts jobs and manual HLTB enrichment boundaries.
8. Validate with local Worker dev/tests and targeted scripts, then mark acceptance criteria as complete.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Created Cloudflare Worker entrypoint with raw libSQL API routes and scheduled Steam Status refresh.
- Added sync_state persistence/lock table, local Wrangler build/dev flow, and Doppler-to-Cloudflare secret sync script.
- Removed Bun web servers and preserved city-builders as a static page backed by a Worker API route.
- Added mission-control OpenTofu Worker/custom-domain/cron/Access resources, applied them, and synced Worker secrets.
- Verified steam-value.scowalt.com redirects to Cloudflare Access and workers.dev route returns 404.

- Addressed review findings: escaped city-builders game names/controller values, stopped printing Steam tokens/cookies, added lock ownership checks, removed appinfo from owned-game sync, moved Worker DB indexes to setup script, and added Worker/browser typecheck configs.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved Steam Value’s always-on web surface to Cloudflare Workers with Static Assets while keeping Turso as the database.

Changes:
- Added a typed Worker entrypoint with raw libSQL routes for /api/games, /api/city-builders, /api/sync, /api/sync-state, and scheduled daily Steam Status refresh.
- Added sync_state persistence/locking, a Worker DB setup script, and preserved external/admin jobs against Turso.
- Removed the Bun web servers; local web development now runs through Wrangler/Miniflare.
- Added build/typecheck scripts, Wrangler config, Doppler-to-Cloudflare secret sync, and updated README/.env docs.
- Added mission-control OpenTofu resources for Worker assets/script, custom domain, disabled workers.dev subdomain, cron trigger, and Cloudflare Access.
- Deployed the Worker infra, synced Worker secrets, and verified steam-value.scowalt.com redirects to Cloudflare Access while steam-value.scowalt.workers.dev returns 404.

Validation:
- bun run typecheck
- bun run build
- bun run db:setup-worker
- bun run hydrate-daily
- timeout 20 bun web
- bunx wrangler deploy --dry-run --outdir /tmp/steam-value-worker-dry-run
- doppler run --project mission-control --config dev -- tofu validate
- doppler run --project mission-control --config dev -- tofu plan/apply
- final mission-control tofu plan shows no changes
<!-- SECTION:FINAL_SUMMARY:END -->
