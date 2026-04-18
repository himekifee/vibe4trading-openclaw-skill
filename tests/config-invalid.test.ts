import { describe, expect, it } from "vitest";

import { parseRuntimeState } from "../src/state";

const validStateFixture = {
  wallet: {
    address: "0x1234567890abcdef1234567890ABCDEF12345678",
    mnemonicFilePath: "/home/grider/Desktop/openclaw-v4t-wallet-mnemonic.txt",
  },
  vibe4tradingToken: "token",
  market: {
    venue: "hyperliquid",
    mode: "spot",
    marketId: "spot:hyperliquid:ETH/USDC",
    symbol: "ETH/USDC",
  },
  overridePhraseAccepted: false,
  cumulativeBridgeUsd: "5.01",
  bridgeHistory: [
    {
      transferId: "bridge-1",
      amountUsd: "5.01",
      confirmedAt: "2026-03-27T10:00:00.000Z",
    },
  ],
  pendingBridgeTransfers: [],
  lastExecutedSlot: "2026-03-27T10:30:00.000Z",
  lastSuggestionId: "suggestion-1",
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
};

describe("config-invalid", () => {
  it("tolerates unknown fields in runtime state for downgrade safety", () => {
    const state = parseRuntimeState({
      ...validStateFixture,
      markets: [validStateFixture.market],
    });
    expect(state.market).toEqual(validStateFixture.market);
    expect((state as Record<string, unknown>).markets).toBeUndefined();
  });

  it("rejects market arrays so runtime state stays one-market-only", () => {
    expect(() =>
      parseRuntimeState({
        ...validStateFixture,
        market: [validStateFixture.market],
      }),
    ).toThrowError(/plain object/i);
  });

  it("rejects mismatched cumulative bridge totals", () => {
    expect(() =>
      parseRuntimeState({
        ...validStateFixture,
        cumulativeBridgeUsd: "99.99",
      }),
    ).toThrowError(/must exactly match the confirmed bridge history total/i);
  });

  it("rejects non-slot timestamps for lastExecutedSlot", () => {
    expect(() =>
      parseRuntimeState({
        ...validStateFixture,
        lastExecutedSlot: "2026-03-27T10:00:00.000Z",
      }),
    ).toThrowError(/hh:30 utc/i);
  });

  it("rejects numeric haltReason", () => {
    expect(() =>
      parseRuntimeState({
        ...validStateFixture,
        haltReason: 42,
      }),
    ).toThrowError(/must be a string or null/i);
  });

  it("rejects empty-string haltReason", () => {
    expect(() =>
      parseRuntimeState({
        ...validStateFixture,
        haltReason: "",
      }),
    ).toThrowError(/must not be empty/i);
  });

  it("rejects boolean haltReason", () => {
    expect(() =>
      parseRuntimeState({
        ...validStateFixture,
        haltReason: true,
      }),
    ).toThrowError(/must be a string or null/i);
  });

  it("rejects non-object tradingSelection", () => {
    expect(() =>
      parseRuntimeState({
        ...validStateFixture,
        tradingSelection: "invalid",
      }),
    ).toThrowError(/must be a plain object/i);
  });

  it("rejects tradingSelection with missing fields", () => {
    expect(() =>
      parseRuntimeState({
        ...validStateFixture,
        tradingSelection: {
          market: validStateFixture.market,
          strategyProfile: "balanced",
        },
      }),
    ).toThrowError(/missing required field/i);
  });

  it("tolerates tradingSelection with extra fields for downgrade safety", () => {
    const state = parseRuntimeState({
      ...validStateFixture,
      tradingSelection: {
        optionId: "opt-1",
        market: validStateFixture.market,
        modelKey: "openclaw-daemon",
        strategyKey: "momentum-v1",
        strategyProfile: "balanced",
        recommendationId: null,
        sourceAgentMdVersion: null,
        sourceAgentMdFetchedAt: null,
        extraField: true,
      },
    });
    expect(state.tradingSelection?.optionId).toBe("opt-1");
  });

  it("rejects tradingSelection with invalid strategyProfile enum", () => {
    expect(() =>
      parseRuntimeState({
        ...validStateFixture,
        tradingSelection: {
          optionId: "opt-1",
          market: validStateFixture.market,
          modelKey: "openclaw-daemon",
          strategyKey: "momentum-v1",
          strategyProfile: "yolo",
          recommendationId: null,
          sourceAgentMdVersion: null,
          sourceAgentMdFetchedAt: null,
        },
      }),
    ).toThrowError(/must be one of/i);
  });

  it("rejects tradingSelection with empty strategyKey", () => {
    expect(() =>
      parseRuntimeState({
        ...validStateFixture,
        tradingSelection: {
          optionId: "opt-1",
          market: validStateFixture.market,
          modelKey: "openclaw-daemon",
          strategyKey: "",
          strategyProfile: "balanced",
          recommendationId: null,
          sourceAgentMdVersion: null,
          sourceAgentMdFetchedAt: null,
        },
      }),
    ).toThrowError(/must not be empty/i);
  });

  it("rejects tradingSelection with invalid sourceAgentMdFetchedAt timestamp", () => {
    expect(() =>
      parseRuntimeState({
        ...validStateFixture,
        tradingSelection: {
          optionId: "opt-1",
          market: validStateFixture.market,
          modelKey: "openclaw-daemon",
          strategyKey: "momentum-v1",
          strategyProfile: "balanced",
          recommendationId: null,
          sourceAgentMdVersion: "7",
          sourceAgentMdFetchedAt: "not-a-timestamp",
        },
      }),
    ).toThrowError(/canonical UTC ISO timestamp/i);
  });

  it("rejects non-object walletBackup", () => {
    expect(() =>
      parseRuntimeState({
        ...validStateFixture,
        walletBackup: "backed-up",
      }),
    ).toThrowError(/must be a plain object/i);
  });

  it("rejects walletBackup with missing fields", () => {
    expect(() =>
      parseRuntimeState({
        ...validStateFixture,
        walletBackup: {
          status: "pending",
        },
      }),
    ).toThrowError(/missing required field/i);
  });

  it("rejects walletBackup with invalid status enum", () => {
    expect(() =>
      parseRuntimeState({
        ...validStateFixture,
        walletBackup: {
          status: "lost",
          mnemonicDisplayedAt: null,
          confirmedAt: null,
          cleanedUpAt: null,
        },
      }),
    ).toThrowError(/must be one of/i);
  });

  it("rejects walletBackup with invalid confirmedAt timestamp", () => {
    expect(() =>
      parseRuntimeState({
        ...validStateFixture,
        walletBackup: {
          status: "confirmed",
          mnemonicDisplayedAt: null,
          confirmedAt: "not-a-timestamp",
          cleanedUpAt: null,
        },
      }),
    ).toThrowError(/canonical UTC ISO timestamp/i);
  });

  it("rejects non-object liveTradingConsent", () => {
    expect(() =>
      parseRuntimeState({
        ...validStateFixture,
        liveTradingConsent: true,
      }),
    ).toThrowError(/must be a plain object/i);
  });

  it("rejects liveTradingConsent with missing fields", () => {
    expect(() =>
      parseRuntimeState({
        ...validStateFixture,
        liveTradingConsent: {
          acknowledged: true,
        },
      }),
    ).toThrowError(/missing required field/i);
  });

  it("rejects liveTradingConsent with non-boolean acknowledged", () => {
    expect(() =>
      parseRuntimeState({
        ...validStateFixture,
        liveTradingConsent: {
          acknowledged: "yes",
          acknowledgedAt: null,
        },
      }),
    ).toThrowError(/must be a boolean/i);
  });

  it("rejects liveTradingConsent with invalid acknowledgedAt timestamp", () => {
    expect(() =>
      parseRuntimeState({
        ...validStateFixture,
        liveTradingConsent: {
          acknowledged: true,
          acknowledgedAt: "not-a-timestamp",
        },
      }),
    ).toThrowError(/canonical UTC ISO timestamp/i);
  });
});
