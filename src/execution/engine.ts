import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { extractBaseAsset } from "../chain/normalization";
import {
  DEFAULT_ORDER_STYLE,
  MAX_IOC_SAME_TICK_RETRIES,
  MIN_ORDER_NOTIONAL_USD,
} from "../config/constants";
import { compareDecimalStrings, normalizeDecimalString } from "../config/decimals";
import type { MarketMode } from "../config/market";
import { AUDIT_LOG_FILE_PATH } from "../config/paths";
import type {
  LocalPolicyDecision,
  PolicyHoldDecision,
  PolicyTargetPositionDecision,
  PolicyValueSource,
} from "../policy/engine";
import type { RuntimeState } from "../state/runtime-state";
import type { RecommendationDirection } from "../v4t";

export type ExecutionActionKind =
  | "no-trade"
  | "leverage-sync"
  | "place-order"
  | "cancel-order"
  | "close-position"
  | "dead-man-schedule"
  | "dead-man-clear";

export type ExecutionAction = {
  readonly kind: ExecutionActionKind;
  readonly detail: string;
  readonly exchangeId: string | null;
};

export type RetryMetadata = {
  readonly orderStyle: string;
  readonly maxAttempts: number;
  readonly attemptCount: number;
  readonly partialFill: boolean;
};

export type ReshapingMetadata = {
  readonly baselineTarget: {
    readonly side: RecommendationDirection;
    readonly targetFraction: string;
    readonly leverage: number;
  };
  readonly requestedTarget: {
    readonly side: RecommendationDirection;
    readonly targetFraction: string;
    readonly leverage: number;
  };
  readonly finalTarget: {
    readonly side: RecommendationDirection;
    readonly targetFraction: string;
    readonly leverage: number;
  };
  readonly sources: {
    readonly side: PolicyValueSource;
    readonly targetFraction: PolicyValueSource;
    readonly leverage: PolicyValueSource;
  };
};

export type ExecutionResult = {
  readonly slotId: string;
  readonly suggestionId: string | null;
  readonly marketId: string;
  readonly mode: MarketMode;
  readonly judgmentSummary: string;
  readonly actions: readonly ExecutionAction[];
  readonly skipped: boolean;
  readonly skipReason: string | null;
  readonly executedAt: string;
  readonly retryMetadata: RetryMetadata | null;
  readonly reshapingMetadata: ReshapingMetadata | null;
};

function getOrderFailureMessages(statuses: readonly unknown[]): readonly string[] {
  return statuses.flatMap((status) => {
    if (
      typeof status === "object" &&
      status !== null &&
      "error" in status &&
      typeof status.error === "string"
    ) {
      return [status.error];
    }

    return [];
  });
}

function buildOrderFailureDetail(messages: readonly string[]): string {
  if (messages.length === 0) {
    return "embedded exchange rejection";
  }

  return messages.join("; ");
}

/**
 * Injectable exchange operations. Every exchange mutation flows through these
 * functions so tests can fully mock the chain layer.
 */
export type ExecutionDeps = {
  readonly syncLeverage: (
    assetIndex: number,
    leverage: number,
    isCross: boolean,
  ) => Promise<{ success: boolean; exchangeId: string | null }>;

  readonly placeOrder: (params: {
    assetIndex: number;
    isBuy: boolean;
    price: string;
    size: string;
    reduceOnly: boolean;
    orderType: "gtc" | "ioc";
    clientOrderId?: string;
  }) => Promise<{ success: boolean; statuses: readonly unknown[] }>;

  readonly cancelOrder: (params: {
    assetIndex: number;
    orderId: number;
  }) => Promise<{ success: boolean }>;

  readonly scheduleDeadMan: (
    nowMs?: number,
  ) => Promise<{ scheduled: true; cancelTimeMs: number } | { scheduled: false; reason: string }>;

  readonly clearDeadMan?: () => Promise<void>;

  readonly getMidPrice: (coin: string) => Promise<string | null>;

  readonly getAccountEquity: () => Promise<string>;

  readonly getSizeDecimals: (coin: string) => Promise<number>;

  readonly getAssetIndex: (coin: string) => Promise<number>;

  readonly getPositionSize: (coin: string) => Promise<string>;

  readonly getOpenOrders: (coin: string) => Promise<readonly { oid: number; coin: string }[]>;

  /** Optional injectable audit writer. Defaults to the file-based appendAuditEntry. */
  readonly appendAuditEntry?: (entry: ExecutionAuditEntry) => Promise<void>;
};

export class ExecutionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExecutionError";
  }
}

export type ExecutionOrderStyle = "ioc" | "gtc";

export type ExecutionContext = {
  readonly orderStyle?: ExecutionOrderStyle;
};

function buildRpcFailureResult(
  decision: LocalPolicyDecision,
  executedAt: string,
  error: unknown,
): ExecutionResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    slotId: decision.slotId,
    suggestionId: decision.suggestionId,
    marketId: decision.marketId,
    mode: decision.mode,
    judgmentSummary: `RPC failure: ${message}`,
    actions: [],
    skipped: true,
    skipReason: "rpc-failure",
    executedAt,
    retryMetadata: null,
    reshapingMetadata: null,
  };
}

function buildReshapingMetadata(decision: PolicyTargetPositionDecision): ReshapingMetadata {
  return {
    baselineTarget: {
      side: decision.baselineTarget.side,
      targetFraction: decision.baselineTarget.targetFraction,
      leverage: decision.baselineTarget.leverage,
    },
    requestedTarget: {
      side: decision.requestedTarget.side,
      targetFraction: decision.requestedTarget.targetFraction,
      leverage: decision.requestedTarget.leverage,
    },
    finalTarget: {
      side: decision.target.side,
      targetFraction: decision.target.targetFraction,
      leverage: decision.target.leverage,
    },
    sources: {
      side: decision.sources.side,
      targetFraction: decision.sources.targetFraction,
      leverage: decision.sources.leverage,
    },
  };
}

export async function executeDecision(
  decision: LocalPolicyDecision,
  state: RuntimeState,
  deps: ExecutionDeps,
  now?: Date,
  context: ExecutionContext = {},
): Promise<ExecutionResult> {
  const executedAt = (now ?? new Date()).toISOString();
  const slotId = decision.slotId;

  if (decision.marketId !== state.market.marketId) {
    throw new ExecutionError(
      `Market mismatch: decision targets "${decision.marketId}" but runtime state is configured for "${state.market.marketId}".`,
    );
  }

  const writeAudit = deps.appendAuditEntry ?? ((e: ExecutionAuditEntry) => appendAuditEntry(e));

  if (state.lastExecutedSlot !== null && state.lastExecutedSlot === slotId) {
    const skippedResult: ExecutionResult = {
      slotId,
      suggestionId: decision.suggestionId,
      marketId: decision.marketId,
      mode: decision.mode,
      judgmentSummary: "Duplicate slot — already executed this tick.",
      actions: [],
      skipped: true,
      skipReason: "duplicate-slot",
      executedAt,
      retryMetadata: null,
      reshapingMetadata: null,
    };
    await writeAudit(buildAuditEntry(skippedResult));
    return skippedResult;
  }

  if (decision.kind === "hold") {
    try {
      const result = await executeHold(decision, deps, executedAt);
      await writeAudit(buildAuditEntry(result));
      return result;
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      const rpcResult = buildRpcFailureResult(decision, executedAt, error);
      await writeAudit(buildAuditEntry(rpcResult));
      return rpcResult;
    }
  }

  try {
    const result = await executeTargetPosition(decision, state, deps, executedAt, context);
    await writeAudit(buildAuditEntry(result));
    return result;
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    const rpcResult = buildRpcFailureResult(decision, executedAt, error);
    await writeAudit(buildAuditEntry(rpcResult));
    return rpcResult;
  }
}

async function executeHold(
  decision: PolicyHoldDecision,
  deps: ExecutionDeps,
  executedAt: string,
): Promise<ExecutionResult> {
  const actions: ExecutionAction[] = [];

  actions.push({
    kind: "no-trade",
    detail: `Hold: ${decision.holdReason} — ${decision.message}`,
    exchangeId: null,
  });

  await reconcileDeadManProtection(decision.marketId, deps, actions);

  return {
    slotId: decision.slotId,
    suggestionId: decision.suggestionId,
    marketId: decision.marketId,
    mode: decision.mode,
    judgmentSummary: `Hold: ${decision.holdReason}`,
    actions,
    skipped: false,
    skipReason: null,
    executedAt,
    retryMetadata: null,
    reshapingMetadata: null,
  };
}

async function executeTargetPosition(
  decision: PolicyTargetPositionDecision,
  _state: RuntimeState,
  deps: ExecutionDeps,
  executedAt: string,
  context: ExecutionContext,
): Promise<ExecutionResult> {
  const actions: ExecutionAction[] = [];
  const target = decision.target;
  const mode = decision.mode;
  const orderStyle = context.orderStyle ?? DEFAULT_ORDER_STYLE;
  const reshaping = buildReshapingMetadata(decision);

  if (target.side === "flat") {
    return executeFlatPosition(decision, deps, actions, executedAt);
  }

  const coin = extractCoinFromMarketId(decision.marketId);
  const baseAsset = extractBaseAsset(coin);
  const assetIndex = await deps.getAssetIndex(coin);

  const midPrice = await deps.getMidPrice(coin);
  if (midPrice === null) {
    actions.push({
      kind: "no-trade",
      detail: "No mid price available — cannot place order.",
      exchangeId: null,
    });

    await reconcileDeadManProtection(decision.marketId, deps, actions);

    return {
      slotId: decision.slotId,
      suggestionId: decision.suggestionId,
      marketId: decision.marketId,
      mode,
      judgmentSummary: "Target-position: no mid price available",
      actions,
      skipped: false,
      skipReason: null,
      executedAt,
      retryMetadata: null,
      reshapingMetadata: reshaping,
    };
  }

  const accountEquity = normalizeDecimalString(await deps.getAccountEquity());
  const sizeDecimals = await deps.getSizeDecimals(coin);
  const targetPositionAbs = computeOrderSize({
    accountEquity,
    targetFraction: target.targetFraction,
    midPrice,
    sizeDecimals,
  });
  const currentPosition = normalizeSignedDecimalString(await deps.getPositionSize(baseAsset));
  const targetPosition = buildSignedTargetPosition(targetPositionAbs, target.side);
  const delta = subtractSignedDecimalStrings(targetPosition, currentPosition);

  if (isZeroSignedDecimalString(delta)) {
    actions.push({
      kind: "no-trade",
      detail: `Current position ${currentPosition} already matches target ${targetPosition} — delta normalized to zero.`,
      exchangeId: null,
    });

    await reconcileDeadManProtection(decision.marketId, deps, actions);

    return {
      slotId: decision.slotId,
      suggestionId: decision.suggestionId,
      marketId: decision.marketId,
      mode,
      judgmentSummary: "Target-position: delta is zero",
      actions,
      skipped: false,
      skipReason: null,
      executedAt,
      retryMetadata: null,
      reshapingMetadata: reshaping,
    };
  }

  let openingReferencePosition = currentPosition;
  if (isOppositeDirection(currentPosition, targetPosition)) {
    const closeMaxAttempts = 1 + MAX_IOC_SAME_TICK_RETRIES;
    let closePosition = currentPosition;
    let closeMidPrice = midPrice;
    let lastCloseSucceeded = false;

    for (let closeAttempt = 0; closeAttempt < closeMaxAttempts; closeAttempt++) {
      if (isZeroSignedDecimalString(closePosition)) {
        break;
      }

      const closeClientOrderId =
        closeAttempt === 0
          ? `oc-${decision.slotId}-close`
          : `oc-${decision.slotId}-close-r${closeAttempt}`;

      lastCloseSucceeded = await placeAndRecordOrder({
        deps,
        actions,
        actionKind: "close-position",
        assetIndex,
        isBuy: readSignedDecimalSign(closePosition) < 0,
        price: closeMidPrice,
        size: absoluteSignedDecimalString(closePosition),
        reduceOnly: true,
        clientOrderId: closeClientOrderId,
        orderStyle: "ioc",
        detail: `Close ${closePosition} ${baseAsset} @ ${closeMidPrice} (reduce-only IOC${closeAttempt > 0 ? ` retry ${closeAttempt}/${MAX_IOC_SAME_TICK_RETRIES}` : ""})`,
      });

      if (!lastCloseSucceeded) {
        break;
      }

      const refreshedClosePosition = normalizeSignedDecimalString(
        await deps.getPositionSize(baseAsset),
      );

      if (isZeroSignedDecimalString(refreshedClosePosition)) {
        closePosition = refreshedClosePosition;
        break;
      }

      // No progress — partial fill did not reduce position at all
      if (
        isZeroSignedDecimalString(
          subtractSignedDecimalStrings(closePosition, refreshedClosePosition),
        )
      ) {
        closePosition = refreshedClosePosition;
        break;
      }

      if (closeAttempt < closeMaxAttempts - 1) {
        const refreshedCloseMidPrice = await deps.getMidPrice(coin);
        if (refreshedCloseMidPrice === null) {
          actions.push({
            kind: "no-trade",
            detail: `IOC close retry ${closeAttempt + 2}/${closeMaxAttempts} aborted: no mid price available after partial fill.`,
            exchangeId: null,
          });
          closePosition = refreshedClosePosition;
          break;
        }
        closeMidPrice = refreshedCloseMidPrice;
        closePosition = refreshedClosePosition;
      } else {
        closePosition = refreshedClosePosition;
      }
    }

    if (!lastCloseSucceeded) {
      await reconcileDeadManProtection(decision.marketId, deps, actions);
      return {
        slotId: decision.slotId,
        suggestionId: decision.suggestionId,
        marketId: decision.marketId,
        mode,
        judgmentSummary: "Target-position failed: reversal close rejected",
        actions,
        skipped: true,
        skipReason: "order-rejected",
        executedAt,
        retryMetadata: null,
        reshapingMetadata: reshaping,
      };
    }

    if (!isZeroSignedDecimalString(closePosition)) {
      actions.push({
        kind: "no-trade",
        detail: `Reversal close left residual position ${closePosition} ${baseAsset} — aborting ${target.side} reopen.`,
        exchangeId: null,
      });
      await reconcileDeadManProtection(decision.marketId, deps, actions);
      return {
        slotId: decision.slotId,
        suggestionId: decision.suggestionId,
        marketId: decision.marketId,
        mode,
        judgmentSummary: "Target-position failed: reversal did not flatten",
        actions,
        skipped: true,
        skipReason: "position-not-flat",
        executedAt,
        retryMetadata: null,
        reshapingMetadata: reshaping,
      };
    }

    openingReferencePosition = closePosition;
  }

  if (mode === "perp" && target.leverage > 0) {
    const leverageResult = await deps.syncLeverage(assetIndex, target.leverage, false);
    actions.push({
      kind: "leverage-sync",
      detail: `Set leverage to ${target.leverage}x (isolated) — success=${leverageResult.success}`,
      exchangeId: leverageResult.exchangeId,
    });

    if (!leverageResult.success) {
      await reconcileDeadManProtection(decision.marketId, deps, actions);
      return {
        slotId: decision.slotId,
        suggestionId: decision.suggestionId,
        marketId: decision.marketId,
        mode,
        judgmentSummary: `Target-position failed: leverage sync to ${target.leverage}x rejected`,
        actions,
        skipped: true,
        skipReason: "leverage-sync-failed",
        executedAt,
        retryMetadata: null,
        reshapingMetadata: reshaping,
      };
    }
  }

  const initialRemainingDelta = subtractSignedDecimalStrings(
    targetPosition,
    openingReferencePosition,
  );
  if (isZeroSignedDecimalString(initialRemainingDelta)) {
    actions.push({
      kind: "no-trade",
      detail: `Target ${targetPosition} reached after reconciliation — no additional order needed.`,
      exchangeId: null,
    });
    await reconcileDeadManProtection(decision.marketId, deps, actions);
    return {
      slotId: decision.slotId,
      suggestionId: decision.suggestionId,
      marketId: decision.marketId,
      mode,
      judgmentSummary: "Target-position: delta is zero",
      actions,
      skipped: false,
      skipReason: null,
      executedAt,
      retryMetadata: null,
      reshapingMetadata: reshaping,
    };
  }

  const maxAttempts = orderStyle === "ioc" ? 1 + MAX_IOC_SAME_TICK_RETRIES : 1;
  let retryMidPrice = midPrice;
  let retryPosition = openingReferencePosition;
  let lastOrderSucceeded = false;
  let attemptCount = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const remainingDelta = subtractSignedDecimalStrings(targetPosition, retryPosition);

    if (isZeroSignedDecimalString(remainingDelta)) {
      break;
    }

    if (attempt > 0) {
      const remainingNotional = computeNotionalUsd(
        absoluteSignedDecimalString(remainingDelta),
        retryMidPrice,
      );
      if (compareDecimalStrings(remainingNotional, String(MIN_ORDER_NOTIONAL_USD)) < 0) {
        actions.push({
          kind: "no-trade",
          detail: `IOC retry ${attempt + 1}/${maxAttempts} skipped: remaining notional $${remainingNotional} below minimum $${MIN_ORDER_NOTIONAL_USD}.`,
          exchangeId: null,
        });
        break;
      }
    }

    attemptCount = attempt + 1;
    const clientOrderId =
      attempt === 0
        ? `oc-${decision.slotId}-${target.side}`
        : `oc-${decision.slotId}-${target.side}-r${attempt}`;

    lastOrderSucceeded = await placeAndRecordOrder({
      deps,
      actions,
      actionKind: "place-order",
      assetIndex,
      isBuy: readSignedDecimalSign(remainingDelta) > 0,
      price: retryMidPrice,
      size: absoluteSignedDecimalString(remainingDelta),
      reduceOnly: false,
      clientOrderId,
      orderStyle,
      detail: `${readSignedDecimalSign(remainingDelta) > 0 ? "Buy" : "Sell"} ${absoluteSignedDecimalString(remainingDelta)} @ ${retryMidPrice} (${orderStyle.toUpperCase()}${attempt > 0 ? ` retry ${attempt}/${MAX_IOC_SAME_TICK_RETRIES}` : ""})`,
    });

    if (!lastOrderSucceeded) {
      break;
    }

    if (orderStyle === "ioc" && attempt < maxAttempts - 1) {
      const refreshedPosition = normalizeSignedDecimalString(await deps.getPositionSize(baseAsset));
      const refreshedDelta = subtractSignedDecimalStrings(targetPosition, refreshedPosition);

      if (isZeroSignedDecimalString(refreshedDelta)) {
        retryPosition = refreshedPosition;
        break;
      }

      if (
        isZeroSignedDecimalString(subtractSignedDecimalStrings(retryPosition, refreshedPosition))
      ) {
        break;
      }

      const refreshedMidPrice = await deps.getMidPrice(coin);
      if (refreshedMidPrice === null) {
        actions.push({
          kind: "no-trade",
          detail: `IOC retry ${attempt + 2}/${maxAttempts} aborted: no mid price available after partial fill.`,
          exchangeId: null,
        });
        break;
      }

      retryMidPrice = refreshedMidPrice;
      retryPosition = refreshedPosition;
    }
  }

  await reconcileDeadManProtection(decision.marketId, deps, actions);

  const partialFill = !isZeroSignedDecimalString(
    subtractSignedDecimalStrings(retryPosition, openingReferencePosition),
  );
  const retryMeta: RetryMetadata = {
    orderStyle,
    maxAttempts,
    attemptCount,
    partialFill,
  };

  if (!lastOrderSucceeded && attemptCount > 0) {
    return {
      slotId: decision.slotId,
      suggestionId: decision.suggestionId,
      marketId: decision.marketId,
      mode,
      judgmentSummary: `Target-position failed: ${target.side} order rejected`,
      actions,
      skipped: true,
      skipReason: "order-rejected",
      executedAt,
      retryMetadata: retryMeta,
      reshapingMetadata: reshaping,
    };
  }

  return {
    slotId: decision.slotId,
    suggestionId: decision.suggestionId,
    marketId: decision.marketId,
    mode,
    judgmentSummary: `Target-position: ${target.side} ${target.targetFraction} @ ${target.leverage}x`,
    actions,
    skipped: false,
    skipReason: null,
    executedAt,
    retryMetadata: retryMeta,
    reshapingMetadata: reshaping,
  };
}

async function executeFlatPosition(
  decision: PolicyTargetPositionDecision,
  deps: ExecutionDeps,
  actions: ExecutionAction[],
  executedAt: string,
): Promise<ExecutionResult> {
  const coin = extractCoinFromMarketId(decision.marketId);
  const baseAsset = extractBaseAsset(coin);
  const assetIndex = await deps.getAssetIndex(coin);

  const openOrders = await deps.getOpenOrders(coin);
  for (const order of openOrders) {
    const cancelResult = await deps.cancelOrder({
      assetIndex,
      orderId: order.oid,
    });
    actions.push({
      kind: "cancel-order",
      detail: `Cancel order ${order.oid} for ${coin} — success=${cancelResult.success}`,
      exchangeId: String(order.oid),
    });
  }

  const positionSize = await deps.getPositionSize(baseAsset);
  const normalizedPosition = normalizeSignedDecimalString(positionSize);
  const positionAbs = absoluteSignedDecimalString(normalizedPosition);
  const hasPosition = !isZeroSignedDecimalString(normalizedPosition);

  if (hasPosition) {
    const isCurrentlyLong = readSignedDecimalSign(normalizedPosition) > 0;
    const midPrice = await deps.getMidPrice(coin);

    if (midPrice !== null) {
      const closeSuccess = await placeAndRecordOrder({
        deps,
        actions,
        actionKind: "close-position",
        assetIndex,
        isBuy: !isCurrentlyLong,
        price: midPrice,
        size: positionAbs,
        reduceOnly: true,
        clientOrderId: `oc-${decision.slotId}-close`,
        orderStyle: DEFAULT_ORDER_STYLE,
        detail: `Close ${normalizedPosition} ${baseAsset} @ ${midPrice} (reduce-only ${DEFAULT_ORDER_STYLE.toUpperCase()})`,
      });

      if (!closeSuccess) {
        await reconcileDeadManProtection(decision.marketId, deps, actions);

        return {
          slotId: decision.slotId,
          suggestionId: decision.suggestionId,
          marketId: decision.marketId,
          mode: decision.mode,
          judgmentSummary: "Target-position failed: flat close rejected",
          actions,
          skipped: true,
          skipReason: "order-rejected",
          executedAt,
          retryMetadata: null,
          reshapingMetadata: buildReshapingMetadata(decision),
        };
      }
    } else {
      actions.push({
        kind: "no-trade",
        detail: `Position ${positionSize} ${baseAsset} exists but no mid price — cannot close.`,
        exchangeId: null,
      });
    }
  } else if (openOrders.length === 0) {
    actions.push({
      kind: "no-trade",
      detail: "Flat target with no open orders and no position — no action needed.",
      exchangeId: null,
    });
  }

  await reconcileDeadManProtection(decision.marketId, deps, actions);

  return {
    slotId: decision.slotId,
    suggestionId: decision.suggestionId,
    marketId: decision.marketId,
    mode: decision.mode,
    judgmentSummary: "Target-position: flat (close/no-trade)",
    actions,
    skipped: false,
    skipReason: null,
    executedAt,
    retryMetadata: null,
    reshapingMetadata: buildReshapingMetadata(decision),
  };
}

/** perp "perps:hyperliquid:ETH" → "ETH"; spot "spot:hyperliquid:ETH/USDC" → "ETH/USDC" */
function extractCoinFromMarketId(marketId: string): string {
  const parts = marketId.split(":");
  const suffix = parts.at(-1);
  if (!suffix) {
    throw new ExecutionError(`Cannot extract coin from marketId: ${marketId}`);
  }
  return suffix;
}

function computeOrderSize(params: {
  accountEquity: string;
  targetFraction: string;
  midPrice: string;
  sizeDecimals: number;
}): string {
  const accountEquity = normalizeDecimalString(params.accountEquity);
  const targetFraction = normalizeDecimalString(params.targetFraction);
  const midPrice = normalizeDecimalString(params.midPrice);

  if (
    compareDecimalStrings(accountEquity, "0") === 0 ||
    compareDecimalStrings(targetFraction, "0") === 0 ||
    compareDecimalStrings(midPrice, "0") === 0
  ) {
    return "0";
  }

  if (!Number.isInteger(params.sizeDecimals) || params.sizeDecimals < 0) {
    throw new ExecutionError(`Invalid size decimal precision: ${params.sizeDecimals}`);
  }

  const equity = parseDecimalToScaledInteger(accountEquity);
  const fraction = parseDecimalToScaledInteger(targetFraction);
  const price = parseDecimalToScaledInteger(midPrice);

  const numerator =
    equity.integer * fraction.integer * 10n ** BigInt(price.scale + params.sizeDecimals);
  const denominator = price.integer * 10n ** BigInt(equity.scale + fraction.scale);
  const truncatedScaledSize = numerator / denominator;

  return formatScaledNonNegativeDecimal(truncatedScaledSize, params.sizeDecimals);
}

function computeNotionalUsd(size: string, price: string): string {
  const sizeScaled = parseDecimalToScaledInteger(normalizeDecimalString(size));
  const priceScaled = parseDecimalToScaledInteger(normalizeDecimalString(price));
  const product = sizeScaled.integer * priceScaled.integer;
  const totalScale = sizeScaled.scale + priceScaled.scale;
  return formatScaledNonNegativeDecimal(product, totalScale);
}

function normalizeSignedDecimalString(value: string): string {
  if (value.startsWith("-")) {
    const normalizedMagnitude = normalizeDecimalString(value.slice(1));
    return compareDecimalStrings(normalizedMagnitude, "0") === 0 ? "0" : `-${normalizedMagnitude}`;
  }

  return normalizeDecimalString(value);
}

function parseDecimalToScaledInteger(value: string): { integer: bigint; scale: number } {
  const normalized = normalizeDecimalString(value);
  const [integerPart, fractionalPart = ""] = normalized.split(".");
  return {
    integer: BigInt(`${integerPart}${fractionalPart}`),
    scale: fractionalPart.length,
  };
}

function formatScaledNonNegativeDecimal(value: bigint, scale: number): string {
  if (scale === 0) {
    return normalizeDecimalString(value.toString());
  }

  const raw = value.toString().padStart(scale + 1, "0");
  const integerPart = raw.slice(0, -scale) || "0";
  const fractionalPart = raw.slice(-scale);
  return normalizeDecimalString(`${integerPart}.${fractionalPart}`);
}

function parseSignedDecimalToScaledInteger(value: string): { integer: bigint; scale: number } {
  const normalized = normalizeSignedDecimalString(value);
  const sign = normalized.startsWith("-") ? -1n : 1n;
  const unsigned = normalized.startsWith("-") ? normalized.slice(1) : normalized;
  const parsed = parseDecimalToScaledInteger(unsigned);
  return {
    integer: parsed.integer * sign,
    scale: parsed.scale,
  };
}

function formatScaledDecimal(value: bigint, scale: number): string {
  if (scale === 0) {
    return normalizeSignedDecimalString(value.toString());
  }

  const sign = value < 0n ? "-" : "";
  const absoluteValue = value < 0n ? value * -1n : value;
  const raw = absoluteValue.toString().padStart(scale + 1, "0");
  const integerPart = raw.slice(0, -scale) || "0";
  const fractionalPart = raw.slice(-scale);
  return normalizeSignedDecimalString(`${sign}${integerPart}.${fractionalPart}`);
}

function subtractSignedDecimalStrings(left: string, right: string): string {
  const normalizedLeft = normalizeSignedDecimalString(left);
  const normalizedRight = normalizeSignedDecimalString(right);
  const leftScale = normalizedLeft.startsWith("-")
    ? (normalizedLeft.slice(1).split(".")[1]?.length ?? 0)
    : (normalizedLeft.split(".")[1]?.length ?? 0);
  const rightScale = normalizedRight.startsWith("-")
    ? (normalizedRight.slice(1).split(".")[1]?.length ?? 0)
    : (normalizedRight.split(".")[1]?.length ?? 0);
  const targetScale = Math.max(leftScale, rightScale);
  const scaledLeft = scaleSignedDecimal(normalizedLeft, targetScale);
  const scaledRight = scaleSignedDecimal(normalizedRight, targetScale);
  return formatScaledDecimal(scaledLeft - scaledRight, targetScale);
}

function scaleSignedDecimal(value: string, targetScale: number): bigint {
  const parsed = parseSignedDecimalToScaledInteger(value);
  const scaleDelta = targetScale - parsed.scale;
  if (scaleDelta < 0) {
    throw new ExecutionError(`Cannot scale decimal ${value} to smaller precision ${targetScale}.`);
  }
  return parsed.integer * 10n ** BigInt(scaleDelta);
}

function readSignedDecimalSign(value: string): -1 | 0 | 1 {
  const normalized = normalizeSignedDecimalString(value);
  if (normalized === "0") {
    return 0;
  }
  return normalized.startsWith("-") ? -1 : 1;
}

function isZeroSignedDecimalString(value: string): boolean {
  return readSignedDecimalSign(value) === 0;
}

function absoluteSignedDecimalString(value: string): string {
  const normalized = normalizeSignedDecimalString(value);
  return normalized.startsWith("-") ? normalized.slice(1) : normalized;
}

function buildSignedTargetPosition(size: string, side: "long" | "short"): string {
  if (compareDecimalStrings(size, "0") === 0) {
    return "0";
  }
  return side === "long" ? size : `-${size}`;
}

function isOppositeDirection(currentPosition: string, targetPosition: string): boolean {
  const currentSign = readSignedDecimalSign(currentPosition);
  const targetSign = readSignedDecimalSign(targetPosition);
  return currentSign !== 0 && targetSign !== 0 && currentSign !== targetSign;
}

async function placeAndRecordOrder(params: {
  deps: ExecutionDeps;
  actions: ExecutionAction[];
  actionKind: "place-order" | "close-position";
  assetIndex: number;
  isBuy: boolean;
  price: string;
  size: string;
  reduceOnly: boolean;
  clientOrderId: string;
  orderStyle: ExecutionOrderStyle;
  detail: string;
}): Promise<boolean> {
  const orderResult = await params.deps.placeOrder({
    assetIndex: params.assetIndex,
    isBuy: params.isBuy,
    price: params.price,
    size: params.size,
    reduceOnly: params.reduceOnly,
    orderType: params.orderStyle,
    clientOrderId: params.clientOrderId,
  });

  const orderExchangeId =
    orderResult.statuses.length > 0 ? JSON.stringify(orderResult.statuses[0]) : null;
  const orderFailureDetail = buildOrderFailureDetail(getOrderFailureMessages(orderResult.statuses));

  params.actions.push({
    kind: params.actionKind,
    detail: `${params.detail} — success=${orderResult.success}${orderResult.success ? "" : ` — failure=${orderFailureDetail}`}`,
    exchangeId: orderExchangeId,
  });

  return orderResult.success;
}

async function reconcileDeadManProtection(
  marketId: string,
  deps: ExecutionDeps,
  actions: ExecutionAction[],
): Promise<void> {
  const coin = extractCoinFromMarketId(marketId);
  const baseAsset = extractBaseAsset(coin);
  const openOrders = await deps.getOpenOrders(coin);
  const positionSize = normalizeSignedDecimalString(await deps.getPositionSize(baseAsset));
  const hasPosition = !isZeroSignedDecimalString(positionSize);

  if (openOrders.length > 0 || hasPosition) {
    const deadMan = await deps.scheduleDeadMan();
    actions.push({
      kind: "dead-man-schedule",
      detail: deadMan.scheduled
        ? `Dead-man scheduled at ${deadMan.cancelTimeMs}`
        : `Dead-man failed: ${deadMan.reason}`,
      exchangeId: null,
    });
    return;
  }

  if (deps.clearDeadMan !== undefined) {
    await deps.clearDeadMan();
    actions.push({
      kind: "dead-man-clear",
      detail: "Dead-man cleared — flat with no pending orders.",
      exchangeId: null,
    });
  }
}

export type ExecutionAuditEntry = {
  readonly slotId: string;
  readonly suggestionId: string | null;
  readonly marketId: string;
  readonly mode: MarketMode;
  readonly judgmentSummary: string;
  readonly actions: readonly ExecutionAction[];
  readonly exchangeIds: readonly (string | null)[];
  readonly skipped: boolean;
  readonly skipReason: string | null;
  readonly executedAt: string;
  readonly retryMetadata: RetryMetadata | null;
  readonly reshapingMetadata: ReshapingMetadata | null;
};

export function buildAuditEntry(result: ExecutionResult): ExecutionAuditEntry {
  return {
    slotId: result.slotId,
    suggestionId: result.suggestionId,
    marketId: result.marketId,
    mode: result.mode,
    judgmentSummary: result.judgmentSummary,
    actions: result.actions,
    exchangeIds: result.actions.map((a) => a.exchangeId),
    skipped: result.skipped,
    skipReason: result.skipReason,
    executedAt: result.executedAt,
    retryMetadata: result.retryMetadata,
    reshapingMetadata: result.reshapingMetadata,
  };
}

export async function appendAuditEntry(
  entry: ExecutionAuditEntry,
  filePath: string = AUDIT_LOG_FILE_PATH,
): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf-8", mode: 0o600 });
  } catch (error) {
    console.error(
      `appendAuditEntry: failed to write audit log — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
