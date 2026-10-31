# Steam review service

During the 2026-10-31 D1 consumer check, the old store `/appreviews/<appid>?json=1` route returned HTTP302 to the store homepage instead of JSON. Steam's [old endpoint documentation](https://partner.steamgames.com/doc/store/getreviews) now marks it deprecated and points to [IUserReviewsService.GetAppReviews](https://partner.steamgames.com/doc/webapi/IUserReviewsService#GetAppReviews).

Both the Catalog Facts refresh and shared manual `SteamClient` use `https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/`. Parameters go in `input_json`: app ID, Helpful filter0, all languages, all review types0 and all purchase types1. Request one review to minimize payload; only first-page summary totals are consumed. Requesting zero reviews now returns the default page, not a summary-only response.

The response is wrapped in `response` and no longer has a `success` flag. Require successful HTTP status and finite nonnegative integer positive/negative/total counts in `query_summary`. A genuine zero summary is valid. Missing or malformed totals are a provider failure, not zero reviews; preserve existing Catalog Facts rather than overwriting them with invented zeros.

Reviews do not require an API key. Do not send the personal app-list key as a publisher key: Steam only grants the higher review limit to a key associated with the reviewed app. Existing app-list authentication, provider delays/retries, manual cache behavior, database access, checkpoints and Value Score formula remain unchanged. HTTP429 remains a rate limit, not permission to bypass it.

The bounded production dry-run that discovered the deprecated endpoint did not write or checkpoint. Its failed observation remains separate from successful D1 website, manual database and scheduled-job checks. Follow [#17](https://github.com/scowalt/steam-value/issues/17) for current cutover and retention acceptance; a provider repair or green CI alone does not start retention.
