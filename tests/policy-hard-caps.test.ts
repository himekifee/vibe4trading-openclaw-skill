import { describe, expect, it } from "vitest";

import { type PolicyAccountState, evaluateOpenClawPolicy } from "../src/policy";
import { createRuntimeState } from "../src/state";

function createRuntimeStateFixture() {
  return createRuntimeState({
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
    bridgeHistory: [
      {
        transferId: "bridge-1",
        amountUsd: "80",
        confirmedAt: "2026-03-27T10:00:00.000Z",
      },
    ],
  });
}

const accountState: PolicyAccountState = {
  supportedModes: ["perp", "spot"],
  maxTradableFraction: "1",
};

describe("policy-hard-caps", () => {
  it("clamps oversized leverage and allocation to code-owned hard caps", () => {
    const decision = evaluateOpenClawPolicy({
      now: new Date("2026-03-27T12:05:00.000Z"),
      runtimeState: {
        ...createRuntimeStateFixture(),
        overridePhraseAccepted: true,
      },
      suggestionResult: {
        kind: "ok",
        httpStatus: 200,
        recommendation: {
          tickTime: "2026-03-27T12:00:00.000Z",
          expiresAt: "2026-03-27T12:10:00.000Z",
          marketId: "perps:hyperliquid:BTC-PERP",
          recommendedMode: "futures",
          recommendedDirection: "long",
          recommendedSizeFraction: "1",
          recommendedLeverage: 50,
          recommendationId: "run-hard-cap::2026-03-27T12:00:00.000Z",
          raw: {
            confidence: "0.9",
            rationale: "Aggressive test suggestion.",
            key_signals: ["breakout"],
            stop_loss_pct: "0.04",
            take_profit_pct: "0.1",
            run_id: "run-hard-cap",
            strategy: null,
          },
        },
      },
      agentMdPolicy: {
        version: "1",
        lastUpdated: "2026-03-27T12:00:00.000Z",
        apiContractVersion: "1",
        status: "active",
      },
      agentMdFetchedAt: "2026-03-27T12:04:00.000Z",
      accountState,
    });

    expect(decision.kind).toBe("target-position");
    if (decision.kind === "target-position") {
      expect(decision.target.targetFraction).toBe("0.95");
      expect(decision.target.leverage).toBe(5);
      expect(decision.clamps).toEqual([
        {
          field: "targetFraction",
          from: "1",
          to: "0.95",
          reason: "Code-owned maximum position notional fraction applied.",
        },
        {
          field: "leverage",
          from: 50,
          to: 5,
          reason: "Code-owned maximum leverage applied.",
        },
      ]);
    }
  });

  it("halts when cumulative bridged funds exceed the cap without accepted override", () => {
    const decision = evaluateOpenClawPolicy({
      now: new Date("2026-03-27T12:05:00.000Z"),
      runtimeState: createRuntimeState({
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
        bridgeHistory: [
          {
            transferId: "bridge-1",
            amountUsd: "101",
            confirmedAt: "2026-03-27T10:00:00.000Z",
          },
        ],
      }),
      suggestionResult: {
        kind: "ok",
        httpStatus: 200,
        recommendation: {
          tickTime: "2026-03-27T12:00:00.000Z",
          expiresAt: "2026-03-27T12:10:00.000Z",
          marketId: "perps:hyperliquid:BTC-PERP",
          recommendedMode: "futures",
          recommendedDirection: "long",
          recommendedSizeFraction: "0.25",
          recommendedLeverage: 2,
          recommendationId: "run-override-required::2026-03-27T12:00:00.000Z",
          raw: {
            confidence: "0.6",
            rationale: "Should never execute.",
            key_signals: ["guardrail"],
            stop_loss_pct: null,
            take_profit_pct: null,
            run_id: "run-override-required",
            strategy: null,
          },
        },
      },
      agentMdPolicy: {
        version: "1",
        lastUpdated: "2026-03-27T12:00:00.000Z",
        apiContractVersion: "1",
        status: "active",
      },
      agentMdFetchedAt: "2026-03-27T12:04:00.000Z",
      accountState,
    });

    expect(decision.kind).toBe("hold");
    if (decision.kind === "hold") {
      expect(decision.holdReason).toBe("override-required");
      expect(decision.overridePhrase).toEqual({
        wasAccepted: false,
        isAccepted: false,
        requiresAcceptance: true,
        shouldPersist: false,
      });
    }
  });

  it("requires fresh operator consent again after the persisted override is reset", () => {
    const decision = evaluateOpenClawPolicy({
      now: new Date("2026-03-27T12:05:00.000Z"),
      runtimeState: createRuntimeState({
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
        bridgeHistory: [
          {
            transferId: "bridge-1",
            amountUsd: "150",
            confirmedAt: "2026-03-27T10:00:00.000Z",
          },
        ],
        overridePhraseAccepted: false,
      }),
      suggestionResult: {
        kind: "ok",
        httpStatus: 200,
        recommendation: {
          tickTime: "2026-03-27T12:00:00.000Z",
          expiresAt: "2026-03-27T12:10:00.000Z",
          marketId: "perps:hyperliquid:BTC-PERP",
          recommendedMode: "futures",
          recommendedDirection: "long",
          recommendedSizeFraction: "0.25",
          recommendedLeverage: 2,
          recommendationId: "run-reset-required::2026-03-27T12:00:00.000Z",
          raw: {
            confidence: "0.6",
            rationale: "Reset should force a fresh override prompt.",
            key_signals: ["guardrail"],
            stop_loss_pct: null,
            take_profit_pct: null,
            run_id: "run-reset-required",
            strategy: null,
          },
        },
      },
      agentMdPolicy: {
        version: "1",
        lastUpdated: "2026-03-27T12:00:00.000Z",
        apiContractVersion: "1",
        status: "active",
      },
      agentMdFetchedAt: "2026-03-27T12:04:00.000Z",
      accountState,
    });

    expect(decision.kind).toBe("hold");
    if (decision.kind === "hold") {
      expect(decision.holdReason).toBe("override-required");
      expect(decision.overridePhrase).toEqual({
        wasAccepted: false,
        isAccepted: false,
        requiresAcceptance: true,
        shouldPersist: false,
      });
    }
  });
});
