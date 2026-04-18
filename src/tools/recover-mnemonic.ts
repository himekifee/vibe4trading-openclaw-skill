import { MNEMONIC_FILE_PATH } from "../config/paths";
import { recoverMnemonicFromFile } from "../wallet";

export const recover_mnemonic = (args: { path?: string }) =>
  recoverMnemonicFromFile(args.path ?? MNEMONIC_FILE_PATH);
