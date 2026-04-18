import { randomUUID } from "node:crypto";

import type { BridgeConfirmationStatus } from "../chain/arbitrum-client";
import type { BridgePreflightInput } from "../chain/bridge-guards";
import { checkBridgePreflight } from "../chain/bridge-guards";
import {
  MAX_CUMULATIVE_BRIDGE_USD,
  MIN_BRIDGE_USDC,
  MIN_ETH_GAS_BUFFER_MULTIPLIER,
} from "../config/constants";
import {
  compareDecimalStrings,
  subtractDecimalStrings,
  sumDecimalStrings,
} from "../config/decimals";
import type { SingleMarketConfig } from "../config/market";
import type {
  BridgeTransferRecord,
  PendingBridgeTransfer as RuntimePendingBridgeTransfer,
  RuntimeState,
} from "../state/runtime-state";
import { classifyOnboardingStatus } from "./status";
import type { OnboardingStatusInput, OnboardingStatusResult } from "./status";

export type PendingBridgeTransfer = RuntimePendingBridgeTransfer;

export type DepositDeps = {
  readonly getUsdcBalance: (address: string) => Promise<{ formatted: string }>;
  readonly getUsdtBalance?: (address: string) => Promise<{ formatted: string }>;
  readonly getEthBalance: (address: string) => Promise<{ wei: bigint }>;
  readonly estimateBridgeGas: (
    address: string,
    amountUsdc: string,
  ) => Promise<{ totalCostWei: bigint }>;
  readonly convertUsdtToUsdc?: (input: {
    readonly walletAddress: string;
    readonly recipientAddress?: string;
    readonly amountUsdt: string;
    readonly minimumRequiredAmountOutUsdc?: string;
  }) => Promise<
    | {
        readonly kind: "converted";
        readonly amountInUsdt: string;
        readonly quotedAmountOutUsdc: string;
        readonly amountOutMinimumUsdc: string;
        readonly approvalResetTxHash: string;
        readonly approvalAmountTxHash: string;
        readonly swapTxHash: string;
      }
    | {
        readonly kind: "failed";
        readonly failure: { readonly code: string; readonly message: string };
      }
  >;
  readonly submitBridgeTransfer: (
    address: string,
    amountUsdc: string,
  ) => Promise<{ txHash: string }>;
  readonly confirmBridgeTransfer: (txHash: string) => Promise<BridgeConfirmationStatus>;
  readonly persistState?: (state: RuntimeState) => Promise<void>;
};

export type DepositResult =
  | { readonly kind: "not_ready"; readonly status: OnboardingStatusResult }
  | { readonly kind: "preflight_failed"; readonly reason: string }
  | {
      readonly kind: "already_pending";
      readonly pending: PendingBridgeTransfer;
      readonly pendingBridgeTransfers: readonly PendingBridgeTransfer[];
    }
  | {
      readonly kind: "blocked";
      readonly code: "insufficient_gas" | "below_minimum" | "insufficient_balance";
      readonly reason: string;
    }
  | {
      readonly kind: "conversion_failed";
      readonly reason: string;
      readonly code: string;
    }
  | {
      readonly kind: "submitted";
      readonly pending: PendingBridgeTransfer & { readonly txHash: string };
      readonly pendingBridgeTransfers: readonly PendingBridgeTransfer[];
      readonly conversion?: {
        readonly amountInUsdt: string;
        readonly amountOutUsdc: string;
        readonly swapTxHash: string;
      };
      readonly updatedState: RuntimeState;
    }
  | { readonly kind: "cap_blocked"; readonly reason: string };

type ConfirmResult =
  | {
      readonly kind: "no_pending";
      readonly pendingBridgeTransfers: readonly PendingBridgeTransfer[];
    }
  | {
      readonly kind: "not_confirmed";
      readonly pendingBridgeTransfers: readonly PendingBridgeTransfer[];
    }
  | {
      readonly kind: "failed";
      readonly txHash: string;
      readonly pendingBridgeTransfers: readonly PendingBridgeTransfer[];
      readonly updatedState: RuntimeState;
    }
  | {
      readonly kind: "unknown";
      readonly reason: string;
      readonly pendingBridgeTransfers: readonly PendingBridgeTransfer[];
    }
  | {
      readonly kind: "confirmed";
      readonly record: BridgeTransferRecord;
      readonly pendingBridgeTransfers: readonly PendingBridgeTransfer[];
      readonly updatedState: RuntimeState;
    };

const DEFAULT_GAS_ESTIMATE_WEI = 200_000n * 1_000_000_000n;

function mirrorPendingTransfersForCompatibility(
  target: readonly PendingBridgeTransfer[],
  next: readonly PendingBridgeTransfer[],
): void {
  const mutableTarget = target as PendingBridgeTransfer[];
  mutableTarget.length = 0;
  mutableTarget.push(...next);
}

export function createIdempotencyKey(walletAddress: string, amountUsdc: string): string {
  return `bridge:${walletAddress}:${amountUsdc}:${randomUUID()}`;
}

export function hasDuplicateIdempotencyKey(
  pendingTransfers: readonly PendingBridgeTransfer[],
  key: string,
): boolean {
  return pendingTransfers.some((t) => t.idempotencyKey === key);
}

export async function getOnboardingStatus(
  state: RuntimeState,
  deps: Pick<
    DepositDeps,
    "getUsdcBalance" | "getUsdtBalance" | "getEthBalance" | "estimateBridgeGas"
  >,
  pendingTransfers: readonly PendingBridgeTransfer[],
  collateralPrepStatus?: "pending" | "failed" | null,
): Promise<OnboardingStatusResult> {
  const { wallet } = state;

  let walletUsdcBalance = "0";
  let walletUsdtBalance = "0";
  let walletEthWei = 0n;
  let estimatedGasWei = DEFAULT_GAS_ESTIMATE_WEI;

  try {
    const [usdcResult, usdtResult, ethResult] = await Promise.all([
      deps.getUsdcBalance(wallet.address),
      deps.getUsdtBalance?.(wallet.address) ?? Promise.resolve({ formatted: "0" }),
      deps.getEthBalance(wallet.address),
    ]);
    walletUsdcBalance = usdcResult.formatted;
    walletUsdtBalance = usdtResult.formatted;
    walletEthWei = ethResult.wei;
  } catch (error) {
    console.warn(
      `getOnboardingStatus: wallet balance fetch failed — ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      status: "unfunded",
      message: "Unable to fetch wallet balances (USDC/USDT/ETH). Check RPC connectivity.",
      bridgeableAmount: null,
    };
  }

  try {
    const gasEstimateAmount =
      compareDecimalStrings(walletUsdcBalance, "0") > 0 ? walletUsdcBalance : walletUsdtBalance;
    if (compareDecimalStrings(gasEstimateAmount, "0") > 0) {
      const gasResult = await deps.estimateBridgeGas(wallet.address, gasEstimateAmount);
      estimatedGasWei = gasResult.totalCostWei;
    }
  } catch (error) {
    console.warn(
      `getOnboardingStatus: gas estimation failed, using default — ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const input: OnboardingStatusInput = {
    walletUsdcBalance,
    walletEthWei,
    estimatedGasWei,
    cumulativeBridgeUsd: state.cumulativeBridgeUsd,
    overridePhraseAccepted: state.overridePhraseAccepted,
    hasPendingTransfer: pendingTransfers.length > 0,
    walletUsdtBalance,
    collateralPrepStatus: collateralPrepStatus ?? null,
  };

  return classifyOnboardingStatus(input);
}

export async function depositToHyperliquid(
  state: RuntimeState,
  deps: DepositDeps,
  pendingTransfers: readonly PendingBridgeTransfer[],
  requestedAmount?: string,
): Promise<DepositResult> {
  if (pendingTransfers.length > 0) {
    return {
      kind: "already_pending",
      pending: pendingTransfers[0],
      pendingBridgeTransfers: pendingTransfers,
    };
  }

  const status = await getOnboardingStatus(state, deps, pendingTransfers);

  if (status.status !== "ready" || status.bridgeableAmount === null) {
    if (status.status === "cap_exceeded_no_override") {
      return { kind: "cap_blocked", reason: status.message };
    }
    return { kind: "not_ready", status };
  }

  const amountUsdc = requestedAmount ?? status.bridgeableAmount;

  if (!state.overridePhraseAccepted) {
    const projectedCumulative = sumDecimalStrings([state.cumulativeBridgeUsd, amountUsdc]);
    if (compareDecimalStrings(projectedCumulative, String(MAX_CUMULATIVE_BRIDGE_USD)) > 0) {
      return {
        kind: "cap_blocked",
        reason: `Bridge of ${amountUsdc} USDC would push cumulative total to ${projectedCumulative}, exceeding the ${MAX_CUMULATIVE_BRIDGE_USD} USDC cap. Accept override phrase first.`,
      };
    }
  }

  let ethResult: { wei: bigint };
  let usdcResult: { formatted: string };
  let usdtResult: { formatted: string };
  let gasResult: { totalCostWei: bigint };

  try {
    [usdcResult, usdtResult, ethResult, gasResult] = await Promise.all([
      deps.getUsdcBalance(state.wallet.address),
      deps.getUsdtBalance?.(state.wallet.address) ?? Promise.resolve({ formatted: "0" }),
      deps.getEthBalance(state.wallet.address),
      deps.estimateBridgeGas(state.wallet.address, amountUsdc),
    ]);
  } catch (error) {
    console.warn(
      `depositToHyperliquid: preflight balance check failed — ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      kind: "not_ready",
      status: {
        status: "unfunded",
        message: "Unable to fetch wallet balances for preflight check.",
        bridgeableAmount: null,
      },
    };
  }

  const walletUsdcBalance = usdcResult.formatted;
  const walletUsdtBalance = usdtResult.formatted;
  const combinedStableBalance = sumDecimalStrings([walletUsdcBalance, walletUsdtBalance]);

  const requiredGasWei = gasResult.totalCostWei * MIN_ETH_GAS_BUFFER_MULTIPLIER;
  if (ethResult.wei < requiredGasWei) {
    return {
      kind: "blocked",
      code: "insufficient_gas",
      reason: `Wallet ETH balance (${ethResult.wei} wei) is below the required gas buffer (${requiredGasWei} wei, 2× estimate). Send ETH to the wallet on Arbitrum before depositing.`,
    };
  }

  if (compareDecimalStrings(combinedStableBalance, String(MIN_BRIDGE_USDC)) < 0) {
    return {
      kind: "blocked",
      code: "below_minimum",
      reason: `Combined wallet stablecoin balance (${walletUsdcBalance} USDC + ${walletUsdtBalance} USDT = ${combinedStableBalance}) is below the minimum bridge amount of ${MIN_BRIDGE_USDC} USDC. Fund the wallet with at least ${MIN_BRIDGE_USDC} USDC or USDT on Arbitrum.`,
    };
  }

  if (compareDecimalStrings(combinedStableBalance, amountUsdc) < 0) {
    return {
      kind: "blocked",
      code: "insufficient_balance",
      reason: `Wallet needs ${amountUsdc} USDC total for funding, but only ${walletUsdcBalance} USDC and ${walletUsdtBalance} USDT (${combinedStableBalance} combined) are available on Arbitrum.`,
    };
  }

  let conversionDetail:
    | { amountInUsdt: string; amountOutUsdc: string; swapTxHash: string }
    | undefined;

  if (compareDecimalStrings(walletUsdcBalance, amountUsdc) < 0) {
    const shortfallUsdc = subtractDecimalStrings(amountUsdc, walletUsdcBalance);

    if (deps.convertUsdtToUsdc === undefined) {
      return {
        kind: "conversion_failed",
        code: "conversion_unavailable",
        reason:
          "USDT conversion path is unavailable in the current deposit dependency configuration.",
      };
    }

    const conversion = await deps.convertUsdtToUsdc({
      walletAddress: state.wallet.address,
      amountUsdt: shortfallUsdc,
      minimumRequiredAmountOutUsdc: shortfallUsdc,
    });
    if (conversion.kind === "failed") {
      return {
        kind: "conversion_failed",
        code: conversion.failure.code,
        reason: conversion.failure.message,
      };
    }

    conversionDetail = {
      amountInUsdt: conversion.amountInUsdt,
      amountOutUsdc: conversion.quotedAmountOutUsdc,
      swapTxHash: conversion.swapTxHash,
    };
  }

  const postConversionUsdcBalance = conversionDetail
    ? (await deps.getUsdcBalance(state.wallet.address)).formatted
    : walletUsdcBalance;

  const preflightInput: BridgePreflightInput = {
    amountUsdc,
    cumulativeBridgeUsd: state.cumulativeBridgeUsd,
    overridePhraseAccepted: state.overridePhraseAccepted,
    walletUsdcBalance: postConversionUsdcBalance,
    walletEthWei: ethResult.wei,
    estimatedGasWei: gasResult.totalCostWei,
  };

  const preflight = checkBridgePreflight(preflightInput);
  if (!preflight.ok) {
    return { kind: "preflight_failed", reason: preflight.reason };
  }

  const idempotencyKey = createIdempotencyKey(state.wallet.address, amountUsdc);

  const prePending: PendingBridgeTransfer = {
    idempotencyKey,
    txHash: null,
    amountUsdc,
    submittedAt: new Date().toISOString(),
  };

  const preSubmitPendingBridgeTransfers = [...pendingTransfers, prePending];

  const preSubmitState: RuntimeState = {
    ...state,
    pendingBridgeTransfers: preSubmitPendingBridgeTransfers,
  };

  if (deps.persistState) {
    await deps.persistState(preSubmitState);
  }

  const { txHash } = await deps.submitBridgeTransfer(state.wallet.address, amountUsdc);

  const pending: PendingBridgeTransfer & { readonly txHash: string } = { ...prePending, txHash };
  const pendingBridgeTransfers = [...preSubmitPendingBridgeTransfers.slice(0, -1), pending];
  mirrorPendingTransfersForCompatibility(pendingTransfers, pendingBridgeTransfers);

  const updatedState: RuntimeState = {
    ...state,
    pendingBridgeTransfers,
  };

  return {
    kind: "submitted",
    pending,
    pendingBridgeTransfers,
    conversion: conversionDetail,
    updatedState,
  };
}

export async function confirmPendingTransfer(
  state: RuntimeState,
  deps: Pick<DepositDeps, "confirmBridgeTransfer">,
  pendingTransfers: readonly PendingBridgeTransfer[],
): Promise<ConfirmResult> {
  if (pendingTransfers.length === 0) {
    return { kind: "no_pending", pendingBridgeTransfers: pendingTransfers };
  }

  const pending = pendingTransfers[0];

  if (pending.txHash === null) {
    return { kind: "not_confirmed", pendingBridgeTransfers: pendingTransfers };
  }

  const confirmation = await deps.confirmBridgeTransfer(pending.txHash);

  if (confirmation.status === "pending") {
    return { kind: "not_confirmed", pendingBridgeTransfers: pendingTransfers };
  }
  if (confirmation.status === "failed") {
    const pendingBridgeTransfers = pendingTransfers.slice(1);
    mirrorPendingTransfersForCompatibility(pendingTransfers, pendingBridgeTransfers);
    const updatedState: RuntimeState = {
      ...state,
      pendingBridgeTransfers,
    };
    return { kind: "failed", txHash: pending.txHash, pendingBridgeTransfers, updatedState };
  }
  if (confirmation.status === "unknown") {
    return {
      kind: "unknown",
      reason: confirmation.reason,
      pendingBridgeTransfers: pendingTransfers,
    };
  }

  const record: BridgeTransferRecord = {
    transferId: pending.idempotencyKey,
    amountUsd: pending.amountUsdc,
    confirmedAt: new Date().toISOString(),
  };

  const newBridgeHistory = [...state.bridgeHistory, record];
  const newCumulativeBridgeUsd = sumDecimalStrings(newBridgeHistory.map((r) => r.amountUsd));
  const pendingBridgeTransfers = pendingTransfers.slice(1);
  mirrorPendingTransfersForCompatibility(pendingTransfers, pendingBridgeTransfers);

  const updatedState: RuntimeState = {
    ...state,
    cumulativeBridgeUsd: newCumulativeBridgeUsd,
    bridgeHistory: newBridgeHistory,
    pendingBridgeTransfers,
  };

  return { kind: "confirmed", record, pendingBridgeTransfers, updatedState };
}

type RefreshPendingBridgeTransfersResult =
  | { readonly kind: "unchanged"; readonly state: RuntimeState }
  | {
      readonly kind: "confirmed";
      readonly state: RuntimeState;
      readonly record: BridgeTransferRecord;
    }
  | { readonly kind: "failed"; readonly txHash: string; readonly state: RuntimeState }
  | { readonly kind: "unknown"; readonly reason: string; readonly state: RuntimeState };

export async function refreshPendingBridgeTransfers(
  state: RuntimeState,
  deps: Pick<DepositDeps, "confirmBridgeTransfer">,
): Promise<RefreshPendingBridgeTransfersResult> {
  if (state.pendingBridgeTransfers.length === 0) {
    return { kind: "unchanged", state };
  }

  const result = await confirmPendingTransfer(state, deps, state.pendingBridgeTransfers);
  if (result.kind === "confirmed") {
    return {
      kind: "confirmed",
      state: result.updatedState,
      record: result.record,
    };
  }
  if (result.kind === "failed") {
    return { kind: "failed", txHash: result.txHash, state: result.updatedState };
  }
  if (result.kind === "unknown") {
    return { kind: "unknown", reason: result.reason, state };
  }

  return { kind: "unchanged", state };
}

export type CollateralPrepDeps = {
  readonly transferBetweenPerpAndSpot: (
    amountUsd: string,
    toPerp: boolean,
  ) => Promise<{ success: boolean }>;
};

export type CollateralPrepResult =
  | {
      readonly kind: "prepared";
      readonly amountUsd: string;
    }
  | {
      readonly kind: "skipped_spot";
    }
  | {
      readonly kind: "skipped_no_balance";
    }
  | {
      readonly kind: "failed";
      readonly reason: string;
    };

export function requiresCollateralPrep(market: SingleMarketConfig): boolean {
  return market.mode === "perp";
}

export async function prepareCollateralForPerp(
  market: SingleMarketConfig,
  deps: CollateralPrepDeps,
  confirmedAmountUsd: string,
): Promise<CollateralPrepResult> {
  if (!requiresCollateralPrep(market)) {
    return { kind: "skipped_spot" };
  }

  if (compareDecimalStrings(confirmedAmountUsd, "0") <= 0) {
    return { kind: "skipped_no_balance" };
  }

  try {
    const result = await deps.transferBetweenPerpAndSpot(confirmedAmountUsd, true);
    if (!result.success) {
      return {
        kind: "failed",
        reason: `USD class transfer of ${confirmedAmountUsd} to perp context returned unsuccessful.`,
      };
    }
    return { kind: "prepared", amountUsd: confirmedAmountUsd };
  } catch (error) {
    return {
      kind: "failed",
      reason: `Collateral preparation transfer failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

type ReconcileWithCollateralPrepResult = {
  readonly bridgeResult: RefreshPendingBridgeTransfersResult;
  readonly collateralResult: CollateralPrepResult | null;
  readonly state: RuntimeState;
};

export async function reconcileWithCollateralPrep(
  state: RuntimeState,
  bridgeDeps: Pick<DepositDeps, "confirmBridgeTransfer">,
  collateralDeps: CollateralPrepDeps | null,
  market: SingleMarketConfig,
): Promise<ReconcileWithCollateralPrepResult> {
  const bridgeResult = await refreshPendingBridgeTransfers(state, bridgeDeps);

  if (bridgeResult.kind === "confirmed" && requiresCollateralPrep(market)) {
    if (collateralDeps === null) {
      return {
        bridgeResult,
        collateralResult: {
          kind: "failed",
          reason: "Collateral preparation dependencies are unavailable.",
        },
        state: bridgeResult.state,
      };
    }

    const collateralResult = await prepareCollateralForPerp(
      market,
      collateralDeps,
      bridgeResult.record.amountUsd,
    );
    return {
      bridgeResult,
      collateralResult,
      state: bridgeResult.state,
    };
  }

  return {
    bridgeResult,
    collateralResult: null,
    state: bridgeResult.state,
  };
}
