/**
 * Steam API Client with Rate Limiting, Retry, and Caching
 *
 * Provides a centralized client for all Steam API calls with:
 * - Rate limiting (sequential requests with configurable delay)
 * - Retry with exponential backoff
 * - In-memory response caching
 */

export interface SteamData {
  appId: number;
  name: string;
  reviewScore: number; // 0-100 positive percentage
  reviewCount: number;
}

export interface SteamClientConfig {
  /** Minimum delay between requests in ms (default: 1500) */
  minDelayMs?: number;
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;
  /** Cache TTL in ms (default: 300000 = 5 minutes) */
  cacheTtlMs?: number;
  /** Log rate limit events and retries (default: false) */
  verbose?: boolean;
}

export interface SteamClientStats {
  requests: number;
  cacheHits: number;
  retries: number;
}

// Steam API response types
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
      type: string;
      name: string;
      steam_appid: number;
      supported_languages?: string;
    };
  };
}

// Simple sleep utility
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rate limiter that enforces minimum delay between requests
 */
class RateLimiter {
  private lastRequestTime = 0;
  private queue: Array<{ resolve: () => void }> = [];
  private processing = false;

  constructor(private minDelayMs: number) {}

  async acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ resolve });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      const waitTime = Math.max(0, this.minDelayMs - elapsed);

      if (waitTime > 0) {
        await sleep(waitTime);
      }

      this.lastRequestTime = Date.now();
      const next = this.queue.shift();
      next?.resolve();
    }

    this.processing = false;
  }
}

/**
 * Simple in-memory cache with TTL
 */
class ResponseCache<T> {
  private cache = new Map<string, { value: T; expiresAt: number }>();

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * Steam API Client with built-in rate limiting, retry, and caching
 */
export class SteamClient {
  private rateLimiter: RateLimiter;
  private cache = new ResponseCache<unknown>();
  private config: Required<SteamClientConfig>;
  private stats: SteamClientStats = { requests: 0, cacheHits: 0, retries: 0 };

  constructor(config?: SteamClientConfig) {
    this.config = {
      minDelayMs: config?.minDelayMs ?? 1500,
      maxRetries: config?.maxRetries ?? 3,
      cacheTtlMs: config?.cacheTtlMs ?? 5 * 60 * 1000,
      verbose: config?.verbose ?? false,
    };
    this.rateLimiter = new RateLimiter(this.config.minDelayMs);
  }

  /**
   * Fetch with rate limiting and retry logic
   */
  private async fetchWithRetry<T>(url: string): Promise<T> {
    await this.rateLimiter.acquire();

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      this.stats.requests++;

      try {
        const response = await fetch(url);
        const data = await response.json();

        if (this.isRateLimited(response, data)) {
          if (attempt < this.config.maxRetries) {
            this.stats.retries++;
            const backoff = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
            if (this.config.verbose) {
              console.warn(
                `[SteamClient] Rate limited, retry ${attempt + 1}/${this.config.maxRetries} in ${backoff}ms...`
              );
            }
            await sleep(backoff);
            continue;
          }
          throw new Error("Steam API rate limit exceeded after retries");
        }

        return data as T;
      } catch (error) {
        if (attempt < this.config.maxRetries && this.isRetryableError(error)) {
          this.stats.retries++;
          const backoff = 2000 * Math.pow(2, attempt);
          if (this.config.verbose) {
            console.warn(
              `[SteamClient] Request failed, retry ${attempt + 1}/${this.config.maxRetries} in ${backoff}ms...`
            );
          }
          await sleep(backoff);
          continue;
        }
        throw error;
      }
    }

    throw new Error("Max retries exceeded");
  }

  /**
   * Detect Steam rate limiting (can be 429, null response, or success: false)
   */
  private isRateLimited(response: Response, data: unknown): boolean {
    if (response.status === 429) return true;
    if (data === null) return true;
    return false;
  }

  /**
   * Check if an error is retryable (network errors, 5xx, etc.)
   */
  private isRetryableError(error: unknown): boolean {
    if (error instanceof TypeError) return true; // Network errors
    if (error instanceof Error && error.message.includes("fetch")) return true;
    return false;
  }

  /**
   * Fetch Steam data for a game (reviews + details)
   */
  async fetchSteamData(appId: number): Promise<SteamData> {
    const cacheKey = `steam:${appId}`;
    const cached = this.cache.get(cacheKey) as SteamData | undefined;
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }

    // Fetch reviews
    const reviewsUrl = `https://store.steampowered.com/appreviews/${appId}?json=1&language=all&purchase_type=all`;
    const reviewsData = await this.fetchWithRetry<SteamReviewsResponse>(reviewsUrl);

    if (!reviewsData.success) {
      throw new Error(`Steam API returned unsuccessful response for app ${appId}`);
    }

    const { total_positive, total_reviews } = reviewsData.query_summary;
    const reviewScore =
      total_reviews > 0 ? Math.round((total_positive / total_reviews) * 100) : 0;

    // Fetch details
    const detailsUrl = `https://store.steampowered.com/api/appdetails?appids=${appId}`;
    const detailsData = await this.fetchWithRetry<SteamAppDetailsResponse>(detailsUrl);
    const appDetails = detailsData[appId.toString()];

    if (!appDetails?.success || !appDetails.data) {
      throw new Error(`Steam app ${appId} not found or not accessible`);
    }

    const result: SteamData = {
      appId,
      name: appDetails.data.name,
      reviewScore,
      reviewCount: total_reviews,
    };

    this.cache.set(cacheKey, result, this.config.cacheTtlMs);
    return result;
  }

  /**
   * Check if a Steam app is a game (not DLC, video, software, etc.)
   */
  async isGame(appId: number): Promise<boolean> {
    const cacheKey = `isGame:${appId}`;
    const cached = this.cache.get(cacheKey) as boolean | undefined;
    if (cached !== undefined) {
      this.stats.cacheHits++;
      return cached;
    }

    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}`;

    try {
      const data = await this.fetchWithRetry<SteamAppDetailsResponse>(url);
      const appData = data[appId.toString()];

      if (!appData?.success || !appData.data) {
        this.cache.set(cacheKey, false, this.config.cacheTtlMs);
        return false;
      }

      const result = appData.data.type === "game";
      this.cache.set(cacheKey, result, this.config.cacheTtlMs);
      return result;
    } catch {
      return false;
    }
  }

  /**
   * Get supported languages for a Steam app
   */
  async getLanguages(appId: number): Promise<string[] | null> {
    const cacheKey = `languages:${appId}`;
    const cached = this.cache.get(cacheKey) as string[] | null | undefined;
    if (cached !== undefined) {
      this.stats.cacheHits++;
      return cached;
    }

    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}`;

    try {
      const data = await this.fetchWithRetry<SteamAppDetailsResponse>(url);
      const appData = data[appId.toString()];

      if (!appData?.success || !appData.data?.supported_languages) {
        this.cache.set(cacheKey, null, this.config.cacheTtlMs);
        return null;
      }

      // Parse languages from HTML string
      // Format: "English<strong>*</strong>, French, German<br>..."
      const langString = appData.data.supported_languages
        .replace(/<br\s*\/?>/gi, ",") // Replace <br> with comma first
        .replace(/<[^>]*>/g, "") // Remove other HTML tags
        .replace(/\s+/g, " "); // Normalize whitespace

      const languages = langString
        .split(",")
        .map((lang) => lang.trim())
        .filter((lang) => lang.length > 0);

      this.cache.set(cacheKey, languages, this.config.cacheTtlMs);
      return languages;
    } catch {
      this.cache.set(cacheKey, null, this.config.cacheTtlMs);
      return null;
    }
  }

  /**
   * Check if a game has English support
   */
  async hasEnglishSupport(appId: number): Promise<boolean | null> {
    const languages = await this.getLanguages(appId);
    if (languages === null) return null;
    return languages.some(
      (lang) => lang.toLowerCase().includes("english")
    );
  }

  /**
   * Get client statistics
   */
  getStats(): SteamClientStats {
    return { ...this.stats };
  }

  /**
   * Clear the response cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = { requests: 0, cacheHits: 0, retries: 0 };
  }
}

// Default singleton instance
export const steam = new SteamClient();

// Backward-compatible function exports
export const fetchSteamData = (appId: number) => steam.fetchSteamData(appId);
export const isGame = (appId: number) => steam.isGame(appId);
