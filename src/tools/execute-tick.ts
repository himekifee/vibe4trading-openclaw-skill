import { execute_tick as executeDaemonTick } from "../daemon/engine";
import type { ExecuteTickInput } from "../daemon/engine";
import { StateReadError } from "../daemon/runtime-state-file";
import { buildTickContextBootstrapGuidance } from "./bootstrap-guidance";

export async function execute_tick(input: ExecuteTickInput = {}) {
  try {
    return await executeDaemonTick(input);
  } catch (error) {
    if (error instanceof StateReadError) {
      return buildTickContextBootstrapGuidance(input);
    }

    throw error;
  }
}
