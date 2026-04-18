import { readFileSync, statSync } from "node:fs";
import { validateMnemonic } from "@scure/bip39";
import { english } from "viem/accounts";
import { MNEMONIC_FILE_MODE } from "../config/paths";
import { WalletCreationError } from "./wallet-create";

export type MnemonicDisplayResult = {
  readonly mnemonic: string;
  readonly displayedAt: string;
};

export type ConfirmationState = {
  readonly walletAddress: string;
  readonly mnemonicFilePath: string;
  readonly mnemonicDisplayedOnce: boolean;
  readonly backupConfirmed: boolean;
};

/**
 * Security-critical: Produces the mnemonic for one-time display.
 * After the caller shows it and receives confirmation, the mnemonic
 * must be dropped from memory and never stored in state/logs.
 */
export function displayMnemonicOnce(
  mnemonic: string,
  confirmationState: ConfirmationState,
): MnemonicDisplayResult {
  if (confirmationState.mnemonicDisplayedOnce) {
    throw new WalletCreationError(
      "Mnemonic has already been displayed. Use the local recovery tool to re-read from the desktop file if needed.",
    );
  }

  return {
    mnemonic,
    displayedAt: new Date().toISOString(),
  };
}

export function confirmBackup(state: ConfirmationState): ConfirmationState {
  if (!state.mnemonicDisplayedOnce) {
    throw new WalletCreationError("Cannot confirm backup before the mnemonic has been displayed.");
  }

  if (state.backupConfirmed) {
    throw new WalletCreationError("Backup has already been confirmed.");
  }

  return { ...state, backupConfirmed: true };
}

export function createConfirmationState(
  walletAddress: string,
  mnemonicFilePath: string,
): ConfirmationState {
  return {
    walletAddress,
    mnemonicFilePath,
    mnemonicDisplayedOnce: false,
    backupConfirmed: false,
  };
}

export function markMnemonicDisplayed(state: ConfirmationState): ConfirmationState {
  return { ...state, mnemonicDisplayedOnce: true };
}

export function recoverMnemonicFromFile(filePath: string): string {
  const stat = statSync(filePath);
  const mode = stat.mode & 0o777;
  if (mode !== MNEMONIC_FILE_MODE) {
    throw new WalletCreationError(
      `Mnemonic file at ${filePath} has mode ${mode.toString(8)}, expected 600. Refusing to read.`,
    );
  }

  const content = readFileSync(filePath, "utf-8").trim();
  const words = content ? content.split(/\s+/) : [];
  if (words.length < 12 || words.length > 24) {
    throw new WalletCreationError(
      "Mnemonic file does not contain a valid BIP-39 mnemonic (expected 12-24 words).",
    );
  }

  if (!validateMnemonic(content, english)) {
    throw new WalletCreationError(
      "Mnemonic file does not contain a valid BIP-39 mnemonic (expected 12-24 words).",
    );
  }

  return content;
}
