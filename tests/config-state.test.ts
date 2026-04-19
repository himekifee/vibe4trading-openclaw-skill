import { describe, expect, it } from "vitest";

import { SchemaValidationError } from "../src/config/validation";
import {
  computeCurrentTickSlotUtc,
  createAgentMdCacheState,
  createRuntimeState,
  deserializeAgentMdCacheState,
  deserializeRuntimeState,
  parseCanonicalUtcTimestamp,
  replaceMarketConfig,
  serializeAgentMdCacheState,
  serializeRuntimeState,
  slotIdFromDate,
} from "../src/state";

describe("config state", () => {
  it("round-trips runtime state serialization with decimal-string persistence", () => {
    const state = createRuntimeState({
      wallet: {
        address: "0x1234567890abcdef1234567890ABCDEF12345678",
        privateKey: `0x${"ab".repeat(32)}`,
      },
      vibe4tradingToken: "v4t-token",
      market: {
        venue: "hyperliquid",
        mode: "spot",
        marketId: "spot:hyperliquid:ETH/USDC",
        symbol: "ETH/USDC",
      },
      bridgeHistory: [
        {
          transferId: "bridge-1",
          amountUsd: "5.01",
          confirmedAt: "2026-03-27T10:00:00.000Z",
        },
        {
          transferId: "bridge-2",
          amountUsd: "0.99",
          confirmedAt: "2026-03-27T11:00:00.000Z",
        },
      ],
      pendingBridgeTransfers: [
        {
          idempotencyKey: "bridge:0x1234567890abcdef1234567890ABCDEF12345678:3:uuid-1",
          txHash: "0xabc123",
          amountUsdc: "3",
          submittedAt: "2026-03-27T11:15:00.000Z",
        },
      ],
      lastExecutedSlot: "2026-03-27T11:30:00.000Z",
      lastSuggestionId: "suggestion-2",
      daemonStatus: "halted",
      exchangeActivity: {
        hasOpenPosition: false,
        hasPendingOrder: false,
      },
      haltReason: "tick-loop-crash",
    });

    const serialized = serializeRuntimeState(state);
    expect(serialized).toContain('"cumulativeBridgeUsd": "6"');
    expect(serialized).toContain('"amountUsd": "5.01"');
    expect(serialized).toContain('"pendingBridgeTransfers"');
    expect(serialized).toContain('"haltReason": "tick-loop-crash"');
    expect(deserializeRuntimeState(serialized)).toEqual(state);
  });

  it("defaults missing pendingBridgeTransfers to an empty array for legacy state files", () => {
    const serializedLegacyState = `${JSON.stringify(
      {
        wallet: {
          address: "0x1234567890abcdef1234567890ABCDEF12345678",
          privateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        vibe4tradingToken: "v4t-token",
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
        lastExecutedSlot: "2026-03-27T10:30:00.000Z",
        lastSuggestionId: "suggestion-1",
        daemonStatus: "stopped",
        exchangeActivity: {
          hasOpenPosition: false,
          hasPendingOrder: false,
        },
      },
      null,
      2,
    )}\n`;

    expect(deserializeRuntimeState(serializedLegacyState).pendingBridgeTransfers).toEqual([]);
    expect(deserializeRuntimeState(serializedLegacyState).haltReason).toBeNull();
  });

  it("defaults missing haltReason to null for legacy state files", () => {
    const serializedLegacyState = `${JSON.stringify(
      {
        wallet: {
          address: "0x1234567890abcdef1234567890ABCDEF12345678",
          privateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        vibe4tradingToken: "v4t-token",
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
      },
      null,
      2,
    )}\n`;

    const deserialized = deserializeRuntimeState(serializedLegacyState);
    expect(deserialized.haltReason).toBeNull();
    expect(deserialized.pendingBridgeTransfers).toEqual([]);
  });

  it("round-trips runtime state with product-rule persistence fields populated", () => {
    const state = createRuntimeState({
      wallet: {
        address: "0x1234567890abcdef1234567890ABCDEF12345678",
        privateKey: `0x${"ab".repeat(32)}`,
      },
      market: {
        venue: "hyperliquid",
        mode: "perp",
        marketId: "perps:hyperliquid:BTC-PERP",
        symbol: "BTC-PERP",
      },
      tradingSelection: {
        optionId: "BTC-PERP|conservative|openclaw-daemon",
        market: {
          venue: "hyperliquid",
          mode: "perp",
          marketId: "perps:hyperliquid:BTC-PERP",
          symbol: "BTC-PERP",
        },
        modelKey: "openclaw-daemon",
        strategyProfile: "conservative",
        recommendationId: "rec-123",
        sourceAgentMdVersion: "7",
        sourceAgentMdFetchedAt: "2026-03-28T09:00:00.000Z",
      },
      walletBackup: {
        status: "confirmed",
        mnemonicDisplayedAt: "2026-03-28T09:30:00.000Z",
        confirmedAt: "2026-03-28T09:35:00.000Z",
        cleanedUpAt: null,
      },
      liveTradingConsent: {
        acknowledged: true,
        acknowledgedAt: "2026-03-28T10:00:00.000Z",
      },
    });

    const serialized = serializeRuntimeState(state);
    expect(serialized).toContain('"tradingSelection"');
    expect(serialized).toContain('"optionId": "BTC-PERP|conservative|openclaw-daemon"');
    expect(serialized).toContain('"strategyProfile": "conservative"');
    expect(serialized).toContain('"modelKey": "openclaw-daemon"');
    expect(serialized).toContain('"recommendationId": "rec-123"');
    expect(serialized).toContain('"sourceAgentMdVersion": "7"');
    expect(serialized).toContain('"walletBackup"');
    expect(serialized).toContain('"status": "confirmed"');
    expect(serialized).toContain('"mnemonicDisplayedAt": "2026-03-28T09:30:00.000Z"');
    expect(serialized).toContain('"liveTradingConsent"');
    expect(serialized).toContain('"acknowledged": true');
    expect(serialized).toContain('"acknowledgedAt": "2026-03-28T10:00:00.000Z"');
    expect(deserializeRuntimeState(serialized)).toEqual(state);
  });

  it("defaults missing product-rule fields for legacy state files", () => {
    const serializedLegacyState = `${JSON.stringify(
      {
        wallet: {
          address: "0x1234567890abcdef1234567890ABCDEF12345678",
          privateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        vibe4tradingToken: "v4t-token",
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
        executingSlot: null,
        lastSuggestionId: "suggestion-1",
        daemonStatus: "stopped",
        exchangeActivity: {
          hasOpenPosition: false,
          hasPendingOrder: false,
        },
        haltReason: null,
      },
      null,
      2,
    )}\n`;

    const deserialized = deserializeRuntimeState(serializedLegacyState);
    expect(deserialized.tradingSelection).toBeNull();
    expect(deserialized.walletBackup).toEqual({
      status: "pending",
      mnemonicDisplayedAt: null,
      confirmedAt: null,
      cleanedUpAt: null,
    });
    expect(deserialized.liveTradingConsent).toEqual({
      acknowledged: false,
      acknowledgedAt: null,
    });
  });

  it("round-trips agents.md cache serialization", () => {
    const cacheState = deserializeAgentMdCacheState(
      `${JSON.stringify(
        {
          url: "https://vibe4trading.ai/agents.md",
          version: "7",
          lastUpdated: "2026-03-27T11:00:00.000Z",
          apiContractVersion: "2",
          status: "degraded",
          etag: "etag-1",
          hash: "abc123",
          fetchedAt: "2026-03-27T11:01:00.000Z",
          tradingOptions: null,
        },
        null,
        2,
      )}\n`,
    );

    const serialized = serializeAgentMdCacheState(cacheState);
    expect(serialized).toContain('"status": "degraded"');
    expect(serialized).toContain('"tradingOptions": null');
    expect(deserializeAgentMdCacheState(serialized)).toEqual(cacheState);
  });

  it("round-trips agents.md cache serialization with trading options catalog", () => {
    const cacheState = createAgentMdCacheState({
      markdown: `---
version: 8
last_updated: 2026-03-28T11:00:00.000Z
api_contract_version: 3
status: active
---

# Trading Options



\`\`\`json
{
  "models": ["openclaw-daemon"],
  "strategies": ["balanced"],
  "pairs": [
    {
      "venue": "hyperliquid",
      "mode": "perp",
      "marketId": "perps:hyperliquid:BTC-PERP",
      "symbol": "BTC-PERP"
    }
  ],
  "recommended": {
    "pair": "BTC-PERP",
    "strategy": "balanced",
    "model": "openclaw-daemon"
  }
}
\`\`\`

# Platform Status
active
`,
      fetchedAt: "2026-03-28T11:01:00.000Z",
      hash: "def456",
      etag: "etag-2",
    });

    const serialized = serializeAgentMdCacheState(cacheState);
    expect(serialized).toContain('"tradingOptions"');
    expect(serialized).toContain('"recommended"');
    expect(serialized).toContain('"pair": "BTC-PERP"');
    expect(deserializeAgentMdCacheState(serialized)).toEqual(cacheState);
  });

  it("rejects legacy tradingSelection riskProfile from persisted runtime state", () => {
    const serializedLegacySelection = `${JSON.stringify(
      {
        wallet: {
          address: "0x1234567890abcdef1234567890ABCDEF12345678",
          privateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        vibe4tradingToken: "v4t-token",
        market: {
          venue: "hyperliquid",
          mode: "perp",
          marketId: "perps:hyperliquid:BTC-PERP",
          symbol: "BTC-PERP",
        },
        overridePhraseAccepted: false,
        cumulativeBridgeUsd: "0",
        bridgeHistory: [],
        pendingBridgeTransfers: [],
        lastExecutedSlot: null,
        executingSlot: null,
        lastSuggestionId: null,
        daemonStatus: "stopped",
        exchangeActivity: {
          hasOpenPosition: false,
          hasPendingOrder: false,
        },
        haltReason: null,
        tradingSelection: {
          optionId: "BTC-PERP|balanced|openclaw-daemon",
          market: {
            venue: "hyperliquid",
            mode: "perp",
            marketId: "perps:hyperliquid:BTC-PERP",
            symbol: "BTC-PERP",
          },
          modelKey: "openclaw-daemon",
          riskProfile: "balanced",
          recommendationId: null,
          sourceAgentMdVersion: null,
          sourceAgentMdFetchedAt: null,
        },
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
      },
      null,
      2,
    )}\n`;

    expect(() => deserializeRuntimeState(serializedLegacySelection)).toThrow(SchemaValidationError);
    expect(() => deserializeRuntimeState(serializedLegacySelection)).toThrow(/strategyProfile/);
  });

  it("computes deterministic hh:30 UTC slots by rounding down", () => {
    expect(computeCurrentTickSlotUtc(new Date("2026-03-27T12:45:12.999Z")).toISOString()).toBe(
      "2026-03-27T12:30:00.000Z",
    );
    expect(computeCurrentTickSlotUtc(new Date("2026-03-27T12:15:12.999Z")).toISOString()).toBe(
      "2026-03-27T11:30:00.000Z",
    );
    expect(slotIdFromDate(new Date("2026-03-27T00:00:00.000Z"))).toBe("2026-03-26T23:30:00.000Z");
  });

  it("rejects valid ISO-8601 timestamps that omit milliseconds", () => {
    expect(() => parseCanonicalUtcTimestamp("2026-03-27T12:30:00Z", "test")).toThrowError(
      /canonical UTC ISO timestamp/,
    );
  });

  it("blocks market configuration changes while exposure exists", () => {
    const state = createRuntimeState({
      wallet: {
        address: "0x1234567890abcdef1234567890ABCDEF12345678",
        privateKey: `0x${"ab".repeat(32)}`,
      },
      market: {
        venue: "hyperliquid",
        mode: "perp",
        marketId: "perps:hyperliquid:BTC-PERP",
        symbol: "BTC-PERP",
      },
      exchangeActivity: {
        hasOpenPosition: true,
        hasPendingOrder: false,
      },
    });

    expect(() =>
      replaceMarketConfig(state, {
        venue: "hyperliquid",
        mode: "perp",
        marketId: "perps:hyperliquid:ETH-PERP",
        symbol: "ETH-PERP",
      }),
    ).toThrowError(/cannot change while an open position or pending order exists/i);
  });
});
