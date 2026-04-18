import { updateRuntimeStateFile } from "../daemon/runtime-state-file";
import { parseRuntimeState } from "../state";
import type { RuntimeState } from "../state";

export async function acknowledge_live_trading(args: {
  readonly confirmed: true;
  readonly stateFilePath?: string;
}): Promise<{
  readonly acknowledged: boolean;
  readonly acknowledgedAt: string;
  readonly walletAddress: string;
}> {
  if (args.confirmed !== true) {
    throw new Error("acknowledge_live_trading requires { confirmed: true }.");
  }

  const now = new Date().toISOString();

  const updatedState: RuntimeState = args.stateFilePath
    ? await updateRuntimeStateFile(args.stateFilePath, (state) =>
        withLiveTradingAcknowledgment(state, now),
      )
    : await updateRuntimeStateFile((state) => withLiveTradingAcknowledgment(state, now));

  return {
    acknowledged: updatedState.liveTradingConsent.acknowledged,
    acknowledgedAt: updatedState.liveTradingConsent.acknowledgedAt ?? now,
    walletAddress: updatedState.wallet.address,
  };
}

function withLiveTradingAcknowledgment(state: RuntimeState, now: string): RuntimeState {
  if (state.liveTradingConsent.acknowledged) {
    return state;
  }

  return parseRuntimeState({
    ...state,
    liveTradingConsent: {
      acknowledged: true,
      acknowledgedAt: now,
    },
  });
}
