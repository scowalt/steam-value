# Steam Value branding

The owner selected **C — The shortlist**: three ascending game cases, with a play triangle cut out of the largest. The original vector artwork is part of this MIT-licensed project; it uses no Valve artwork or third-party font asset.

## Assets

| File | Purpose |
| --- | --- |
| `src/web/logo.svg` | Transparent 64-unit master mark, green `#34d399`, shown at 40px in both page headers. |
| `src/web/favicon.svg` | Same geometry, with `#087f5b` for light browser chrome and `#34d399` for dark chrome through `prefers-color-scheme`. |
| `src/web/favicon.ico` | Transparent 16px, 32px and 48px PNG frames in an ICO container for browsers without SVG favicons. Uses `#059669` for visibility on both light and dark tabs. |

The full header logo pairs the mark with the lowercase, live-text `steamvalue` wordmark: system sans, 28px, bold `steam` and regular `value`. Keeping the lettering in HTML preserves the project's no-font-download rule. The home link supplies the accessible name, so its mark and visual wordmark are not read a second time. The adjacent route name is the single H1 and wraps rather than clipping on narrow screens.

The build copies all three assets unchanged into `dist/assets`. Both HTML entrypoints declare the ICO fallback first and the theme-aware SVG last. No manifest, service worker or new application behavior is introduced.

## Regeneration

The SVG files are the editable vector sources. If geometry changes, keep the logo and SVG favicon paths identical, then regenerate the fallback:

```sh
bun install --frozen-lockfile
bunx playwright install chromium
bun --no-env-file run favicon:generate
bun --no-env-file test src/web/brand.test.ts scripts/build-worker.test.ts
bun --no-env-file run build
```

`scripts/generate-favicon.ts` rasterizes the local master SVG using the project's pinned Playwright/Chromium, on transparent backgrounds at each native size, then writes the ICO directory. The committed ICO is generated solely from that vector, not sourced imagery. The normal application build only copies it and does not need a browser. Browser-version changes can alter antialiasing; review regenerated pixels before committing.

Verification covers matching SVG geometry, light/dark colors, ICO frame dimensions, packaged bytes, keyboard access to the home link, and both pages at 280px, 320px, 390px and desktop widths. Visual inspection uses intercepted synthetic Catalog Facts only; it needs no development server, Steam account, credentials or production access.
