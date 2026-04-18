import { describe, expect, it, vi } from "vitest";

import * as bridgeGuards from "../src/chain/bridge-guards";
import type { SingleMarketConfig } from "../src/config/market";
import {
  confirmPendingTransfer,
  createIdempotencyKey,
  depositToHyperliquid,
  getOnboardingStatus,
  hasDuplicateIdempotencyKey,
  prepareCollateralForPerp,
  reconcileWithCollateralPrep,
  refreshPendingBridgeTransfers,
  requiresCollateralPrep,
} from "../src/onboarding/deposit";
import type {
  CollateralPrepDeps,
  DepositDeps,
  PendingBridgeTransfer,
} from "../src/onboarding/deposit";
import type { RuntimeState } from "../src/state/runtime-state";

function makeState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    wallet: { address: "0x1234567890abcdef1234567890abcdef12345678", mnemonicFilePath: "/tmp/m" },
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
      status: "pending",
      mnemonicDisplayedAt: null,
      confirmedAt: null,
      cleanedUpAt: null,
    },
    liveTradingConsent: {
      acknowledged: false,
      acknowledgedAt: null,
    },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DepositDeps> = {}): DepositDeps {
  return {
    getUsdcBalance: vi.fn().mockResolvedValue({ formatted: "50" }),
    getUsdtBalance: vi.fn().mockResolvedValue({ formatted: "0" }),
    getEthBalance: vi.fn().mockResolvedValue({ wei: 1_000_000_000_000_000n }),
    estimateBridgeGas: vi.fn().mockResolvedValue({ totalCostWei: 100_000_000_000_000n }),
    convertUsdtToUsdc: vi.fn().mockResolvedValue({
      kind: "converted",
      amountInUsdt: "0",
      quotedAmountOutUsdc: "0",
      amountOutMinimumUsdc: "0",
      approvalResetTxHash: "0xapprove-reset",
      approvalAmountTxHash: "0xapprove-amount",
      swapTxHash: "0xswap",
    }),
    submitBridgeTransfer: vi.fn().mockResolvedValue({ txHash: "0xabc123" }),
    confirmBridgeTransfer: vi.fn().mockResolvedValue({ status: "confirmed" }),
    ...overrides,
  };
}

describe("getOnboardingStatus", () => {
  it("returns ready status for funded wallet", async () => {
    const state = makeState();
    const deps = makeDeps();
    const result = await getOnboardingStatus(state, deps, []);
    expect(result.status).toBe("ready");
    expect(result.bridgeableAmount).toBeTruthy();
  });

  it("treats combined USDC and USDT balances as bridgeable funding", async () => {
    const state = makeState();
    const deps = makeDeps({
      getUsdcBalance: vi.fn().mockResolvedValue({ formatted: "0" }),
      getUsdtBalance: vi.fn().mockResolvedValue({ formatted: "12" }),
    });

    const result = await getOnboardingStatus(state, deps, []);

    expect(result.status).toBe("ready");
    expect(result.bridgeableAmount).toBe("12");
    expect(result.message).toContain("convertible USDT");
  });

  it("returns unfunded when balance fetch fails", async () => {
    const state = makeState();
    const deps = makeDeps({
      getUsdcBalance: vi.fn().mockRejectedValue(new Error("RPC down")),
    });
    const result = await getOnboardingStatus(state, deps, []);
    expect(result.status).toBe("unfunded");
    expect(result.message).toContain("Unable to fetch");
  });

  it("reports pending when transfers exist", async () => {
    const state = makeState();
    const deps = makeDeps();
    const pending: PendingBridgeTransfer[] = [
      {
        idempotencyKey: "k1",
        txHash: "0x111",
        amountUsdc: "10",
        submittedAt: new Date().toISOString(),
      },
    ];
    const result = await getOnboardingStatus(state, deps, pending);
    expect(result.status).toBe("pending_confirmation");
  });

  it("reports real cumulative totals while override remains persisted until reset", async () => {
    const state = makeState({
      cumulativeBridgeUsd: "150",
      bridgeHistory: [
        { transferId: "t1", amountUsd: "150", confirmedAt: "2026-01-01T00:00:00.000Z" },
      ],
      overridePhraseAccepted: true,
    });
    const deps = makeDeps({
      getUsdcBalance: vi.fn().mockResolvedValue({ formatted: "200" }),
    });

    const result = await getOnboardingStatus(state, deps, []);

    expect(result.status).toBe("ready");
    expect(result.bridgeableAmount).toBe("200");
    expect(result.message).toContain("150 USDC");
    expect(result.message).toContain("remaining headroom: 0 USDC");
    expect(result.message).toContain("reset_override_phrase");
  });
});

describe("depositToHyperliquid", () => {
  it("submits bridge transfer for funded wallet", async () => {
    const state = makeState();
    const deps = makeDeps();
    const pending: PendingBridgeTransfer[] = [];
    const result = await depositToHyperliquid(state, deps, pending);
    expect(result.kind).toBe("submitted");
    if (result.kind === "submitted") {
      expect(result.pending.txHash).toBe("0xabc123");
      expect(result.pending.amountUsdc).toBe("50");
      expect(pending).toHaveLength(1);
      expect(result.updatedState.pendingBridgeTransfers).toEqual(pending);
    }
  });

  it("blocks when pending transfer already exists", async () => {
    const state = makeState();
    const deps = makeDeps();
    const pending: PendingBridgeTransfer[] = [
      {
        idempotencyKey: "k1",
        txHash: "0x111",
        amountUsdc: "10",
        submittedAt: new Date().toISOString(),
      },
    ];
    const result = await depositToHyperliquid(state, deps, pending);
    expect(result.kind).toBe("already_pending");
  });

  it("blocks when cumulative would exceed cap without override", async () => {
    const state = makeState({
      cumulativeBridgeUsd: "96",
      bridgeHistory: [
        { transferId: "t1", amountUsd: "96", confirmedAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const deps = makeDeps({
      getUsdcBalance: vi.fn().mockResolvedValue({ formatted: "20" }),
    });
    const pending: PendingBridgeTransfer[] = [];
    const result = await depositToHyperliquid(state, deps, pending);
    expect(result.kind).toBe("cap_blocked");
  });

  it("allows bridge when override phrase accepted even over cap", async () => {
    const state = makeState({
      cumulativeBridgeUsd: "90",
      bridgeHistory: [
        { transferId: "t1", amountUsd: "90", confirmedAt: "2026-01-01T00:00:00.000Z" },
      ],
      overridePhraseAccepted: true,
    });
    const deps = makeDeps({
      getUsdcBalance: vi.fn().mockResolvedValue({ formatted: "20" }),
    });
    const pending: PendingBridgeTransfer[] = [];
    const result = await depositToHyperliquid(state, deps, pending);
    expect(result.kind).toBe("submitted");
  });

  it("returns not_ready when wallet is unfunded", async () => {
    const state = makeState();
    const deps = makeDeps({
      getUsdcBalance: vi.fn().mockResolvedValue({ formatted: "0" }),
    });
    const pending: PendingBridgeTransfer[] = [];
    const result = await depositToHyperliquid(state, deps, pending);
    expect(result.kind).toBe("not_ready");
  });

  it("returns preflight_failed when gas insufficient for requested amount", async () => {
    const state = makeState();
    const deps = makeDeps({
      getEthBalance: vi.fn().mockResolvedValue({ wei: 0n }),
    });
    const pending: PendingBridgeTransfer[] = [];
    const result = await depositToHyperliquid(state, deps, pending);
    expect(result.kind).toBe("not_ready");
  });

  it("converts only the USDT shortfall before bridging", async () => {
    const convertUsdtToUsdc = vi.fn().mockResolvedValue({
      kind: "converted",
      amountInUsdt: "15",
      quotedAmountOutUsdc: "15.02",
      amountOutMinimumUsdc: "15.00498",
      approvalResetTxHash: "0xapprove-reset",
      approvalAmountTxHash: "0xapprove-amount",
      swapTxHash: "0xswap",
    });
    const submitBridgeTransfer = vi.fn().mockResolvedValue({ txHash: "0xabc123" });
    const state = makeState();
    const getUsdcBalance = vi
      .fn()
      .mockResolvedValueOnce({ formatted: "5" })
      .mockResolvedValueOnce({ formatted: "5" })
      .mockResolvedValueOnce({ formatted: "20.02" });
    const deps = makeDeps({
      getUsdcBalance,
      getUsdtBalance: vi.fn().mockResolvedValue({ formatted: "20" }),
      convertUsdtToUsdc,
      submitBridgeTransfer,
    });

    const result = await depositToHyperliquid(state, deps, [], "20");

    expect(result.kind).toBe("submitted");
    expect(convertUsdtToUsdc).toHaveBeenCalledWith({
      walletAddress: state.wallet.address,
      amountUsdt: "15",
      minimumRequiredAmountOutUsdc: "15",
    });
    expect(submitBridgeTransfer).toHaveBeenCalledWith(state.wallet.address, "20");
    expect(convertUsdtToUsdc.mock.invocationCallOrder[0]).toBeLessThan(
      submitBridgeTransfer.mock.invocationCallOrder[0],
    );
  });

  it("blocks funding when USDT conversion fails", async () => {
    const convertUsdtToUsdc = vi.fn().mockResolvedValue({
      kind: "failed",
      failure: {
        code: "quote_failed",
        message:
          "Unable to quote Arbitrum USDT→USDC conversion via Uniswap V3 QuoterV2 (RPC timeout).",
      },
    });
    const submitBridgeTransfer = vi.fn().mockResolvedValue({ txHash: "0xabc123" });
    const state = makeState();
    const deps = makeDeps({
      getUsdcBalance: vi.fn().mockResolvedValue({ formatted: "5" }),
      getUsdtBalance: vi.fn().mockResolvedValue({ formatted: "20" }),
      convertUsdtToUsdc,
      submitBridgeTransfer,
    });

    const result = await depositToHyperliquid(state, deps, [], "20");

    expect(result.kind).toBe("conversion_failed");
    if (result.kind === "conversion_failed") {
      expect(result.code).toBe("quote_failed");
      expect(result.reason).toContain("Unable to quote Arbitrum USDT→USDC conversion");
    }
    expect(submitBridgeTransfer).not.toHaveBeenCalled();
  });
});

describe("confirmPendingTransfer", () => {
  it("returns no_pending when list is empty", async () => {
    const state = makeState();
    const deps = makeDeps();
    const result = await confirmPendingTransfer(state, deps, []);
    expect(result.kind).toBe("no_pending");
  });

  it("returns not_confirmed when transfer not yet confirmed", async () => {
    const state = makeState();
    const deps = makeDeps({
      confirmBridgeTransfer: vi.fn().mockResolvedValue({ status: "pending" }),
    });
    const pending: PendingBridgeTransfer[] = [
      {
        idempotencyKey: "k1",
        txHash: "0x111",
        amountUsdc: "10",
        submittedAt: new Date().toISOString(),
      },
    ];
    const result = await confirmPendingTransfer(state, deps, pending);
    expect(result.kind).toBe("not_confirmed");
    expect(pending).toHaveLength(1);
  });

  it("returns confirmed with updated state when transfer confirms", async () => {
    const state = makeState();
    const deps = makeDeps();
    const pending: PendingBridgeTransfer[] = [
      {
        idempotencyKey: "k1",
        txHash: "0x111",
        amountUsdc: "10",
        submittedAt: new Date().toISOString(),
      },
    ];
    const result = await confirmPendingTransfer(state, deps, pending);
    expect(result.kind).toBe("confirmed");
    if (result.kind === "confirmed") {
      expect(result.record.amountUsd).toBe("10");
      expect(result.record.transferId).toBe("k1");
      expect(result.updatedState.cumulativeBridgeUsd).toBe("10");
      expect(result.updatedState.bridgeHistory).toHaveLength(1);
      expect(result.updatedState.pendingBridgeTransfers).toEqual([]);
    }
    expect(pending).toHaveLength(0);
  });

  it("accumulates cumulative bridge total across multiple confirmations", async () => {
    const state = makeState({
      cumulativeBridgeUsd: "40",
      bridgeHistory: [
        { transferId: "t1", amountUsd: "40", confirmedAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const deps = makeDeps();
    const pending: PendingBridgeTransfer[] = [
      {
        idempotencyKey: "k2",
        txHash: "0x222",
        amountUsdc: "20",
        submittedAt: new Date().toISOString(),
      },
    ];
    const result = await confirmPendingTransfer(state, deps, pending);
    expect(result.kind).toBe("confirmed");
    if (result.kind === "confirmed") {
      expect(result.updatedState.cumulativeBridgeUsd).toBe("60");
      expect(result.updatedState.bridgeHistory).toHaveLength(2);
      expect(result.updatedState.pendingBridgeTransfers).toEqual([]);
    }
  });

  it("preserves confirmed totals until pending transfer confirms", async () => {
    const submittedAt = new Date().toISOString();
    const state = makeState({
      cumulativeBridgeUsd: "40",
      bridgeHistory: [
        { transferId: "t1", amountUsd: "40", confirmedAt: "2026-01-01T00:00:00.000Z" },
      ],
      pendingBridgeTransfers: [
        {
          idempotencyKey: "k2",
          txHash: "0x222",
          amountUsdc: "20",
          submittedAt,
        },
      ],
    });
    const deps = makeDeps({
      confirmBridgeTransfer: vi.fn().mockResolvedValue({ status: "pending" }),
    });

    expect(state.cumulativeBridgeUsd).toBe("40");
    expect(state.bridgeHistory).toHaveLength(1);
    expect(state.pendingBridgeTransfers).toEqual([
      {
        idempotencyKey: "k2",
        txHash: "0x222",
        amountUsdc: "20",
        submittedAt,
      },
    ]);

    const result = await confirmPendingTransfer(state, deps, [...state.pendingBridgeTransfers]);
    expect(result.kind).toBe("not_confirmed");
    expect(state.cumulativeBridgeUsd).toBe("40");
    expect(state.bridgeHistory).toHaveLength(1);
  });

  it("preserves real cumulative accounting even when override is active", async () => {
    const state = makeState({
      cumulativeBridgeUsd: "80",
      bridgeHistory: [
        { transferId: "t1", amountUsd: "80", confirmedAt: "2026-01-01T00:00:00.000Z" },
      ],
      overridePhraseAccepted: true,
    });
    const deps = makeDeps();
    const pending: PendingBridgeTransfer[] = [
      {
        idempotencyKey: "k3",
        txHash: "0x333",
        amountUsdc: "30",
        submittedAt: new Date().toISOString(),
      },
    ];

    const result = await confirmPendingTransfer(state, deps, pending);

    expect(result.kind).toBe("confirmed");
    if (result.kind === "confirmed") {
      expect(result.updatedState.overridePhraseAccepted).toBe(true);
      expect(result.updatedState.cumulativeBridgeUsd).toBe("110");
      expect(result.updatedState.bridgeHistory).toHaveLength(2);
    }
  });

  it("returns failed with txHash when bridge transfer is reverted", async () => {
    const state = makeState();
    const deps = makeDeps({
      confirmBridgeTransfer: vi.fn().mockResolvedValue({ status: "failed" }),
    });
    const pending: PendingBridgeTransfer[] = [
      {
        idempotencyKey: "k1",
        txHash: "0x111",
        amountUsdc: "10",
        submittedAt: new Date().toISOString(),
      },
    ];
    const result = await confirmPendingTransfer(state, deps, pending);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.txHash).toBe("0x111");
      expect(result.updatedState.pendingBridgeTransfers).toEqual([]);
    }
    expect(pending).toHaveLength(0);
  });

  it("returns unknown with reason when RPC transport fails", async () => {
    const state = makeState();
    const deps = makeDeps({
      confirmBridgeTransfer: vi
        .fn()
        .mockResolvedValue({ status: "unknown", reason: "RPC timeout" }),
    });
    const pending: PendingBridgeTransfer[] = [
      {
        idempotencyKey: "k1",
        txHash: "0x111",
        amountUsdc: "10",
        submittedAt: new Date().toISOString(),
      },
    ];
    const result = await confirmPendingTransfer(state, deps, pending);
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.reason).toBe("RPC timeout");
    }
    expect(pending).toHaveLength(1);
  });

  it("failed transfer does not alter cumulative bridge accounting", async () => {
    const state = makeState({
      cumulativeBridgeUsd: "40",
      bridgeHistory: [
        { transferId: "t1", amountUsd: "40", confirmedAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const deps = makeDeps({
      confirmBridgeTransfer: vi.fn().mockResolvedValue({ status: "failed" }),
    });
    const pending: PendingBridgeTransfer[] = [
      {
        idempotencyKey: "k2",
        txHash: "0x222",
        amountUsdc: "20",
        submittedAt: new Date().toISOString(),
      },
    ];
    const result = await confirmPendingTransfer(state, deps, pending);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.updatedState.cumulativeBridgeUsd).toBe("40");
      expect(result.updatedState.bridgeHistory).toHaveLength(1);
      expect(result.updatedState.pendingBridgeTransfers).toEqual([]);
    }
  });

  it("unknown status preserves pending list for retry", async () => {
    const state = makeState();
    const deps = makeDeps({
      confirmBridgeTransfer: vi
        .fn()
        .mockResolvedValue({ status: "unknown", reason: "ECONNREFUSED" }),
    });
    const pending: PendingBridgeTransfer[] = [
      {
        idempotencyKey: "k1",
        txHash: "0x111",
        amountUsdc: "10",
        submittedAt: new Date().toISOString(),
      },
    ];
    const result = await confirmPendingTransfer(state, deps, pending);
    expect(result.kind).toBe("unknown");
    expect(pending).toHaveLength(1);
  });
});

describe("refreshPendingBridgeTransfers", () => {
  it("returns unchanged state when no pending transfers exist", async () => {
    const state = makeState();
    const deps = makeDeps();

    const result = await refreshPendingBridgeTransfers(state, deps);

    expect(result).toEqual({ kind: "unchanged", state });
  });

  it("returns confirmed state and clears pending transfers after confirmation", async () => {
    const state = makeState({
      pendingBridgeTransfers: [
        {
          idempotencyKey: "k1",
          txHash: "0x111",
          amountUsdc: "10",
          submittedAt: new Date().toISOString(),
        },
      ],
    });
    const deps = makeDeps();

    const result = await refreshPendingBridgeTransfers(state, deps);

    expect(result.kind).toBe("confirmed");
    if (result.kind === "confirmed") {
      expect(result.state.pendingBridgeTransfers).toEqual([]);
      expect(result.state.cumulativeBridgeUsd).toBe("10");
      expect(result.state.bridgeHistory).toHaveLength(1);
    }
  });

  it("surfaces failed status with txHash when bridge transfer reverted", async () => {
    const state = makeState({
      pendingBridgeTransfers: [
        {
          idempotencyKey: "k1",
          txHash: "0xreverted",
          amountUsdc: "10",
          submittedAt: new Date().toISOString(),
        },
      ],
    });
    const deps = makeDeps({
      confirmBridgeTransfer: vi.fn().mockResolvedValue({ status: "failed" }),
    });

    const result = await refreshPendingBridgeTransfers(state, deps);

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.txHash).toBe("0xreverted");
      expect(result.state.pendingBridgeTransfers).toEqual([]);
    }
  });

  it("surfaces unknown status with reason when RPC transport fails", async () => {
    const state = makeState({
      pendingBridgeTransfers: [
        {
          idempotencyKey: "k1",
          txHash: "0x111",
          amountUsdc: "10",
          submittedAt: new Date().toISOString(),
        },
      ],
    });
    const deps = makeDeps({
      confirmBridgeTransfer: vi
        .fn()
        .mockResolvedValue({ status: "unknown", reason: "ECONNREFUSED" }),
    });

    const result = await refreshPendingBridgeTransfers(state, deps);

    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.reason).toBe("ECONNREFUSED");
      expect(result.state).toBe(state);
    }
  });

  it("returns unchanged when confirmation is still pending", async () => {
    const state = makeState({
      pendingBridgeTransfers: [
        {
          idempotencyKey: "k1",
          txHash: "0x111",
          amountUsdc: "10",
          submittedAt: new Date().toISOString(),
        },
      ],
    });
    const deps = makeDeps({
      confirmBridgeTransfer: vi.fn().mockResolvedValue({ status: "pending" }),
    });

    const result = await refreshPendingBridgeTransfers(state, deps);

    expect(result.kind).toBe("unchanged");
    expect(result.state).toBe(state);
  });
});

describe("override bypass verification", () => {
  it("override=true bypasses cumulative cap even when far above limit", async () => {
    const preflightSpy = vi.spyOn(bridgeGuards, "checkBridgePreflight");
    const state = makeState({
      cumulativeBridgeUsd: "500",
      bridgeHistory: [
        { transferId: "t1", amountUsd: "500", confirmedAt: "2026-01-01T00:00:00.000Z" },
      ],
      overridePhraseAccepted: true,
    });
    const deps = makeDeps({
      getUsdcBalance: vi.fn().mockResolvedValue({ formatted: "50" }),
    });
    const pending: PendingBridgeTransfer[] = [];
    const result = await depositToHyperliquid(state, deps, pending);
    expect(result.kind).toBe("submitted");
    if (result.kind === "submitted") {
      expect(result.pending.amountUsdc).toBe("50");
    }
    expect(preflightSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        amountUsdc: "50",
        cumulativeBridgeUsd: "500",
        overridePhraseAccepted: true,
      }),
    );
    preflightSpy.mockRestore();
  });

  it("override=false blocks deposit when requestedAmount pushes cumulative over cap", async () => {
    // 80 already bridged; requesting 50 → projected 130, above 100 cap
    const state = makeState({
      cumulativeBridgeUsd: "80",
      bridgeHistory: [
        { transferId: "t1", amountUsd: "80", confirmedAt: "2026-01-01T00:00:00.000Z" },
      ],
      overridePhraseAccepted: false,
    });
    const deps = makeDeps({
      getUsdcBalance: vi.fn().mockResolvedValue({ formatted: "50" }),
    });
    const pending: PendingBridgeTransfer[] = [];
    const result = await depositToHyperliquid(state, deps, pending, "50");
    expect(result.kind).toBe("cap_blocked");
    if (result.kind === "cap_blocked") {
      expect(result.reason).toContain("130");
      expect(result.reason).toContain("100");
      expect(result.reason).toContain("override");
    }
  });

  it("override=true with same state as blocked test results in submitted", async () => {
    const state = makeState({
      cumulativeBridgeUsd: "80",
      bridgeHistory: [
        { transferId: "t1", amountUsd: "80", confirmedAt: "2026-01-01T00:00:00.000Z" },
      ],
      overridePhraseAccepted: true,
    });
    const deps = makeDeps({
      getUsdcBalance: vi.fn().mockResolvedValue({ formatted: "50" }),
    });
    const pending: PendingBridgeTransfer[] = [];
    const result = await depositToHyperliquid(state, deps, pending, "50");
    expect(result.kind).toBe("submitted");
    if (result.kind === "submitted") {
      expect(result.pending.amountUsdc).toBe("50");
    }
  });

  it("override=false allows deposit when projected stays under cap", async () => {
    // 40 already bridged + 50 = 90, under 100 cap → should pass even without override
    const state = makeState({
      cumulativeBridgeUsd: "40",
      bridgeHistory: [
        { transferId: "t1", amountUsd: "40", confirmedAt: "2026-01-01T00:00:00.000Z" },
      ],
      overridePhraseAccepted: false,
    });
    const deps = makeDeps({
      getUsdcBalance: vi.fn().mockResolvedValue({ formatted: "50" }),
    });
    const pending: PendingBridgeTransfer[] = [];
    const result = await depositToHyperliquid(state, deps, pending);
    expect(result.kind).toBe("submitted");
    if (result.kind === "submitted") {
      expect(result.pending.amountUsdc).toBe("50");
    }
  });

  it("override=false blocks at exact cap boundary", async () => {
    // 100 already bridged, any new amount would exceed → blocked
    const state = makeState({
      cumulativeBridgeUsd: "100",
      bridgeHistory: [
        { transferId: "t1", amountUsd: "100", confirmedAt: "2026-01-01T00:00:00.000Z" },
      ],
      overridePhraseAccepted: false,
    });
    const deps = makeDeps({
      getUsdcBalance: vi.fn().mockResolvedValue({ formatted: "10" }),
    });
    const pending: PendingBridgeTransfer[] = [];
    const result = await depositToHyperliquid(state, deps, pending);
    // Status classifier should see cap_exceeded_no_override before we even get to the deposit cap check
    expect(result.kind).toBe("cap_blocked");
  });

  it("override=true submits even at exact cap boundary", async () => {
    const state = makeState({
      cumulativeBridgeUsd: "100",
      bridgeHistory: [
        { transferId: "t1", amountUsd: "100", confirmedAt: "2026-01-01T00:00:00.000Z" },
      ],
      overridePhraseAccepted: true,
    });
    const deps = makeDeps({
      getUsdcBalance: vi.fn().mockResolvedValue({ formatted: "10" }),
    });
    const pending: PendingBridgeTransfer[] = [];
    const result = await depositToHyperliquid(state, deps, pending);
    expect(result.kind).toBe("submitted");
    if (result.kind === "submitted") {
      expect(result.pending.amountUsdc).toBe("10");
    }
  });
});

describe("idempotency helpers", () => {
  it("creates unique idempotency keys", () => {
    const key1 = createIdempotencyKey("0xabc", "10");
    const key2 = createIdempotencyKey("0xabc", "10");
    expect(key1).not.toBe(key2);
    expect(key1).toContain("bridge:0xabc:10:");
  });

  it("detects duplicate keys", () => {
    const pending: PendingBridgeTransfer[] = [
      {
        idempotencyKey: "bridge:0xabc:10:uuid1",
        txHash: "0x111",
        amountUsdc: "10",
        submittedAt: new Date().toISOString(),
      },
    ];
    expect(hasDuplicateIdempotencyKey(pending, "bridge:0xabc:10:uuid1")).toBe(true);
    expect(hasDuplicateIdempotencyKey(pending, "bridge:0xabc:10:uuid2")).toBe(false);
  });
});

describe("funding orchestration", () => {
  it("uses USDC directly without conversion when wallet holds only USDC", async () => {
    const convertUsdtToUsdc = vi.fn();
    const submitBridgeTransfer = vi.fn().mockResolvedValue({ txHash: "0xabc123" });
    const state = makeState();
    const deps = makeDeps({
      getUsdcBalance: vi.fn().mockResolvedValue({ formatted: "30" }),
      getUsdtBalance: vi.fn().mockResolvedValue({ formatted: "0" }),
      convertUsdtToUsdc,
      submitBridgeTransfer,
    });

    const result = await depositToHyperliquid(state, deps, []);

    expect(result.kind).toBe("submitted");
    expect(convertUsdtToUsdc).not.toHaveBeenCalled();
    expect(submitBridgeTransfer).toHaveBeenCalledWith(state.wallet.address, "30");
    if (result.kind === "submitted") {
      expect(result.conversion).toBeUndefined();
    }
  });

  it("uses available USDC first and converts only exact USDT shortfall", async () => {
    const convertUsdtToUsdc = vi.fn().mockResolvedValue({
      kind: "converted",
      amountInUsdt: "10",
      quotedAmountOutUsdc: "10.01",
      amountOutMinimumUsdc: "9.999",
      approvalResetTxHash: "0xapprove-reset",
      approvalAmountTxHash: "0xapprove-amount",
      swapTxHash: "0xswap-hash",
    });
    const submitBridgeTransfer = vi.fn().mockResolvedValue({ txHash: "0xbridge" });
    const state = makeState();
    const getUsdcBalance = vi
      .fn()
      .mockResolvedValueOnce({ formatted: "20" })
      .mockResolvedValueOnce({ formatted: "20" })
      .mockResolvedValueOnce({ formatted: "30.01" });
    const deps = makeDeps({
      getUsdcBalance,
      getUsdtBalance: vi.fn().mockResolvedValue({ formatted: "15" }),
      convertUsdtToUsdc,
      submitBridgeTransfer,
    });

    const result = await depositToHyperliquid(state, deps, [], "30");

    expect(result.kind).toBe("submitted");
    expect(convertUsdtToUsdc).toHaveBeenCalledWith({
      walletAddress: state.wallet.address,
      amountUsdt: "10",
      minimumRequiredAmountOutUsdc: "10",
    });
    if (result.kind === "submitted") {
      expect(result.conversion).toEqual({
        amountInUsdt: "10",
        amountOutUsdc: "10.01",
        swapTxHash: "0xswap-hash",
      });
    }
  });

  it("blocks with insufficient_gas when fresh fetch reveals gas shortage", async () => {
    const getEthBalance = vi
      .fn()
      .mockResolvedValueOnce({ wei: 1_000_000_000_000_000n })
      .mockResolvedValueOnce({ wei: 0n });
    const submitBridgeTransfer = vi.fn();
    const state = makeState();
    const deps = makeDeps({
      getEthBalance,
      submitBridgeTransfer,
    });

    const result = await depositToHyperliquid(state, deps, []);

    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.code).toBe("insufficient_gas");
      expect(result.reason).toContain("Send ETH");
      expect(result.reason).toContain("Arbitrum");
    }
    expect(submitBridgeTransfer).not.toHaveBeenCalled();
  });

  it("blocks with below_minimum when combined stablecoins below minimum bridge", async () => {
    const getUsdcBalance = vi
      .fn()
      .mockResolvedValueOnce({ formatted: "50" })
      .mockResolvedValueOnce({ formatted: "2" });
    const getUsdtBalance = vi
      .fn()
      .mockResolvedValueOnce({ formatted: "50" })
      .mockResolvedValueOnce({ formatted: "2" });
    const submitBridgeTransfer = vi.fn();
    const state = makeState();
    const deps = makeDeps({
      getUsdcBalance,
      getUsdtBalance,
      submitBridgeTransfer,
    });

    const result = await depositToHyperliquid(state, deps, []);

    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.code).toBe("below_minimum");
      expect(result.reason).toContain("5.01");
      expect(result.reason).toContain("Fund the wallet");
    }
    expect(submitBridgeTransfer).not.toHaveBeenCalled();
  });

  it("blocks with insufficient_balance when combined stablecoins below requested amount", async () => {
    const getUsdcBalance = vi
      .fn()
      .mockResolvedValueOnce({ formatted: "50" })
      .mockResolvedValueOnce({ formatted: "10" });
    const getUsdtBalance = vi
      .fn()
      .mockResolvedValueOnce({ formatted: "50" })
      .mockResolvedValueOnce({ formatted: "5" });
    const submitBridgeTransfer = vi.fn();
    const state = makeState();
    const deps = makeDeps({
      getUsdcBalance,
      getUsdtBalance,
      submitBridgeTransfer,
    });

    const result = await depositToHyperliquid(state, deps, [], "20");

    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.code).toBe("insufficient_balance");
      expect(result.reason).toContain("20 USDC total");
      expect(result.reason).toContain("15 combined");
    }
    expect(submitBridgeTransfer).not.toHaveBeenCalled();
  });

  it("conversion failure blocks bridge and does not submit", async () => {
    const convertUsdtToUsdc = vi.fn().mockResolvedValue({
      kind: "failed",
      failure: {
        code: "swap_reverted",
        message: "Swap transaction reverted on-chain (slippage exceeded).",
      },
    });
    const submitBridgeTransfer = vi.fn();
    const state = makeState();
    const deps = makeDeps({
      getUsdcBalance: vi.fn().mockResolvedValue({ formatted: "5" }),
      getUsdtBalance: vi.fn().mockResolvedValue({ formatted: "25" }),
      convertUsdtToUsdc,
      submitBridgeTransfer,
    });

    const result = await depositToHyperliquid(state, deps, [], "20");

    expect(result.kind).toBe("conversion_failed");
    if (result.kind === "conversion_failed") {
      expect(result.code).toBe("swap_reverted");
      expect(result.reason).toContain("slippage");
    }
    expect(submitBridgeTransfer).not.toHaveBeenCalled();
  });

  it("enforces single pending deposit by rejecting second submission", async () => {
    const state = makeState();
    const deps = makeDeps();
    const pending: PendingBridgeTransfer[] = [];

    const first = await depositToHyperliquid(state, deps, pending);
    expect(first.kind).toBe("submitted");
    expect(pending).toHaveLength(1);

    const second = await depositToHyperliquid(state, deps, pending);
    expect(second.kind).toBe("already_pending");
    expect(pending).toHaveLength(1);
  });

  it("USDT-only wallet converts full amount before bridging", async () => {
    const convertUsdtToUsdc = vi.fn().mockResolvedValue({
      kind: "converted",
      amountInUsdt: "25",
      quotedAmountOutUsdc: "25.02",
      amountOutMinimumUsdc: "24.975",
      approvalResetTxHash: "0xapprove-reset",
      approvalAmountTxHash: "0xapprove-amount",
      swapTxHash: "0xswap",
    });
    const submitBridgeTransfer = vi.fn().mockResolvedValue({ txHash: "0xbridge" });
    const state = makeState();
    const getUsdcBalance = vi
      .fn()
      .mockResolvedValueOnce({ formatted: "0" })
      .mockResolvedValueOnce({ formatted: "0" })
      .mockResolvedValueOnce({ formatted: "25.02" });
    const deps = makeDeps({
      getUsdcBalance,
      getUsdtBalance: vi.fn().mockResolvedValue({ formatted: "25" }),
      convertUsdtToUsdc,
      submitBridgeTransfer,
    });

    const result = await depositToHyperliquid(state, deps, [], "25");

    expect(result.kind).toBe("submitted");
    expect(convertUsdtToUsdc).toHaveBeenCalledWith({
      walletAddress: state.wallet.address,
      amountUsdt: "25",
      minimumRequiredAmountOutUsdc: "25",
    });
    expect(submitBridgeTransfer).toHaveBeenCalledWith(state.wallet.address, "25");
    if (result.kind === "submitted") {
      expect(result.conversion).toBeDefined();
      expect(result.conversion?.amountInUsdt).toBe("25");
    }
  });
});

function makePerpMarket(): SingleMarketConfig {
  return {
    venue: "hyperliquid",
    mode: "perp",
    marketId: "perps:hyperliquid:ETH",
    symbol: "ETH",
  };
}

function makeSpotMarket(): SingleMarketConfig {
  return {
    venue: "hyperliquid",
    mode: "spot",
    marketId: "spot:hyperliquid:ETH/USDC",
    symbol: "ETH/USDC",
  };
}

function makeCollateralDeps(overrides: Partial<CollateralPrepDeps> = {}): CollateralPrepDeps {
  return {
    transferBetweenPerpAndSpot: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

describe("requiresCollateralPrep", () => {
  it("returns true for perp market", () => {
    expect(requiresCollateralPrep(makePerpMarket())).toBe(true);
  });

  it("returns false for spot market", () => {
    expect(requiresCollateralPrep(makeSpotMarket())).toBe(false);
  });
});

describe("prepareCollateralForPerp", () => {
  it("transfers confirmed bridge amount to perp context for perp market", async () => {
    const deps = makeCollateralDeps();
    const result = await prepareCollateralForPerp(makePerpMarket(), deps, "50");

    expect(result.kind).toBe("prepared");
    if (result.kind === "prepared") {
      expect(result.amountUsd).toBe("50");
    }
    expect(deps.transferBetweenPerpAndSpot).toHaveBeenCalledWith("50", true);
  });

  it("returns skipped_spot for spot market without calling transfer", async () => {
    const deps = makeCollateralDeps();
    const result = await prepareCollateralForPerp(makeSpotMarket(), deps, "50");

    expect(result.kind).toBe("skipped_spot");
    expect(deps.transferBetweenPerpAndSpot).not.toHaveBeenCalled();
  });

  it("returns skipped_no_balance when confirmed amount is zero", async () => {
    const deps = makeCollateralDeps();
    const result = await prepareCollateralForPerp(makePerpMarket(), deps, "0");

    expect(result.kind).toBe("skipped_no_balance");
    expect(deps.transferBetweenPerpAndSpot).not.toHaveBeenCalled();
  });

  it("returns failed when transfer returns unsuccessful", async () => {
    const deps = makeCollateralDeps({
      transferBetweenPerpAndSpot: vi.fn().mockResolvedValue({ success: false }),
    });
    const result = await prepareCollateralForPerp(makePerpMarket(), deps, "50");

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toContain("returned unsuccessful");
    }
  });

  it("returns failed with message when transfer throws", async () => {
    const deps = makeCollateralDeps({
      transferBetweenPerpAndSpot: vi.fn().mockRejectedValue(new Error("exchange error")),
    });
    const result = await prepareCollateralForPerp(makePerpMarket(), deps, "50");

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toContain("exchange error");
    }
  });

  it("uses exact confirmed amount instead of sweeping total balance", async () => {
    const deps = makeCollateralDeps();
    const result = await prepareCollateralForPerp(makePerpMarket(), deps, "25.50");

    expect(result.kind).toBe("prepared");
    if (result.kind === "prepared") {
      expect(result.amountUsd).toBe("25.50");
    }
    expect(deps.transferBetweenPerpAndSpot).toHaveBeenCalledWith("25.50", true);
  });
});

describe("reconcileWithCollateralPrep", () => {
  it("chains bridge confirmation and collateral prep for perp market", async () => {
    const state = makeState({
      pendingBridgeTransfers: [
        {
          idempotencyKey: "k1",
          txHash: "0x111",
          amountUsdc: "50",
          submittedAt: new Date().toISOString(),
        },
      ],
    });
    const bridgeDeps = {
      confirmBridgeTransfer: vi.fn().mockResolvedValue({ status: "confirmed" }),
    };
    const collateralDeps = makeCollateralDeps();

    const result = await reconcileWithCollateralPrep(
      state,
      bridgeDeps,
      collateralDeps,
      makePerpMarket(),
    );

    expect(result.bridgeResult.kind).toBe("confirmed");
    expect(result.collateralResult).not.toBeNull();
    expect(result.collateralResult?.kind).toBe("prepared");
    expect(collateralDeps.transferBetweenPerpAndSpot).toHaveBeenCalledWith("50", true);
  });

  it("skips collateral prep for spot market after bridge confirmation", async () => {
    const state = makeState({
      pendingBridgeTransfers: [
        {
          idempotencyKey: "k1",
          txHash: "0x111",
          amountUsdc: "50",
          submittedAt: new Date().toISOString(),
        },
      ],
    });
    const bridgeDeps = {
      confirmBridgeTransfer: vi.fn().mockResolvedValue({ status: "confirmed" }),
    };
    const collateralDeps = makeCollateralDeps();

    const result = await reconcileWithCollateralPrep(
      state,
      bridgeDeps,
      collateralDeps,
      makeSpotMarket(),
    );

    expect(result.bridgeResult.kind).toBe("confirmed");
    expect(result.collateralResult).toBeNull();
    expect(collateralDeps.transferBetweenPerpAndSpot).not.toHaveBeenCalled();
  });

  it("returns null collateral result when bridge is still pending", async () => {
    const state = makeState({
      pendingBridgeTransfers: [
        {
          idempotencyKey: "k1",
          txHash: "0x111",
          amountUsdc: "50",
          submittedAt: new Date().toISOString(),
        },
      ],
    });
    const bridgeDeps = {
      confirmBridgeTransfer: vi.fn().mockResolvedValue({ status: "pending" }),
    };
    const collateralDeps = makeCollateralDeps();

    const result = await reconcileWithCollateralPrep(
      state,
      bridgeDeps,
      collateralDeps,
      makePerpMarket(),
    );

    expect(result.bridgeResult.kind).toBe("unchanged");
    expect(result.collateralResult).toBeNull();
    expect(collateralDeps.transferBetweenPerpAndSpot).not.toHaveBeenCalled();
  });

  it("surfaces collateral prep failure distinctly from bridge failure", async () => {
    const state = makeState({
      pendingBridgeTransfers: [
        {
          idempotencyKey: "k1",
          txHash: "0x111",
          amountUsdc: "50",
          submittedAt: new Date().toISOString(),
        },
      ],
    });
    const bridgeDeps = {
      confirmBridgeTransfer: vi.fn().mockResolvedValue({ status: "confirmed" }),
    };
    const collateralDeps = makeCollateralDeps({
      transferBetweenPerpAndSpot: vi.fn().mockRejectedValue(new Error("transfer rejected")),
    });

    const result = await reconcileWithCollateralPrep(
      state,
      bridgeDeps,
      collateralDeps,
      makePerpMarket(),
    );

    expect(result.bridgeResult.kind).toBe("confirmed");
    expect(result.collateralResult).not.toBeNull();
    expect(result.collateralResult?.kind).toBe("failed");
    if (result.collateralResult?.kind === "failed") {
      expect(result.collateralResult.reason).toContain("transfer rejected");
    }
  });

  it("returns failed collateral when deps are null for perp market", async () => {
    const state = makeState({
      pendingBridgeTransfers: [
        {
          idempotencyKey: "k1",
          txHash: "0x111",
          amountUsdc: "50",
          submittedAt: new Date().toISOString(),
        },
      ],
    });
    const bridgeDeps = {
      confirmBridgeTransfer: vi.fn().mockResolvedValue({ status: "confirmed" }),
    };

    const result = await reconcileWithCollateralPrep(state, bridgeDeps, null, makePerpMarket());

    expect(result.bridgeResult.kind).toBe("confirmed");
    expect(result.collateralResult).not.toBeNull();
    expect(result.collateralResult?.kind).toBe("failed");
    if (result.collateralResult?.kind === "failed") {
      expect(result.collateralResult.reason).toContain("unavailable");
    }
  });
});
