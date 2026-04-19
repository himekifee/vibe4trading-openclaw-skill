import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DaemonService, stop_trading as engineStopTrading } from "../src/daemon/engine";
import type { DaemonDeps } from "../src/daemon/engine";
import { emergencyCancelAndClearDeadMan } from "../src/daemon/production-deps";
import { StateReadError, readRawRuntimeStateFile } from "../src/daemon/runtime-state-file";
import { createRuntimeState } from "../src/state";
import { stop_trading } from "../src/tools/stop-trading";

// ---------------------------------------------------------------------------
// Module-level mocks: keep real implementations except the seams the tool-level
// stop_trading() dispatches through.
// ---------------------------------------------------------------------------
vi.mock("../src/daemon/engine", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/daemon/engine")>();
  return { ...original, stop_trading: vi.fn() };
});

vi.mock("../src/daemon/runtime-state-file", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/daemon/runtime-state-file")>();
  return { ...original, readRawRuntimeStateFile: vi.fn() };
});

vi.mock("../src/daemon/production-deps", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/daemon/production-deps")>();
  return { ...original, emergencyCancelAndClearDeadMan: vi.fn() };
});

function stubDaemonDeps(overrides: Partial<DaemonDeps> = {}): DaemonDeps {
  const defaultState = createRuntimeState({
    wallet: {
      address: "0x1234567890abcdef1234567890ABCDEF12345678",
      privateKey: `0x${"ab".repeat(32)}`,
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
          url: "https://vibe4trading.ai/agents.md",
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
      judgmentSummary: "Hold",
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

describe("stop_trading: corrupt state behavior", () => {
  it("DaemonService.stopTrading throws StateReadError with PARSE_ERROR for corrupt state", async () => {
    const service = new DaemonService(
      stubDaemonDeps({
        readState: async () => {
          throw new StateReadError("corrupt", { code: "PARSE_ERROR" });
        },
      }),
    );

    await expect(service.stopTrading()).rejects.toThrow(StateReadError);
    try {
      await service.stopTrading();
    } catch (error) {
      expect(error).toBeInstanceOf(StateReadError);
      expect((error as StateReadError).code).toBe("PARSE_ERROR");
    }
  });

  it("DaemonService.stopTrading throws StateReadError with ENOENT for missing state", async () => {
    const service = new DaemonService(
      stubDaemonDeps({
        readState: async () => {
          throw new StateReadError("missing", { code: "ENOENT" });
        },
      }),
    );

    try {
      await service.stopTrading();
    } catch (error) {
      expect(error).toBeInstanceOf(StateReadError);
      expect((error as StateReadError).code).toBe("ENOENT");
    }
  });
});

describe("stop_trading tool: ENOENT → bootstrap guidance", () => {
  beforeEach(() => {
    vi.mocked(engineStopTrading).mockRejectedValue(
      new StateReadError("missing", { code: "ENOENT" }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns bootstrap guidance with correct shape", async () => {
    const result = await stop_trading();

    expect(result).toMatchObject({
      bootstrapRequired: true,
      reason: "runtime-state-missing",
    });
    expect(result).toHaveProperty("currentSlot");
    expect(result).toHaveProperty("network");
    expect(result).toHaveProperty("message");
    expect(result).toHaveProperty("nextActions");
  });

  it("includes actionable next steps in bootstrap guidance", async () => {
    const result = (await stop_trading()) as {
      nextActions: readonly { tool: string; description: string }[];
    };

    expect(result.nextActions.length).toBeGreaterThan(0);
    expect(result.nextActions[0]).toHaveProperty("tool");
    expect(result.nextActions[0]).toHaveProperty("description");
  });

  it("does not attempt emergency cleanup for missing state", async () => {
    await stop_trading();

    expect(readRawRuntimeStateFile).not.toHaveBeenCalled();
    expect(emergencyCancelAndClearDeadMan).not.toHaveBeenCalled();
  });
});

describe("stop_trading tool: PARSE_ERROR → corruptState result", () => {
  beforeEach(() => {
    vi.mocked(engineStopTrading).mockRejectedValue(
      new StateReadError("corrupt", { code: "PARSE_ERROR" }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns corruptState result with correct shape", async () => {
    vi.mocked(readRawRuntimeStateFile).mockResolvedValue(null);

    const result = await stop_trading();

    expect(result).toMatchObject({
      corruptState: true,
      reason: "runtime-state-unreadable",
    });
    expect(result).toHaveProperty("currentSlot");
    expect(result).toHaveProperty("network");
    expect(result).toHaveProperty("message");
    expect(result).toHaveProperty("recoveredInfo");
    expect(result).toHaveProperty("emergencyCleanup");
  });

  it("skips emergency cleanup when no wallet info is recoverable", async () => {
    vi.mocked(readRawRuntimeStateFile).mockResolvedValue(null);

    const result = (await stop_trading()) as {
      emergencyCleanup: unknown;
      recoveredInfo: unknown;
    };

    expect(emergencyCancelAndClearDeadMan).not.toHaveBeenCalled();
    expect(result.recoveredInfo).toBeNull();
    expect(result.emergencyCleanup).toBeNull();
  });

  it("attempts emergency cleanup when wallet address and privateKey are recoverable", async () => {
    vi.mocked(readRawRuntimeStateFile).mockResolvedValue({
      walletAddress: "0xABCD",
      privateKey: `0x${"ab".repeat(32)}`,
      marketId: "perps:hyperliquid:ETH",
      marketSymbol: "ETH",
    });
    vi.mocked(emergencyCancelAndClearDeadMan).mockResolvedValue({
      cancelAttempted: true,
      cancelledCount: 1,
      clearDeadManAttempted: true,
      errors: [],
    });

    const result = (await stop_trading()) as {
      emergencyCleanup: {
        cancelAttempted: boolean;
        cancelledCount: number;
        clearDeadManAttempted: boolean;
        errors: readonly string[];
      };
      recoveredInfo: { walletAddress: string; privateKey: string };
    };

    expect(emergencyCancelAndClearDeadMan).toHaveBeenCalledWith("0xABCD", `0x${"ab".repeat(32)}`);
    expect(result.emergencyCleanup).toMatchObject({
      cancelAttempted: true,
      cancelledCount: 1,
      clearDeadManAttempted: true,
    });
    expect(result.recoveredInfo).toMatchObject({
      walletAddress: "0xABCD",
      privateKey: `0x${"ab".repeat(32)}`,
    });
  });

  it("tolerates emergency cleanup failure and still returns corruptState result", async () => {
    vi.mocked(readRawRuntimeStateFile).mockResolvedValue({
      walletAddress: "0xABCD",
      privateKey: `0x${"ab".repeat(32)}`,
      marketId: null,
      marketSymbol: null,
    });
    vi.mocked(emergencyCancelAndClearDeadMan).mockRejectedValue(new Error("network down"));

    const result = (await stop_trading()) as {
      corruptState: boolean;
      emergencyCleanup: unknown;
    };

    expect(result.corruptState).toBe(true);
    expect(result.emergencyCleanup).toBeNull();
  });

  it("skips cleanup when walletAddress present but privateKey missing", async () => {
    vi.mocked(readRawRuntimeStateFile).mockResolvedValue({
      walletAddress: "0xABCD",
      privateKey: null,
      marketId: null,
      marketSymbol: null,
    });

    const result = (await stop_trading()) as { emergencyCleanup: unknown };

    expect(emergencyCancelAndClearDeadMan).not.toHaveBeenCalled();
    expect(result.emergencyCleanup).toBeNull();
  });
});

describe("stop_trading tool: non-StateReadError propagation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-throws errors that are not StateReadError", async () => {
    vi.mocked(engineStopTrading).mockRejectedValue(new Error("unexpected"));

    await expect(stop_trading()).rejects.toThrow("unexpected");
  });
});
