import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MNEMONIC_FILE_MODE } from "../src/config/paths";
import {
  DaemonService,
  LiveTradingConsentRequiredError,
  resolveNetworkTarget,
} from "../src/daemon/engine";
import type { DaemonDeps } from "../src/daemon/engine";
import { readRuntimeStateFile, updateRuntimeStateFile } from "../src/daemon/runtime-state-file";
import { createRuntimeState, parseRuntimeState } from "../src/state";
import type { RuntimeState } from "../src/state";
import { acknowledge_live_trading } from "../src/tools/acknowledge-live-trading";
import { cleanup_mnemonic_file } from "../src/tools/cleanup-mnemonic-file";
import { create_wallet } from "../src/tools/create-wallet";

function stubDaemonDeps(overrides: Partial<DaemonDeps> = {}): DaemonDeps {
  const defaultState = createRuntimeState({
    wallet: {
      address: "0x1234567890abcdef1234567890ABCDEF12345678",
      mnemonicFilePath: "/tmp/test-mnemonic.txt",
    },
    market: {
      venue: "hyperliquid",
      mode: "perp",
      marketId: "perps:hyperliquid:ETH",
      symbol: "ETH",
    },
  });

  return {
    readState: async () => defaultState,
    updateState: async (updater) => updater(defaultState),
    acquirePidLock: async () => ({
      replacedStalePid: false,
      existingPid: null,
      release: async () => {},
    }),
    reconcileState: async (s) => ({
      state: s,
      driftDetected: false,
      rpcFailed: false,
      previousActivity: s.exchangeActivity,
      nextActivity: s.exchangeActivity,
    }),
    getOnboardingStatus: async () => ({
      status: "ready" as const,
      message: "ready",
      bridgeableAmount: "25",
    }),
    refreshAgentMd: async () =>
      ({
        kind: "not-modified",
        httpStatus: 304,
        cache: {
          url: "https://vibe4trading.ai/agent.md",
          version: "1",
          lastUpdated: "2026-03-27T12:00:00.000Z",
          apiContractVersion: "1",
          status: "active",
          etag: '"etag-1"',
          hash: "hash-1",
          fetchedAt: "2026-03-27T12:31:00.000Z",
          tradingOptions: null,
        },
        policy: {
          version: "1",
          lastUpdated: "2026-03-27T12:00:00.000Z",
          apiContractVersion: "1",
          status: "active",
        },
      }) as Awaited<ReturnType<DaemonDeps["refreshAgentMd"]>>,
    fetchSuggestion: async () => ({
      kind: "ok" as const,
      httpStatus: 200 as const,
      recommendation: {
        tickTime: "2026-03-27T12:30:10.000Z",
        expiresAt: "2026-03-27T12:40:00.000Z",
        marketId: "perps:hyperliquid:ETH",
        recommendedMode: "futures",
        recommendedDirection: "long",
        recommendedSizeFraction: "0.4",
        recommendedLeverage: 2,
        recommendationId: "run-stub::2026-03-27T12:30:10.000Z",
        raw: {
          confidence: "0.8",
          rationale: "Stub.",
          key_signals: [],
          stop_loss_pct: null,
          take_profit_pct: null,
          run_id: "run-stub",
          strategy: null,
        },
      },
    }),
    evaluatePolicy: () =>
      ({
        kind: "hold",
        marketId: "perps:hyperliquid:ETH",
        mode: "perp",
        evaluatedAt: "2026-03-27T12:31:00.000Z",
        slotId: "2026-03-27T12:30",
        suggestionId: null,
        overridePhrase: {
          wasAccepted: false,
          isAccepted: false,
          requiresAcceptance: false,
          shouldPersist: false,
        },
        agentStatus: "active",
        clamps: [],
        holdReason: "no-suggestion",
        message: "No suggestion.",
      }) as ReturnType<DaemonDeps["evaluatePolicy"]>,
    executeDecision: async (_decision, _state, tickNow) => ({
      slotId: "2026-03-27T12:30",
      suggestionId: null,
      marketId: "perps:hyperliquid:ETH",
      mode: "perp" as const,
      judgmentSummary: "Hold: no-suggestion",
      actions: [],
      skipped: false,
      skipReason: null,
      executedAt: tickNow.toISOString(),
      retryMetadata: null,
      reshapingMetadata: null,
    }),
    cancelOutstandingOrders: async () => ({
      cancelledCount: 0,
      hadFailures: false,
      confirmedNoPendingOrders: true,
    }),
    clearDeadMan: async () => {},
    readTradeHistory: async () => [],
    now: () => new Date("2026-03-27T12:31:00.000Z"),
    ...overrides,
  };
}

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) {
    process.env[key] = "";
  } else {
    process.env[key] = original;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wallet bootstrap: create_wallet initializes runtime state", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wallet-bootstrap-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates mnemonic file and runtime state file with safe defaults", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    const result = await create_wallet({ path: mnemonicPath, stateFilePath: statePath });

    expect("walletAlreadyExists" in result && result.walletAlreadyExists).toBe(false);
    if ("wallet" in result) {
      const fileStat = statSync(mnemonicPath);
      expect(fileStat.mode & 0o777).toBe(MNEMONIC_FILE_MODE);

      const mnemonicContent = readFileSync(mnemonicPath, "utf-8").trim();
      expect(mnemonicContent).toBe(result.wallet.mnemonic);
      expect(mnemonicContent.split(/\s+/)).toHaveLength(12);

      expect(result.wallet.address).toMatch(/^0x[a-fA-F0-9]{40}$/);

      const state = await readRuntimeStateFile(statePath);
      expect(state.wallet.address).toBe(result.wallet.address);
      expect(state.wallet.mnemonicFilePath).toBe(mnemonicPath);
      expect(state.daemonStatus).toBe("stopped");
      expect(state.walletBackup.status).toBe("pending");
      expect(state.walletBackup.mnemonicDisplayedAt).toBeNull();
      expect(state.walletBackup.confirmedAt).toBeNull();
      expect(state.walletBackup.cleanedUpAt).toBeNull();
      expect(state.liveTradingConsent.acknowledged).toBe(false);
      expect(state.liveTradingConsent.acknowledgedAt).toBeNull();
      expect(state.tradingSelection).toBeNull();
      expect(state.overridePhraseAccepted).toBe(false);
      expect(state.cumulativeBridgeUsd).toBe("0");
      expect(state.bridgeHistory).toHaveLength(0);
    }
  });

  it("returns both wallet creation result and runtime state", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    const result = await create_wallet({
      path: mnemonicPath,
      stateFilePath: statePath,
    });

    expect("wallet" in result).toBe(true);
    if (!("wallet" in result)) return;
    const { wallet, runtimeState } = result;

    expect(wallet.mnemonic).toBeTruthy();
    expect(wallet.address).toBeTruthy();
    expect(wallet.mnemonicFilePath).toBe(mnemonicPath);
    expect(runtimeState.wallet.address).toBe(wallet.address);
    expect(runtimeState.daemonStatus).toBe("stopped");
  });

  it("refuses to overwrite existing state file (atomic initialization)", async () => {
    const mnemonicPath1 = join(tmpDir, "mnemonic1.txt");
    const mnemonicPath2 = join(tmpDir, "mnemonic2.txt");
    const statePath = join(tmpDir, "state.json");

    const first = await create_wallet({ path: mnemonicPath1, stateFilePath: statePath });
    expect("wallet" in first).toBe(true);

    const second = await create_wallet({ path: mnemonicPath2, stateFilePath: statePath });
    expect("walletAlreadyExists" in second && second.walletAlreadyExists).toBe(true);
    if ("walletAlreadyExists" in second) {
      expect(second.reason).toBe("runtime-state-exists");
      expect(second.nextActions.length).toBeGreaterThan(0);
    }

    // The second call must not leave an orphan mnemonic file on disk.
    expect(existsSync(mnemonicPath2)).toBe(false);
    // The first wallet's mnemonic must remain untouched.
    expect(existsSync(mnemonicPath1)).toBe(true);
  });

  it("duplicate-state path does not leave orphan mnemonic on disk", async () => {
    const mnemonicPath1 = join(tmpDir, "m-first.txt");
    const mnemonicPath2 = join(tmpDir, "m-orphan.txt");
    const statePath = join(tmpDir, "state.json");

    await create_wallet({ path: mnemonicPath1, stateFilePath: statePath });

    const result = await create_wallet({ path: mnemonicPath2, stateFilePath: statePath });
    expect("walletAlreadyExists" in result && result.walletAlreadyExists).toBe(true);

    // Core assertion: no orphan mnemonic left behind.
    expect(existsSync(mnemonicPath2)).toBe(false);

    // Original mnemonic and state file are intact.
    expect(existsSync(mnemonicPath1)).toBe(true);
    expect(existsSync(statePath)).toBe(true);

    // State file still contains the first wallet's data.
    const state = await readRuntimeStateFile(statePath);
    expect(state.wallet.mnemonicFilePath).toBe(mnemonicPath1);
  });

  it("refuses overwrite even when state file is corrupt", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    writeFileSync(statePath, "CORRUPT_DATA", "utf-8");

    const result = await create_wallet({ path: mnemonicPath, stateFilePath: statePath });
    expect("walletAlreadyExists" in result && result.walletAlreadyExists).toBe(true);
  });

  it("two concurrent create_wallet calls: exactly one succeeds, loser leaves no orphan", async () => {
    const mnemonicPath1 = join(tmpDir, "m1.txt");
    const mnemonicPath2 = join(tmpDir, "m2.txt");
    const statePath = join(tmpDir, "state.json");

    const results = await Promise.all([
      create_wallet({ path: mnemonicPath1, stateFilePath: statePath }),
      create_wallet({ path: mnemonicPath2, stateFilePath: statePath }),
    ]);

    const successes = results.filter((r) => "wallet" in r);
    const existsResults = results.filter(
      (r) => "walletAlreadyExists" in r && r.walletAlreadyExists,
    );

    expect(successes).toHaveLength(1);
    expect(existsResults).toHaveLength(1);

    const winnerPath = "wallet" in results[0] ? mnemonicPath1 : mnemonicPath2;
    const loserPath = winnerPath === mnemonicPath1 ? mnemonicPath2 : mnemonicPath1;

    expect(existsSync(winnerPath)).toBe(true);
    expect(existsSync(loserPath)).toBe(false);
  });
});

describe("backup confirmation: persisted state survives restart", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "backup-confirm-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("backup pending status persists across re-reads (simulated restart)", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    await create_wallet({ path: mnemonicPath, stateFilePath: statePath });

    const stateAfterRestart = await readRuntimeStateFile(statePath);
    expect(stateAfterRestart.walletBackup.status).toBe("pending");
  });

  it("mnemonic displayed timestamp persists and confirms across restarts", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    await create_wallet({ path: mnemonicPath, stateFilePath: statePath });

    const displayedAt = new Date().toISOString();
    await updateRuntimeStateFile(statePath, (state) =>
      parseRuntimeState({
        ...state,
        walletBackup: { ...state.walletBackup, mnemonicDisplayedAt: displayedAt },
      }),
    );

    const stateAfterDisplay = await readRuntimeStateFile(statePath);
    expect(stateAfterDisplay.walletBackup.mnemonicDisplayedAt).toBe(displayedAt);
    expect(stateAfterDisplay.walletBackup.status).toBe("pending");

    const confirmedAt = new Date().toISOString();
    await updateRuntimeStateFile(statePath, (state) =>
      parseRuntimeState({
        ...state,
        walletBackup: {
          ...state.walletBackup,
          status: "confirmed",
          confirmedAt,
        },
      }),
    );

    const stateAfterConfirm = await readRuntimeStateFile(statePath);
    expect(stateAfterConfirm.walletBackup.status).toBe("confirmed");
    expect(stateAfterConfirm.walletBackup.confirmedAt).toBe(confirmedAt);

    const stateAfterSecondRestart = await readRuntimeStateFile(statePath);
    expect(stateAfterSecondRestart.walletBackup.status).toBe("confirmed");
    expect(stateAfterSecondRestart.walletBackup.confirmedAt).toBe(confirmedAt);
  });

  it("does not depend on module-global walletSession for backup flow", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    await create_wallet({ path: mnemonicPath, stateFilePath: statePath });

    const displayedAt = new Date().toISOString();
    await updateRuntimeStateFile(statePath, (state) =>
      parseRuntimeState({
        ...state,
        walletBackup: { ...state.walletBackup, mnemonicDisplayedAt: displayedAt },
      }),
    );

    const confirmedAt = new Date().toISOString();
    await updateRuntimeStateFile(statePath, (state) =>
      parseRuntimeState({
        ...state,
        walletBackup: {
          ...state.walletBackup,
          status: "confirmed",
          confirmedAt,
        },
      }),
    );

    const freshState = await readRuntimeStateFile(statePath);
    expect(freshState.walletBackup.status).toBe("confirmed");
    expect(freshState.walletBackup.confirmedAt).toBe(confirmedAt);
    expect(freshState.wallet.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });
});

describe("mainnet acknowledgment gating", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mainnet-ack-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("acknowledge_live_trading persists acknowledged=true in runtime state", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    await create_wallet({ path: mnemonicPath, stateFilePath: statePath });

    const beforeAck = await readRuntimeStateFile(statePath);
    expect(beforeAck.liveTradingConsent.acknowledged).toBe(false);

    const result = await acknowledge_live_trading({ confirmed: true, stateFilePath: statePath });
    expect(result.acknowledged).toBe(true);
    expect(result.acknowledgedAt).toBeTruthy();
    expect(result.walletAddress).toBe(beforeAck.wallet.address);

    const afterAck = await readRuntimeStateFile(statePath);
    expect(afterAck.liveTradingConsent.acknowledged).toBe(true);
    expect(afterAck.liveTradingConsent.acknowledgedAt).toBeTruthy();
  });

  it("acknowledge_live_trading is idempotent", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    await create_wallet({ path: mnemonicPath, stateFilePath: statePath });

    const first = await acknowledge_live_trading({ confirmed: true, stateFilePath: statePath });
    const second = await acknowledge_live_trading({ confirmed: true, stateFilePath: statePath });

    expect(first.acknowledged).toBe(true);
    expect(second.acknowledged).toBe(true);
    expect(second.acknowledgedAt).toBe(first.acknowledgedAt);
  });

  it("acknowledgment survives restart (persisted, not module-global)", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    await create_wallet({ path: mnemonicPath, stateFilePath: statePath });
    await acknowledge_live_trading({ confirmed: true, stateFilePath: statePath });

    const afterRestart = await readRuntimeStateFile(statePath);
    expect(afterRestart.liveTradingConsent.acknowledged).toBe(true);
    expect(afterRestart.liveTradingConsent.acknowledgedAt).toBeTruthy();
  });

  it("LiveTradingConsentRequiredError is a named error class", () => {
    const err = new LiveTradingConsentRequiredError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LiveTradingConsentRequiredError);
    expect(err.name).toBe("LiveTradingConsentRequiredError");
    expect(err.message).toBe("test");
  });

  it("fresh state has liveTradingConsent.acknowledged=false by default", () => {
    const state = createRuntimeState({
      wallet: {
        address: "0x1234567890abcdef1234567890ABCDEF12345678",
        mnemonicFilePath: "/tmp/test-mnemonic.txt",
      },
      market: {
        venue: "hyperliquid",
        mode: "perp",
        marketId: "perps:hyperliquid:ETH",
        symbol: "ETH",
      },
    });

    expect(state.liveTradingConsent.acknowledged).toBe(false);
    expect(state.liveTradingConsent.acknowledgedAt).toBeNull();
  });

  it("DaemonService.startTrading() refuses on mainnet without acknowledgment", async () => {
    const originalHlNetwork = process.env.HL_NETWORK;
    const originalHlTestnet = process.env.HL_TESTNET;
    try {
      process.env.HL_NETWORK = "mainnet";
      process.env.HL_TESTNET = "";

      const state = createRuntimeState({
        wallet: {
          address: "0x1234567890abcdef1234567890ABCDEF12345678",
          mnemonicFilePath: "/tmp/test-mnemonic.txt",
        },
        market: {
          venue: "hyperliquid",
          mode: "perp",
          marketId: "perps:hyperliquid:ETH",
          symbol: "ETH",
        },
      });

      expect(state.liveTradingConsent.acknowledged).toBe(false);

      const service = new DaemonService(stubDaemonDeps({ readState: async () => state }));

      await expect(service.startTrading()).rejects.toThrow(LiveTradingConsentRequiredError);
      await expect(service.startTrading()).rejects.toThrow(
        "Mainnet live trading requires explicit acknowledgment",
      );
    } finally {
      restoreEnv("HL_NETWORK", originalHlNetwork);
      restoreEnv("HL_TESTNET", originalHlTestnet);
    }
  });

  it("DaemonService.startTrading() succeeds on mainnet after acknowledgment", async () => {
    const originalHlNetwork = process.env.HL_NETWORK;
    const originalHlTestnet = process.env.HL_TESTNET;
    try {
      process.env.HL_NETWORK = "mainnet";
      process.env.HL_TESTNET = "";

      let state: RuntimeState = {
        ...createRuntimeState({
          wallet: {
            address: "0x1234567890abcdef1234567890ABCDEF12345678",
            mnemonicFilePath: "/tmp/test-mnemonic.txt",
          },
          market: {
            venue: "hyperliquid",
            mode: "perp",
            marketId: "perps:hyperliquid:ETH",
            symbol: "ETH",
          },
        }),
        liveTradingConsent: {
          acknowledged: true,
          acknowledgedAt: "2026-03-27T12:00:00.000Z",
        },
      };

      const service = new DaemonService(
        stubDaemonDeps({
          readState: async () => state,
          updateState: async (updater) => {
            state = updater(state);
            return state;
          },
        }),
      );

      const result = await service.startTrading();
      expect(result.daemonStatus).toBe("running");
      expect(result.haltReason).toBeNull();
      expect(result.network).toBe("mainnet");
    } finally {
      restoreEnv("HL_NETWORK", originalHlNetwork);
      restoreEnv("HL_TESTNET", originalHlTestnet);
    }
  });
});

describe("mnemonic lifecycle state readiness", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mnemonic-lifecycle-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("mnemonic file is NOT deleted during create or confirm flow", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    await create_wallet({ path: mnemonicPath, stateFilePath: statePath });

    expect(statSync(mnemonicPath).isFile()).toBe(true);

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

    expect(statSync(mnemonicPath).isFile()).toBe(true);
  });

  it("walletBackup supports archived and deleted statuses for later cleanup", () => {
    const archived = parseRuntimeState({
      wallet: {
        address: "0x1234567890abcdef1234567890ABCDEF12345678",
        mnemonicFilePath: "/tmp/test-mnemonic.txt",
      },
      vibe4tradingToken: null,
      market: {
        venue: "hyperliquid",
        mode: "perp",
        marketId: "perps:hyperliquid:ETH",
        symbol: "ETH",
      },
      overridePhraseAccepted: false,
      cumulativeBridgeUsd: "0",
      bridgeHistory: [],
      pendingBridgeTransfers: [],
      lastExecutedSlot: null,
      executingSlot: null,
      lastSuggestionId: null,
      daemonStatus: "stopped",
      exchangeActivity: { hasOpenPosition: false, hasPendingOrder: false },
      haltReason: null,
      tradingSelection: null,
      walletBackup: {
        status: "archived",
        mnemonicDisplayedAt: "2026-01-01T00:00:00.000Z",
        confirmedAt: "2026-01-01T00:01:00.000Z",
        cleanedUpAt: "2026-01-01T00:02:00.000Z",
      },
      liveTradingConsent: { acknowledged: false, acknowledgedAt: null },
    });

    expect(archived.walletBackup.status).toBe("archived");
    expect(archived.walletBackup.cleanedUpAt).toBe("2026-01-01T00:02:00.000Z");
  });
});

describe("resolveNetworkTarget env precedence", () => {
  function withEnv(
    hlNetwork: string | undefined,
    hlTestnet: string | undefined,
    fn: () => void,
  ): void {
    const origNetwork = process.env.HL_NETWORK;
    const origTestnet = process.env.HL_TESTNET;
    try {
      process.env.HL_NETWORK = hlNetwork ?? "";
      process.env.HL_TESTNET = hlTestnet ?? "";
      fn();
    } finally {
      restoreEnv("HL_NETWORK", origNetwork);
      restoreEnv("HL_TESTNET", origTestnet);
    }
  }

  it("defaults to mainnet when both env vars are unset", () => {
    withEnv("", "", () => {
      expect(resolveNetworkTarget()).toBe("mainnet");
    });
  });

  it("HL_NETWORK=mainnet takes precedence", () => {
    withEnv("mainnet", "1", () => {
      expect(resolveNetworkTarget()).toBe("mainnet");
    });
  });

  it("HL_NETWORK=testnet takes precedence", () => {
    withEnv("testnet", "0", () => {
      expect(resolveNetworkTarget()).toBe("testnet");
    });
  });

  it("legacy HL_TESTNET=0 resolves to mainnet when HL_NETWORK is absent", () => {
    withEnv("", "0", () => {
      expect(resolveNetworkTarget()).toBe("mainnet");
    });
  });

  it("legacy HL_TESTNET=1 resolves to testnet when HL_NETWORK is absent", () => {
    withEnv("", "1", () => {
      expect(resolveNetworkTarget()).toBe("testnet");
    });
  });

  it("legacy HL_TESTNET=true resolves to testnet when HL_NETWORK is absent", () => {
    withEnv("", "true", () => {
      expect(resolveNetworkTarget()).toBe("testnet");
    });
  });

  it("HL_NETWORK is case-insensitive", () => {
    withEnv("MAINNET", "", () => {
      expect(resolveNetworkTarget()).toBe("mainnet");
    });
    withEnv("Testnet", "", () => {
      expect(resolveNetworkTarget()).toBe("testnet");
    });
  });
});

describe("mnemonic cleanup: blocked before backup confirmation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cleanup-blocked-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cleanup archive is rejected when backup status is pending", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    await create_wallet({ path: mnemonicPath, stateFilePath: statePath });

    const state = await readRuntimeStateFile(statePath);
    expect(state.walletBackup.status).toBe("pending");

    await expect(
      cleanup_mnemonic_file({ action: "archive", stateFilePath: statePath }),
    ).rejects.toThrow('must be "confirmed"');

    expect(existsSync(mnemonicPath)).toBe(true);
  });

  it("cleanup delete is rejected when backup status is pending", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    await create_wallet({ path: mnemonicPath, stateFilePath: statePath });

    await expect(
      cleanup_mnemonic_file({ action: "delete", stateFilePath: statePath }),
    ).rejects.toThrow('must be "confirmed"');

    expect(existsSync(mnemonicPath)).toBe(true);
  });

  it("persisted state is NOT mutated when cleanup is rejected", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    await create_wallet({ path: mnemonicPath, stateFilePath: statePath });

    try {
      await cleanup_mnemonic_file({ action: "archive", stateFilePath: statePath });
    } catch {}

    const state = await readRuntimeStateFile(statePath);
    expect(state.walletBackup.status).toBe("pending");
    expect(state.walletBackup.cleanedUpAt).toBeNull();
  });
});

describe("mnemonic cleanup: succeeds after backup confirmation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cleanup-success-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createAndConfirmWallet(dir: string) {
    const mnemonicPath = join(dir, "mnemonic.txt");
    const statePath = join(dir, "state.json");

    await create_wallet({ path: mnemonicPath, stateFilePath: statePath });

    await updateRuntimeStateFile(statePath, (state) =>
      parseRuntimeState({
        ...state,
        walletBackup: {
          ...state.walletBackup,
          status: "confirmed",
          mnemonicDisplayedAt: new Date().toISOString(),
          confirmedAt: new Date().toISOString(),
        },
      }),
    );

    return { mnemonicPath, statePath };
  }

  it("archive moves mnemonic file and persists archived status", async () => {
    const { mnemonicPath, statePath } = await createAndConfirmWallet(tmpDir);

    expect(existsSync(mnemonicPath)).toBe(true);

    const result = await cleanup_mnemonic_file({
      action: "archive",
      stateFilePath: statePath,
    });

    if ("bootstrapRequired" in result) {
      throw new Error("expected cleanup to complete, got bootstrap guidance");
    }

    expect(result.completed).toBe(true);
    expect(result.action).toBe("archive");
    expect(result.walletBackupStatus).toBe("archived");
    expect(result.archivedPath).toBeTruthy();
    expect(existsSync(mnemonicPath)).toBe(false);
    expect(existsSync(String(result.archivedPath))).toBe(true);

    const state = await readRuntimeStateFile(statePath);
    expect(state.walletBackup.status).toBe("archived");
    expect(state.walletBackup.cleanedUpAt).toBeTruthy();
    expect(state.walletBackup.confirmedAt).toBeTruthy();
  });

  it("delete removes mnemonic file permanently and persists deleted status", async () => {
    const { mnemonicPath, statePath } = await createAndConfirmWallet(tmpDir);

    expect(existsSync(mnemonicPath)).toBe(true);

    const result = await cleanup_mnemonic_file({
      action: "delete",
      stateFilePath: statePath,
    });

    if ("bootstrapRequired" in result) {
      throw new Error("expected cleanup to complete, got bootstrap guidance");
    }

    expect(result.completed).toBe(true);
    expect(result.action).toBe("delete");
    expect(result.walletBackupStatus).toBe("deleted");
    expect(existsSync(mnemonicPath)).toBe(false);

    const state = await readRuntimeStateFile(statePath);
    expect(state.walletBackup.status).toBe("deleted");
    expect(state.walletBackup.cleanedUpAt).toBeTruthy();
  });

  it("lifecycle state survives restart after archive", async () => {
    const { statePath } = await createAndConfirmWallet(tmpDir);

    await cleanup_mnemonic_file({
      action: "archive",
      stateFilePath: statePath,
    });

    const afterRestart = await readRuntimeStateFile(statePath);
    expect(afterRestart.walletBackup.status).toBe("archived");
    expect(afterRestart.walletBackup.cleanedUpAt).toBeTruthy();
  });

  it("cleanup rejects when mnemonic file is already missing", async () => {
    const mnemonicPath = join(tmpDir, "mnemonic.txt");
    const statePath = join(tmpDir, "state.json");

    await create_wallet({ path: mnemonicPath, stateFilePath: statePath });

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

    rmSync(mnemonicPath);

    await expect(
      cleanup_mnemonic_file({ action: "archive", stateFilePath: statePath }),
    ).rejects.toThrow("Mnemonic file not found");
  });

  it("archive rejects when mnemonic file has unsafe permissions", async () => {
    const { mnemonicPath, statePath } = await createAndConfirmWallet(tmpDir);

    chmodSync(mnemonicPath, 0o644);

    await expect(
      cleanup_mnemonic_file({ action: "archive", stateFilePath: statePath }),
    ).rejects.toThrow("expected 600");

    expect(existsSync(mnemonicPath)).toBe(true);

    const state = await readRuntimeStateFile(statePath);
    expect(state.walletBackup.status).toBe("confirmed");
  });

  it("delete rejects when mnemonic file has unsafe permissions", async () => {
    const { mnemonicPath, statePath } = await createAndConfirmWallet(tmpDir);

    chmodSync(mnemonicPath, 0o755);

    await expect(
      cleanup_mnemonic_file({ action: "delete", stateFilePath: statePath }),
    ).rejects.toThrow("expected 600");

    expect(existsSync(mnemonicPath)).toBe(true);

    const state = await readRuntimeStateFile(statePath);
    expect(state.walletBackup.status).toBe("confirmed");
  });
});

describe("status snapshot exposes walletBackup lifecycle", () => {
  it("get_status includes walletBackup with current lifecycle state", async () => {
    let state: RuntimeState = {
      ...createRuntimeState({
        wallet: {
          address: "0x1234567890abcdef1234567890ABCDEF12345678",
          mnemonicFilePath: "/tmp/test-mnemonic.txt",
        },
        market: {
          venue: "hyperliquid",
          mode: "perp",
          marketId: "perps:hyperliquid:ETH",
          symbol: "ETH",
        },
      }),
      walletBackup: {
        status: "archived",
        mnemonicDisplayedAt: "2026-01-01T00:00:00.000Z",
        confirmedAt: "2026-01-01T00:01:00.000Z",
        cleanedUpAt: "2026-01-01T00:02:00.000Z",
      },
    };

    const service = new DaemonService(
      stubDaemonDeps({
        readState: async () => state,
        updateState: async (updater) => {
          state = updater(state);
          return state;
        },
      }),
    );

    const status = await service.getStatusSnapshot();
    expect(status.walletBackup).toBeDefined();
    expect(status.walletBackup.status).toBe("archived");
    expect(status.walletBackup.cleanedUpAt).toBe("2026-01-01T00:02:00.000Z");
    expect(status.walletBackup.confirmedAt).toBe("2026-01-01T00:01:00.000Z");
    expect(status.walletBackup.mnemonicDisplayedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("get_status reflects pending backup for fresh state", async () => {
    const state = createRuntimeState({
      wallet: {
        address: "0x1234567890abcdef1234567890ABCDEF12345678",
        mnemonicFilePath: "/tmp/test-mnemonic.txt",
      },
      market: {
        venue: "hyperliquid",
        mode: "perp",
        marketId: "perps:hyperliquid:ETH",
        symbol: "ETH",
      },
    });

    const service = new DaemonService(stubDaemonDeps({ readState: async () => state }));

    const status = await service.getStatusSnapshot();
    expect(status.walletBackup.status).toBe("pending");
    expect(status.walletBackup.cleanedUpAt).toBeNull();
  });
});
