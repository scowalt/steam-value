# Licensing and third-party material

Steam Value's original code and documentation are licensed under the [MIT license](LICENSE), copyright 2026 Scott Walters. Third-party components retain their own licenses. This license does not grant rights to provider data, game artwork, trademarks, account data or credentials. Source availability does not grant access to the owner's deployed application or private runtime resources.

## Vendored assets

**0build 0.6.13**, copyright 2026 0build, is MIT-licensed. The unmodified stylesheet and complete upstream license are retained at:

- [`src/web/vendor/0build/0.6.13/kit.min.css`](src/web/vendor/0build/0.6.13/kit.min.css)
- [`src/web/vendor/0build/0.6.13/LICENSE.md`](src/web/vendor/0build/0.6.13/LICENSE.md)

Both files come from [upstream commit `a7336dd1178c199b8e1f0f0f828e01a795a18b8d`](https://github.com/0builddotdev/0build/tree/a7336dd1178c199b8e1f0f0f828e01a795a18b8d). The [integration guide](docs/ui/0build.md) records their hashes and update procedure. Builds copy the vendor license beside the CSS, and copy this notice and the application's MIT license to static assets as `THIRD_PARTY_NOTICES.txt` and `LICENSE.txt`.

## Installed dependencies

`package.json` and `bun.lock` identify the dependency versions; installing them does not relicense them under Steam Value's MIT license. Retain their bundled notices when redistributing their code. Direct dependency license declarations at the current lock include:

| Packages | Declared license |
| --- | --- |
| `@libsql/client`, `steam-session`, `drizzle-kit`, `miniflare`, `@types/bun` | MIT |
| `drizzle-orm`, `playwright`, `typescript` | Apache-2.0 |
| `@cloudflare/workers-types`, `wrangler` | MIT OR Apache-2.0 |
| `howlongtobeat` | WTFPL v2 |

Important transitive cases:

- Miniflare uses Sharp (Apache-2.0); platform libvips packages declare LGPL-3.0-or-later, sometimes alongside other licenses. These are toolchain dependencies, not vendored application binaries. Redistributing a toolchain, container or executable containing them requires examining its actual notices and [LGPLv3 source/relinking requirements](https://www.gnu.org/licenses/lgpl-3.0.html#section4). Merely declaring a dependency is not the same distribution.
- `steam-session` depends on `node-bignumber@1.2.2`. Its npm metadata omits a license field, but the package's `LICENSE` and `original/LICENSE` contain Tom Wu's permissive copyright/disclaimer requirements; RSA signing code carries Kenji Urushima's MIT notice. Preserve those notices rather than substituting the application's license. [Upstream license](https://github.com/JoeDoyle23/node-bignumber/blob/master/LICENSE).

This is a guide to significant dependencies, not a replacement for the licenses shipped by every installed package or a license inventory for arbitrary future bundles. Review actual shipped code and notices when adding dependencies or distributing binaries.

## Provider data and integrations

No Steam Status, authenticated browser profile, live database or production credentials are part of this source distribution. Tests use synthetic data. A software library's license, including that of `howlongtobeat`, does not license the corresponding provider's website or database.

The tracked `src/data/steam-hltb-map.json` is an empty array. `scripts/sync-hltb-map.ts` is an old importer for [leinstay/steamdb](https://github.com/leinstay/steamdb), a Game Gauntlets dataset, not a license grant from Valve or other providers. The upstream declares GPLv3 and identifies third-party inputs with their own rights. The populated raw file expected by manual enrichment is deliberately ignored at `src/data/steamdb-raw.json`; it is not supplied here. The old importer's URL/schema is not a promise of compatibility with current upstream releases.

Before distributing any downloaded or transformed dataset, establish its precise provenance and applicable provider permissions, retain required licenses/notices, and document the transformations. Do not assume that GPL automatically covers every independent application file, or that upstream can license all provider inputs. See [GPLv3 §§4–5](https://www.gnu.org/licenses/gpl-3.0.html#section4) and the [upstream license and credits](https://github.com/leinstay/steamdb#license-and-credits).

[Wikidata structured data is CC0](https://www.wikidata.org/wiki/Wikidata:Licensing); its identifier mappings are not HowLongToBeat Estimates. Runtime integrations remain subject to [Steam Web API terms](https://steamcommunity.com/dev/apiterms), [IsThereAnyDeal API terms](https://docs.isthereanydeal.com/#section/Terms-of-Service) and other applicable provider terms. Keep the existing IsThereAnyDeal attribution. This project is not endorsed by or affiliated with those providers, and does not grant trademark rights.
