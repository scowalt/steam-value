# 0build integration

The rankings and city-builder views use [0build](https://0build.dev/), with native HTML controls and vanilla TypeScript. [Issue #39](https://github.com/scowalt/steam-value/issues/39) records the approved migration. The backend, data contracts and deployment controls are unchanged.

## Pinned dependency

Use the unmodified prebuilt CSS from **v0.6.13**, the release used by the installation/component documentation consulted for this migration. This is an explicit pin, not a claim that it is the latest release.

Upstream commit: [`a7336dd1178c199b8e1f0f0f828e01a795a18b8d`](https://github.com/0builddotdev/0build/tree/a7336dd1178c199b8e1f0f0f828e01a795a18b8d).

| Local file under `src/web/vendor/0build/0.6.13/` | Upstream path | SHA-256 |
| --- | --- | --- |
| `kit.min.css` | `dist/css/kit.min.css` | `0fd39628261d49d8c768e34544c8a8b62f1eb962570b7ae5d4f9bea1a8cb5c24` |
| `LICENSE.md` | `LICENSE.md` | `64252d0a5fdd5cebfe5ac8b0492c80675350c60bcffa1c75808e132ca96caaff` |

The MIT license ships beside the stylesheet. The repository's comment policy already excludes vendored code; do not alter upstream bytes or strip notices to appease an authored-source rule.

`scripts/build-worker.ts` copies those two files into Cloudflare Static Assets and uses Bun to build `app.js`, `city-builders.js` and `styles.css`. Both HTML entrypoints load the same local stylesheets. Normal builds and browser visits make **no dependency/CDN requests**. No 0build runtime, UIkit JavaScript, React, Tailwind build, remote font or icon package is required for the chosen CSS-only components. The only icons are small inline SVG checks and sort indicators.

## Component and theme boundaries

- Use genuine `z-table`, `z-card`, `z-checkbox`, `z-select`, `z-input`, `z-button`, `z-label` and `z-alert` classes; don't reimplement them in application CSS.
- Both documents select `dark z-layout-small` before rendering. There is no theme initialization script or local-storage dependency.
- `src/web/styles.css` puts overrides in 0build's documented `styles` layer. It owns layout, numeric alignment, the 900px rankings table/card breakpoint and small accessibility corrections.
- The pinned release needs explicit dark option foreground/background, stronger input borders, visible native select arrows, square checkbox corners, and translucent status labels with contrasting foregrounds. Keep these overrides when updating unless the replacement is verified to solve them. Component text/geometry is otherwise supplied by 0build.
- City-builder sorting uses native buttons and `aria-sort`. Its TypeScript entrypoint retains search, original-rank/name/numeric sorting, null-last ordering, Steam links and displayed values, and supplies explicit loading, empty, error and retry states.
- [DESIGN.md](../../DESIGN.md) records the implemented visual system. Product and per-surface decisions are development documentation, not shipped assets.

## Updating

1. Choose and review an upstream release and resolve its immutable commit. Check the actual distributed CSS against the documented component names and theme tokens.
2. Download that commit's `dist/css/kit.min.css` and `LICENSE.md` into a new version directory. Preserve them byte-for-byte and record their SHA-256 hashes here.
3. Update both HTML paths, the build copy path, test asset paths and integrity expectations together. Remove only the superseded dependency files after the new pin passes verification.
4. Review the accessibility overrides, run `bun --no-env-file test src/web`, `bun --no-env-file run build`, and the comment-policy check. Verify that both built pages load their local CSS and that the license is included. Run the full suite before acceptance.
5. Inspect both views at desktop/mobile sizes, including keyboard controls, native select options, long names, table scrolling and loading/error/empty states. Use synthetic data and the Portless/private Tailscale workflow in [README.md](../../README.md); never download production credentials for this check.

## Browser-test lifecycle

`src/web/testing.ts` bundles the real browser entrypoints/styles and provides the pinned CSS to intercepted requests. Tests have no HTTP server and abort unexpected external requests.

Adding a second Chromium suite reproduced intermittent timeouts under Bun 1.3.11/Playwright 1.57.0. The browser diagnostic log showed Chromium's DevTools pipe terminating unexpectedly during a later suite, followed by the process exiting while Playwright operations remained pending. Individual suites passed. This is consistent with the existing [Bun released-pipe lifecycle failure](../operations/d1-catalog-test-repair.md), not evidence that a larger timeout is needed.

The browser fixture now collects released owners before launch and after awaited close, using the same public `Bun.gc(true)` boundary mitigation as the native D1 test fixtures. Three consecutive combined UI runs passed after the change, without retries or timeout changes. Keep it confined to tests; it is not an upstream fix or a guarantee for other runtime versions. Revisit ownership if the combined suite regresses.

## Verification scope

Browser regressions cover both views at 1920, 1440, 390 and 320px; combined filters and pagination; request cancellation races; offer expiry; retries and empty results; keyboard controls and sort announcements; long/escaped names; local stylesheet loading; default-state text contrast; and vendored asset integrity. Manual screenshots use synthetic game data, not production Catalog Facts or Steam Status. Production deployment and live-data verification are separate work.

Verified on 2026-10-31:

- Final isolated, unfiltered `bun --no-env-file test`: **414 passed, 0 failed**, 3,124 assertions across 29 files (467.49 seconds). The earlier attempt hit the shell's 240-second execution limit and was not counted as a passing run.
- Focused UI suite: **24 passed**, 255 assertions, including computed text-contrast checks.
- `bun --no-env-file run build`: all configured type checks and production bundles passed. Copied vendor CSS/license matched source bytes exactly.
- Comment-policy check: **0 violations**; its 13 regression tests passed.
- Desktop/mobile screenshots of both views were inspected in-thread; no independent reviewer was used. The detector's actual option-contrast finding was corrected; unused upstream gradient utilities and cell-padded table wrappers were not treated as rendered defects.
- Temporary Portless/private-Tailscale preview and owned browser sessions stopped. No production data, secrets, deployment or backend changes.
