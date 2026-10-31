# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users and purpose

Steam Value is Scott's personal Steam game browser. It combines public Catalog Facts with his Steam Status to help choose games through Value Score rankings, filters and current sale/bundle information. Terminology is defined in [GLOSSARY.md](GLOSSARY.md).

## Capabilities and constraints

Preserve rankings, filters and defaults, pagination, Steam links, Steam Status, offer freshness, and the searchable/sortable city-builder view. HowLongToBeat Estimates must remain distinct from recorded Playtime. Desktop rankings use a table; mobile rankings use cards. The city-builder table stays horizontally scrollable on small screens.

The existing vanilla TypeScript/Bun application ships through Cloudflare Worker Static Assets behind Cloudflare Access. A UI change must not change APIs, ranking logic, database, providers, jobs, secrets, access controls or deployment gates. Use only synthetic data for isolated browser verification.

## Approved design-system commitment

The owner approved [issue #39](https://github.com/scowalt/steam-value/issues/39): migrate both views to self-hosted, pinned 0build dark-theme components while preserving existing functionality and backend. Keyboard controls, visible focus, labelled inputs and responsive states are required. No production deployment is authorized by this work.

## Evidence on hand

[README.md](README.md), [GLOSSARY.md](GLOSSARY.md), existing viewer implementations and browser regression tests. Preview fixtures are illustrative, not claims about actual Catalog Facts or Steam Status.
