import { get_tick_context as getDaemonTickContext } from "../daemon/engine";
import type { ExecuteTickInput } from "../daemon/engine";
import { StateReadError } from "../daemon/runtime-state-file";
import { buildTickContextBootstrapGuidance } from "./bootstrap-guidance";

export async function get_tick_context(input: ExecuteTickInput = {}) {
  try {
    return await getDaemonTickContext(input);
  } catch (error) {
    if (error instanceof StateReadError) {
      return buildTickContextBootstrapGuidance(input);
    }

    throw error;
  }
}
