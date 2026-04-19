import { buildOptionId } from "../config/agent-md";
import type { AgentMdTradingOptionsCatalog } from "../config/agent-md";
import {
  ALLOWED_ORDER_STYLES,
  DEAD_MANS_SWITCH_SECONDS,
  DEFAULT_ORDER_STYLE,
} from "../config/constants";
import { SchemaValidationError } from "../config/validation";
import type { CollateralPrepResult } from "../onboarding";
import type { AgentMdCacheState, RuntimeState, TradingSelection } from "../state";
import { parseTickSlotUtc, slotIdFromDate } from "../state";
import type { TickRecommendationRequest } from "../v4t";
import type { ReconcileRuntimeStateResult } from "./reconcile";
import type {
  AllowedOrderStyle,
  CancelOrderEntry,
  CancelOutstandingOrdersResult,
  DaemonTickResult,
  ExecuteTickInput,
  ExecuteTickIntent,
  ExecuteTickIntentAction,
  NormalizedExecuteTickInput,
  SelectionResolution,
} from "./types";

export function createNoopReconciliation(state: RuntimeState): ReconcileRuntimeStateResult {
  return {
    state,
    driftDetected: false,
    rpcFailed: false,
    previousActivity: state.exchangeActivity,
    nextActivity: state.exchangeActivity,
  };
}

export function mergeRuntimeStateForReconciliation(
  lockedState: RuntimeState,
  reconciledState: RuntimeState,
): RuntimeState {
  // Compare by transfer IDs rather than array length: concurrent add+remove
  // between read and write would make a length check pick the wrong source.
  const lockedIds = new Set(lockedState.bridgeHistory.map((h) => h.transferId));
  const reconciledIds = new Set(reconciledState.bridgeHistory.map((h) => h.transferId));
  const lockedHasExtra = [...lockedIds].some((id) => !reconciledIds.has(id));
  const reconciledHasExtra = [...reconciledIds].some((id) => !lockedIds.has(id));

  // Prefer locked only when it has entries reconciled lacks and reconciled
  // has nothing new (concurrent confirmation while tick was in flight).
  const useLocked = lockedHasExtra && !reconciledHasExtra;
  return {
    ...lockedState,
    cumulativeBridgeUsd: useLocked
      ? lockedState.cumulativeBridgeUsd
      : reconciledState.cumulativeBridgeUsd,
    bridgeHistory: useLocked ? lockedState.bridgeHistory : reconciledState.bridgeHistory,
    pendingBridgeTransfers: useLocked
      ? lockedState.pendingBridgeTransfers
      : reconciledState.pendingBridgeTransfers,
    exchangeActivity: reconciledState.exchangeActivity,
  };
}

export async function cancelOrdersWithPartialFailure(
  orders: readonly CancelOrderEntry[],
  cancelOne: (order: CancelOrderEntry) => Promise<void>,
): Promise<Pick<CancelOutstandingOrdersResult, "cancelledCount" | "hadFailures">> {
  let cancelledCount = 0;
  const errors: Array<{ orderId: number; coin: string; error: unknown }> = [];
  for (const order of orders) {
    try {
      await cancelOne(order);
      cancelledCount += 1;
    } catch (error) {
      errors.push({ orderId: order.oid, coin: order.coin, error });
    }
  }
  if (errors.length > 0) {
    const details = errors
      .map(
        (e) =>
          `order ${e.orderId} (${e.coin}): ${e.error instanceof Error ? e.error.message : String(e.error)}`,
      )
      .join("; ");
    console.warn(
      `cancelOutstandingOrders: ${cancelledCount} succeeded, ${errors.length} failed — ${details}`,
    );
  }
  return {
    cancelledCount,
    hadFailures: errors.length > 0,
  };
}

export function isSlotAlreadyConsumed(state: RuntimeState, slotId: string): boolean {
  return state.lastExecutedSlot === slotId || state.executingSlot === slotId;
}

export function isDeadManSwitchExpired(lastExecutedSlot: string | null, now: Date): boolean {
  if (lastExecutedSlot === null) {
    return true;
  }
  const slotTime = new Date(lastExecutedSlot).getTime();
  return now.getTime() - slotTime > DEAD_MANS_SWITCH_SECONDS * 1000;
}

export function deriveCollateralPrepStatus(
  collateralResult: CollateralPrepResult | null,
): "pending" | "failed" | null {
  if (collateralResult === null) {
    return null;
  }
  if (collateralResult.kind === "failed") {
    return "failed";
  }
  if (collateralResult.kind === "prepared" || collateralResult.kind === "skipped_spot") {
    return null;
  }
  // skipped_no_balance: bridge confirmed but nothing arrived yet — treat as pending
  return "pending";
}

export function normalizeCancelOutstandingOrdersResult(
  result: CancelOutstandingOrdersResult | number,
): CancelOutstandingOrdersResult {
  if (typeof result === "number") {
    return {
      cancelledCount: result,
      hadFailures: false,
      confirmedNoPendingOrders: result > 0,
    };
  }

  return result;
}

export { toErrorMessage } from "./errors";

export function normalizeExecuteTickInput(
  input: ExecuteTickInput,
  now: Date,
): NormalizedExecuteTickInput {
  const orderStyle = readAllowedOrderStyle(input.intent?.orderStyle);
  const action = readExecuteTickIntentAction(input.intent);
  validateExecuteTickIntentShape(input.intent, action);
  return {
    slotId: input.slotId === undefined ? slotIdFromDate(now) : parseTickSlotUtc(input.slotId),
    userPreferences: undefined,
    priorInteractionSummary:
      input.intent === undefined
        ? undefined
        : {
            sideOverride: null,
            targetFractionOverride:
              action === "target-position" ? (input.intent.targetFraction ?? null) : null,
            leverageOverride: action === "target-position" ? (input.intent.leverage ?? null) : null,
            acceptOverridePhrase: false,
          },
    executionIntent:
      action === undefined
        ? undefined
        : {
            action,
            rationale: input.intent?.rationale ?? "",
            ...(action === "target-position"
              ? {
                  side: input.intent?.side,
                  targetFraction: input.intent?.targetFraction,
                  leverage: input.intent?.leverage,
                }
              : {}),
          },
    executionContext: {
      orderStyle,
    },
  };
}

function readExecuteTickIntentAction(
  intent: ExecuteTickIntent | undefined,
): ExecuteTickIntentAction | undefined {
  if (intent === undefined) {
    return undefined;
  }

  if (intent.action !== "hold" && intent.action !== "target-position") {
    throw new SchemaValidationError(
      "execute_tick.intent.action must be one of: hold, target-position.",
    );
  }

  return intent.action;
}

function validateExecuteTickIntentShape(
  intent: ExecuteTickIntent | undefined,
  action: ExecuteTickIntentAction | undefined,
): void {
  if (intent === undefined) {
    return;
  }

  if (typeof intent.rationale !== "string" || intent.rationale.trim().length === 0) {
    throw new SchemaValidationError("execute_tick.intent.rationale must be a non-empty string.");
  }

  if (action !== "hold") {
    return;
  }

  const unsupportedFields = ["side", "targetFraction", "leverage"] as const;
  for (const field of unsupportedFields) {
    if (intent[field] !== undefined) {
      throw new SchemaValidationError(
        `execute_tick.intent.${field} is only supported when intent.action is "target-position".`,
      );
    }
  }
}

function readAllowedOrderStyle(orderStyle: string | undefined): AllowedOrderStyle {
  if (orderStyle === undefined) {
    return DEFAULT_ORDER_STYLE;
  }

  if (!ALLOWED_ORDER_STYLES.includes(orderStyle as AllowedOrderStyle)) {
    throw new SchemaValidationError(
      `execute_tick.intent.orderStyle must be one of: ${ALLOWED_ORDER_STYLES.join(", ")}.`,
    );
  }

  return orderStyle as AllowedOrderStyle;
}

export function buildSuggestionRequest(
  state: RuntimeState,
  selectionResolution: SelectionResolution,
): TickRecommendationRequest | null {
  if (state.vibe4tradingToken === null || selectionResolution.validation.status !== "validated") {
    return null;
  }

  const selection = selectionResolution.selection;
  if (selection === null) {
    return null;
  }

  return {
    apiToken: state.vibe4tradingToken,
    marketId: selection.market.marketId,
    modelKey: selection.modelKey,
    strategyKey: selection.strategyProfile,
  };
}

export function resolveSelectionValidation(
  state: RuntimeState,
  cache: AgentMdCacheState | null,
): SelectionResolution {
  const selection = state.tradingSelection;
  if (selection === null) {
    return {
      selection: null,
      validation: {
        status: "missing",
        reason: "No persisted trading selection is configured.",
      },
    };
  }

  if (
    selection.market.marketId !== state.market.marketId ||
    selection.market.mode !== state.market.mode ||
    selection.market.symbol !== state.market.symbol ||
    selection.market.venue !== state.market.venue
  ) {
    return {
      selection,
      validation: {
        status: "option-mismatch",
        reason:
          "Persisted tradingSelection.market does not match the runtime single-market configuration.",
      },
    };
  }

  if (cache?.tradingOptions === null || cache?.tradingOptions === undefined) {
    return {
      selection,
      validation: {
        status: "agent-md-unavailable",
        reason: "agents.md trading options cache is unavailable for selection validation.",
      },
    };
  }

  const catalog = cache.tradingOptions;
  const missingAxis = findMissingSelectionAxis(selection, catalog);
  if (missingAxis !== null) {
    return {
      selection,
      validation: {
        status: "option-not-found",
        reason: missingAxis,
      },
    };
  }

  const expectedOptionId = buildOptionId({
    pair: selection.market.symbol,
    strategy: selection.strategyProfile,
    model: selection.modelKey,
  });
  if (selection.optionId !== expectedOptionId) {
    return {
      selection,
      validation: {
        status: "option-mismatch",
        reason: `Persisted tradingSelection.optionId \"${selection.optionId}\" does not match its component fields (expected \"${expectedOptionId}\").`,
      },
    };
  }

  return {
    selection,
    validation: {
      status: "validated",
      reason: null,
    },
  };
}

function findMissingSelectionAxis(
  selection: TradingSelection,
  catalog: AgentMdTradingOptionsCatalog,
): string | null {
  if (!catalog.pairs.some((entry) => entry.symbol === selection.market.symbol)) {
    return `Persisted tradingSelection pair \"${selection.market.symbol}\" is not present in agents.md trading options.`;
  }
  if (!catalog.strategies.includes(selection.strategyProfile)) {
    return `Persisted tradingSelection strategy \"${selection.strategyProfile}\" is not present in agents.md trading options.`;
  }
  if (!catalog.models.includes(selection.modelKey)) {
    return `Persisted tradingSelection model \"${selection.modelKey}\" is not present in agents.md trading options.`;
  }
  return null;
}
