---
version: 1
slug: "src-web-index-html"
primary_target: "src/web/index.html"
related_targets: ["src/web/city-builders.html","src/web/styles.css"]
---

# Steam Value viewer

Mode: Operate. Scope: rankings and city-builder views. Preserve game data, filters, defaults, API requests, pagination, offer expiry and external links. The owner approved the scoped 0build migration in issue #39; no new identity selection or production deployment is needed.

## Direction contract

THESIS: A compact game-comparison tool built from real 0build components, not a dashboard of decorative metrics.

OWN-WORLD: 0build's native dark neutral surfaces, system sans typography, compact layout scale, bordered tables/cards and native form controls. Green denotes offers and positive game markers; blue denotes ownership/multiplayer; amber denotes Early Access/partial support and recoverable errors.

STORY: Read the Value Score ordering, narrow the same game list with familiar filters, inspect reviews/estimates/Playtime, then follow a Steam or deal link. The city-builder view keeps search and sortable columns.

FIRST VIEWPORT: Title and Steam Status above a compact filter panel; rankings immediately below in a divided table. At 900px and below the same records become compact cards with score, three statistics, deals and status labels. City-builder search precedes a horizontally scrollable table. Standard hover/focus feedback is the interaction language; no entrance animation or hidden content.

FORM: User-pinned 0build dark theme and existing table/card composition; no randomized seed applies. Preserve behavior rather than inventing a new visual world.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
