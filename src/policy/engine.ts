import {
  MAX_AGENT_MD_AGE_SECONDS,
  MAX_CUMULATIVE_BRIDGE_USD,
  MAX_LEVERAGE,
  MAX_POSITION_NOTIONAL_FRACTION,
} from "../config/constants";
import { compareDecimalStrings, ensureNonNegativeDecimalString } from "../config/decimals";
import type { MarketMode } from "../config/market";
import { SchemaValidationError } from "../config/validation";
import { parseCanonicalUtcTimestamp, parseRuntimeState, slotIdFromDate } from "../state";
import type { RuntimeState } from "../state/runtime-state";
import type { AgentMdPolicyView } from "../v4t/agent-md";
import {
  type RecommendationDirection,
  type TickRecommendation,
  type TickRecommendationResult,
  isRecommendationFresh,
} from "../v4t/suggestions";

const POLICY_SIDE_PREFERENCES = ["follow-suggestion", "long", "short", "flat"] as const;

const POLICY_VALUE_SOURCES = [
  "suggestion",
  "execution-intent",
  "user-preferences",
  "prior-interaction",
] as const;

const POLICY_HOLD_REASONS = [
  "override-required",
  "agent-md-unavailable",
  "agent-md-stale",
  "agent-md-degraded",
  "no-suggestion",
  "suggestion-degraded",
  "suggestion-stale",
  "market-mismatch",
  "mode-mismatch",
  "account-mode-unsupported",
  "spot-short-unsupported",
  "leverage-zero-disallowed",
  "agent-intent-hold",
] as const;

export type PolicySidePreference = (typeof POLICY_SIDE_PREFERENCES)[number];
export type PolicyValueSource = (typeof POLICY_VALUE_SOURCES)[number];
export type PolicyHoldReason = (typeof POLICY_HOLD_REASONS)[number];

export type PolicyUserPreferences = {
  readonly sidePreference: PolicySidePreference;
  readonly maxPositionNotionalFraction: string | null;
  readonly maxLeverage: number | null;
};

export type PriorInteractionSummary = {
  readonly sideOverride: RecommendationDirection | null;
  readonly targetFractionOverride: string | null;
  readonly leverageOverride: number | null;
  readonly acceptOverridePhrase: boolean;
};

export type PolicyAccountState = {
  readonly supportedModes: readonly MarketMode[];
  readonly maxTradableFraction: string;
};

export type PolicyExecutionIntent =
  | {
      readonly action: "hold";
      readonly rationale: string;
    }
  | {
      readonly action: "target-position";
      readonly rationale: string;
      readonly side?: RecommendationDirection;
      readonly targetFraction?: string;
      readonly leverage?: number;
    };

export type PolicyClamp = {
  readonly field: "side" | "targetFraction" | "leverage" | "overridePhrase";
  readonly from: string | number | boolean;
  readonly to: string | number | boolean;
  readonly reason: string;
};

export type PolicyTarget = {
  readonly side: RecommendationDirection;
  readonly targetFraction: string;
  readonly leverage: number;
};

export type OverridePhrasePolicyState = {
  readonly wasAccepted: boolean;
  readonly isAccepted: boolean;
  readonly requiresAcceptance: boolean;
  readonly shouldPersist: boolean;
};

type PolicyDecisionBase = {
  readonly marketId: string;
  readonly mode: MarketMode;
  readonly evaluatedAt: string;
  readonly slotId: string;
  readonly suggestionId: string | null;
  readonly overridePhrase: OverridePhrasePolicyState;
  readonly agentStatus: AgentMdPolicyView["status"] | null;
  readonly clamps: readonly PolicyClamp[];
};

export type PolicyHoldDecision = PolicyDecisionBase & {
  readonly kind: "hold";
  readonly holdReason: PolicyHoldReason;
  readonly message: string;
};

export type PolicyTargetPositionDecision = PolicyDecisionBase & {
  readonly kind: "target-position";
  readonly baselineTarget: PolicyTarget;
  readonly requestedTarget: PolicyTarget;
  readonly target: PolicyTarget;
  readonly sources: {
    readonly side: PolicyValueSource;
    readonly targetFraction: PolicyValueSource;
    readonly leverage: PolicyValueSource;
  };
  readonly confidence: string;
  readonly rationale: string;
  readonly keySignals: readonly string[];
  readonly stopLossPct: string | null;
  readonly takeProfitPct: string | null;
};

export type LocalPolicyDecision = PolicyHoldDecision | PolicyTargetPositionDecision;

export type PolicyEvaluationInput = {
  readonly now?: Date;
  readonly slotId?: string;
  readonly runtimeState: RuntimeState;
  readonly suggestionResult: TickRecommendationResult | null;
  readonly agentMdPolicy: AgentMdPolicyView | null;
  readonly agentMdFetchedAt: string | null;
  readonly userPreferences?: PolicyUserPreferences;
  readonly priorInteractionSummary?: PriorInteractionSummary;
  readonly executionIntent?: PolicyExecutionIntent;
  readonly accountState: PolicyAccountState;
};

function createDefaultPolicyUserPreferences(): PolicyUserPreferences {
  return Object.freeze({
    sidePreference: "follow-suggestion",
    maxPositionNotionalFraction: null,
    maxLeverage: null,
  });
}

export function createEmptyPriorInteractionSummary(): PriorInteractionSummary {
  return Object.freeze({
    sideOverride: null,
    targetFractionOverride: null,
    leverageOverride: null,
    acceptOverridePhrase: false,
  });
}

export function evaluateOpenClawPolicy(input: PolicyEvaluationInput): LocalPolicyDecision {
  const now = input.now ?? new Date();
  const evaluatedAt = now.toISOString();
  const slotId = input.slotId ?? slotIdFromDate(now);
  const runtimeState = parseRuntimeState(input.runtimeState);
  const preferences = normalizeUserPreferences(input.userPreferences);
  const priorInteractionSummary = normalizePriorInteractionSummary(input.priorInteractionSummary);
  const executionIntent = normalizeExecutionIntent(input.executionIntent);
  const accountState = normalizeAccountState(input.accountState);
  const overridePhrase = buildOverridePhraseState(runtimeState, priorInteractionSummary);
  const marketId = runtimeState.market.marketId;
  const mode = runtimeState.market.mode;
  const agentStatus = input.agentMdPolicy?.status ?? null;
  const hold = (input: {
    readonly suggestionId: string | null;
    readonly clamps: readonly PolicyClamp[];
    readonly holdReason: PolicyHoldReason;
    readonly message: string;
  }): PolicyHoldDecision =>
    holdDecision({
      marketId,
      mode,
      evaluatedAt,
      slotId,
      suggestionId: input.suggestionId,
      overridePhrase:
        input.holdReason === "override-required"
          ? {
              ...overridePhrase,
              requiresAcceptance: true,
            }
          : overridePhrase,
      agentStatus,
      clamps: input.clamps,
      holdReason: input.holdReason,
      message: input.message,
    });

  if (executionIntent?.action === "hold") {
    return hold({
      suggestionId: readSuggestionId(input.suggestionResult),
      clamps: [],
      holdReason: "agent-intent-hold",
      message: executionIntent.rationale,
    });
  }

  if (
    compareDecimalStrings(runtimeState.cumulativeBridgeUsd, String(MAX_CUMULATIVE_BRIDGE_USD)) >=
      0 &&
    !overridePhrase.isAccepted
  ) {
    return hold({
      suggestionId: readSuggestionId(input.suggestionResult),
      clamps: [
        {
          field: "overridePhrase",
          from: false,
          to: false,
          reason:
            "Cumulative bridge total exceeds the automation cap without persisted override acceptance.",
        },
      ],
      holdReason: "override-required",
      message:
        "Automation is halted because cumulative bridged funds exceed the code-owned cap and no override phrase has been accepted.",
    });
  }

  if (input.agentMdPolicy === null || input.agentMdFetchedAt === null) {
    return hold({
      suggestionId: readSuggestionId(input.suggestionResult),
      clamps: [],
      holdReason: "agent-md-unavailable",
      message: "Policy view is unavailable because the latest parsed agents.md state is missing.",
    });
  }

  const agentMdFetchedAt = parseCanonicalUtcTimestamp(
    input.agentMdFetchedAt,
    "policy.agentMdFetchedAt",
  );
  const agentMdAgeMs = now.getTime() - agentMdFetchedAt.getTime();
  if (agentMdAgeMs < 0 || agentMdAgeMs > MAX_AGENT_MD_AGE_SECONDS * 1000) {
    return hold({
      suggestionId: readSuggestionId(input.suggestionResult),
      clamps: [],
      holdReason: "agent-md-stale",
      message: "Policy view is stale, so OpenClaw refuses to trade on this tick.",
    });
  }

  if (input.agentMdPolicy.status !== "active") {
    return hold({
      suggestionId: readSuggestionId(input.suggestionResult),
      clamps: [],
      holdReason: "agent-md-degraded",
      message: `agents.md status is ${input.agentMdPolicy.status}, so OpenClaw will hold instead of trading.`,
    });
  }

  if (input.suggestionResult === null) {
    return hold({
      suggestionId: null,
      clamps: [],
      holdReason: "no-suggestion",
      message: "No fresh vibe4trading suggestion is available for the configured market.",
    });
  }

  if (input.suggestionResult.kind === "degraded") {
    return hold({
      suggestionId: null,
      clamps: [],
      holdReason: "suggestion-degraded",
      message: `Suggestion input is degraded (${input.suggestionResult.reason}): ${input.suggestionResult.message}`,
    });
  }

  const recommendation = input.suggestionResult.recommendation;
  if (!isRecommendationFresh(recommendation, now)) {
    return hold({
      suggestionId: recommendation.recommendationId,
      clamps: [],
      holdReason: "suggestion-stale",
      message: "Recommendation data is stale or expired, so no trade will be opened.",
    });
  }

  if (recommendation.marketId !== marketId) {
    return hold({
      suggestionId: recommendation.recommendationId,
      clamps: [],
      holdReason: "market-mismatch",
      message: "Recommendation market does not match the configured single-market runtime state.",
    });
  }

  const normalizedMode = recommendation.recommendedMode === "futures" ? "perp" : "spot";
  if (normalizedMode !== mode) {
    return hold({
      suggestionId: recommendation.recommendationId,
      clamps: [],
      holdReason: "mode-mismatch",
      message: "Recommendation mode is incompatible with the configured spot/perp market mode.",
    });
  }

  if (!accountState.supportedModes.includes(mode)) {
    return hold({
      suggestionId: recommendation.recommendationId,
      clamps: [],
      holdReason: "account-mode-unsupported",
      message: "Account state does not support the configured market mode on this tick.",
    });
  }

  const baselineTarget: PolicyTarget = {
    side: recommendation.recommendedDirection as RecommendationDirection,
    targetFraction: recommendation.recommendedSizeFraction,
    leverage: recommendation.recommendedLeverage,
  };

  const requestedTarget = buildRequestedTarget(
    recommendation,
    preferences,
    priorInteractionSummary,
    executionIntent,
  );
  if (mode === "spot" && requestedTarget.target.side === "short") {
    return hold({
      suggestionId: recommendation.recommendationId,
      clamps: [],
      holdReason: "spot-short-unsupported",
      message:
        "Spot mode does not support short exposure, so the policy rejects this reinterpretation.",
    });
  }

  const finalization = finalizeTarget({
    requestedTarget: requestedTarget.target,
    mode,
    preferences,
    accountState,
  });

  if (finalization.kind === "hold") {
    return hold({
      suggestionId: recommendation.recommendationId,
      clamps: finalization.clamps,
      holdReason: finalization.holdReason,
      message: finalization.message,
    });
  }

  const rawConfidence = recommendation.raw.confidence;
  const rawRationale = recommendation.raw.rationale;
  const rawKeySignals = recommendation.raw.key_signals;
  const rawStopLossPct = recommendation.raw.stop_loss_pct;
  const rawTakeProfitPct = recommendation.raw.take_profit_pct;

  return {
    kind: "target-position",
    marketId,
    mode,
    evaluatedAt,
    slotId,
    suggestionId: recommendation.recommendationId,
    overridePhrase,
    agentStatus,
    clamps: finalization.clamps,
    baselineTarget,
    requestedTarget: requestedTarget.target,
    target: finalization.target,
    sources: requestedTarget.sources,
    confidence: typeof rawConfidence === "string" ? rawConfidence : "0",
    rationale:
      executionIntent?.action === "target-position"
        ? executionIntent.rationale
        : typeof rawRationale === "string"
          ? rawRationale
          : "",
    keySignals: Array.isArray(rawKeySignals)
      ? rawKeySignals.filter((s): s is string => typeof s === "string")
      : [],
    stopLossPct: typeof rawStopLossPct === "string" ? rawStopLossPct : null,
    takeProfitPct: typeof rawTakeProfitPct === "string" ? rawTakeProfitPct : null,
  };
}

function buildRequestedTarget(
  recommendation: TickRecommendation,
  preferences: PolicyUserPreferences,
  priorInteractionSummary: PriorInteractionSummary,
  executionIntent?: PolicyExecutionIntent,
): {
  readonly target: PolicyTarget;
  readonly sources: {
    readonly side: PolicyValueSource;
    readonly targetFraction: PolicyValueSource;
    readonly leverage: PolicyValueSource;
  };
} {
  let side: RecommendationDirection =
    recommendation.recommendedDirection as RecommendationDirection;
  let sideSource: PolicyValueSource = "suggestion";

  if (preferences.sidePreference !== "follow-suggestion") {
    side = preferenceToSide(preferences.sidePreference);
    sideSource = "user-preferences";
  }

  if (priorInteractionSummary.sideOverride !== null) {
    side = priorInteractionSummary.sideOverride;
    sideSource = "prior-interaction";
  }

  let targetFraction = recommendation.recommendedSizeFraction;
  let targetFractionSource: PolicyValueSource = "suggestion";
  if (priorInteractionSummary.targetFractionOverride !== null) {
    targetFraction = priorInteractionSummary.targetFractionOverride;
    targetFractionSource = "prior-interaction";
  }

  let leverage = recommendation.recommendedLeverage;
  let leverageSource: PolicyValueSource = "suggestion";
  if (priorInteractionSummary.leverageOverride !== null) {
    leverage = priorInteractionSummary.leverageOverride;
    leverageSource = "prior-interaction";
  }

  if (executionIntent?.action === "target-position") {
    if (executionIntent.side !== undefined) {
      side = executionIntent.side;
      sideSource = "execution-intent";
    }

    if (executionIntent.targetFraction !== undefined) {
      targetFraction = executionIntent.targetFraction;
      targetFractionSource = "execution-intent";
    }

    if (executionIntent.leverage !== undefined) {
      leverage = executionIntent.leverage;
      leverageSource = "execution-intent";
    }
  }

  return {
    target: {
      side,
      targetFraction,
      leverage,
    },
    sources: {
      side: sideSource,
      targetFraction: targetFractionSource,
      leverage: leverageSource,
    },
  };
}

type FinalizeTargetResult =
  | {
      readonly kind: "target";
      readonly target: PolicyTarget;
      readonly clamps: readonly PolicyClamp[];
    }
  | {
      readonly kind: "hold";
      readonly holdReason: PolicyHoldReason;
      readonly message: string;
      readonly clamps: readonly PolicyClamp[];
    };

function finalizeFlatTarget(input: {
  readonly side: "flat";
  readonly targetFraction: string;
  readonly leverage: number;
  readonly clamps: PolicyClamp[];
}): FinalizeTargetResult {
  let targetFraction = input.targetFraction;
  let leverage = input.leverage;

  if (compareDecimalStrings(targetFraction, "0") !== 0) {
    input.clamps.push({
      field: "targetFraction",
      from: targetFraction,
      to: "0",
      reason: "Flat exposure always resolves to zero target notional fraction.",
    });
    targetFraction = "0";
  }

  if (leverage !== 0) {
    input.clamps.push({
      field: "leverage",
      from: leverage,
      to: 0,
      reason: "Flat exposure always resolves to zero leverage.",
    });
    leverage = 0;
  }

  return {
    kind: "target",
    target: {
      side: input.side,
      targetFraction,
      leverage,
    },
    clamps: input.clamps,
  };
}

function finalizeSpotTarget(input: {
  readonly side: RecommendationDirection;
  readonly targetFraction: string;
  readonly leverage: number;
  readonly clamps: PolicyClamp[];
}): FinalizeTargetResult {
  if (input.leverage !== 1) {
    input.clamps.push({
      field: "leverage",
      from: input.leverage,
      to: 1,
      reason: "Spot markets are forced to deterministic 1x exposure.",
    });
  }

  return {
    kind: "target",
    target: {
      side: input.side,
      targetFraction: input.targetFraction,
      leverage: 1,
    },
    clamps: input.clamps,
  };
}

function finalizePerpLeverage(input: {
  readonly side: Exclude<RecommendationDirection, "flat">;
  readonly targetFraction: string;
  readonly leverage: number;
  readonly preferences: PolicyUserPreferences;
  readonly clamps: PolicyClamp[];
}): FinalizeTargetResult {
  let leverage = input.leverage;

  // maxLeverage clamp runs before the 1x floor: maxLeverage:0 → hold, not silent 1x override.
  if (input.preferences.maxLeverage !== null && leverage > input.preferences.maxLeverage) {
    input.clamps.push({
      field: "leverage",
      from: leverage,
      to: input.preferences.maxLeverage,
      reason: "User preference max leverage applied.",
    });
    leverage = input.preferences.maxLeverage;
  }

  if (input.preferences.maxLeverage !== null && leverage < 1) {
    return {
      kind: "hold",
      holdReason: "leverage-zero-disallowed",
      message:
        "User maxLeverage preference disallows perp exposure (effective leverage < 1). Holding instead of trading.",
      clamps: input.clamps,
    };
  }

  if (leverage < 1) {
    input.clamps.push({
      field: "leverage",
      from: leverage,
      to: 1,
      reason: "Perp exposure uses a minimum deterministic leverage of 1x when non-flat.",
    });
    leverage = 1;
  }

  if (leverage > MAX_LEVERAGE) {
    input.clamps.push({
      field: "leverage",
      from: leverage,
      to: MAX_LEVERAGE,
      reason: "Code-owned maximum leverage applied.",
    });
    leverage = MAX_LEVERAGE;
  }

  return {
    kind: "target",
    target: {
      side: input.side,
      targetFraction: input.targetFraction,
      leverage,
    },
    clamps: input.clamps,
  };
}

function finalizeTarget(input: {
  readonly requestedTarget: PolicyTarget;
  readonly mode: MarketMode;
  readonly preferences: PolicyUserPreferences;
  readonly accountState: PolicyAccountState;
}): FinalizeTargetResult {
  const clamps: PolicyClamp[] = [];
  const side = input.requestedTarget.side;
  let targetFraction = normalizeRequestedFraction(
    input.requestedTarget.targetFraction,
    "policy.requestedTarget.targetFraction",
  );
  const leverage = normalizeNonNegativeInteger(
    input.requestedTarget.leverage,
    "policy.requestedTarget.leverage",
  );

  if (side === "flat") {
    return finalizeFlatTarget({ side, targetFraction, leverage, clamps });
  }

  targetFraction = clampFraction(
    targetFraction,
    input.preferences.maxPositionNotionalFraction,
    clamps,
    {
      reason: "User preference max position fraction applied.",
      sourceField: "targetFraction",
    },
  );
  targetFraction = clampFraction(targetFraction, input.accountState.maxTradableFraction, clamps, {
    reason: "Account-state tradable fraction applied.",
    sourceField: "targetFraction",
  });
  targetFraction = clampFraction(targetFraction, String(MAX_POSITION_NOTIONAL_FRACTION), clamps, {
    reason: "Code-owned maximum position notional fraction applied.",
    sourceField: "targetFraction",
  });

  if (compareDecimalStrings(targetFraction, "0") === 0) {
    clamps.push({
      field: "side",
      from: side,
      to: "flat",
      reason: "Zero target fraction is normalized to a flat decision.",
    });
    if (leverage !== 0) {
      clamps.push({
        field: "leverage",
        from: leverage,
        to: 0,
        reason: "Zero target fraction removes leverage exposure.",
      });
    }
    return {
      kind: "target",
      target: {
        side: "flat",
        targetFraction: "0",
        leverage: 0,
      },
      clamps,
    };
  }

  if (input.mode === "spot") {
    return finalizeSpotTarget({ side, targetFraction, leverage, clamps });
  }

  return finalizePerpLeverage({
    side,
    targetFraction,
    leverage,
    preferences: input.preferences,
    clamps,
  });
}

function buildOverridePhraseState(
  runtimeState: RuntimeState,
  priorInteractionSummary: PriorInteractionSummary,
): OverridePhrasePolicyState {
  const wasAccepted = runtimeState.overridePhraseAccepted;
  const isAccepted = wasAccepted || priorInteractionSummary.acceptOverridePhrase;
  return {
    wasAccepted,
    isAccepted,
    requiresAcceptance: false,
    shouldPersist: !wasAccepted && isAccepted,
  };
}

function holdDecision(input: {
  readonly marketId: string;
  readonly mode: MarketMode;
  readonly evaluatedAt: string;
  readonly slotId: string;
  readonly suggestionId: string | null;
  readonly overridePhrase: OverridePhrasePolicyState;
  readonly agentStatus: AgentMdPolicyView["status"] | null;
  readonly clamps: readonly PolicyClamp[];
  readonly holdReason: PolicyHoldReason;
  readonly message: string;
}): PolicyHoldDecision {
  return {
    kind: "hold",
    marketId: input.marketId,
    mode: input.mode,
    evaluatedAt: input.evaluatedAt,
    slotId: input.slotId,
    suggestionId: input.suggestionId,
    overridePhrase: input.overridePhrase,
    agentStatus: input.agentStatus,
    clamps: input.clamps,
    holdReason: input.holdReason,
    message: input.message,
  };
}

function preferenceToSide(
  preference: Exclude<PolicySidePreference, "follow-suggestion">,
): RecommendationDirection {
  if (preference === "long") {
    return "long";
  }
  if (preference === "short") {
    return "short";
  }
  return "flat";
}

function normalizeUserPreferences(value?: PolicyUserPreferences): PolicyUserPreferences {
  const defaults = createDefaultPolicyUserPreferences();
  if (value === undefined) {
    return defaults;
  }

  if (!POLICY_SIDE_PREFERENCES.includes(value.sidePreference)) {
    throw new SchemaValidationError(
      `policy.userPreferences.sidePreference must be one of: ${POLICY_SIDE_PREFERENCES.join(", ")}.`,
    );
  }

  return {
    sidePreference: value.sidePreference,
    maxPositionNotionalFraction:
      value.maxPositionNotionalFraction === null
        ? null
        : normalizeUnitFraction(
            value.maxPositionNotionalFraction,
            "policy.userPreferences.maxPositionNotionalFraction",
          ),
    maxLeverage:
      value.maxLeverage === null
        ? null
        : normalizeNonNegativeInteger(value.maxLeverage, "policy.userPreferences.maxLeverage"),
  };
}

function normalizePriorInteractionSummary(
  value?: PriorInteractionSummary,
): PriorInteractionSummary {
  const defaults = createEmptyPriorInteractionSummary();
  if (value === undefined) {
    return defaults;
  }

  if (
    value.sideOverride !== null &&
    value.sideOverride !== "long" &&
    value.sideOverride !== "short" &&
    value.sideOverride !== "flat"
  ) {
    throw new SchemaValidationError("policy.priorInteractionSummary.sideOverride is invalid.");
  }

  return {
    sideOverride: value.sideOverride,
    targetFractionOverride:
      value.targetFractionOverride === null
        ? null
        : normalizeRequestedFraction(
            value.targetFractionOverride,
            "policy.priorInteractionSummary.targetFractionOverride",
          ),
    leverageOverride:
      value.leverageOverride === null
        ? null
        : normalizeNonNegativeInteger(
            value.leverageOverride,
            "policy.priorInteractionSummary.leverageOverride",
          ),
    acceptOverridePhrase: value.acceptOverridePhrase,
  };
}

function normalizeExecutionIntent(
  value?: PolicyExecutionIntent,
): PolicyExecutionIntent | undefined {
  if (value === undefined) {
    return undefined;
  }

  const rationale = value.rationale.trim();
  if (rationale.length === 0) {
    throw new SchemaValidationError("policy.executionIntent.rationale must not be empty.");
  }

  if (value.action === "hold") {
    return {
      action: "hold",
      rationale,
    };
  }

  if (value.action !== "target-position") {
    throw new SchemaValidationError(
      "policy.executionIntent.action must be one of: hold, target-position.",
    );
  }

  if (
    value.side !== undefined &&
    value.side !== "long" &&
    value.side !== "short" &&
    value.side !== "flat"
  ) {
    throw new SchemaValidationError("policy.executionIntent.side is invalid.");
  }

  return {
    action: "target-position",
    rationale,
    side: value.side,
    targetFraction:
      value.targetFraction === undefined
        ? undefined
        : normalizeUnitFraction(value.targetFraction, "policy.executionIntent.targetFraction"),
    leverage:
      value.leverage === undefined
        ? undefined
        : normalizeNonNegativeInteger(value.leverage, "policy.executionIntent.leverage"),
  };
}

function normalizeAccountState(value: PolicyAccountState): PolicyAccountState {
  if (value.supportedModes.length === 0) {
    throw new SchemaValidationError("policy.accountState.supportedModes must not be empty.");
  }

  for (const mode of value.supportedModes) {
    if (mode !== "spot" && mode !== "perp") {
      throw new SchemaValidationError(
        "policy.accountState.supportedModes contains an invalid mode.",
      );
    }
  }

  return {
    supportedModes: [...value.supportedModes],
    maxTradableFraction: normalizeUnitFraction(
      value.maxTradableFraction,
      "policy.accountState.maxTradableFraction",
    ),
  };
}

function normalizeRequestedFraction(value: string, context: string): string {
  return ensureNonNegativeDecimalString(value, context);
}

function normalizeUnitFraction(value: string, context: string): string {
  const normalized = ensureNonNegativeDecimalString(value, context);
  if (compareDecimalStrings(normalized, "1") > 0) {
    throw new SchemaValidationError(`${context} must be <= 1.`);
  }
  return normalized;
}

function normalizeNonNegativeInteger(value: number, context: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new SchemaValidationError(`${context} must be a non-negative integer.`);
  }
  return value;
}

function clampFraction(
  currentValue: string,
  maxValue: string | null,
  clamps: PolicyClamp[],
  input: {
    readonly reason: string;
    readonly sourceField: "targetFraction";
  },
): string {
  if (maxValue === null) {
    return currentValue;
  }

  if (compareDecimalStrings(currentValue, maxValue) <= 0) {
    return currentValue;
  }

  clamps.push({
    field: input.sourceField,
    from: currentValue,
    to: maxValue,
    reason: input.reason,
  });
  return maxValue;
}

function readSuggestionId(result: TickRecommendationResult | null): string | null {
  if (result === null || result.kind !== "ok") {
    return null;
  }

  return result.recommendation.recommendationId;
}
