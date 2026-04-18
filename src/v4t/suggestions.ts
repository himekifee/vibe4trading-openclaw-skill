import { DEFAULT_V4T_API_ORIGIN, MAX_SUGGESTION_AGE_SECONDS } from "../config/constants";

/**
 * Tick recommendation direction, matching the vibe4trading API's
 * `recommended_direction` field. Kept as a union type for the
 * deterministic policy engine's side checks — the LLM may encounter
 * additional values in `raw` and handle them freely.
 */
export type RecommendationDirection = "long" | "short" | "flat";

/**
 * Lightweight tick recommendation extracted from the vibe4trading
 * `/api/agent/tick-recommendation` endpoint.
 *
 * Only the fields required for deterministic safety checks are
 * extracted and typed.  The full raw JSON response is preserved in
 * `raw` so that the consuming LLM can interpret any field — including
 * fields added or renamed by the upstream API without a code change
 * here.
 *
 * No rigid parser or class is used; field extraction is done with
 * simple property access and fallback defaults.  If an essential
 * field is missing or malformed, the caller treats it as a degraded
 * result and the tick holds.
 */
export type TickRecommendation = {
  readonly tickTime: string;
  readonly expiresAt: string;
  readonly marketId: string;
  readonly recommendedMode: string;
  readonly recommendedDirection: string;
  readonly recommendedSizeFraction: string;
  readonly recommendedLeverage: number;
  readonly recommendationId: string;
  /**
   * Full raw JSON response from the API.  The consuming LLM should
   * read this to interpret fields like `recommended_action`,
   * `market_regime`, `return_pct`, `confidence`, `rationale`,
   * `key_signals`, `reasoning_scratchpad`, `current_price`, etc.
   * Fields in `raw` may change without notice — the LLM handles that.
   */
  readonly raw: Record<string, unknown>;
};

type TickRecommendationOkResult = {
  readonly kind: "ok";
  readonly httpStatus: 200;
  readonly recommendation: TickRecommendation;
};

type TickRecommendationDegradedReason =
  | "endpoint-unsupported"
  | "no-fresh-recommendation"
  | "unauthorized"
  | "unsupported-request"
  | "invalid-response"
  | "network-error"
  | "unexpected-http-status";

type TickRecommendationDegradedResult = {
  readonly kind: "degraded";
  readonly reason: TickRecommendationDegradedReason;
  readonly httpStatus: number | null;
  readonly message: string;
};

export type TickRecommendationResult =
  | TickRecommendationOkResult
  | TickRecommendationDegradedResult;

export type TickRecommendationRequest = {
  readonly apiToken: string;
  readonly marketId: string;
  readonly modelKey: string;
  readonly strategyKey: string;
};

export type TickRecommendationProvider = (
  request: TickRecommendationRequest,
) => Promise<TickRecommendationResult>;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function createHttpTickRecommendationProvider(
  options: {
    readonly apiOrigin?: string;
    readonly fetchImpl?: FetchLike;
  } = {},
): TickRecommendationProvider {
  const apiOrigin = options.apiOrigin ?? DEFAULT_V4T_API_ORIGIN;
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (request) => {
    const endpointUrl = new URL("/api/agent/tick-recommendation", apiOrigin);
    endpointUrl.searchParams.set("model", request.modelKey);
    endpointUrl.searchParams.set("strategy", request.strategyKey);
    endpointUrl.searchParams.set("market_pair", request.marketId);

    try {
      const response = await fetchImpl(endpointUrl.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${request.apiToken}`,
        },
      });

      if (response.status === 200) {
        let payload: unknown;
        try {
          payload = (await response.json()) as unknown;
        } catch (error) {
          return degradedResult(
            "invalid-response",
            response.status,
            `Tick recommendation response body is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
          );
        }

        const extracted = extractTickRecommendation(payload);
        if (extracted === null) {
          return degradedResult(
            "invalid-response",
            response.status,
            "Tick recommendation response is missing essential fields (tick_time, expires_at, market_id, recommended_direction, recommended_size_fraction, recommended_leverage, or recommended_mode).",
          );
        }

        return {
          kind: "ok",
          httpStatus: 200,
          recommendation: extracted,
        };
      }

      if (response.status === 204) {
        return degradedResult(
          "no-fresh-recommendation",
          response.status,
          "No fresh tick recommendation is currently available.",
        );
      }

      if (
        response.status === 404 ||
        response.status === 405 ||
        response.status === 410 ||
        response.status === 501
      ) {
        return degradedResult(
          "endpoint-unsupported",
          response.status,
          "Tick recommendation endpoint is not available in the current vibe4trading environment.",
        );
      }

      if (response.status === 401 || response.status === 403) {
        return degradedResult(
          "unauthorized",
          response.status,
          "Tick recommendation request was rejected by vibe4trading authentication.",
        );
      }

      if (response.status === 422) {
        return degradedResult(
          "unsupported-request",
          response.status,
          "Tick recommendation request is not supported for the configured market or model.",
        );
      }

      return degradedResult(
        "unexpected-http-status",
        response.status,
        `Unexpected tick recommendation HTTP status: ${response.status}.`,
      );
    } catch (error) {
      return degradedResult(
        "network-error",
        null,
        error instanceof Error ? error.message : "Tick recommendation request failed.",
      );
    }
  };
}

function extractTickRecommendation(value: unknown): TickRecommendation | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const data = value as Record<string, unknown>;

  const tickTime = readStringField(data, "tick_time");
  const expiresAt = readStringField(data, "expires_at");
  const marketId = readStringField(data, "market_id");
  const recommendedDirection = readStringField(data, "recommended_direction");
  const recommendedSizeFraction = readStringField(data, "recommended_size_fraction");
  const recommendedMode = readStringField(data, "recommended_mode");

  if (
    tickTime === null ||
    expiresAt === null ||
    marketId === null ||
    recommendedDirection === null ||
    recommendedSizeFraction === null ||
    recommendedMode === null
  ) {
    return null;
  }

  const leverageValue = data.recommended_leverage;
  const recommendedLeverage =
    typeof leverageValue === "number" && Number.isFinite(leverageValue)
      ? Math.max(0, Math.round(leverageValue))
      : null;

  if (recommendedLeverage === null) {
    return null;
  }

  // Derive a recommendation ID from run_id + tick_time for dedup/audit.
  const runId = readStringField(data, "run_id");
  const recommendationId = runId !== null ? [runId, tickTime].join("::") : `unknown::${tickTime}`;

  return {
    tickTime,
    expiresAt,
    marketId,
    recommendedMode,
    recommendedDirection,
    recommendedSizeFraction,
    recommendedLeverage,
    recommendationId,
    raw: { ...data },
  };
}

function readStringField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}

export function isRecommendationFresh(
  recommendation: TickRecommendation,
  now: Date = new Date(),
): boolean {
  const tickTimeMs = Date.parse(recommendation.tickTime);
  const expiresAtMs = Date.parse(recommendation.expiresAt);
  if (Number.isNaN(tickTimeMs) || Number.isNaN(expiresAtMs)) {
    return false;
  }

  const ageMs = now.getTime() - tickTimeMs;
  return ageMs >= 0 && ageMs <= MAX_SUGGESTION_AGE_SECONDS * 1000 && now.getTime() <= expiresAtMs;
}

function degradedResult(
  reason: TickRecommendationDegradedReason,
  httpStatus: number | null,
  message: string,
): TickRecommendationDegradedResult {
  return {
    kind: "degraded",
    reason,
    httpStatus,
    message,
  };
}

// ---------------------------------------------------------------------------
// Legacy aliases — these keep the existing import paths working while
// consumers are migrated to the new naming.  They will be removed once
// all call-sites have been updated.
// ---------------------------------------------------------------------------

/** @deprecated Use TickRecommendationResult instead. */
export type SuggestionProviderResult = TickRecommendationResult;

/** @deprecated Use TickRecommendationRequest instead. */
export type SuggestionRequest = TickRecommendationRequest;

/** @deprecated Use TickRecommendationProvider instead. */
export type SuggestionProvider = TickRecommendationProvider;

/** @deprecated Use RecommendationDirection instead. */
export type SuggestionSide = RecommendationDirection;

/** @deprecated Use createHttpTickRecommendationProvider instead. */
export const createHttpSuggestionProvider = createHttpTickRecommendationProvider;

/** @deprecated Use isRecommendationFresh instead. */
export const isSuggestionFresh = isRecommendationFresh;

/**
 * @deprecated Access `recommendation` field on a `TickRecommendationResult`
 * of kind `"ok"` instead.  NormalizedSuggestion no longer exists.
 */
export type NormalizedSuggestion = TickRecommendation;
