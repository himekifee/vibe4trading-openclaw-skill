import { updateRuntimeStateFile } from "../daemon/runtime-state-file";
import { parseRuntimeState } from "../state";

export async function accept_override_phrase(args: {
  readonly confirmed: true;
}): Promise<{
  readonly accepted: boolean;
  readonly overridePhraseAccepted: boolean;
  readonly message: string;
}> {
  if (args.confirmed !== true) {
    throw new Error("accept_override_phrase requires { confirmed: true }.");
  }

  let wasAlreadyAccepted = false;
  const updatedState = await updateRuntimeStateFile((state) => {
    wasAlreadyAccepted = state.overridePhraseAccepted;
    return state.overridePhraseAccepted
      ? state
      : parseRuntimeState({ ...state, overridePhraseAccepted: true });
  });

  return {
    accepted: true,
    overridePhraseAccepted: updatedState.overridePhraseAccepted,
    message: wasAlreadyAccepted
      ? "Override phrase was already accepted."
      : "Override phrase acceptance persisted. Over-cap bridge decisions are now permitted until reset_override_phrase is called.",
  };
}
