---
id: TASK-2
title: Move Steam Status refresh to persistent Steel browser
status: Done
assignee: []
created_date: '2026-08-03 21:12'
updated_date: '2026-08-03 22:23'
labels:
  - steam-status
  - automation
  - infra
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Run Steam Status refresh from a persistent, tailnet-only Steel browser on arcane so HttpOnly Steam authentication remains in the browser profile instead of Doppler.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A dedicated Steel browser profile persists Steam authentication on arcane
- [x] #2 Daily Steam Status refresh updates Turso from authenticated Dynamic Store data and the owned-games API
- [x] #3 Suspicious empty or sharply reduced Steam data fails without modifying game status
- [x] #4 The deployment is tailnet-only and survives reboot
- [x] #5 The obsolete Cloudflare cookie-based scheduled refresh is disabled
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Deployed a dedicated tailnet-only Steel browser and persistent Chrome profile on arcane, moved the guarded daily Steam Status refresh to systemd, removed the Worker cron and obsolete Cloudflare Steam secrets, and documented operations. Verified login persistence across a Steel restart and two production syncs: 1,432 owned, 165 wishlisted, and 6,097 ignored; the repeat sync made zero changes.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Automated tests and typechecks pass
- [x] #2 A production sync is verified with nonzero wishlist, ignored, and owned counts
<!-- DOD:END -->
