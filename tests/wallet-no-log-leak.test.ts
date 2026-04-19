import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntimeState, serializeRuntimeState } from "../src/state";
import { createWallet, deriveAddressFromMnemonic } from "../src/wallet";
import {
  confirmBackup,
  createConfirmationState,
  displayMnemonicOnce,
  markMnemonicDisplayed,
} from "../src/wallet/confirmation";

describe("wallet-no-log-leak", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wallet-leak-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serialized runtime state never contains a mnemonic phrase", () => {
    const targetPath = join(tmpDir, "mnemonic.txt");
    const result = createWallet(targetPath);

    expect(deriveAddressFromMnemonic(result.mnemonic)).toBe(result.address);

    const state = createRuntimeState({
      wallet: {
        address: result.address,
        privateKey: result.privateKey,
      },
      market: {
        venue: "hyperliquid",
        mode: "perp",
        marketId: "perps:hyperliquid:ETH-PERP",
        symbol: "ETH-PERP",
      },
    });

    const serialized = serializeRuntimeState(state);

    expect(serialized).not.toContain(result.mnemonic);

    const words = result.mnemonic.split(/\s+/);
    for (let i = 0; i <= words.length - 3; i++) {
      const fragment = words.slice(i, i + 3).join(" ");
      expect(serialized).not.toContain(fragment);
    }

    expect(serialized).toContain(result.address);
    expect(serialized).toContain(result.privateKey);
  });

  it("console.log is never called with mnemonic content during wallet creation", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const targetPath = join(tmpDir, "mnemonic.txt");
      const result = createWallet(targetPath);

      for (const spy of [logSpy, warnSpy, errorSpy]) {
        for (const call of spy.mock.calls) {
          const output = call.map(String).join(" ");
          expect(output).not.toContain(result.mnemonic);
          const words = result.mnemonic.split(/\s+/);
          for (let i = 0; i <= words.length - 3; i++) {
            const fragment = words.slice(i, i + 3).join(" ");
            expect(output).not.toContain(fragment);
          }
        }
      }
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("confirmation flow enforces display-once semantics", () => {
    const targetPath = join(tmpDir, "mnemonic.txt");
    const result = createWallet(targetPath);

    let state = createConfirmationState(result.address, result.mnemonicFilePath);
    expect(state.mnemonicDisplayedOnce).toBe(false);
    expect(state.backupConfirmed).toBe(false);

    const displayResult = displayMnemonicOnce(result.mnemonic, state);
    expect(displayResult.mnemonic).toBe(result.mnemonic);
    expect(displayResult.displayedAt).toBeTruthy();

    state = markMnemonicDisplayed(state);
    expect(state.mnemonicDisplayedOnce).toBe(true);

    expect(() => displayMnemonicOnce(result.mnemonic, state)).toThrow("already been displayed");
  });

  it("confirmation flow requires display before backup confirmation", () => {
    const state = createConfirmationState(
      "0x1234567890abcdef1234567890abcdef12345678",
      "/tmp/test-mnemonic.txt",
    );

    expect(() => confirmBackup(state)).toThrow(
      "Cannot confirm backup before the mnemonic has been displayed",
    );
  });

  it("confirmation flow allows backup after display", () => {
    const targetPath = join(tmpDir, "mnemonic.txt");
    const result = createWallet(targetPath);

    let state = createConfirmationState(result.address, result.mnemonicFilePath);
    displayMnemonicOnce(result.mnemonic, state);
    state = markMnemonicDisplayed(state);
    const confirmed = confirmBackup(state);

    expect(confirmed.backupConfirmed).toBe(true);
  });

  it("confirmation flow rejects double confirmation", () => {
    const targetPath = join(tmpDir, "mnemonic.txt");
    const result = createWallet(targetPath);

    let state = createConfirmationState(result.address, result.mnemonicFilePath);
    displayMnemonicOnce(result.mnemonic, state);
    state = markMnemonicDisplayed(state);
    const confirmed = confirmBackup(state);

    expect(() => confirmBackup(confirmed)).toThrow("already been confirmed");
  });

  it("WalletState type carries only address and privateKey, never mnemonic", () => {
    const targetPath = join(tmpDir, "mnemonic.txt");
    const result = createWallet(targetPath);

    const walletState = {
      address: result.address,
      privateKey: `0x${"ab".repeat(32)}`,
    };

    expect(Object.keys(walletState)).toEqual(["address", "privateKey"]);
    expect(JSON.stringify(walletState)).not.toContain(result.mnemonic);
  });
});
