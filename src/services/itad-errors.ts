const diagnostics = {
  UNAVAILABLE: "ITAD unavailable",
  MISSING_API_KEY: "Missing ITAD_API_KEY",
  INVALID_MAPPING: "Incomplete or invalid ITAD Steam mapping response",
  UNEXPECTED_PRICE_ID: "Unexpected ITAD price game ID",
  REPEATED_BUNDLE_ID: "ITAD bundle pagination repeated an ID; retry later",
  BUNDLE_PAGE_LIMIT: "ITAD bundle pagination exceeded safety limit",
  NETWORK_FAILURE: "ITAD network request failed",
  INVALID_JSON: "ITAD returned invalid JSON",
  LONG_RETRY_DELAY: "ITAD requested a long retry delay; next scheduled run will retry",
  INVALID_DISCOUNT: "Invalid ITAD discount",
  INVALID_BUNDLE_TIER: "Invalid ITAD bundle tier",
  MISSING_BUNDLE_PUBLICATION: "Missing ITAD bundle publication date",
  INVALID_BUNDLE_GAME_ID: "Invalid ITAD bundle game ID",
  INVALID_OBJECT: "Invalid ITAD object",
  INVALID_ARRAY: "Invalid ITAD array",
  INVALID_TEXT: "Invalid ITAD text",
  INVALID_NUMBER: "Invalid ITAD number",
  INVALID_EXPIRY: "Invalid ITAD expiry",
  INVALID_URL: "Invalid ITAD offer URL",
} as const;

export type ItadErrorCode = keyof typeof diagnostics | "HTTP_FAILURE";

export class ItadError extends Error {
  readonly code: ItadErrorCode;
  #diagnostic: string;

  constructor(code: ItadErrorCode, status?: number) {
    const message = code === "HTTP_FAILURE"
      ? typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? `ITAD request failed (HTTP ${status})` : "ITAD request failed"
      : diagnostics[code];
    super(message);
    this.name = "ItadError";
    this.code = code;
    this.#diagnostic = message;
  }

  static safeMessage(error: unknown): string | undefined {
    return error instanceof ItadError && #diagnostic in error ? error.#diagnostic : undefined;
  }
}
