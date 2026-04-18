import { pbkdf2Sync } from "node:crypto";
import { statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  HDKey,
  english,
  generateMnemonic,
  privateKeyToAccount,
  publicKeyToAddress,
} from "viem/accounts";
import { DESKTOP_DIRECTORY, MNEMONIC_FILE_MODE, MNEMONIC_FILE_PATH } from "../config/paths";

const DEFAULT_ETH_DERIVATION_PATH = "m/44'/60'/0'/0/0";
const BIP39_SEED_ROUNDS = 2048;
const BIP39_SEED_BYTES = 64;
const BIP39_SALT = "mnemonic";

export type WalletCreationResult = {
  readonly mnemonic: string;
  readonly address: string;
  readonly mnemonicFilePath: string;
};

export class WalletCreationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WalletCreationError";
  }
}

function deriveAccountFromMnemonic(mnemonic: string) {
  const normalizedMnemonic = mnemonic.normalize("NFKD");
  const seed = pbkdf2Sync(
    normalizedMnemonic,
    BIP39_SALT,
    BIP39_SEED_ROUNDS,
    BIP39_SEED_BYTES,
    "sha512",
  );
  const derivedKey = HDKey.fromMasterSeed(seed).derive(DEFAULT_ETH_DERIVATION_PATH);

  if (!derivedKey.privateKey) {
    throw new WalletCreationError("Unable to derive private key from mnemonic.");
  }

  const privateKey = `0x${Buffer.from(derivedKey.privateKey).toString("hex")}` as const;
  return privateKeyToAccount(privateKey);
}

export function derivePubKeyFromMnemonic(mnemonic: string): `0x${string}` {
  return deriveAccountFromMnemonic(mnemonic).publicKey as `0x${string}`;
}

export function pubKeyToAddress(pubKeyHex: `0x${string}`): `0x${string}` {
  return publicKeyToAddress(pubKeyHex);
}

export function deriveAddressFromMnemonic(mnemonic: string): `0x${string}` {
  return deriveAccountFromMnemonic(mnemonic).address as `0x${string}`;
}

/**
 * Security-critical: The returned `mnemonic` field is the ONLY in-memory copy.
 * Callers must display it once, then drop the reference.
 */
export function createWallet(overridePath?: string): WalletCreationResult {
  const targetPath = overridePath ?? MNEMONIC_FILE_PATH;

  assertDesktopDirectory(overridePath ? dirname(targetPath) : DESKTOP_DIRECTORY);

  const mnemonic = generateMnemonic(english);
  const address = deriveAddressFromMnemonic(mnemonic);

  exportMnemonicToFile(mnemonic, targetPath);

  return { mnemonic, address, mnemonicFilePath: targetPath };
}

export function assertFilePermissions(filePath: string): void {
  const stat = statSync(filePath);
  const mode = stat.mode & 0o777;
  if (mode !== MNEMONIC_FILE_MODE) {
    throw new WalletCreationError(
      `Mnemonic file at ${filePath} has mode ${mode.toString(8)}, expected 600. Refusing to proceed.`,
    );
  }
}

function exportMnemonicToFile(mnemonic: string, filePath: string): void {
  try {
    writeFileSync(filePath, `${mnemonic}\n`, {
      mode: MNEMONIC_FILE_MODE,
      flag: "wx",
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new WalletCreationError(
        `Mnemonic file already exists at ${filePath}. Remove the existing file before creating a new wallet.`,
      );
    }
    throw new WalletCreationError(
      `Failed to write mnemonic file at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  assertFilePermissions(filePath);
}

function assertDesktopDirectory(dirPath: string): void {
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
      `Desktop directory not accessible at ${dirPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
