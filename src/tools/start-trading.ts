import { start_trading as startDaemonTrading } from "../daemon/engine";
import { StateReadError } from "../daemon/runtime-state-file";
import { buildStatusBootstrapGuidance } from "./bootstrap-guidance";

export async function start_trading() {
  try {
    return await startDaemonTrading();
  } catch (error) {
    if (error instanceof StateReadError) {
      return buildStatusBootstrapGuidance();
    }

    throw error;
  }
}
