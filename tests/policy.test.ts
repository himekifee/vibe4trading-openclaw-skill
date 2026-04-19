import { describe, expect, it } from "vitest";

import { createEmptyPriorInteractionSummary, evaluateOpenClawPolicy } from "../src/policy";
import type { PolicyAccountState } from "../src/policy";
import { createRuntimeState } from "../src/state";
import type { AgentMdPolicyView, TickRecommendationResult } from "../src/v4t";

function createBaseRuntimeState() {
  return createRuntimeState({
    wallet: {
      address: "0x1234567890abcdef1234567890ABCDEF12345678",
      mnemonicFilePath: "/home/grider/Desktop/openclaw-v4t-wallet-mnemonic.txt",
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
        amountUsd: "50",
        confirmedAt: "2026-03-27T10:00:00.000Z",
      },
    ],
  });
}

function createActiveAgentMdPolicy(): AgentMdPolicyView {
  return {
    version: "1",
    lastUpdated: "2026-03-27T12:00:00.000Z",
    apiContractVersion: "1",
    status: "active",
  };
}

function createSuggestionResult(
  overrides: Partial<TickRecommendationResult & { recommendation: Record<string, unknown> }> = {},
) {
  return {
    kind: "ok",
    httpStatus: 200,
    recommendation: {
      tickTime: "2026-03-27T12:00:00.000Z",
      expiresAt: "2026-03-27T12:10:00.000Z",
      marketId: "perps:hyperliquid:BTC-PERP",
      recommendedMode: "futures",
      recommendedDirection: "long",
      recommendedSizeFraction: "0.4",
      recommendedLeverage: 3,
      recommendationId: "run-1::2026-03-27T12:00:00.000Z",
      raw: {
        confidence: "0.8",
        rationale: "Momentum aligns with the configured market.",
        key_signals: ["trend_up"],
        stop_loss_pct: "0.03",
        take_profit_pct: "0.08",
        run_id: "run-1",
        strategy: null,
      },
      ...(overrides.recommendation ?? {}),
    },
    ...(overrides.kind === "ok" ? overrides : {}),
  } as TickRecommendationResult;
}

const accountState: PolicyAccountState = {
  supportedModes: ["perp"],
  maxTradableFraction: "0.9",
};

describe("policy", () => {
  it("holds when agents.md status is degraded", () => {
    const decision = evaluateOpenClawPolicy({
      now: new Date("2026-03-27T12:05:00.000Z"),
      runtimeState: createBaseRuntimeState(),
      suggestionResult: createSuggestionResult(),
      agentMdPolicy: {
        ...createActiveAgentMdPolicy(),
        status: "degraded",
      },
      agentMdFetchedAt: "2026-03-27T12:04:00.000Z",
      priorInteractionSummary: createEmptyPriorInteractionSummary(),
      accountState,
    });

    expect(decision.kind).toBe("hold");
    if (decision.kind === "hold") {
      expect(decision.holdReason).toBe("agent-md-degraded");
      expect(decision.message).toMatch(/hold/i);
    }
  });

  it("holds when the suggestion market differs from the configured market", () => {
    const decision = evaluateOpenClawPolicy({
      now: new Date("2026-03-27T12:05:00.000Z"),
      runtimeState: createBaseRuntimeState(),
      suggestionResult: createSuggestionResult({
        recommendation: {
          marketId: "perps:hyperliquid:ETH",
        },
      }),
      agentMdPolicy: createActiveAgentMdPolicy(),
      agentMdFetchedAt: "2026-03-27T12:04:00.000Z",
      priorInteractionSummary: createEmptyPriorInteractionSummary(),
      accountState,
    });

    expect(decision.kind).toBe("hold");
    if (decision.kind === "hold") {
      expect(decision.holdReason).toBe("market-mismatch");
    }
  });

  it("holds when suggestion data is stale", () => {
    const decision = evaluateOpenClawPolicy({
      now: new Date("2026-03-27T12:30:01.000Z"),
      runtimeState: createBaseRuntimeState(),
      suggestionResult: createSuggestionResult(),
      agentMdPolicy: createActiveAgentMdPolicy(),
      agentMdFetchedAt: "2026-03-27T12:29:30.000Z",
      priorInteractionSummary: createEmptyPriorInteractionSummary(),
      accountState,
    });

    expect(decision.kind).toBe("hold");
    if (decision.kind === "hold") {
      expect(decision.holdReason).toBe("suggestion-stale");
    }
  });

  it("returns target-position for a valid fresh suggestion within caps", () => {
    const decision = evaluateOpenClawPolicy({
      now: new Date("2026-03-27T12:05:00.000Z"),
      runtimeState: createBaseRuntimeState(),
      suggestionResult: createSuggestionResult(),
      agentMdPolicy: createActiveAgentMdPolicy(),
      agentMdFetchedAt: "2026-03-27T12:04:00.000Z",
      priorInteractionSummary: createEmptyPriorInteractionSummary(),
      accountState,
    });

    expect(decision.kind).toBe("target-position");
    if (decision.kind === "target-position") {
      expect(decision.marketId).toBe("perps:hyperliquid:BTC-PERP");
      expect(decision.mode).toBe("perp");
      expect(decision.suggestionId).toBe("run-1::2026-03-27T12:00:00.000Z");
      expect(decision.target.side).toBe("long");
      expect(decision.target.targetFraction).toBe("0.4");
      expect(decision.target.leverage).toBe(3);
      expect(decision.confidence).toBe("0.8");
      expect(decision.rationale).toBe("Momentum aligns with the configured market.");
      expect(decision.keySignals).toEqual(["trend_up"]);
      expect(decision.stopLossPct).toBe("0.03");
      expect(decision.takeProfitPct).toBe("0.08");
      expect(decision.sources.side).toBe("suggestion");
      expect(decision.sources.targetFraction).toBe("suggestion");
      expect(decision.sources.leverage).toBe("suggestion");
    }
  });

  it("returns a visible hold when agent-authored intent explicitly chooses hold", () => {
    const decision = evaluateOpenClawPolicy({
      now: new Date("2026-03-27T12:05:00.000Z"),
      runtimeState: createBaseRuntimeState(),
      suggestionResult: createSuggestionResult(),
      agentMdPolicy: createActiveAgentMdPolicy(),
      agentMdFetchedAt: "2026-03-27T12:04:00.000Z",
      executionIntent: {
        action: "hold",
        rationale: "Wait for stronger confirmation before trading.",
      },
      priorInteractionSummary: createEmptyPriorInteractionSummary(),
      accountState,
    });

    expect(decision.kind).toBe("hold");
    if (decision.kind === "hold") {
      expect(decision.holdReason).toBe("agent-intent-hold");
      expect(decision.message).toBe("Wait for stronger confirmation before trading.");
    }
  });

  it("holds when market mode is spot and suggestion side is short", () => {
    const spotRuntime = createRuntimeState({
      wallet: {
        address: "0x1234567890abcdef1234567890ABCDEF12345678",
        mnemonicFilePath: "/home/grider/Desktop/openclaw-v4t-wallet-mnemonic.txt",
      },
      market: {
        venue: "hyperliquid",
        mode: "spot",
        marketId: "spot:hyperliquid:ETH/USDC",
        symbol: "ETH/USDC",
      },
      bridgeHistory: [
        {
          transferId: "bridge-1",
          amountUsd: "50",
          confirmedAt: "2026-03-27T10:00:00.000Z",
        },
      ],
    });

    const decision = evaluateOpenClawPolicy({
      now: new Date("2026-03-27T12:05:00.000Z"),
      runtimeState: spotRuntime,
      suggestionResult: createSuggestionResult({
        recommendation: {
          marketId: "spot:hyperliquid:ETH/USDC",
          recommendedMode: "spot",
          recommendedDirection: "short",
        },
      }),
      agentMdPolicy: createActiveAgentMdPolicy(),
      agentMdFetchedAt: "2026-03-27T12:04:00.000Z",
      priorInteractionSummary: createEmptyPriorInteractionSummary(),
      accountState: {
        supportedModes: ["spot"],
        maxTradableFraction: "0.9",
      },
    });

    expect(decision.kind).toBe("hold");
    if (decision.kind === "hold") {
      expect(decision.holdReason).toBe("spot-short-unsupported");
    }
  });

  it("holds when the suggestion provider degrades with unauthorized status", () => {
    const decision = evaluateOpenClawPolicy({
      now: new Date("2026-03-27T12:05:00.000Z"),
      runtimeState: createBaseRuntimeState(),
      suggestionResult: {
        kind: "degraded",
        reason: "unauthorized",
        httpStatus: 401,
        message: "Bad token.",
      },
      agentMdPolicy: createActiveAgentMdPolicy(),
      agentMdFetchedAt: "2026-03-27T12:04:00.000Z",
      priorInteractionSummary: createEmptyPriorInteractionSummary(),
      accountState,
    });

    expect(decision.kind).toBe("hold");
    if (decision.kind === "hold") {
      expect(decision.holdReason).toBe("suggestion-degraded");
      expect(decision.message).toMatch(/unauthorized/i);
    }
  });
});
