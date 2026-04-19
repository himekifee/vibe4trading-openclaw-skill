import { describe, expect, it } from "vitest";
import type { ExecutionAuditEntry, ExecutionDeps } from "../src/execution/engine";
import { ExecutionError, executeDecision } from "../src/execution/engine";
import type { LocalPolicyDecision } from "../src/policy/engine";
import { createRuntimeState } from "../src/state";
import type { RuntimeState } from "../src/state/runtime-state";

function noopAudit(_entry: ExecutionAuditEntry): Promise<void> {
  return Promise.resolve();
}

const SLOT_ID = "2026-03-27T12:30:00.000Z";
const EXECUTED_AT = new Date("2026-03-27T12:31:00.000Z");

function createTestState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return createRuntimeState({
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
    ...overrides,
  });
}

function createMockDeps(): ExecutionDeps {
  return {
    syncLeverage: async () => ({ success: true, exchangeId: null }),
    placeOrder: async () => ({ success: true, statuses: [] }),
    cancelOrder: async () => ({ success: true }),
    scheduleDeadMan: async () => ({ scheduled: true, cancelTimeMs: Date.now() + 90_000 }),
    getMidPrice: async () => "3500",
    getAccountEquity: async () => "10000",
    getSizeDecimals: async () => 3,
    getAssetIndex: async () => 1,
    getPositionSize: async () => "0",
    getOpenOrders: async () => [],
    appendAuditEntry: noopAudit,
  };
}

function createHoldDecision(): LocalPolicyDecision {
  return {
    kind: "hold",
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
    holdReason: "no-suggestion",
    message: "No suggestion.",
  };
}

describe("execution idempotent slot guard", () => {
  it("first execution for a slot succeeds", async () => {
    const state = createTestState();
    const deps = createMockDeps();
    const decision = createHoldDecision();

    const result = await executeDecision(decision, state, deps, EXECUTED_AT);

    expect(result.skipped).toBe(false);
    expect(result.skipReason).toBeNull();
    expect(result.actions.length).toBeGreaterThan(0);
  });

  it("duplicate slot execution is skipped when lastExecutedSlot matches", async () => {
    const state = createTestState({ lastExecutedSlot: SLOT_ID });
    const deps = createMockDeps();
    const decision = createHoldDecision();

    const result = await executeDecision(decision, state, deps, EXECUTED_AT);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("duplicate-slot");
    expect(result.actions).toHaveLength(0);
    expect(result.judgmentSummary).toContain("Duplicate slot");
  });

  it("different slot executes normally even with lastExecutedSlot set", async () => {
    const previousSlot = "2026-03-27T11:30:00.000Z";
    const state = createTestState({ lastExecutedSlot: previousSlot });
    const deps = createMockDeps();
    const decision = createHoldDecision();

    const result = await executeDecision(decision, state, deps, EXECUTED_AT);

    expect(result.skipped).toBe(false);
    expect(result.slotId).toBe(SLOT_ID);
  });

  it("null lastExecutedSlot always allows execution", async () => {
    const state = createTestState({ lastExecutedSlot: null });
    const deps = createMockDeps();
    const decision = createHoldDecision();

    const result = await executeDecision(decision, state, deps, EXECUTED_AT);

    expect(result.skipped).toBe(false);
  });

  it("market mismatch is checked before slot deduplication", async () => {
    const state = createTestState({ lastExecutedSlot: SLOT_ID });
    const deps = createMockDeps();
    const mismatchedDecision: LocalPolicyDecision = {
      ...createHoldDecision(),
      marketId: "perps:hyperliquid:BTC-PERP",
    };

    await expect(executeDecision(mismatchedDecision, state, deps, EXECUTED_AT)).rejects.toThrow(
      ExecutionError,
    );
  });

  it("skipped result still carries slot and suggestion metadata", async () => {
    const state = createTestState({ lastExecutedSlot: SLOT_ID });
    const deps = createMockDeps();
    const decision = createHoldDecision();

    const result = await executeDecision(decision, state, deps, EXECUTED_AT);

    expect(result.slotId).toBe(SLOT_ID);
    expect(result.suggestionId).toBe("sugg-001");
    expect(result.marketId).toBe("perps:hyperliquid:ETH");
    expect(result.mode).toBe("perp");
    expect(result.executedAt).toBe(EXECUTED_AT.toISOString());
  });
});
