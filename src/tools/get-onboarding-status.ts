import {
  confirmBridgeTransfer,
  createArbitrumClient,
  estimateBridgeGas,
  getEthBalance,
  getUsdcBalance,
  getUsdtBalance,
} from "../chain";
import { StateReadError } from "../daemon/runtime-state-file";
import { readRuntimeStateFile, updateRuntimeStateFile } from "../daemon/runtime-state-file";
import { getOnboardingStatus, refreshPendingBridgeTransfers } from "../onboarding";
import { parseRuntimeState } from "../state";
import type { RuntimeState } from "../state";
import { buildOnboardingBootstrapGuidance } from "./bootstrap-guidance";

export async function get_onboarding_status() {
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

  const refreshedPendingTransfers = await refreshPendingBridgeTransfers(state, {
    confirmBridgeTransfer: async (txHash) => confirmBridgeTransfer(arbitrumClient, txHash),
  });
  if (
    refreshedPendingTransfers.kind === "confirmed" ||
    refreshedPendingTransfers.kind === "failed"
  ) {
    state = refreshedPendingTransfers.state;
    state = await updateRuntimeStateFile((lockedState) =>
      parseRuntimeState({
        ...lockedState,
        cumulativeBridgeUsd: refreshedPendingTransfers.state.cumulativeBridgeUsd,
        bridgeHistory: refreshedPendingTransfers.state.bridgeHistory,
        pendingBridgeTransfers: refreshedPendingTransfers.state.pendingBridgeTransfers,
      }),
    );
  }

  const onboardingStatus = await getOnboardingStatus(
    state,
    {
      getUsdcBalance: async (address) => getUsdcBalance(arbitrumClient, address),
      getUsdtBalance: async (address) => getUsdtBalance(arbitrumClient, address),
      getEthBalance: async (address) => getEthBalance(arbitrumClient, address),
      estimateBridgeGas: async (address, amountUsdc) =>
        estimateBridgeGas(arbitrumClient, address, amountUsdc),
    },
    state.pendingBridgeTransfers,
  );

  if (refreshedPendingTransfers.kind === "failed") {
    return {
      ...onboardingStatus,
      bridgeRefresh: {
        kind: "failed" as const,
        txHash: refreshedPendingTransfers.txHash,
        message: `Bridge transfer ${refreshedPendingTransfers.txHash} reverted on-chain. The pending transfer has been removed.`,
      },
    };
  }
  if (refreshedPendingTransfers.kind === "unknown") {
    return {
      ...onboardingStatus,
      bridgeRefresh: {
        kind: "unknown" as const,
        reason: refreshedPendingTransfers.reason,
        message: `Bridge confirmation check failed (${refreshedPendingTransfers.reason}). Pending transfer retained for retry.`,
      },
    };
  }

  return onboardingStatus;
}
