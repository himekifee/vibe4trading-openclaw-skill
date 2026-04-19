import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMnemonic, english } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MNEMONIC_FILE_MODE } from "../src/config/paths";
import { readRuntimeStateFile, updateRuntimeStateFile } from "../src/daemon/runtime-state-file";
import { parseRuntimeState } from "../src/state";
import { create_wallet } from "../src/tools/create-wallet";
import { recover_from_mnemonic } from "../src/tools/recover-from-mnemonic";

const REFERENCE_MNEMONIC = "test test test test test test test test test test test junk";
const REFERENCE_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("recover_from_mnemonic: fresh recovery (no existing state)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "recover-fresh-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes runtime state from a valid BIP-39 mnemonic", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    const result = await recover_from_mnemonic({
      mnemonic: REFERENCE_MNEMONIC,
      path: mnemonicPath,
      stateFilePath: statePath,
    });

    if (!("recovered" in result)) {
      throw new Error("Expected recovery to succeed");
    }

    expect(result.recovered).toBe(true);
    expect(result.walletAddress).toBe(REFERENCE_ADDRESS);
    expect(result.mnemonicFilePath).toBe(mnemonicPath);

    const mnemonicContent = readFileSync(mnemonicPath, "utf-8").trim();
    expect(mnemonicContent).toBe(REFERENCE_MNEMONIC);

    const fileStat = statSync(mnemonicPath);
    expect(fileStat.mode & 0o777).toBe(MNEMONIC_FILE_MODE);

    const state = await readRuntimeStateFile(statePath);
    expect(state.wallet.address).toBe(REFERENCE_ADDRESS);
    expect(state.wallet.privateKey).toBeTruthy();
    expect(state.wallet.privateKey).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(state.daemonStatus).toBe("stopped");
    expect(state.walletBackup.status).toBe("confirmed");
    expect(state.walletBackup.mnemonicDisplayedAt).toBeTruthy();
    expect(state.walletBackup.confirmedAt).toBeTruthy();
    expect(state.walletBackup.cleanedUpAt).toBeNull();
    expect(state.liveTradingConsent.acknowledged).toBe(false);
    expect(state.tradingSelection).toBeNull();
    expect(state.overridePhraseAccepted).toBe(false);
    expect(state.cumulativeBridgeUsd).toBe("0");
  });

  it("derives correct address for a randomly generated mnemonic", async () => {
    const mnemonic = generateMnemonic(english);
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    const result = await recover_from_mnemonic({
      mnemonic,
      path: mnemonicPath,
      stateFilePath: statePath,
    });

    if (!("recovered" in result)) {
      throw new Error("Expected recovery to succeed");
    }

    expect(result.recovered).toBe(true);
    expect(result.walletAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);

    const state = await readRuntimeStateFile(statePath);
    expect(state.wallet.address).toBe(result.walletAddress);
  });

  it("sets backup status to confirmed since the operator proved they have their backup", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    await recover_from_mnemonic({
      mnemonic: REFERENCE_MNEMONIC,
      path: mnemonicPath,
      stateFilePath: statePath,
    });

    const state = await readRuntimeStateFile(statePath);
    expect(state.walletBackup.status).toBe("confirmed");
    expect(state.walletBackup.confirmedAt).toBeTruthy();
    expect(state.walletBackup.mnemonicDisplayedAt).toBeTruthy();
  });

  it("survives restart — state persists across re-reads", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    await recover_from_mnemonic({
      mnemonic: REFERENCE_MNEMONIC,
      path: mnemonicPath,
      stateFilePath: statePath,
    });

    const stateAfterRestart = await readRuntimeStateFile(statePath);
    expect(stateAfterRestart.wallet.address).toBe(REFERENCE_ADDRESS);
    expect(stateAfterRestart.walletBackup.status).toBe("confirmed");
  });
});

describe("recover_from_mnemonic: validation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "recover-validation-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects empty mnemonic", async () => {
    await expect(
      recover_from_mnemonic({
        mnemonic: "",
        path: join(tmpDir, "mnemonic.txt"),
        stateFilePath: join(tmpDir, "state.json"),
      }),
    ).rejects.toThrow("Mnemonic must not be empty");
  });

  it("rejects whitespace-only mnemonic", async () => {
    await expect(
      recover_from_mnemonic({
        mnemonic: "   ",
        path: join(tmpDir, "mnemonic.txt"),
        stateFilePath: join(tmpDir, "state.json"),
      }),
    ).rejects.toThrow("Mnemonic must not be empty");
  });

  it("rejects mnemonic with fewer than 12 words", async () => {
    await expect(
      recover_from_mnemonic({
        mnemonic: "abandon ability able about above absent absorb abstract",
        path: join(tmpDir, "mnemonic.txt"),
        stateFilePath: join(tmpDir, "state.json"),
      }),
    ).rejects.toThrow("expected 12-24 words");
  });

  it("rejects mnemonic with more than 24 words", async () => {
    const words = Array.from({ length: 25 }, (_, i) => "abandon").join(" ");
    await expect(
      recover_from_mnemonic({
        mnemonic: words,
        path: join(tmpDir, "mnemonic.txt"),
        stateFilePath: join(tmpDir, "state.json"),
      }),
    ).rejects.toThrow("expected 12-24 words");
  });

  it("rejects invalid BIP-39 mnemonic (valid wordlist, bad checksum)", async () => {
    await expect(
      recover_from_mnemonic({
        mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon",
        path: join(tmpDir, "mnemonic.txt"),
        stateFilePath: join(tmpDir, "state.json"),
      }),
    ).rejects.toThrow("Invalid mnemonic");
  });

  it("rejects non-wordlist text", async () => {
    await expect(
      recover_from_mnemonic({
        mnemonic: "dog cat bird fish mouse horse lion tiger bear wolf eagle hawk",
        path: join(tmpDir, "mnemonic.txt"),
        stateFilePath: join(tmpDir, "state.json"),
      }),
    ).rejects.toThrow("Invalid mnemonic");
  });
});

describe("recover_from_mnemonic: existing state interaction", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "recover-existing-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("re-writes mnemonic file when existing state matches the derived address", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    await create_wallet({ path: mnemonicPath, stateFilePath: statePath });

    const stateBefore = await readRuntimeStateFile(statePath);
    const createdMnemonic = readFileSync(mnemonicPath, "utf-8").trim();

    rmSync(mnemonicPath);
    expect(existsSync(mnemonicPath)).toBe(false);

    const result = await recover_from_mnemonic({
      mnemonic: createdMnemonic,
      path: mnemonicPath,
      stateFilePath: statePath,
    });

    if (!("recovered" in result)) {
      throw new Error("Expected recovery to succeed");
    }

    expect(result.recovered).toBe(true);
    expect(result.walletAddress).toBe(stateBefore.wallet.address);
    expect(existsSync(mnemonicPath)).toBe(true);

    const recoveredContent = readFileSync(mnemonicPath, "utf-8").trim();
    expect(recoveredContent).toBe(createdMnemonic);

    const stateAfter = await readRuntimeStateFile(statePath);
    expect(stateAfter.wallet.address).toBe(stateBefore.wallet.address);
    expect(stateAfter.walletBackup.status).toBe("confirmed");
  });

  it("refuses when existing state has a different wallet address", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    await create_wallet({ path: mnemonicPath, stateFilePath: statePath });

    const differentMnemonic = generateMnemonic(english);

    const result = await recover_from_mnemonic({
      mnemonic: differentMnemonic,
      path: mnemonicPath,
      stateFilePath: statePath,
    });

    expect("walletAlreadyExists" in result).toBe(true);
    if ("walletAlreadyExists" in result) {
      expect(result.reason).toBe("runtime-state-exists");
      expect(result.message).toContain("does not match");
      expect(result.nextActions.length).toBeGreaterThan(0);
    }
  });

  it("does not mutate state when refusing due to address mismatch", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    await create_wallet({ path: mnemonicPath, stateFilePath: statePath });
    const stateBefore = await readRuntimeStateFile(statePath);

    const differentMnemonic = generateMnemonic(english);
    await recover_from_mnemonic({
      mnemonic: differentMnemonic,
      path: mnemonicPath,
      stateFilePath: statePath,
    });

    const stateAfter = await readRuntimeStateFile(statePath);
    expect(stateAfter.wallet.address).toBe(stateBefore.wallet.address);
  });

  it("updates archived backup status back to confirmed on recovery", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    await create_wallet({ path: mnemonicPath, stateFilePath: statePath, mnemonicDisplayedAt: new Date().toISOString() });

    await updateRuntimeStateFile(statePath, (state) =>
      parseRuntimeState({
        ...state,
        walletBackup: {
          ...state.walletBackup,
          status: "confirmed",
          confirmedAt: new Date().toISOString(),
        },
      }),
    );

    const archivedPath = `${mnemonicPath}.archived-${Date.now()}`;
    renameSync(mnemonicPath, archivedPath);

    await updateRuntimeStateFile(statePath, (state) =>
      parseRuntimeState({
        ...state,
        walletBackup: {
          ...state.walletBackup,
          status: "archived",
          cleanedUpAt: new Date().toISOString(),
        },
      }),
    );

    const stateBefore = await readRuntimeStateFile(statePath);
    expect(stateBefore.walletBackup.status).toBe("archived");

    const mnemonicContent = readFileSync(archivedPath, "utf-8").trim();
    const result = await recover_from_mnemonic({
      mnemonic: mnemonicContent,
      path: mnemonicPath,
      stateFilePath: statePath,
    });

    if (!("recovered" in result)) {
      throw new Error("Expected recovery to succeed");
    }

    const stateAfter = await readRuntimeStateFile(statePath);
    expect(stateAfter.walletBackup.status).toBe("confirmed");
    expect(stateAfter.walletBackup.cleanedUpAt).toBeNull();
  });
});

describe("recover_from_mnemonic: mnemonic file handling", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "recover-file-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes mnemonic file with 0600 permissions", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    await recover_from_mnemonic({
      mnemonic: REFERENCE_MNEMONIC,
      path: mnemonicPath,
      stateFilePath: statePath,
    });

    const fileStat = statSync(mnemonicPath);
    expect(fileStat.mode & 0o777).toBe(MNEMONIC_FILE_MODE);
  });

  it("overwrites existing mnemonic file with correct content", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    writeFileSync(mnemonicPath, "old content that is stale\n", { mode: 0o600 });

    await recover_from_mnemonic({
      mnemonic: REFERENCE_MNEMONIC,
      path: mnemonicPath,
      stateFilePath: statePath,
    });

    const content = readFileSync(mnemonicPath, "utf-8").trim();
    expect(content).toBe(REFERENCE_MNEMONIC);
  });

  it("fails when target directory does not exist", async () => {
    const badPath = join(tmpDir, "nonexistent", "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    await expect(
      recover_from_mnemonic({
        mnemonic: REFERENCE_MNEMONIC,
        path: badPath,
        stateFilePath: statePath,
      }),
    ).rejects.toThrow("not accessible");
  });

  it("handles extra whitespace in mnemonic (trims correctly)", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    const result = await recover_from_mnemonic({
      mnemonic: `  ${REFERENCE_MNEMONIC}  `,
      path: mnemonicPath,
      stateFilePath: statePath,
    });

    if (!("recovered" in result)) {
      throw new Error("Expected recovery to succeed");
    }

    expect(result.walletAddress).toBe(REFERENCE_ADDRESS);
  });
});

describe("recover_from_mnemonic: idempotency", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "recover-idempotent-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("calling recover_from_mnemonic twice with the same mnemonic succeeds both times", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    const first = await recover_from_mnemonic({
      mnemonic: REFERENCE_MNEMONIC,
      path: mnemonicPath,
      stateFilePath: statePath,
    });

    const second = await recover_from_mnemonic({
      mnemonic: REFERENCE_MNEMONIC,
      path: mnemonicPath,
      stateFilePath: statePath,
    });

    if (!("recovered" in first) || !("recovered" in second)) {
      throw new Error("Expected both recoveries to succeed");
    }

    expect(first.walletAddress).toBe(second.walletAddress);
    expect(second.recovered).toBe(true);
  });
});
