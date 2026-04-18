import { get_status as getDaemonStatus } from "../daemon/engine";
import { StateReadError } from "../daemon/runtime-state-file";
import { buildStatusBootstrapGuidance } from "./bootstrap-guidance";

export async function get_status() {
  try {
    return await getDaemonStatus();
  } catch (error) {
    if (error instanceof StateReadError) {
      return buildStatusBootstrapGuidance();
    }

    throw error;
  }
}
