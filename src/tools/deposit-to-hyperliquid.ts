import {
  confirmBridgeTransfer,
  createArbitrumClient,
  createArbitrumUsdtToUsdcConversionExecutor,
  estimateBridgeGas,
  getEthBalance,
  getUsdcBalance,
  getUsdtBalance,
  submitBridgeTransfer,
} from "../chain";
import { StateReadError } from "../daemon/runtime-state-file";
import { readRuntimeStateFile, updateRuntimeStateFile } from "../daemon/runtime-state-file";
import { depositToHyperliquid, refreshPendingBridgeTransfers } from "../onboarding";
import type { DepositDeps } from "../onboarding";
import { parseRuntimeState } from "../state";
import type { RuntimeState } from "../state";
import { buildOnboardingBootstrapGuidance } from "./bootstrap-guidance";

export async function deposit_to_hyperliquid(args: { amountUsdc?: string }) {
  let state: RuntimeState;
  try {
    state = await readRuntimeStateFile();
  } catch (error) {
    if (error instanceof StateReadError) {
      return buildOnboardingBootstrapGuidance();
    }

    throw error;
  }
  const arbitrumClient = createArbitrumClient();
  const convertUsdtToUsdc = createArbitrumUsdtToUsdcConversionExecutor({
    client: arbitrumClient,
    privateKey: state.wallet.privateKey,
  });

  const deps: DepositDeps = {
    getUsdcBalance: async (address) => getUsdcBalance(arbitrumClient, address),
    getUsdtBalance: async (address) => getUsdtBalance(arbitrumClient, address),
    getEthBalance: async (address) => getEthBalance(arbitrumClient, address),
    estimateBridgeGas: async (address, amountUsdc) =>
      estimateBridgeGas(arbitrumClient, address, amountUsdc),
    convertUsdtToUsdc,
    submitBridgeTransfer: async (address, amountUsdc) => {
      return submitBridgeTransfer(arbitrumClient, state.wallet.privateKey, address, amountUsdc);
    },
    confirmBridgeTransfer: async (txHash) => confirmBridgeTransfer(arbitrumClient, txHash),
    persistState: async (preSubmitState) => {
      await updateRuntimeStateFile((lockedState) =>
        parseRuntimeState({
          ...lockedState,
          pendingBridgeTransfers: preSubmitState.pendingBridgeTransfers,
        }),
      );
    },
  };

  const refreshedPendingTransfers = await refreshPendingBridgeTransfers(state, deps);
  if (
    refreshedPendingTransfers.kind === "confirmed" ||
    refreshedPendingTransfers.kind === "failed"
  ) {
    state = refreshedPendingTransfers.state;
    await updateRuntimeStateFile((lockedState) =>
      parseRuntimeState({
        ...lockedState,
        cumulativeBridgeUsd: refreshedPendingTransfers.state.cumulativeBridgeUsd,
        bridgeHistory: refreshedPendingTransfers.state.bridgeHistory,
        pendingBridgeTransfers: refreshedPendingTransfers.state.pendingBridgeTransfers,
      }),
    );
  }
  if (refreshedPendingTransfers.kind === "failed") {
    return {
      kind: "bridge_failed" as const,
      txHash: refreshedPendingTransfers.txHash,
      message: `Prior bridge transfer ${refreshedPendingTransfers.txHash} reverted on-chain. Pending transfer cleared; you may retry the deposit.`,
    };
  }
  if (refreshedPendingTransfers.kind === "unknown") {
    return {
      kind: "bridge_unknown" as const,
      reason: refreshedPendingTransfers.reason,
      message: `Bridge confirmation check failed (${refreshedPendingTransfers.reason}). Pending transfer retained for retry. Try again later.`,
    };
  }

  const result = await depositToHyperliquid(
    state,
    deps,
    [...state.pendingBridgeTransfers],
    args.amountUsdc,
  );
  if (result.kind !== "submitted") {
    return result;
  }

  try {
    await updateRuntimeStateFile((lockedState) =>
      parseRuntimeState({
        ...lockedState,
        pendingBridgeTransfers: result.pendingBridgeTransfers,
      }),
    );
  } catch (error) {
    console.error(
      `deposit_to_hyperliquid: bridge tx submitted but state persist failed — ${error instanceof Error ? error.message : String(error)}. ` +
        `Pending transfer ${JSON.stringify(result.pending)} may not be tracked. Manual reconciliation needed.`,
    );
  }
  return {
    kind: result.kind,
    pending: result.pending,
    ...(result.conversion ? { conversion: result.conversion } : {}),
  };
}
