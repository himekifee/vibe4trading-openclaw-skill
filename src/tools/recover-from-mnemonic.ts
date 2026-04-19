import { statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateMnemonic } from "@scure/bip39";
import { english } from "viem/accounts";

import { MNEMONIC_FILE_MODE, MNEMONIC_FILE_PATH } from "../config/paths";
import {
  StateExistsError,
  initializeRuntimeStateFile,
  readRuntimeStateFile,
  updateRuntimeStateFile,
} from "../daemon/runtime-state-file";
import { createRuntimeState, parseRuntimeState } from "../state";
import type { RuntimeState } from "../state";
import {
  WalletCreationError,
  assertFilePermissions,
  deriveAddressFromMnemonic,
  derivePrivateKeyFromMnemonic,
} from "../wallet";

const BOOTSTRAP_MARKET = {
  venue: "hyperliquid" as const,
  mode: "perp" as const,
  marketId: "perps:hyperliquid:ETH",
  symbol: "ETH",
};

export type RecoverFromMnemonicResult =
  | {
      readonly recovered: true;
      readonly walletAddress: string;
      readonly mnemonicFilePath: string;
      readonly message: string;
    }
  | {
      readonly walletAlreadyExists: true;
      readonly reason: "runtime-state-exists";
      readonly message: string;
      readonly nextActions: readonly {
        readonly tool: string;
        readonly description: string;
      }[];
    };

const WALLET_EXISTS_NEXT_ACTIONS: readonly {
  readonly tool: string;
  readonly description: string;
}[] = [
  {
    tool: "get_status",
    description: "Check the current wallet and trading status.",
  },
  {
    tool: "recover_mnemonic",
    description: "Re-read the mnemonic from the desktop file if backup status allows it.",
  },
];

export async function recover_from_mnemonic(args: {
  readonly mnemonic: string;
  readonly path?: string;
  readonly stateFilePath?: string;
}): Promise<RecoverFromMnemonicResult> {
  const { mnemonic: rawMnemonic, stateFilePath } = args;

  const trimmedMnemonic = rawMnemonic.trim();
  if (!trimmedMnemonic) {
    throw new Error("Mnemonic must not be empty.");
  }

  const words = trimmedMnemonic.split(/\s+/);
  if (words.length < 12 || words.length > 24) {
    throw new Error(
      "Invalid mnemonic: expected 12-24 words. Ensure words are separated by single spaces.",
    );
  }

  if (!validateMnemonic(trimmedMnemonic, english)) {
    throw new Error(
      "Invalid mnemonic: the provided words do not form a valid BIP-39 mnemonic. Check each word for typos.",
    );
  }

  const derivedAddress = deriveAddressFromMnemonic(trimmedMnemonic);
  const derivedPrivateKey = derivePrivateKeyFromMnemonic(trimmedMnemonic);
  const targetPath = args.path ?? MNEMONIC_FILE_PATH;

  let existingState: RuntimeState | null = null;
  try {
    existingState =
      stateFilePath !== undefined
        ? await readRuntimeStateFile(stateFilePath)
        : await readRuntimeStateFile();
  } catch {
    // empty: fresh recovery proceeds when no state file exists
  }

  if (existingState !== null) {
    return recoverIntoExistingState(existingState, derivedAddress, derivedPrivateKey, trimmedMnemonic, targetPath, stateFilePath);
  }

  return freshRecovery(derivedAddress, derivedPrivateKey, trimmedMnemonic, targetPath, stateFilePath);
}

async function recoverIntoExistingState(
  existingState: RuntimeState,
  derivedAddress: string,
  derivedPrivateKey: string,
  mnemonic: string,
  targetPath: string,
  stateFilePath: string | undefined,
): Promise<RecoverFromMnemonicResult> {
  if (existingState.wallet.address.toLowerCase() !== derivedAddress.toLowerCase()) {
    return {
      walletAlreadyExists: true,
      reason: "runtime-state-exists",
      message: `Runtime state already exists for wallet ${existingState.wallet.address}. The provided mnemonic derives to address ${derivedAddress}, which does not match. Refusing to overwrite to protect existing wallet and trading data. If you intend to start fresh, manually remove the state file first.`,
      nextActions: WALLET_EXISTS_NEXT_ACTIONS,
    };
  }

  writeMnemonicFile(mnemonic, targetPath);

  const now = new Date().toISOString();
  const updater = (current: RuntimeState) =>
    parseRuntimeState({
      ...current,
      wallet: {
        ...current.wallet,
        privateKey: derivedPrivateKey,
      },
      walletBackup: {
        ...current.walletBackup,
        status: "confirmed",
        mnemonicDisplayedAt: current.walletBackup.mnemonicDisplayedAt ?? now,
        confirmedAt: current.walletBackup.confirmedAt ?? now,
        cleanedUpAt: null,
      },
    });

  const updatedState =
    stateFilePath !== undefined
      ? await updateRuntimeStateFile(stateFilePath, updater)
      : await updateRuntimeStateFile(updater);

  return {
    recovered: true,
    walletAddress: updatedState.wallet.address,
    mnemonicFilePath: targetPath,
    message:
      "Wallet recovered from provided mnemonic. Mnemonic file written and backup status set to confirmed.",
  };
}

async function freshRecovery(
  derivedAddress: string,
  privateKey: string,
  mnemonic: string,
  targetPath: string,
  stateFilePath: string | undefined,
): Promise<RecoverFromMnemonicResult> {
  writeMnemonicFile(mnemonic, targetPath);

  const now = new Date().toISOString();
  const runtimeState = createRuntimeState({
    wallet: {
      address: derivedAddress,
      privateKey,
    },
    market: BOOTSTRAP_MARKET,
    daemonStatus: "stopped",
    walletBackup: {
      status: "confirmed",
      mnemonicDisplayedAt: now,
      confirmedAt: now,
      cleanedUpAt: null,
    },
    liveTradingConsent: {
      acknowledged: false,
      acknowledgedAt: null,
    },
  });

  try {
    await initializeRuntimeStateFile(runtimeState, stateFilePath);
  } catch (error) {
    if (error instanceof StateExistsError) {
      return handleRaceCondition(derivedAddress, privateKey, targetPath, now, stateFilePath);
    }
    throw error;
  }

  return {
    recovered: true,
    walletAddress: derivedAddress,
    mnemonicFilePath: targetPath,
    message:
      "Wallet recovered from provided mnemonic. Runtime state initialized with safe defaults. Mnemonic file written and backup status set to confirmed.",
  };
}

async function handleRaceCondition(
  derivedAddress: string,
  privateKey: string,
  targetPath: string,
  now: string,
  stateFilePath: string | undefined,
): Promise<RecoverFromMnemonicResult> {
  const racingState = await readRuntimeStateFile(stateFilePath);
  if (racingState.wallet.address.toLowerCase() === derivedAddress.toLowerCase()) {
    const updater = (current: RuntimeState) =>
      parseRuntimeState({
        ...current,
        wallet: {
          ...current.wallet,
          privateKey,
        },
        walletBackup: {
          ...current.walletBackup,
          status: "confirmed",
          mnemonicDisplayedAt: current.walletBackup.mnemonicDisplayedAt ?? now,
          confirmedAt: current.walletBackup.confirmedAt ?? now,
          cleanedUpAt: null,
        },
      });

    const updatedState =
      stateFilePath !== undefined
        ? await updateRuntimeStateFile(stateFilePath, updater)
        : await updateRuntimeStateFile(updater);

    return {
      recovered: true,
      walletAddress: updatedState.wallet.address,
      mnemonicFilePath: targetPath,
      message:
        "Wallet recovered from provided mnemonic. Mnemonic file written and backup status set to confirmed.",
    };
  }

  return {
    walletAlreadyExists: true,
    reason: "runtime-state-exists",
    message:
      "Runtime state was created by another process during recovery. The existing wallet address does not match the provided mnemonic. Refusing to overwrite.",
    nextActions: WALLET_EXISTS_NEXT_ACTIONS,
  };
}

function writeMnemonicFile(mnemonic: string, filePath: string): void {
  assertDesktopDirectory(filePath);

  try {
    writeFileSync(filePath, `${mnemonic}\n`, {
      mode: MNEMONIC_FILE_MODE,
      flag: "w",
    });
  } catch (error) {
    throw new WalletCreationError(
      `Failed to write mnemonic file at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  assertFilePermissions(filePath);
}

function assertDesktopDirectory(filePath: string): void {
  const dirPath = dirname(filePath);
  try {
    const stat = statSync(dirPath);
    if (!stat.isDirectory()) {
      throw new WalletCreationError(`${dirPath} exists but is not a directory.`);
    }
  } catch (error) {
    if (error instanceof WalletCreationError) {
      throw error;
    }
    throw new WalletCreationError(
      `Directory not accessible at ${dirPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
