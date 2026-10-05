export const DEAL_COUNTRY = "US";
export const DEAL_MAX_AGE_SECONDS = 24 * 60 * 60;

export interface DealOffer {
  kind: "retail" | "bundle";
  id: string;
  title: string;
  store: string;
  url: string;
  priceCents: number | null;
  currency: "USD" | null;
  discountPercent: number | null;
  drm: string[];
  voucher: string | null;
  note: string | null;
  expiresAt: number | null;
  validUntil: number;
}

export interface GameDeals {
  status: "fresh" | "partial" | "stale" | "unknown" | "unmapped";
  checkedAt: number | null;
  offers: DealOffer[];
}

export interface DealRefreshStatus {
  country: string;
  currency: string;
  maxAgeSeconds: number;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  isRunning: boolean;
  gamesChecked: number;
  totalGames: number;
  freshGames: number;
}
