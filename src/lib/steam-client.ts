
export interface SteamData {
  appId: number;
  name: string;
  reviewScore: number;  
  reviewCount: number;
}

export interface SteamClientConfig {
  minDelayMs?: number;
  maxRetries?: number;
  cacheTtlMs?: number;
  verbose?: boolean;
}

export interface SteamClientStats {
  requests: number;
  cacheHits: number;
  retries: number;
}

export interface GameModes {
  hasSinglePlayer: boolean;
  hasMultiplayer: boolean;
  hasCoOp: boolean;
  hasOnlineCoOp: boolean;
  hasLocalCoOp: boolean;
  hasPvP: boolean;
  hasOnlinePvP: boolean;
  hasLocalPvP: boolean;
  hasCrossplatform: boolean;
  isMMO: boolean;
}

const CATEGORY_IDS = {
  SINGLE_PLAYER: 2,
  MULTIPLAYER: 1,
  CO_OP: 9,
  ONLINE_CO_OP: 38,
  LOCAL_CO_OP: 37,
  ONLINE_MULTIPLAYER: 36,
  PVP: 49,
  LOCAL_PVP: 39,  
  CROSS_PLATFORM: 27,
  MMO: 20,
  FULL_CONTROLLER: 28,
  PARTIAL_CONTROLLER: 18,
} as const;

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
      genres?: Array<{ id: string; description: string }>;
      categories?: Array<{ id: number; description: string }>;
      release_date?: { coming_soon: boolean; date: string };
    };
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
            const backoff = 2000 * Math.pow(2, attempt);  
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

  private isRateLimited(response: Response, data: unknown): boolean {
    if (response.status === 429) return true;
    if (data === null) return true;
    return false;
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof TypeError) return true;  
    if (error instanceof Error && error.message.includes("fetch")) return true;
    return false;
  }

  async fetchSteamData(appId: number): Promise<SteamData> {
    const cacheKey = `steam:${appId}`;
    const cached = this.cache.get(cacheKey) as SteamData | undefined;
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }

    const reviewsUrl = `https://store.steampowered.com/appreviews/${appId}?json=1&language=all&purchase_type=all`;
    const reviewsData = await this.fetchWithRetry<SteamReviewsResponse>(reviewsUrl);

    if (!reviewsData.success) {
      throw new Error(`Steam API returned unsuccessful response for app ${appId}`);
    }

    const { total_positive, total_reviews } = reviewsData.query_summary;
    const reviewScore =
      total_reviews > 0 ? Math.round((total_positive / total_reviews) * 100) : 0;

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

      const langString = appData.data.supported_languages
        .replace(/<br\s*\/?>/gi, ",")  
        .replace(/<[^>]*>/g, "")  
        .replace(/\s+/g, " ");  

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

  async hasEnglishSupport(appId: number): Promise<boolean | null> {
    const languages = await this.getLanguages(appId);
    if (languages === null) return null;
    return languages.some(
      (lang) => lang.toLowerCase().includes("english")
    );
  }

  async isEarlyAccess(appId: number): Promise<boolean> {
    const cacheKey = `earlyAccess:${appId}`;
    const cached = this.cache.get(cacheKey) as boolean | undefined;
    if (cached !== undefined) {
      this.stats.cacheHits++;
      return cached;
    }

    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}`;

    try {
      const data = await this.fetchWithRetry<SteamAppDetailsResponse>(url);
      const appData = data[appId.toString()];

      if (!appData?.success || !appData.data?.genres) {
        this.cache.set(cacheKey, false, this.config.cacheTtlMs);
        return false;
      }

      const result = appData.data.genres.some((g) => g.id === "70");
      this.cache.set(cacheKey, result, this.config.cacheTtlMs);
      return result;
    } catch {
      this.cache.set(cacheKey, false, this.config.cacheTtlMs);
      return false;
    }
  }

  async getReleaseDate(appId: number): Promise<string | null> {
    const cacheKey = `releaseDate:${appId}`;
    const cached = this.cache.get(cacheKey) as string | null | undefined;
    if (cached !== undefined) {
      this.stats.cacheHits++;
      return cached;
    }

    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}`;

    try {
      const data = await this.fetchWithRetry<SteamAppDetailsResponse>(url);
      const appData = data[appId.toString()];

      if (!appData?.success || !appData.data?.release_date) {
        this.cache.set(cacheKey, null, this.config.cacheTtlMs);
        return null;
      }

      const { coming_soon, date } = appData.data.release_date;
      if (coming_soon || !date) {
        this.cache.set(cacheKey, null, this.config.cacheTtlMs);
        return null;
      }

      const parsed = this.parseSteamDate(date);
      this.cache.set(cacheKey, parsed, this.config.cacheTtlMs);
      return parsed;
    } catch {
      this.cache.set(cacheKey, null, this.config.cacheTtlMs);
      return null;
    }
  }

  private parseSteamDate(dateStr: string): string | null {
    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) return null;
      return date.toISOString().split("T")[0]!;
    } catch {
      return null;
    }
  }

  async getGameModes(appId: number): Promise<GameModes> {
    const cacheKey = `gameModes:${appId}`;
    const cached = this.cache.get(cacheKey) as GameModes | undefined;
    if (cached !== undefined) {
      this.stats.cacheHits++;
      return cached;
    }

    const defaultModes: GameModes = {
      hasSinglePlayer: false,
      hasMultiplayer: false,
      hasCoOp: false,
      hasOnlineCoOp: false,
      hasLocalCoOp: false,
      hasPvP: false,
      hasOnlinePvP: false,
      hasLocalPvP: false,
      hasCrossplatform: false,
      isMMO: false,
    };

    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}`;

    try {
      const data = await this.fetchWithRetry<SteamAppDetailsResponse>(url);
      const appData = data[appId.toString()];

      if (!appData?.success || !appData.data?.categories) {
        this.cache.set(cacheKey, defaultModes, this.config.cacheTtlMs);
        return defaultModes;
      }

      const categories = appData.data.categories;
      const hasCategory = (id: number) => categories.some((c) => c.id === id);

      const result: GameModes = {
        hasSinglePlayer: hasCategory(CATEGORY_IDS.SINGLE_PLAYER),
        hasMultiplayer: hasCategory(CATEGORY_IDS.MULTIPLAYER) || hasCategory(CATEGORY_IDS.ONLINE_MULTIPLAYER),
        hasCoOp: hasCategory(CATEGORY_IDS.CO_OP),
        hasOnlineCoOp: hasCategory(CATEGORY_IDS.ONLINE_CO_OP),
        hasLocalCoOp: hasCategory(CATEGORY_IDS.LOCAL_CO_OP),
        hasPvP: hasCategory(CATEGORY_IDS.PVP),
        hasOnlinePvP: hasCategory(CATEGORY_IDS.ONLINE_MULTIPLAYER),
        hasLocalPvP: hasCategory(CATEGORY_IDS.LOCAL_PVP),
        hasCrossplatform: hasCategory(CATEGORY_IDS.CROSS_PLATFORM),
        isMMO: hasCategory(CATEGORY_IDS.MMO),
      };

      this.cache.set(cacheKey, result, this.config.cacheTtlMs);
      return result;
    } catch {
      this.cache.set(cacheKey, defaultModes, this.config.cacheTtlMs);
      return defaultModes;
    }
  }

  async getControllerSupport(appId: number): Promise<"full" | "partial" | null> {
    const cacheKey = `controller:${appId}`;
    const cached = this.cache.get(cacheKey) as "full" | "partial" | null | undefined;
    if (cached !== undefined) {
      this.stats.cacheHits++;
      return cached;
    }

    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}`;

    try {
      const data = await this.fetchWithRetry<SteamAppDetailsResponse>(url);
      const appData = data[appId.toString()];

      if (!appData?.success || !appData.data?.categories) {
        this.cache.set(cacheKey, null, this.config.cacheTtlMs);
        return null;
      }

      const categories = appData.data.categories;
      const hasCategory = (id: number) => categories.some((c) => c.id === id);

      let result: "full" | "partial" | null = null;
      if (hasCategory(CATEGORY_IDS.FULL_CONTROLLER)) {
        result = "full";
      } else if (hasCategory(CATEGORY_IDS.PARTIAL_CONTROLLER)) {
        result = "partial";
      }

      this.cache.set(cacheKey, result, this.config.cacheTtlMs);
      return result;
    } catch {
      this.cache.set(cacheKey, null, this.config.cacheTtlMs);
      return null;
    }
  }

  async getTags(appId: number): Promise<string[] | null> {
    const cacheKey = `tags:${appId}`;
    const cached = this.cache.get(cacheKey) as string[] | null | undefined;
    if (cached !== undefined) {
      this.stats.cacheHits++;
      return cached;
    }

    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}`;

    try {
      const data = await this.fetchWithRetry<SteamAppDetailsResponse>(url);
      const appData = data[appId.toString()];

      if (!appData?.success || !appData.data) {
        this.cache.set(cacheKey, null, this.config.cacheTtlMs);
        return null;
      }

      const tags: string[] = [];

      if (appData.data.genres) {
        for (const genre of appData.data.genres) {
          tags.push(genre.description);
        }
      }

      if (appData.data.categories) {
        for (const category of appData.data.categories) {
          tags.push(category.description);
        }
      }

      const uniqueTags = [...new Set(tags)];

      this.cache.set(cacheKey, uniqueTags, this.config.cacheTtlMs);
      return uniqueTags;
    } catch {
      this.cache.set(cacheKey, null, this.config.cacheTtlMs);
      return null;
    }
  }

  getStats(): SteamClientStats {
    return { ...this.stats };
  }

  clearCache(): void {
    this.cache.clear();
  }

  resetStats(): void {
    this.stats = { requests: 0, cacheHits: 0, retries: 0 };
  }
}

export const steam = new SteamClient();

export const fetchSteamData = (appId: number) => steam.fetchSteamData(appId);
export const isGame = (appId: number) => steam.isGame(appId);
export const isEarlyAccess = (appId: number) => steam.isEarlyAccess(appId);
export const getControllerSupport = (appId: number) => steam.getControllerSupport(appId);
export const getReleaseDate = (appId: number) => steam.getReleaseDate(appId);
export const getGameModes = (appId: number) => steam.getGameModes(appId);
export const getTags = (appId: number) => steam.getTags(appId);
