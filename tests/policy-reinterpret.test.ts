import { describe, expect, it } from "vitest";

import {
  type PolicyAccountState,
  type PolicyUserPreferences,
  evaluateOpenClawPolicy,
} from "../src/policy";
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
        amountUsd: "150",
        confirmedAt: "2026-03-27T10:00:00.000Z",
      },
    ],
  });
}

const accountState: PolicyAccountState = {
  supportedModes: ["perp"],
  maxTradableFraction: "0.7",
};

const userPreferences: PolicyUserPreferences = {
  sidePreference: "short",
  maxPositionNotionalFraction: "0.55",
  maxLeverage: 3,
};

describe("policy-reinterpret", () => {
  it("reinterprets side size and leverage within the configured market and clamps", () => {
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
          recommendedSizeFraction: "0.8",
          recommendedLeverage: 2,
          recommendationId: "run-1::2026-03-27T12:00:00.000Z",
          raw: {
            confidence: "0.72",
            rationale: "Baseline long idea.",
            key_signals: ["trend_up"],
            stop_loss_pct: "0.03",
            take_profit_pct: "0.08",
            run_id: "run-1",
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
      userPreferences,
      priorInteractionSummary: {
        sideOverride: null,
        targetFractionOverride: "1.2",
        leverageOverride: 6,
        acceptOverridePhrase: false,
      },
      executionIntent: {
        action: "target-position",
        side: "flat",
        targetFraction: "0.9",
        leverage: 5,
        rationale: "Agent wants a bounded short reshape for this tick.",
      },
      accountState,
    });

    expect(decision.kind).toBe("target-position");
    if (decision.kind === "target-position") {
      expect(decision.marketId).toBe("perps:hyperliquid:BTC-PERP");
      expect(decision.baselineTarget).toEqual({
        side: "long",
        targetFraction: "0.8",
        leverage: 2,
      });
      expect(decision.requestedTarget).toEqual({
        side: "flat",
        targetFraction: "0.9",
        leverage: 5,
      });
      expect(decision.target).toEqual({
        side: "flat",
        targetFraction: "0",
        leverage: 0,
      });
      expect(decision.sources).toEqual({
        side: "execution-intent",
        targetFraction: "execution-intent",
        leverage: "execution-intent",
      });
      expect(decision.rationale).toBe("Agent wants a bounded short reshape for this tick.");
      expect(decision.clamps).toEqual([
        {
          field: "targetFraction",
          from: "0.9",
          to: "0",
          reason: "Flat exposure always resolves to zero target notional fraction.",
        },
        {
          field: "leverage",
          from: 5,
          to: 0,
          reason: "Flat exposure always resolves to zero leverage.",
        },
      ]);
    }
  });

  it("rejects unsafe explicit execution intent leverage with schema validation", () => {
    expect(() =>
      evaluateOpenClawPolicy({
        now: new Date("2026-03-27T12:05:00.000Z"),
        runtimeState: createRuntimeStateFixture(),
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
            recommendationId: "run-unsafe::2026-03-27T12:00:00.000Z",
            raw: {
              confidence: "0.7",
              rationale: "Baseline long idea.",
              key_signals: ["trend_up"],
              stop_loss_pct: null,
              take_profit_pct: null,
              run_id: "run-unsafe",
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
        executionIntent: {
          action: "target-position",
          leverage: -1,
          rationale: "Unsafe leverage should be rejected.",
        } as never,
        accountState,
      }),
    ).toThrow(/policy.executionIntent.leverage must be a non-negative integer/i);
  });

  it("turns override phrase acceptance into explicit stateful output", () => {
    const decision = evaluateOpenClawPolicy({
      now: new Date("2026-03-27T12:05:00.000Z"),
      runtimeState: createRuntimeStateFixture(),
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
          recommendationId: "run-2::2026-03-27T12:00:00.000Z",
          raw: {
            confidence: "0.6",
            rationale: "Proceed after explicit override acceptance.",
            key_signals: ["breadth"],
            stop_loss_pct: null,
            take_profit_pct: null,
            run_id: "run-2",
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
      priorInteractionSummary: {
        sideOverride: null,
        targetFractionOverride: null,
        leverageOverride: null,
        acceptOverridePhrase: true,
      },
      accountState,
    });

    expect(decision.kind).toBe("target-position");
    expect(decision.overridePhrase).toEqual({
      wasAccepted: false,
      isAccepted: true,
      requiresAcceptance: false,
      shouldPersist: true,
    });
  });

  it("holds when maxLeverage is 0 for a non-flat perp target instead of emitting leverage: 0", () => {
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
          recommendedSizeFraction: "0.5",
          recommendedLeverage: 2,
          recommendationId: "run-lev0::2026-03-27T12:00:00.000Z",
          raw: {
            confidence: "0.7",
            rationale: "Should be blocked by maxLeverage 0.",
            key_signals: ["trend"],
            stop_loss_pct: null,
            take_profit_pct: null,
            run_id: "run-lev0",
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
      userPreferences: {
        sidePreference: "follow-suggestion",
        maxPositionNotionalFraction: null,
        maxLeverage: 0,
      },
      accountState,
    });

    expect(decision.kind).toBe("hold");
    if (decision.kind === "hold") {
      expect(decision.holdReason).toBe("leverage-zero-disallowed");
      expect(decision.message).toMatch(/maxLeverage/i);
    }
    expect(decision.clamps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "leverage",
          from: 2,
          to: 0,
          reason: "User preference max leverage applied.",
        }),
      ]),
    );
  });

  it("applies deterministic 1x floor when suggestion has leverage 0 but maxLeverage is not set", () => {
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
          recommendedSizeFraction: "0.3",
          recommendedLeverage: 0,
          recommendationId: "run-lev0-floor::2026-03-27T12:00:00.000Z",
          raw: {
            confidence: "0.6",
            rationale: "Zero leverage from suggestion should get 1x floor.",
            key_signals: ["momentum"],
            stop_loss_pct: null,
            take_profit_pct: null,
            run_id: "run-lev0-floor",
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
      userPreferences: {
        sidePreference: "follow-suggestion",
        maxPositionNotionalFraction: null,
        maxLeverage: null,
      },
      accountState,
    });

    expect(decision.kind).toBe("target-position");
    if (decision.kind === "target-position") {
      expect(decision.target.leverage).toBe(1);
      expect(decision.target.side).toBe("long");
      expect(decision.clamps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "leverage",
            from: 0,
            to: 1,
            reason: "Perp exposure uses a minimum deterministic leverage of 1x when non-flat.",
          }),
        ]),
      );
    }
  });

  it("clamps leverage to maxLeverage without holding when maxLeverage >= 1", () => {
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
          recommendedSizeFraction: "0.4",
          recommendedLeverage: 5,
          recommendationId: "run-clamp::2026-03-27T12:00:00.000Z",
          raw: {
            confidence: "0.65",
            rationale: "Leverage 5 should be clamped to 1 without hold.",
            key_signals: ["breadth"],
            stop_loss_pct: null,
            take_profit_pct: null,
            run_id: "run-clamp",
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
      userPreferences: {
        sidePreference: "follow-suggestion",
        maxPositionNotionalFraction: null,
        maxLeverage: 1,
      },
      accountState,
    });

    expect(decision.kind).toBe("target-position");
    if (decision.kind === "target-position") {
      expect(decision.target.leverage).toBe(1);
      expect(decision.clamps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "leverage",
            from: 5,
            to: 1,
            reason: "User preference max leverage applied.",
          }),
        ]),
      );
    }
  });
});
