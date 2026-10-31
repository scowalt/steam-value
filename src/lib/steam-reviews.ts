export interface SteamReviewSummary {
  totalPositive: number;
  totalNegative: number;
  totalReviews: number;
}

export function steamReviewSummaryUrl(appId: number): URL {
  if (!Number.isInteger(appId) || appId <= 0 || appId > 0xffffffff) throw new Error("Invalid Steam app ID");
  const url = new URL("https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/");
  url.searchParams.set("input_json", JSON.stringify({ appid: appId, filter: 0, languages: ["all"], review_type: 0, purchase_type: 1, num_per_page: 1 }));
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseSteamReviewSummary(value: unknown): SteamReviewSummary {
  const response = isRecord(value) ? value.response : undefined;
  const summary = isRecord(response) ? response.query_summary : undefined;
  if (!isRecord(summary) || [summary.total_positive, summary.total_negative, summary.total_reviews].some(count => typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("Steam review summary is missing or invalid");
  }
  return { totalPositive: Number(summary.total_positive), totalNegative: Number(summary.total_negative), totalReviews: Number(summary.total_reviews) };
}
