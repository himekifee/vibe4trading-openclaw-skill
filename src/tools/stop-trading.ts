import { stop_trading as stopDaemonTrading } from "../daemon/engine";
import { resolveNetworkTarget } from "../daemon/engine";
import { emergencyCancelAndClearDeadMan } from "../daemon/production-deps";
import type { EmergencyCleanupResult } from "../daemon/production-deps";
import { StateReadError, readRawRuntimeStateFile } from "../daemon/runtime-state-file";
import type { RawRecoveredState } from "../daemon/runtime-state-file";
import { slotIdFromDate } from "../state";
import { buildStatusBootstrapGuidance } from "./bootstrap-guidance";

type CorruptStateResult = {
  readonly corruptState: true;
  readonly reason: "runtime-state-unreadable";
  readonly message: string;
  readonly currentSlot: string;
  readonly network: "mainnet" | "testnet";
  readonly recoveredInfo: RawRecoveredState | null;
  readonly emergencyCleanup: EmergencyCleanupResult | null;
};

export async function stop_trading() {
  try {
    return await stopDaemonTrading();
  } catch (error) {
    if (error instanceof StateReadError) {
      if (error.code === "ENOENT") {
        return buildStatusBootstrapGuidance();
      }

      return attemptCorruptStateCleanup();
    }

    throw error;
  }
}

async function attemptCorruptStateCleanup(): Promise<CorruptStateResult> {
  const rawState = await readRawRuntimeStateFile();

  let emergencyCleanup: EmergencyCleanupResult | null = null;
  if (rawState?.walletAddress && rawState.privateKey) {
    try {
      emergencyCleanup = await emergencyCancelAndClearDeadMan(
        rawState.walletAddress,
        rawState.privateKey,
      );
    } catch (cleanupError) {
      console.error(`stop_trading: emergency cleanup threw unexpectedly — ${String(cleanupError)}`);
    }
  }

  return {
    corruptState: true,
    reason: "runtime-state-unreadable",
    message:
      "Runtime state file exists but cannot be parsed. Best-effort emergency cleanup was attempted. Inspect and manually repair or remove the state file before resuming.",
    currentSlot: slotIdFromDate(new Date()),
    network: resolveNetworkTarget(),
    recoveredInfo: rawState,
    emergencyCleanup,
  };
}
