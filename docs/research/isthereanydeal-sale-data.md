# TASK-3: IsThereAnyDeal sale data

Researched **2026-09-18** against the live official documentation (OpenAPI **2.11.0**) and official repository commit [`7be4a2c`](https://github.com/IsThereAnyDeal/API/commit/7be4a2c68faad323ba770bfd32e1d4dc4f9c7c3f). Scope: approved **On sale**, **US/USD**, **24-hour freshness**, other stores and bundles. Research only; no credentials inspected/used, registration, database changes, or implementation.

**Conclusion:** ITAD supports bulk Steam mapping, multi-store retail offers, and active bundle membership. Retail integration is well documented. Bundle discovery is feasible, but universal minimum-payable bundle pricing and an absolute “never expired” guarantee are not established by the API. Preserve bundle offers separately from individual-game prices.

## Endpoints and contracts

Base: `https://api.isthereanydeal.com`. POST bodies below are JSON arrays, with `Content-Type: application/json`. Exact schemas are in the [pinned OpenAPI JSON][spec]; rendered-document extraction can omit URL fields.

| Purpose | Endpoint / parameters | Contract |
|---|---|---|
| Bulk Steam → ITAD UUID | `POST /lookup/id/shop/61/v1`, body `["app/220","app/620"]` | Object keyed by submitted shop ID; values UUID or `null`. Keep `app/` distinct from Steam `sub/` and `bundle/`. **Authentication optional:** security explicitly includes `{}` alongside API-key alternatives. Minimum 1 item; **no documented maximum**, not a promise of unlimited requests. Use conservative chunks, e.g. 200. [Lookup][lookup] |
| Shop identity/coverage | `GET /service/shops/v1?country=US` | Unauthenticated active shops, including `id`, `title`, `update`. `/service/shops/map/v1` also includes inactive shops. Steam shop ID is **61**. [Shops][shops] |
| Retail offers | `POST /games/prices/v3?country=US&deals=true&vouchers=false&capacity=0` | **1–200 UUIDs**, API key. `deals=true` excludes prices without a cut; v3 otherwise includes regular prices. Omit `shops` for multi-store coverage. `capacity=0`/omitted means no per-game offer limit. Explicit voucher policy avoids hiding a required coupon. [Prices][prices] |
| Bulk relevant bundles | `POST /games/overview/v2?country=US&vouchers=false` | **1–200 UUIDs**, API key. Returns `prices[]` (one best current offer per game) and **currently active** `bundles[]` containing queried games. Join actual `bundles[].tiers[].games[].id`; do not interpret undocumented `prices[].bundled` count semantics as proof of current membership. [Overview][overview] |
| All active bundles | `GET /bundles/v1?country=US&expired=false&limit=50&offset=0` | API key; page with `offset`; limit **1–50**, default 20. `expired=false` is default. `mature=false` also defaults: set deliberately to avoid silently losing mature catalog matches. Returns bundle array. [Bundle list][bundles] |
| One game's bundles | `GET /games/bundles/v2?id=<UUID>&country=US&expired=false` | API key; array of bundles containing the game. Explicitly disable expired bundles. Useful for targeted verification, not an N-request catalog refresh. [Membership][membership] |

**Keyless verification:** public HTTP requests returned 200 for US shops and the bulk lookup above; `app/220` mapped to `018d937f-012f-73b8-ab2c-898516969e6a`, `app/620` to `018d937f-21e1-728e-86d7-9acb3c59f2bb`. No authenticated price/bundle response was tested.

### Retail fields

Use `prices/v3`, not overview's single `current` offer, for sale qualification: overview has no deals-only parameter and can select a non-discounted offer. Load all retail offers before local expiry/DRM filtering so an ineligible cheapest offer does not conceal a valid alternative. [Prices][prices], [Overview][overview]

[`obj.deal2`][deal-schema] requires `shop {id,name}`, `price`, `regular`, `cut` (0–100), nullable `voucher`, `storeLow`, `flag`, `drm[] {id,name}`, `platforms[]`, `timestamp`, nullable `expiry`, and **`url`**. [`Price`][price-schema] contains `amount`, `amountInt`, `currency`; USD examples use `9.99` / `999`. Store original monetary data and validate USD rather than treating a missing price as zero.

There is a **country** parameter, not a currency selector, on these endpoints. Request US and require `currency === "USD"` for displayed/comparable prices, including bundle tiers; do not silently convert or relabel foreign prices. A Steam app mapping identifies the game, **not Steam activation for every offer**. Show store/DRM explicitly; Steam-direct examples have empty `drm`, while third-party Steam-key claims require explicit DRM evidence. Preserve the supplied purchase `url`, including affiliate parameters. [Prices][prices], [raw examples][overview-example]

## Bundle pricing: what is and is not documented

The [raw bundle schema][bundle-schema] includes:

- `id` (integer), `title`, `page {id,name,shopId?}`, purchase **`url`**, optional ITAD **`details`** URL, `publish`, nullable `expiry`, nullable `note`, `counts {games,media}`, `tiers[]`.
- Each tier requires **`price: Price | null`**, **`addon: boolean`**, **`games: Game[]`**. Games carry ITAD UUID/title/type/etc., **not bundle-specific DRM or activation-region information**.
- `page.id` is **not** a shop ID: the example has Fanatical page ID 8, `page.shopId` 6. `shopId` can be absent/null.

**`tier.price` versus `tiers.prices`:** the reviewed current raw schema, compiled OpenAPI, and live documentation's embedded OpenAPI all use singular **`tiers[].price`**. Overview and both bundle endpoints reference the **same** bundle schema. No `tiers[].prices`, `choice`, or pick-count field is documented in this version. Additional fields are not forbidden, so live responses could differ; this is a contract-test requirement, not evidence that such fields can never exist. Do not invent endpoint-specific plural-price semantics. [Schema][bundle-schema], [overview schema][overview-schema], [spec][spec]

The [official website announcement][bundle-blog] confirms build-your-own selection and add-on tiers exist, but does **not** define their API purchase rules. Consequently:

- Show a known reported price as **“Bundle tier total: $X — contains/offers this game”**, never “Game price: $X”, `$X / game`, or a fabricated discount. Never divide by `counts.games`, choose the cheapest unrelated tier, or deduct owned games.
- Membership in a choice pool does not guarantee receiving every listed game. `addon=true` does not specify the prerequisite purchase; a null/missing price is **unknown, not free**. Tier ordering does not document cumulative inclusion. Missing/empty tiers do not establish a purchasable game offer.
- Preserve the source note and links. Until purchase semantics are verified, ambiguous choice/add-on tiers should be **link-only bundle opportunities**, not numeric minimum-payable offers or qualifying sale prices. A full general-purpose bundle-price calculator is not defensible from these schemas alone.

## Freshness and expiry

**Recommended application policy (not an ITAD guarantee):** keep per-scope successful `fetchedAt` separately from upstream `timestamp`; the docs do not define that timestamp as “last checked.” Require `now < fetchedAt + 24h`, and check expiry **on every read/render**, not only during refresh. Reject `expiry <= now`, malformed expiry, and stale snapshots even if the scheduled refresh failed. Expire browser-visible offers at the same deadline; do not leave already-rendered offers current indefinitely. Successful replacement removes disappeared offers; failures must not advance freshness.

Retail and bundle `expiry` can be **null**. Thus 24-hour polling cannot prove an offer has not ended early, sold out, or expired without an end time. For a strict no-expired-sale filter, **exclude unknown-expiry offers from qualifying results** (substantial coverage loss); optionally show them separately as “reported available; end time unknown.” Even future stated expiry is not a checkout-availability guarantee: ITAD provides data **as-is**. If “never expired” means absolute merchant-level availability, that requirement remains unprovable with ITAD alone. [Retail schema][deal-schema], [bundle schema][bundle-schema], [terms][terms]

## Access, limits, and terms

- A [regular ITAD account and app registration][apps] generate API-key/OAuth credentials; verify email. This feature needs **an API key, not user OAuth**. The listed price/bundle endpoints declare API-key auth; OAuth is for user-authorized endpoints and is not a universal substitute. Prefer backend-only `ITAD-API-Key` header over query-string keys. The parent has requested **`ITAD_API_KEY` in `steam-value/dev`**; none was available per the supplied context, and this research did not re-inspect secrets. [Access][access]
- Default verified-account allowance: **1,000 requests per five-minute window**; actual limits/usage appear in app settings. Cache, avoid sustained maximum usage, and respect `429` / `Retry-After`. Unverified limits are transitional and limits may change. The docs mention explicit approval for some endpoints but do not flag these price/bundle endpoints as approval-only. [Limits][limits]
- Attribution is **SHOULD**, not MUST: link/credit ITAD. **MUST NOT** imply affiliation, alter supplied prices/affiliate URLs, create an app considered competing with ITAD, or help its competition. Partial data use/enrichment is allowed. [Terms][terms]
- **First-party terms conflict:** live docs expressly allow private personal use; their linked [repository terms][repo-terms] say private API use requires contact. Neither defines the competition boundary. Recommendation: obtain written clarification for this personal ranking tool with multi-store/bundle filtering before relying on permission, especially before broader release (`api@isthereanydeal.com`, listed in the OpenAPI contact). No contact or signup was performed.

## Feasible implementation and remaining gates at research time

1. Add separate catalog-fact storage for app-ID mappings, retail offers, bundles/tiers/membership, and refresh status; the existing `src/db/schema.ts` has no price model. Do not overload Value Score or individual-game price with bundle totals.
2. Batch retail prices in groups of 200; index a paged active-bundle feed once per refresh, **or** use overview batches for a selected game set. Deduplicate bundle IDs. Cache unknown mappings; retain unknown/error versus a successful no-qualifying-offer result.
3. Derive On sale from fresh eligible retail discounts (`cut > 0`) or a verified eligible bundle opportunity, retaining the offer kind. Keep ambiguous bundles discoverable separately rather than making unsupported price/activation claims. Enforce US/USD, voucher policy, runtime expiry, and the 24-hour cutoff independently of the scheduler.
4. After the key is supplied, test real US retail and bundle responses, especially choice/add-on/null tiers and undocumented fields; then test TTL/expiry boundaries, failed/partial refreshes, disappeared offers, unmapped games, currency/DRM mismatches, and unchanged affiliate URLs.

**Gates:** key provision for authenticated contract tests; terms clarification; explicit handling of unknown expiry; and live confirmation of bundle selection/add-on semantics before claiming minimum payable totals. Basic retail ingestion and honest bundle links are feasible without solving a universal bundle calculator.

## Implementation follow-up — 2026-09-18

After the user provisioned `ITAD_API_KEY`, authenticated calls verified US retail offers, original links/DRM/vouchers, and the complete active-bundle feed (552 game IDs at the time of verification). Live choice bundles had `tiers[].price: null`; fixed Humble tiers had singular USD `price` objects as documented. No OAuth flow was needed.

One important operational distinction was confirmed: `prices/v3?deals=true` omitted non-discounted games entirely. The implementation instead requests `deals=false`, filters retail discounts locally, and leaves missing game responses unknown rather than manufacturing a fresh no-sale result. A full refresh checked 13,575 ranked games; 777 lacked retail responses and remain partially covered. Bundle and retail snapshots have separate successful-fetch timestamps.

The approved policy uses a 24-hour maximum cache age and honors earlier known expiries. Null expiry remains eligible within that cache window with an availability disclaimer; no absolute merchant-availability guarantee or known-expiry-only restriction was requested. Ambiguous bundle tiers remain link-only opportunities. This resolves the credential and live-contract gates for the implemented behavior, without inventing general bundle purchase rules or changing the personal-use scope.

[spec]: https://raw.githubusercontent.com/IsThereAnyDeal/API/7be4a2c68faad323ba770bfd32e1d4dc4f9c7c3f/dist/openapi.json
[lookup]: https://docs.isthereanydeal.com/#tag/Lookup/operation/lookup-gid-shopid-v1
[shops]: https://docs.isthereanydeal.com/#tag/Shops/operation/service-shops-v1
[prices]: https://docs.isthereanydeal.com/#tag/Prices/operation/games-prices-v3
[overview]: https://docs.isthereanydeal.com/#tag/Prices/operation/games-overview-v2
[bundles]: https://docs.isthereanydeal.com/#tag/Bundles/operation/bundles-v1
[membership]: https://docs.isthereanydeal.com/#tag/Bundles/operation/games-bundles-v2
[deal-schema]: https://raw.githubusercontent.com/IsThereAnyDeal/API/7be4a2c68faad323ba770bfd32e1d4dc4f9c7c3f/docs/schemas/obj.deal2.json
[price-schema]: https://raw.githubusercontent.com/IsThereAnyDeal/API/7be4a2c68faad323ba770bfd32e1d4dc4f9c7c3f/docs/schemas/obj.price.json
[bundle-schema]: https://raw.githubusercontent.com/IsThereAnyDeal/API/7be4a2c68faad323ba770bfd32e1d4dc4f9c7c3f/docs/routes/bundles/schemas/obj.bundle.yaml
[overview-schema]: https://raw.githubusercontent.com/IsThereAnyDeal/API/7be4a2c68faad323ba770bfd32e1d4dc4f9c7c3f/docs/routes/games/schemas/resp.games.overview.yaml
[overview-example]: https://raw.githubusercontent.com/IsThereAnyDeal/API/7be4a2c68faad323ba770bfd32e1d4dc4f9c7c3f/docs/routes/games/examples/resp.overview.v2.success.yaml
[bundle-blog]: https://isthereanydeal.com/blog/2-bundles-more-comments-blog-feed-and-api-improvements/
[apps]: https://isthereanydeal.com/apps/my/
[access]: https://docs.isthereanydeal.com/#section/Access
[limits]: https://docs.isthereanydeal.com/#section/Rate-Limiting
[terms]: https://docs.isthereanydeal.com/#section/Terms-of-Service
[repo-terms]: https://github.com/IsThereAnyDeal/API/blob/7be4a2c68faad323ba770bfd32e1d4dc4f9c7c3f/TERMS_OF_SERVICE.md
