import { describe, expect, it } from "vitest";
import type { ExecutionAuditEntry, ExecutionDeps } from "../src/execution/engine";
import { executeDecision } from "../src/execution/engine";
import type { LocalPolicyDecision } from "../src/policy/engine";
import { createRuntimeState } from "../src/state";
import type { RuntimeState } from "../src/state/runtime-state";

function noopAudit(_entry: ExecutionAuditEntry): Promise<void> {
  return Promise.resolve();
}

const SLOT_ID = "2026-03-27T12:30:00.000Z";
const EXECUTED_AT = new Date("2026-03-27T12:31:00.000Z");

function createPerpState(): RuntimeState {
  return createRuntimeState({
    wallet: {
      address: "0x1234567890abcdef1234567890ABCDEF12345678",
      mnemonicFilePath: "/home/grider/Desktop/openclaw-v4t-wallet-mnemonic.txt",
    },
    market: {
      venue: "hyperliquid",
      mode: "perp",
      marketId: "perps:hyperliquid:ETH",
      symbol: "ETH",
    },
  });
}

function createSpotState(): RuntimeState {
  return createRuntimeState({
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
  });
}

function createTrackingDeps(): { deps: ExecutionDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: ExecutionDeps = {
    syncLeverage: async () => {
      calls.push("syncLeverage");
      return { success: true, exchangeId: null };
    },
    placeOrder: async () => {
      calls.push("placeOrder");
      return { success: true, statuses: [{ oid: 1 }] };
    },
    cancelOrder: async () => {
      calls.push("cancelOrder");
      return { success: true };
    },
    scheduleDeadMan: async () => {
      calls.push("scheduleDeadMan");
      return { scheduled: true, cancelTimeMs: Date.now() + 90_000 };
    },
    clearDeadMan: async () => {
      calls.push("clearDeadMan");
    },
    getMidPrice: async () => "3500",
    getAccountEquity: async () => "10000",
    getSizeDecimals: async () => 3,
    getAssetIndex: async () => 1,
    getPositionSize: async () => "0",
    getOpenOrders: async () => [],
    appendAuditEntry: noopAudit,
  };
  return { deps, calls };
}

function perpHoldDecision(): LocalPolicyDecision {
  return {
    kind: "hold",
    marketId: "perps:hyperliquid:ETH",
    mode: "perp",
    evaluatedAt: "2026-03-27T12:30:30.000Z",
    slotId: SLOT_ID,
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
  };
}

function perpTargetDecision(): LocalPolicyDecision {
  return {
    kind: "target-position",
    marketId: "perps:hyperliquid:ETH",
    mode: "perp",
    evaluatedAt: "2026-03-27T12:30:30.000Z",
    slotId: SLOT_ID,
    suggestionId: "sugg-001",
    overridePhrase: {
      wasAccepted: false,
      isAccepted: false,
      requiresAcceptance: false,
      shouldPersist: false,
    },
    agentStatus: "active",
    clamps: [],
    baselineTarget: { side: "long", targetFraction: "0.5", leverage: 3 },
    requestedTarget: { side: "long", targetFraction: "0.5", leverage: 3 },
    target: { side: "long", targetFraction: "0.5", leverage: 3 },
    sources: {
      side: "suggestion",
      targetFraction: "suggestion",
      leverage: "suggestion",
    },
    confidence: "0.8",
    rationale: "Momentum.",
    keySignals: ["trend_up"],
    stopLossPct: null,
    takeProfitPct: null,
  } as unknown as LocalPolicyDecision;
}

function spotTargetDecision(): LocalPolicyDecision {
  return {
    kind: "target-position",
    marketId: "spot:hyperliquid:ETH/USDC",
    mode: "spot",
    evaluatedAt: "2026-03-27T12:30:30.000Z",
    slotId: SLOT_ID,
    suggestionId: "sugg-002",
    overridePhrase: {
      wasAccepted: false,
      isAccepted: false,
      requiresAcceptance: false,
      shouldPersist: false,
    },
    agentStatus: "active",
    clamps: [],
    baselineTarget: { side: "long", targetFraction: "0.3", leverage: 1 },
    requestedTarget: { side: "long", targetFraction: "0.3", leverage: 1 },
    target: { side: "long", targetFraction: "0.3", leverage: 1 },
    sources: {
      side: "suggestion",
      targetFraction: "suggestion",
      leverage: "suggestion",
    },
    confidence: "0.7",
    rationale: "Momentum.",
    keySignals: ["trend_up"],
    stopLossPct: null,
    takeProfitPct: null,
  } as unknown as LocalPolicyDecision;
}

describe("execution deadman scheduling", () => {
  it("hold execution records disabled dead-man action", async () => {
    const { deps, calls } = createTrackingDeps();
    const state = createPerpState();

    const result = await executeDecision(perpHoldDecision(), state, deps, EXECUTED_AT);

    expect(calls.filter((c) => c === "scheduleDeadMan")).toHaveLength(0);
    expect(calls.filter((c) => c === "clearDeadMan")).toHaveLength(0);
    const deadManAction = result.actions.find((a) => a.kind === "dead-man-schedule");
    expect(deadManAction).toBeDefined();
    expect(deadManAction?.detail).toContain("disabled");
  });

  it("perp target-position records disabled dead-man action instead of clearing", async () => {
    const { deps, calls } = createTrackingDeps();
    const state = createPerpState();

    const result = await executeDecision(perpTargetDecision(), state, deps, EXECUTED_AT);

    expect(calls.filter((c) => c === "scheduleDeadMan")).toHaveLength(0);
    expect(calls.filter((c) => c === "clearDeadMan")).toHaveLength(0);
    const deadManAction = result.actions.find((a) => a.kind === "dead-man-schedule");
    expect(deadManAction).toBeDefined();
    expect(deadManAction?.detail).toContain("disabled");
  });

  it("spot target-position with open orders records disabled dead-man action", async () => {
    const { deps, calls } = createTrackingDeps();
    const state = createSpotState();

    const depsWithOrders: ExecutionDeps = {
      ...deps,
      getOpenOrders: async () => [{ oid: 1, coin: "ETH/USDC" }],
    };

    const result = await executeDecision(spotTargetDecision(), state, depsWithOrders, EXECUTED_AT);

    expect(calls.filter((c) => c === "scheduleDeadMan")).toHaveLength(0);
    expect(calls.filter((c) => c === "clearDeadMan")).toHaveLength(0);
    const deadManAction = result.actions.find((a) => a.kind === "dead-man-schedule");
    expect(deadManAction).toBeDefined();
    expect(deadManAction?.detail).toContain("disabled");
  });

  it("flat target-position records disabled dead-man action after successful flatten", async () => {
    const { deps, calls } = createTrackingDeps();
    const state = createPerpState();
    const decision = {
      ...perpTargetDecision(),
      target: { side: "flat", targetFraction: "0", leverage: 0 },
    } as unknown as LocalPolicyDecision;

    let callCount = 0;
    const depsAfterClose: ExecutionDeps = {
      ...deps,
      getPositionSize: async () => {
        callCount += 1;
        return callCount === 1 ? "1.2" : "0";
      },
    };

    const result = await executeDecision(decision, state, depsAfterClose, EXECUTED_AT);

    expect(calls.filter((c) => c === "scheduleDeadMan")).toHaveLength(0);
    expect(calls.filter((c) => c === "clearDeadMan")).toHaveLength(0);
    const deadManAction = result.actions.find((a) => a.kind === "dead-man-schedule");
    expect(deadManAction).toBeDefined();
    expect(deadManAction?.detail).toContain("disabled");
  });

  it("dead-man disabled action is recorded and does not throw", async () => {
    const deps: ExecutionDeps = {
      syncLeverage: async () => ({ success: true, exchangeId: null }),
      placeOrder: async () => ({ success: true, statuses: [] }),
      cancelOrder: async () => ({ success: true }),
      scheduleDeadMan: async () => ({
        scheduled: false,
        reason: "Cancel time must be at least 5000ms in the future",
      }),
      clearDeadMan: async () => {},
      getMidPrice: async () => "3500",
      getAccountEquity: async () => "10000",
      getSizeDecimals: async () => 3,
      getAssetIndex: async () => 1,
      getPositionSize: async () => "0",
      getOpenOrders: async () => [{ oid: 2, coin: "ETH" }],
      appendAuditEntry: noopAudit,
    };

    const state = createPerpState();
    const result = await executeDecision(perpTargetDecision(), state, deps, EXECUTED_AT);

    expect(result.skipped).toBe(false);
    const deadManAction = result.actions.find((a) => a.kind === "dead-man-schedule");
    expect(deadManAction).toBeDefined();
    expect(deadManAction?.detail).toContain("disabled");
  });

  it("disabled dead-man-schedule appears as last action", async () => {
    const { deps } = createTrackingDeps();
    const state = createPerpState();

    const result = await executeDecision(perpTargetDecision(), state, deps, EXECUTED_AT);

    const lastAction = result.actions[result.actions.length - 1];
    expect(lastAction.kind).toBe("dead-man-schedule");
    expect(lastAction.detail).toContain("disabled");
  });

  it("no-mid-price path records disabled dead-man action", async () => {
    const { deps, calls } = createTrackingDeps();
    const noMidDeps: ExecutionDeps = {
      ...deps,
      getMidPrice: async () => null,
    };
    const state = createPerpState();

    const result = await executeDecision(perpTargetDecision(), state, noMidDeps, EXECUTED_AT);

    expect(calls.filter((c) => c === "scheduleDeadMan")).toHaveLength(0);
    expect(calls.filter((c) => c === "clearDeadMan")).toHaveLength(0);
    const deadManAction = result.actions.find((a) => a.kind === "dead-man-schedule");
    expect(deadManAction).toBeDefined();
    expect(deadManAction?.detail).toContain("disabled");
  });
});
