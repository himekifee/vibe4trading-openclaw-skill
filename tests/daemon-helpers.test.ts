import { describe, expect, it } from "vitest";

import { DEAD_MANS_SWITCH_SECONDS } from "../src/config/constants";
import {
  createNoopReconciliation,
  deriveCollateralPrepStatus,
  isDeadManSwitchExpired,
  isSlotAlreadyConsumed,
  mergeRuntimeStateForReconciliation,
  normalizeCancelOutstandingOrdersResult,
} from "../src/daemon/helpers";
import type { RuntimeState } from "../src/state";

function makeState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    wallet: {
      address: "0x1234567890abcdef1234567890ABCDEF12345678",
      privateKey: `0x${"ab".repeat(32)}`,
    },
    vibe4tradingToken: "token",
    market: {
      venue: "hyperliquid",
      mode: "spot",
      marketId: "spot:hyperliquid:ETH/USDC",
      symbol: "ETH/USDC",
    },
    overridePhraseAccepted: false,
    cumulativeBridgeUsd: "0",
    bridgeHistory: [],
    pendingBridgeTransfers: [],
    lastExecutedSlot: "2026-03-27T10:30:00.000Z",
    executingSlot: null,
    lastSuggestionId: null,
    daemonStatus: "stopped",
    exchangeActivity: {
      hasOpenPosition: false,
      hasPendingOrder: false,
    },
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

describe("createNoopReconciliation", () => {
  it("returns correct shape with driftDetected false and rpcFailed false", () => {
    const state = makeState();
    const result = createNoopReconciliation(state);
    expect(result.state).toBe(state);
    expect(result.driftDetected).toBe(false);
    expect(result.rpcFailed).toBe(false);
    expect(result.previousActivity).toBe(state.exchangeActivity);
    expect(result.nextActivity).toBe(state.exchangeActivity);
  });
});

describe("mergeRuntimeStateForReconciliation", () => {
  it("keeps locked bridge data when locked has more bridge history", () => {
    const locked = makeState({
      cumulativeBridgeUsd: "10",
      bridgeHistory: [
        { transferId: "a", amountUsd: "5", confirmedAt: "2026-03-27T10:00:00.000Z" },
        { transferId: "b", amountUsd: "5", confirmedAt: "2026-03-27T11:00:00.000Z" },
      ],
      exchangeActivity: { hasOpenPosition: false, hasPendingOrder: false },
    });
    const reconciled = makeState({
      cumulativeBridgeUsd: "5",
      bridgeHistory: [{ transferId: "a", amountUsd: "5", confirmedAt: "2026-03-27T10:00:00.000Z" }],
      exchangeActivity: { hasOpenPosition: true, hasPendingOrder: false },
    });

    const result = mergeRuntimeStateForReconciliation(locked, reconciled);
    expect(result.cumulativeBridgeUsd).toBe("10");
    expect(result.bridgeHistory).toBe(locked.bridgeHistory);
    expect(result.exchangeActivity).toBe(reconciled.exchangeActivity);
  });

  it("keeps reconciled bridge data when reconciled has more bridge history", () => {
    const locked = makeState({
      cumulativeBridgeUsd: "5",
      bridgeHistory: [{ transferId: "a", amountUsd: "5", confirmedAt: "2026-03-27T10:00:00.000Z" }],
      exchangeActivity: { hasOpenPosition: false, hasPendingOrder: false },
    });
    const reconciled = makeState({
      cumulativeBridgeUsd: "10",
      bridgeHistory: [
        { transferId: "a", amountUsd: "5", confirmedAt: "2026-03-27T10:00:00.000Z" },
        { transferId: "b", amountUsd: "5", confirmedAt: "2026-03-27T11:00:00.000Z" },
      ],
      exchangeActivity: { hasOpenPosition: true, hasPendingOrder: false },
    });

    const result = mergeRuntimeStateForReconciliation(locked, reconciled);
    expect(result.cumulativeBridgeUsd).toBe("10");
    expect(result.bridgeHistory).toBe(reconciled.bridgeHistory);
    expect(result.exchangeActivity).toBe(reconciled.exchangeActivity);
  });

  it("keeps reconciled bridge data when history lengths are equal (> not >=)", () => {
    const locked = makeState({
      cumulativeBridgeUsd: "5",
      bridgeHistory: [{ transferId: "a", amountUsd: "5", confirmedAt: "2026-03-27T10:00:00.000Z" }],
      exchangeActivity: { hasOpenPosition: false, hasPendingOrder: false },
    });
    const reconciled = makeState({
      cumulativeBridgeUsd: "7",
      bridgeHistory: [{ transferId: "x", amountUsd: "7", confirmedAt: "2026-03-27T12:00:00.000Z" }],
      exchangeActivity: { hasOpenPosition: true, hasPendingOrder: true },
    });

    const result = mergeRuntimeStateForReconciliation(locked, reconciled);
    expect(result.cumulativeBridgeUsd).toBe("7");
    expect(result.bridgeHistory).toBe(reconciled.bridgeHistory);
  });

  it("always takes reconciled exchangeActivity", () => {
    const locked = makeState({
      exchangeActivity: { hasOpenPosition: false, hasPendingOrder: false },
    });
    const reconciled = makeState({
      exchangeActivity: { hasOpenPosition: true, hasPendingOrder: true },
    });

    const result = mergeRuntimeStateForReconciliation(locked, reconciled);
    expect(result.exchangeActivity).toBe(reconciled.exchangeActivity);
  });
});

describe("isSlotAlreadyConsumed", () => {
  it("returns true when lastExecutedSlot matches", () => {
    const state = makeState({ lastExecutedSlot: "2026-03-27T10:30:00.000Z" });
    expect(isSlotAlreadyConsumed(state, "2026-03-27T10:30:00.000Z")).toBe(true);
  });

  it("returns true when executingSlot matches", () => {
    const state = makeState({
      lastExecutedSlot: "2026-03-27T09:30:00.000Z",
      executingSlot: "2026-03-27T10:30:00.000Z",
    });
    expect(isSlotAlreadyConsumed(state, "2026-03-27T10:30:00.000Z")).toBe(true);
  });

  it("returns false when neither matches", () => {
    const state = makeState({
      lastExecutedSlot: "2026-03-27T09:30:00.000Z",
      executingSlot: null,
    });
    expect(isSlotAlreadyConsumed(state, "2026-03-27T10:30:00.000Z")).toBe(false);
  });
});

describe("isDeadManSwitchExpired", () => {
  it("returns true when lastExecutedSlot is null", () => {
    expect(isDeadManSwitchExpired(null, new Date())).toBe(true);
  });

  it("returns true when slot is older than DEAD_MANS_SWITCH_SECONDS", () => {
    const slot = "2026-03-27T10:30:00.000Z";
    const slotTime = new Date(slot).getTime();
    const now = new Date(slotTime + (DEAD_MANS_SWITCH_SECONDS + 1) * 1000);
    expect(isDeadManSwitchExpired(slot, now)).toBe(true);
  });

  it("returns false when slot is within the window", () => {
    const slot = "2026-03-27T10:30:00.000Z";
    const slotTime = new Date(slot).getTime();
    const now = new Date(slotTime + 60 * 1000);
    expect(isDeadManSwitchExpired(slot, now)).toBe(false);
  });
});

describe("deriveCollateralPrepStatus", () => {
  it("returns null for null input", () => {
    expect(deriveCollateralPrepStatus(null)).toBe(null);
  });

  it("returns 'failed' for kind: failed", () => {
    expect(deriveCollateralPrepStatus({ kind: "failed", reason: "oops" })).toBe("failed");
  });

  it("returns null for kind: prepared", () => {
    expect(deriveCollateralPrepStatus({ kind: "prepared", amountUsd: "10" })).toBe(null);
  });

  it("returns null for kind: skipped_spot", () => {
    expect(deriveCollateralPrepStatus({ kind: "skipped_spot" })).toBe(null);
  });

  it("returns 'pending' for kind: skipped_no_balance", () => {
    expect(deriveCollateralPrepStatus({ kind: "skipped_no_balance" })).toBe("pending");
  });
});

describe("normalizeCancelOutstandingOrdersResult", () => {
  it("converts number input to object with hadFailures false", () => {
    const result = normalizeCancelOutstandingOrdersResult(3);
    expect(result).toEqual({
      cancelledCount: 3,
      hadFailures: false,
      confirmedNoPendingOrders: true,
    });
  });

  it("converts zero to object with confirmedNoPendingOrders false", () => {
    const result = normalizeCancelOutstandingOrdersResult(0);
    expect(result).toEqual({
      cancelledCount: 0,
      hadFailures: false,
      confirmedNoPendingOrders: false,
    });
  });

  it("passes through object input unchanged", () => {
    const input = { cancelledCount: 2, hadFailures: true, confirmedNoPendingOrders: true };
    const result = normalizeCancelOutstandingOrdersResult(input);
    expect(result).toBe(input);
  });
});
