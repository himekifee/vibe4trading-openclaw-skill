import { describe, expect, it } from "vitest";

import { reconcileRuntimeState } from "../src/daemon/reconcile";
import { createRuntimeState } from "../src/state";
import type { RuntimeState } from "../src/state";

function createPerpState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return createRuntimeState({
    wallet: {
      address: "0x1234567890abcdef1234567890ABCDEF12345678",
      mnemonicFilePath: "/tmp/openclaw-mnemonic.txt",
    },
    market: {
      venue: "hyperliquid",
      mode: "perp",
      marketId: "perps:hyperliquid:ETH",
      symbol: "ETH",
    },
    ...overrides,
  });
}

function createSpotState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return createRuntimeState({
    wallet: {
      address: "0x1234567890abcdef1234567890ABCDEF12345678",
      mnemonicFilePath: "/tmp/openclaw-mnemonic.txt",
    },
    market: {
      venue: "hyperliquid",
      mode: "spot",
      marketId: "spot:hyperliquid:ETH/USDC",
      symbol: "ETH/USDC",
    },
    ...overrides,
  });
}

describe("daemon reconciliation", () => {
  it("trusts live perp positions and open orders over local exchangeActivity", async () => {
    const state = createPerpState({
      exchangeActivity: { hasOpenPosition: false, hasPendingOrder: false },
    });

    const result = await reconcileRuntimeState(state, {
      readPerpPositions: async () => [{ coin: "ETH", size: "1.25" }],
      readSpotBalances: async () => [],
      readOpenOrders: async () => [{ coin: "ETH", oid: 101 }],
    });

    expect(result.driftDetected).toBe(true);
    expect(result.previousActivity).toEqual({ hasOpenPosition: false, hasPendingOrder: false });
    expect(result.nextActivity).toEqual({ hasOpenPosition: true, hasPendingOrder: true });
    expect(result.state.exchangeActivity).toEqual({
      hasOpenPosition: true,
      hasPendingOrder: true,
    });
  });

  it("uses spot base-asset balances to detect live position", async () => {
    const state = createSpotState({
      exchangeActivity: { hasOpenPosition: false, hasPendingOrder: true },
    });

    const result = await reconcileRuntimeState(state, {
      readPerpPositions: async () => [],
      readSpotBalances: async () => [
        { coin: "ETH", total: "0.75", hold: "0" },
        { coin: "USDC", total: "1200", hold: "0" },
      ],
      readOpenOrders: async () => [],
    });

    expect(result.driftDetected).toBe(true);
    expect(result.nextActivity).toEqual({ hasOpenPosition: true, hasPendingOrder: false });
    expect(result.state.exchangeActivity.hasOpenPosition).toBe(true);
    expect(result.state.exchangeActivity.hasPendingOrder).toBe(false);
  });

  it("reports no drift when local state already matches exchange truth", async () => {
    const state = createPerpState({
      exchangeActivity: { hasOpenPosition: false, hasPendingOrder: false },
    });

    const result = await reconcileRuntimeState(state, {
      readPerpPositions: async () => [{ coin: "ETH", size: "0" }],
      readSpotBalances: async () => [],
      readOpenOrders: async () => [],
    });

    expect(result.driftDetected).toBe(false);
    expect(result.state.exchangeActivity).toEqual(state.exchangeActivity);
  });
});
