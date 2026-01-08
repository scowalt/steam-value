import type { SteamData } from "./types";

interface SteamReviewsResponse {
  success: number;
  query_summary: {
    review_score: number;
    review_score_desc: string;
    total_positive: number;
    total_negative: number;
    total_reviews: number;
  };
}

interface SteamAppDetailsResponse {
  [appId: string]: {
    success: boolean;
    data?: {
      name: string;
      steam_appid: number;
    };
  };
}

export async function fetchSteamData(appId: number): Promise<SteamData> {
  // Fetch review data
  const reviewsUrl = `https://store.steampowered.com/appreviews/${appId}?json=1&language=all&purchase_type=all`;
  const reviewsRes = await fetch(reviewsUrl);

  if (!reviewsRes.ok) {
    throw new Error(`Failed to fetch Steam reviews: ${reviewsRes.status}`);
  }

  const reviewsData = (await reviewsRes.json()) as SteamReviewsResponse;

  if (!reviewsData.success) {
    throw new Error(`Steam API returned unsuccessful response for app ${appId}`);
  }

  const { total_positive, total_negative, total_reviews } =
    reviewsData.query_summary;

  // Calculate positive percentage
  const reviewScore =
    total_reviews > 0
      ? Math.round((total_positive / total_reviews) * 100)
      : 0;

  // Fetch app details for the name
  const detailsUrl = `https://store.steampowered.com/api/appdetails?appids=${appId}`;
  const detailsRes = await fetch(detailsUrl);

  if (!detailsRes.ok) {
    throw new Error(`Failed to fetch Steam app details: ${detailsRes.status}`);
  }

  const detailsData = (await detailsRes.json()) as SteamAppDetailsResponse;
  const appDetails = detailsData[appId.toString()];

  if (!appDetails?.success || !appDetails.data) {
    throw new Error(`Steam app ${appId} not found or not accessible`);
  }

  return {
    appId,
    name: appDetails.data.name,
    reviewScore,
    reviewCount: total_reviews,
  };
}
