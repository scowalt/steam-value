---
id: TASK-3
title: Filter ranked games by IsThereAnyDeal sales and bundles
status: Done
assignee:
  - '@pi'
created_date: '2026-09-18 02:33'
updated_date: '2026-09-18 03:31'
labels:
  - feature
  - web
  - catalog
dependencies: []
references:
  - src/worker/games.ts
  - src/web/app.ts
  - src/web/index.html
  - src/db/schema.ts
  - scripts/setup-worker-db.ts
  - deploy/arcane/README.md
documentation:
  - docs/adr/0001-host-web-surface-on-cloudflare-with-turso.md
  - docs/adr/0002-run-steam-status-from-persistent-steel-browser.md
  - docs/research/isthereanydeal-sale-data.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add sale filtering to existing rankings using IsThereAnyDeal as the preferred source for offers across its supported stores and bundles, not just Steam. User approved US/USD and explicitly chose 24-hour price freshness. Keep the current catalog import and Steam Status sync running unchanged.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 An On sale checkbox filters the full ranked result set before pagination, matches fresh discounted retail offers or active bundle membership, and combines correctly with existing filters on desktop and mobile; disabling it preserves existing ranking behavior.
- [x] #2 US/USD retail offers come from IsThereAnyDeal across supported stores, display store, price, discount, activation/DRM when available, and the original offer link and voucher conditions. Permanently free games, non-discounted retail prices, and unknown or invalid offers do not qualify as retail sales.
- [x] #3 Active bundles containing a ranked game also qualify and are clearly labeled with bundle name and provider link. Any displayed price is the applicable bundle/tier total, never an invented per-game price; ambiguous add-on or choice requirements are labeled without claiming a guaranteed standalone purchase price.
- [x] #4 Cached offers remain usable for at most 24 hours after a successful fetch and expire sooner at a known offer/bundle expiry. Missing or failed responses do not extend freshness; the UI exposes refresh status and distinguishes absent/stale data from confirmed no offers.
- [x] #5 A separate background refresh uses bounded batches, retry/backoff, overlap prevention, and ITAD API credentials kept out of browser/Worker bundles, logs, and git. ITAD attribution and original affiliate URLs are preserved.
- [x] #6 The running catalog import and daily Steam Status job continue unchanged; offer storage and rollout are additive and do not change Value Score calculations.
- [x] #7 Automated tests cover matching, sale/bundle semantics, 24-hour and provider expiry boundaries, failures, filter combinations, and pagination; typechecks/build and desktop/mobile smoke checks pass. Live verification/deployment remains explicitly blocked until valid ITAD credentials are available.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
User approved the feature and US/USD; latest instructions supersede Steam-only pricing and two-hour expiry: use IsThereAnyDeal for stores and bundles, with a 24-hour maximum cache age.

1. Validate ITAD stable lookup, price, and bundle APIs against primary docs; capture findings in docs/research/isthereanydeal-sale-data.md. Confirm auth, API limits, pricing/expiry/bundle semantics, attribution, and original-link requirements.
2. Add isolated, additive offer-cache and refresh-metadata tables, keyed by Steam app and region, plus stable ITAD identity mappings. Do not change the games schema, catalog importer, Steam Status code, or scoring.
3. Implement an external Bun ITAD refresh for rankable games, exact Steam-ID mapping, batched retail deals and active bundle membership, strict response validation, guarded publication, per-offer expiry and 24-hour freshness, overlap lock, throttling, retry/backoff, and useful status. Keep API key server-side in Doppler/arcane only.
4. Extend Worker SQL with optional onSale filtering before pagination and fresh retail/bundle metadata, with a separate offer-refresh status endpoint; preserve existing APIs and defaults.
5. Add On sale control plus readable store/price/discount and bundle/total-price displays on desktop/mobile. Show attribution, freshness/unknown state and original ITAD links; show known DRM/voucher/choice/add-on conditions rather than assuming Steam activation.
6. Add focused fixture and local-database tests for parser and filtering behavior, run Bun tests/typechecks/build, and desktop/mobile smoke checks. Document the feature and separate refresh operations.
7. With a user-provisioned ITAD_API_KEY, verify real mapping/deal/bundle payloads, populate offers, install only the new arcane refresh service/timer, and deploy the hosted app through mission-control OpenTofu. Preserve the active import and Access policy. Never claim production-ready/live validation if key access remains blocked.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Confirmed no existing sale/price fields or sale task. The app filters ranked games in Worker SQL before pagination.
- Read both hosting/sync ADRs. Existing catalog import is still processing with no reported per-app failures; leave it running.
- Read-only probe of Steam appdetails with three app IDs, filters=price_overview, and cc=us returned batched USD prices; a free-to-play game returned no price. Full batch limits and sale responses still require validation.
- Bun, Backlog CLI, Doppler, SSH to arcane, and hosted deployment tooling are available. No application code has been changed; waiting for plan and storefront approval.

- User approved the feature with US/USD, changed freshness to 24 hours, and required IsThereAnyDeal to cover other stores and bundles. Updated acceptance criteria and plan accordingly.
- Official docs confirm API-key-protected price and bundle APIs, 200-game price batches, Retry-After on rate limiting, personal private use allowed, and original links/data must be preserved.
- Checked secret names only in steam-value/dev and dev_personal and current environment: no ITAD credential is configured. Live end-to-end verification and rollout need an ITAD_API_KEY from an app registered by the user.
- Delegated primary-source API research (documentation only) to a background agent.

- Reviewed completed primary-source research in docs/research/isthereanydeal-sale-data.md. Bulk exact Steam mapping is public; current prices and bundles need API-key auth, not OAuth. Retail price batches are limited to 200 games.
- Bundle schemas expose tiers[].price, nullable prices, addon flags, and game membership, but do not establish universal choice/prerequisite purchase rules. Preserve honest bundle discovery links and reported tier totals; never invent a per-game or minimum-payable price.
- Freshness interpretation: user authorized cached offers for 24 hours. Exclude offers at an earlier known expiry; an unknown expiry is not proof of expiration or guaranteed checkout availability. Do not introduce an unrequested known-expiry-only restriction or promise that all cached offers remain purchasable.
- Live docs explicitly permit private personal use, while linked repository terms use older conflicting wording; retain this discrepancy in the research note and re-evaluate if scope expands beyond this private personal tool. No broader publication or third-party contact authorized.
- Implementation/live verification remains pending the requested ITAD_API_KEY setup; no application code or deployed services changed during research.

- User provisioned ITAD_API_KEY. Authenticated live contract checks passed for exact Steam mapping, multi-store retail offers, and fixed/choice bundle tiers. Requests use the header, never a query key.
- Implemented separate additive mapping, retail/bundle cache, and refresh-state tables; fenced/renewable refresh lease; 200-game batches; throttling and Retry-After; seven-day identity remapping; 24-hour offer lifetime with earlier provider expiry. Missing retail responses retain unknown/stale status instead of becoming fresh no-sale results.
- Implemented Worker SQL sale filtering before pagination, deal DTO/status API, accessible desktop/mobile displays, original links/conditions/ITAD attribution, client expiry handling, request race protection, and loading/empty/error states. Scoring and existing importer/Steam Status source remain unchanged.
- Verification: bun test (39 passing), all three typecheck configurations, bun run build, staged Gitleaks scan (no leaks), and self-review. Live-data built Worker/UI smoke checked two pages of 100 unique sale games and desktop/mobile layouts with no browser errors or horizontal overflow.
- Arcane full refresh succeeded: 13,575 ranked games checked, zero unmapped, 777 missing retail responses, 12,798 fully fresh games; 6,930 games with retail discounts and 192 with active bundle opportunities (overlap possible). Dedicated hourly service/timer enabled; private mode-0600 deals.env contains only Turso and ITAD credentials.
- Deployed Worker/assets with a reviewed single-resource OpenTofu plan; post-deployment plan reports no changes. Deployment version 70b914e0-0ee9-4100-b18c-c47608886815. Cloudflare Access still redirects unauthenticated requests; workers.dev/previews remain disabled. Worker retains only the two Turso secrets, not ITAD. Authenticated user-browser navigation was not automated.
- Rechecked catalog job still running with zero per-app failures, Steam Status timer enabled and latest state healthy; original catalog/Steam Status deployed source checksums unchanged.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

ITAD → hourly arcane offer refresh → separate Turso snapshots → Worker onSale SQL filter → desktop/mobile rankings.

- Adds US/USD retail discounts across stores and active bundle opportunities without changing Value Score or Steam Status.
- Preserves original purchase links, voucher/DRM conditions and ITAD attribution; bundle amounts are reported tier totals, never individual-game prices.
- Enforces 24-hour freshness, earlier known expiry, partial-data visibility, guarded publication and automatic scheduled refresh.

## Evidence

- Before: no offer data or sale filtering; 10 existing tests. After: 39 passing tests, typechecks/build and secret scan pass, including browser and local-database behavior checks.
- Live refresh checked 13,575 games; 12,798 have complete fresh coverage. Missing retail responses remain explicit. Live-data API/browser smoke confirmed filtered pagination at desktop/mobile sizes.
- Hosted deployment verified by Cloudflare version and zero-diff OpenTofu plan; Access retained. Catalog import remains running and Steam Status remains healthy.

## Merge Danger

**Door:** two-way. Offer tables are additive; rollback the Worker/assets and disable the new timer if needed. Create offer tables before deploying the new Worker.
**Blast Radius:** rankings API/UI and the independent offer refresh only. ITAD omissions and unknown expiry cannot guarantee merchant availability; ambiguous bundles link to provider requirements.
<!-- SECTION:FINAL_SUMMARY:END -->
