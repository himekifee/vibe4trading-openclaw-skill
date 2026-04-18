import { normalizeDecimalString } from "../config/decimals";
import type { ExchangeActivityState, RuntimeState } from "../state";

export type ReconcileDeps = {
  readonly readPerpPositions: (
    walletAddress: string,
  ) => Promise<readonly { coin: string; size: string }[]>;
  readonly readSpotBalances: (
    walletAddress: string,
  ) => Promise<readonly { coin: string; total: string; hold: string }[]>;
  readonly readOpenOrders: (
    walletAddress: string,
  ) => Promise<readonly { coin: string; oid: number }[]>;
};

export type ReconcileRuntimeStateResult = {
  readonly state: RuntimeState;
  readonly driftDetected: boolean;
  readonly rpcFailed: boolean;
  readonly previousActivity: ExchangeActivityState;
  readonly nextActivity: ExchangeActivityState;
};

export async function reconcileRuntimeState(
  state: RuntimeState,
  deps: ReconcileDeps,
): Promise<ReconcileRuntimeStateResult> {
  let perpPositions: readonly { coin: string; size: string }[];
  let spotBalances: readonly { coin: string; total: string; hold: string }[];
  let openOrders: readonly { coin: string; oid: number }[];

  try {
    [perpPositions, spotBalances, openOrders] = await Promise.all([
      deps.readPerpPositions(state.wallet.address),
      deps.readSpotBalances(state.wallet.address),
      deps.readOpenOrders(state.wallet.address),
    ]);
  } catch (error) {
    // RPC failure: signal callers to hold rather than trading on stale state.
    console.warn(
      `reconcileRuntimeState: RPC failure — ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      state,
      driftDetected: false,
      rpcFailed: true,
      previousActivity: state.exchangeActivity,
      nextActivity: state.exchangeActivity,
    };
  }

  const nextActivity: ExchangeActivityState = {
    hasOpenPosition: detectLivePosition(state, perpPositions, spotBalances),
    hasPendingOrder: openOrders.length > 0,
  };

  const driftDetected =
    state.exchangeActivity.hasOpenPosition !== nextActivity.hasOpenPosition ||
    state.exchangeActivity.hasPendingOrder !== nextActivity.hasPendingOrder;

  return {
    state: driftDetected
      ? {
          ...state,
          exchangeActivity: nextActivity,
        }
      : state,
    driftDetected,
    rpcFailed: false,
    previousActivity: state.exchangeActivity,
    nextActivity,
  };
}

function detectLivePosition(
  state: RuntimeState,
  perpPositions: readonly { coin: string; size: string }[],
  spotBalances: readonly { coin: string; total: string; hold: string }[],
): boolean {
  if (state.market.mode === "perp") {
    const configuredCoin = state.market.symbol;
    const position = perpPositions.find((entry) => entry.coin === configuredCoin);
    return position !== undefined && isNonZeroQuantity(position.size);
  }

  const baseAsset = state.market.symbol.split("/")[0] ?? state.market.symbol;
  const balance = spotBalances.find((entry) => entry.coin === baseAsset);
  if (!balance) {
    return false;
  }

  return isNonZeroQuantity(balance.total) || isNonZeroQuantity(balance.hold);
}

function isNonZeroQuantity(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const unsigned = trimmed.startsWith("-") ? trimmed.slice(1) : trimmed;

  try {
    return normalizeDecimalString(unsigned) !== "0";
  } catch (error) {
    throw new Error(
      `isNonZeroQuantity: failed to normalize "${value}" — ${error instanceof Error ? error.message : String(error)}. Refusing to assume flat position on unparseable quantity.`,
    );
  }
}
