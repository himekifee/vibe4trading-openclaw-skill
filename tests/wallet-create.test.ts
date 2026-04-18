import { execSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateMnemonic } from "@scure/bip39";
import { english, generateMnemonic } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MNEMONIC_FILE_MODE } from "../src/config/paths";
import {
  WalletCreationError,
  assertFilePermissions,
  createWallet,
  deriveAddressFromMnemonic,
} from "../src/wallet";
import { recoverMnemonicFromFile } from "../src/wallet/confirmation";

const REFERENCE_MNEMONIC = "test test test test test test test test test test test junk";
const REFERENCE_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const repoRoot = resolve(import.meta.dirname, "..");
const regressionArtifactPath = join(
  repoRoot,
  ".sisyphus",
  "evidence",
  "remediation-task-6-wallet-regression.json",
);

type RegressionArtifact = {
  mnemonic: string;
  expectedAddress: string;
  observedAddress: string;
  subprocessCommand: string;
  cwd: string;
  tmpDir: string;
  timestamp: string;
};

function runWalletSubprocess(command: string, env: NodeJS.ProcessEnv): string {
  return execSync(command, {
    encoding: "utf-8",
    cwd: repoRoot,
    env: { ...process.env, ...env },
  }).trim();
}

function writeRegressionArtifact(artifact: RegressionArtifact): void {
  mkdirSync(join(repoRoot, ".sisyphus", "evidence"), { recursive: true });
  writeFileSync(regressionArtifactPath, JSON.stringify(artifact, null, 2));
}

function expectRegressionAddressMatch({
  mnemonic,
  expectedAddress,
  observedAddress,
  subprocessCommand,
  tmpDir,
}: {
  mnemonic: string;
  expectedAddress: string;
  observedAddress: string;
  subprocessCommand: string;
  tmpDir: string;
}): void {
  if (observedAddress !== expectedAddress) {
    writeRegressionArtifact({
      mnemonic,
      expectedAddress,
      observedAddress,
      subprocessCommand,
      cwd: repoRoot,
      tmpDir,
      timestamp: new Date().toISOString(),
    });
  }

  expect(observedAddress).toBe(expectedAddress);
}

describe("wallet-create", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wallet-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("derives the canonical viem address for the standard mnemonic path", () => {
    expect(deriveAddressFromMnemonic(REFERENCE_MNEMONIC)).toBe(REFERENCE_ADDRESS);
  });

  it("derives the same address 100 times for the same mnemonic", () => {
    const derivedAddresses = Array.from({ length: 100 }, () =>
      deriveAddressFromMnemonic(REFERENCE_MNEMONIC),
    );

    expect(derivedAddresses).toHaveLength(100);
    for (const derivedAddress of derivedAddresses) {
      expect(derivedAddress).toBe(REFERENCE_ADDRESS);
    }
  });

  it("generates a valid 12-word BIP-39 mnemonic and checksummed address", () => {
    const targetPath = join(tmpDir, "test-mnemonic.txt");

    const createScript = [
      'import{createWallet}from"./src/wallet"',
      "const r=createWallet(process.env.TEST_TARGET_PATH)",
      "process.stdout.write(JSON.stringify({mnemonic:r.mnemonic,address:r.address}))",
    ].join(";");
    const createCommand = `bun -e '${createScript}'`;
    const result = JSON.parse(
      runWalletSubprocess(createCommand, { TEST_TARGET_PATH: targetPath }),
    ) as { mnemonic: string; address: string };

    const words = result.mnemonic.split(/\s+/);
    expect(words).toHaveLength(12);

    expect(result.address).toMatch(/^0x[a-fA-F0-9]{40}$/);

    const deriveScript = [
      'import{deriveAddressFromMnemonic}from"./src/wallet"',
      "process.stdout.write(deriveAddressFromMnemonic(process.env.TEST_MNEMONIC))",
    ].join(";");
    const deriveCommand = `bun -e '${deriveScript}'`;
    const fromMnemonic = runWalletSubprocess(deriveCommand, {
      TEST_MNEMONIC: result.mnemonic,
    });

    const fileScript = [
      'import{deriveAddressFromMnemonic}from"./src/wallet"',
      'import{readFileSync}from"node:fs"',
      'process.stdout.write(deriveAddressFromMnemonic(readFileSync(process.env.TEST_FILE,"utf8").trim()))',
    ].join(";");
    const fileCommand = `bun -e '${fileScript}'`;
    const fromFile = runWalletSubprocess(fileCommand, { TEST_FILE: targetPath });

    expectRegressionAddressMatch({
      mnemonic: result.mnemonic,
      expectedAddress: result.address,
      observedAddress: fromMnemonic,
      subprocessCommand: deriveCommand,
      tmpDir,
    });
    expectRegressionAddressMatch({
      mnemonic: result.mnemonic,
      expectedAddress: result.address,
      observedAddress: fromFile,
      subprocessCommand: fileCommand,
      tmpDir,
    });
  });

  it("exports mnemonic to file with mode 600", () => {
    const targetPath = join(tmpDir, "test-mnemonic.txt");
    const result = createWallet(targetPath);

    const stat = statSync(targetPath);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(MNEMONIC_FILE_MODE);

    const content = readFileSync(targetPath, "utf-8").trim();
    expect(content).toBe(result.mnemonic);
  });

  it("refuses to overwrite an existing mnemonic file", () => {
    const targetPath = join(tmpDir, "test-mnemonic.txt");
    createWallet(targetPath);

    expect(() => createWallet(targetPath)).toThrow(WalletCreationError);
    expect(() => createWallet(targetPath)).toThrow("already exists");
  });

  it("generates unique wallets on each call", () => {
    const path1 = join(tmpDir, "m1.txt");
    const path2 = join(tmpDir, "m2.txt");
    const r1 = createWallet(path1);
    const r2 = createWallet(path2);

    expect(r1.mnemonic).not.toBe(r2.mnemonic);
    expect(r1.address).not.toBe(r2.address);
  });

  it("fails when target directory does not exist", () => {
    const badPath = join(tmpDir, "nonexistent", "mnemonic.txt");
    expect(() => createWallet(badPath)).toThrow(WalletCreationError);
    expect(() => createWallet(badPath)).toThrow("not accessible");
  });

  it("returns the correct mnemonicFilePath", () => {
    const targetPath = join(tmpDir, "test-mnemonic.txt");
    const result = createWallet(targetPath);
    expect(result.mnemonicFilePath).toBe(targetPath);
  });

  it("assertFilePermissions passes for correctly permissioned file", () => {
    const targetPath = join(tmpDir, "test-mnemonic.txt");
    createWallet(targetPath);
    expect(() => assertFilePermissions(targetPath)).not.toThrow();
  });

  it("assertFilePermissions refuses broader-than-600 file", () => {
    const targetPath = join(tmpDir, "test-mnemonic.txt");
    createWallet(targetPath);
    chmodSync(targetPath, 0o644);

    expect(() => assertFilePermissions(targetPath)).toThrow(WalletCreationError);
    expect(() => assertFilePermissions(targetPath)).toThrow("Refusing to proceed");
  });

  it("recoverMnemonicFromFile refuses insecure permissions", () => {
    const targetPath = join(tmpDir, "test-mnemonic.txt");
    createWallet(targetPath);
    chmodSync(targetPath, 0o644);

    expect(() => recoverMnemonicFromFile(targetPath)).toThrow(WalletCreationError);
    expect(() => recoverMnemonicFromFile(targetPath)).toThrow("Refusing to read");
  });

  it("recoverMnemonicFromFile reads with correct permissions", () => {
    const targetPath = join(tmpDir, "test-mnemonic.txt");
    const result = createWallet(targetPath);

    const recovered = recoverMnemonicFromFile(targetPath);
    expect(recovered).toBe(result.mnemonic);
  });

  it("recoverMnemonicFromFile rejects mnemonic with more than 24 words", () => {
    const targetPath = join(tmpDir, "too-many-words.txt");
    const words = Array.from({ length: 25 }, (_, i) => `word${i}`).join(" ");
    writeFileSync(targetPath, words, { mode: 0o600 });

    expect(() => recoverMnemonicFromFile(targetPath)).toThrow(WalletCreationError);
    expect(() => recoverMnemonicFromFile(targetPath)).toThrow("expected 12-24 words");
  });

  it("recoverMnemonicFromFile rejects arbitrary 12-word English text", () => {
    const targetPath = join(tmpDir, "arbitrary-english.txt");
    const arbitraryText = "dog cat bird fish mouse horse lion tiger bear wolf eagle hawk";
    writeFileSync(targetPath, arbitraryText, { mode: 0o600 });

    expect(() => recoverMnemonicFromFile(targetPath)).toThrow(WalletCreationError);
    expect(() => recoverMnemonicFromFile(targetPath)).toThrow("expected 12-24 words");
  });

  it("recoverMnemonicFromFile rejects wordlist-valid but checksum-invalid 12-word phrase", () => {
    const targetPath = join(tmpDir, "bad-checksum.txt");

    const validMnemonic = generateMnemonic(english);
    const words = validMnemonic.split(" ");
    const lastWord = words[words.length - 1];

    let mutated = "";
    for (const candidate of english) {
      if (candidate === lastWord) continue;
      const trial = [...words.slice(0, -1), candidate].join(" ");
      if (!validateMnemonic(trial, english)) {
        mutated = trial;
        break;
      }
    }

    const mutatedWords = mutated.split(" ");
    expect(mutatedWords).toHaveLength(12);
    expect(mutatedWords.every((w) => english.includes(w))).toBe(true);
    expect(validateMnemonic(mutated, english)).toBe(false);

    writeFileSync(targetPath, mutated, { mode: 0o600 });

    expect(() => recoverMnemonicFromFile(targetPath)).toThrow(WalletCreationError);
    expect(() => recoverMnemonicFromFile(targetPath)).toThrow("expected 12-24 words");
  });
});
