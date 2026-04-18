import { StateReadError } from "../daemon/runtime-state-file";
import { readRuntimeStateFile, updateRuntimeStateFile } from "../daemon/runtime-state-file";
import type { RuntimeState } from "../state";
import { buildOnboardingBootstrapGuidance } from "./bootstrap-guidance";

export async function reset_override_phrase() {
  let preState: RuntimeState;
  try {
    preState = await readRuntimeStateFile();
  } catch (error) {
    if (error instanceof StateReadError) {
      return buildOnboardingBootstrapGuidance();
    }

    throw error;
  }

  const nextState = await updateRuntimeStateFile((lockedState) =>
    lockedState.overridePhraseAccepted === false
      ? lockedState
      : { ...lockedState, overridePhraseAccepted: false },
  );

  return {
    reset: preState.overridePhraseAccepted,
    overridePhraseAccepted: nextState.overridePhraseAccepted,
    cumulativeBridgeUsd: nextState.cumulativeBridgeUsd,
    bridgeHistoryCount: nextState.bridgeHistory.length,
    message:
      "Persisted override acceptance cleared. Real cumulative bridge accounting was preserved; future over-cap decisions require fresh consent again.",
  };
}
