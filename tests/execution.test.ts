import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ExecutionAuditEntry,
  type ExecutionDeps,
  ExecutionError,
  appendAuditEntry,
  buildAuditEntry,
  executeDecision,
} from "../src/execution/engine";
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
      mnemonicFilePath: "/home/grider/Desktop/openclaw-v4t-wallet-mnemonic.txt",
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

function createMockDeps(overrides: Partial<ExecutionDeps> = {}): ExecutionDeps {
  return {
    syncLeverage: async () => ({ success: true, exchangeId: "lev-001" }),
    placeOrder: async () => ({ success: true, statuses: [{ oid: 12345 }] }),
    cancelOrder: async () => ({ success: true }),
    scheduleDeadMan: async () => ({
      scheduled: true,
      cancelTimeMs: Date.now() + 90_000,
    }),
    clearDeadMan: async () => {},
    getMidPrice: async () => "1800.5",
    getAccountEquity: async () => "10000",
    getSizeDecimals: async () => 4,
    getAssetIndex: async () => 4,
    getPositionSize: async () => "0",
    getOpenOrders: async () => [],
    appendAuditEntry: noopAudit,
    ...overrides,
  };
}

function createHoldDecision(overrides: Partial<LocalPolicyDecision> = {}): LocalPolicyDecision {
  return {
    kind: "hold",
    marketId: "spot:hyperliquid:ETH/USDC",
    mode: "spot",
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
    message: "No fresh suggestion available.",
    ...overrides,
  } as LocalPolicyDecision;
}

function createSpotTargetDecision(overrides: Record<string, unknown> = {}): LocalPolicyDecision {
  return {
    kind: "target-position",
    marketId: "spot:hyperliquid:ETH/USDC",
    mode: "spot",
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
    baselineTarget: { side: "long", targetFraction: "0.4", leverage: 1 },
    requestedTarget: { side: "long", targetFraction: "0.4", leverage: 1 },
    target: { side: "long", targetFraction: "0.4", leverage: 1 },
    sources: {
      side: "suggestion",
      targetFraction: "suggestion",
      leverage: "suggestion",
    },
    confidence: "0.8",
    rationale: "Momentum aligns.",
    keySignals: ["trend_up"],
    stopLossPct: "0.03",
    takeProfitPct: "0.08",
    ...overrides,
  } as unknown as LocalPolicyDecision;
}

describe("execution engine — spot", () => {
  let state: RuntimeState;
  let deps: ExecutionDeps;

  beforeEach(() => {
    state = createTestState();
    deps = createMockDeps();
  });

  it("hold decision clears dead-man when flat with no orders", async () => {
    const decision = createHoldDecision();
    const result = await executeDecision(decision, state, deps, EXECUTED_AT);

    expect(result.skipped).toBe(false);
    expect(result.judgmentSummary).toContain("Hold");
    expect(result.actions.some((a) => a.kind === "no-trade")).toBe(true);
    expect(result.actions.some((a) => a.kind === "dead-man-schedule")).toBe(true);
    expect(result.slotId).toBe(SLOT_ID);
    expect(result.suggestionId).toBeNull();
  });

  it("spot long target-position places order without leverage sync", async () => {
    const decision = createSpotTargetDecision();
    const result = await executeDecision(decision, state, deps, EXECUTED_AT);

    expect(result.skipped).toBe(false);
    expect(result.mode).toBe("spot");

    const leverageActions = result.actions.filter((a) => a.kind === "leverage-sync");
    expect(leverageActions).toHaveLength(0);

    const orderActions = result.actions.filter((a) => a.kind === "place-order");
    expect(orderActions).toHaveLength(1);
    expect(orderActions[0].detail).toContain("Buy");

    expect(result.actions.some((a) => a.kind === "place-order")).toBe(true);
  });

  it("spot long target-position returns structured failure on embedded order rejection", async () => {
    const rejectedDeps = createMockDeps({
      placeOrder: async () => ({
        success: false,
        statuses: [{ error: "Insufficient margin to place order." }],
      }),
    });

    const decision = createSpotTargetDecision();
    const result = await executeDecision(decision, state, rejectedDeps, EXECUTED_AT);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("order-rejected");
    expect(result.judgmentSummary).toContain("failed");

    const orderActions = result.actions.filter((a) => a.kind === "place-order");
    expect(orderActions).toHaveLength(1);
    expect(orderActions[0].detail).toContain("success=false");
    expect(orderActions[0].detail).toContain("Insufficient margin to place order.");
    expect(result.actions.some((a) => a.kind === "dead-man-schedule")).toBe(true);
    expect(result.actions.some((a) => a.kind === "dead-man-clear")).toBe(false);
  });

  it("spot target sizes from current position delta", async () => {
    const placeOrder = vi.fn(async () => ({
      success: true,
      statuses: [{ oid: 70001 }],
    }));
    const deltaDeps = createMockDeps({
      getMidPrice: async () => "2000",
      getAccountEquity: async () => "10000",
      getSizeDecimals: async () => 3,
      getPositionSize: async () => "1.25",
      placeOrder,
    });

    const decision = createSpotTargetDecision();
    await executeDecision(decision, state, deltaDeps, EXECUTED_AT);

    expect(placeOrder).toHaveBeenCalledWith({
      assetIndex: 4,
      isBuy: true,
      price: "2000",
      size: "0.75",
      reduceOnly: false,
      orderType: "ioc",
      clientOrderId: `oc-${SLOT_ID}-long`,
    });
  });

  it("spot target skips trading when current position already matches target delta", async () => {
    const placeOrder = vi.fn(async () => ({
      success: true,
      statuses: [{ oid: 70002 }],
    }));
    const zeroDeltaDeps = createMockDeps({
      getMidPrice: async () => "2000",
      getAccountEquity: async () => "10000",
      getSizeDecimals: async () => 3,
      getPositionSize: async () => "2",
      placeOrder,
    });

    const decision = createSpotTargetDecision();
    const result = await executeDecision(decision, state, zeroDeltaDeps, EXECUTED_AT);

    expect(placeOrder).not.toHaveBeenCalled();
    expect(result.judgmentSummary).toContain("delta is zero");
    expect(result.actions.some((a) => a.kind === "dead-man-schedule")).toBe(true);
    expect(result.actions.some((a) => a.kind === "dead-man-clear")).toBe(false);
  });

  it("spot hold with existing open orders arms dead-man", async () => {
    const holdDeps = createMockDeps({
      getOpenOrders: async () => [{ oid: 321, coin: "ETH/USDC" }],
    });

    const result = await executeDecision(createHoldDecision(), state, holdDeps, EXECUTED_AT);

    expect(result.actions.some((a) => a.kind === "dead-man-schedule")).toBe(true);
    expect(result.actions.some((a) => a.kind === "dead-man-clear")).toBe(false);
  });

  it("spot flat target cancels open orders and clears dead-man when flat", async () => {
    const getOpenOrders = vi
      .fn<ExecutionDeps["getOpenOrders"]>()
      .mockResolvedValueOnce([
        { oid: 100, coin: "ETH/USDC" },
        { oid: 101, coin: "ETH/USDC" },
      ])
      .mockResolvedValueOnce([]);
    const openOrderDeps = createMockDeps({
      getOpenOrders,
    });

    const decision = createSpotTargetDecision({
      target: { side: "flat", targetFraction: "0", leverage: 0 },
    });

    const result = await executeDecision(decision, state, openOrderDeps, EXECUTED_AT);

    const cancelActions = result.actions.filter((a) => a.kind === "cancel-order");
    expect(cancelActions).toHaveLength(2);
    expect(cancelActions[0].exchangeId).toBe("100");
    expect(cancelActions[1].exchangeId).toBe("101");
    expect(result.actions.some((a) => a.kind === "dead-man-schedule")).toBe(true);
  });

  it("spot flat with no open orders and no position produces no-trade action", async () => {
    const decision = createSpotTargetDecision({
      target: { side: "flat", targetFraction: "0", leverage: 0 },
    });

    const result = await executeDecision(decision, state, deps, EXECUTED_AT);

    expect(result.actions.some((a) => a.kind === "no-trade")).toBe(true);
    expect(result.actions.some((a) => a.kind === "dead-man-schedule")).toBe(true);
    expect(result.judgmentSummary).toContain("flat");
  });

  it("spot flat with existing position places reduce-only close order then clears dead-man", async () => {
    const getPositionSize = vi
      .fn<ExecutionDeps["getPositionSize"]>()
      .mockResolvedValueOnce("1.5")
      .mockResolvedValueOnce("0");
    const positionDeps = createMockDeps({
      getPositionSize,
      placeOrder: async () => ({
        success: true,
        statuses: [{ oid: 77777 }],
      }),
    });

    const decision = createSpotTargetDecision({
      target: { side: "flat", targetFraction: "0", leverage: 0 },
    });

    const result = await executeDecision(decision, state, positionDeps, EXECUTED_AT);

    const closeActions = result.actions.filter((a) => a.kind === "close-position");
    expect(closeActions).toHaveLength(1);
    expect(closeActions[0].detail).toContain("Close");
    expect(closeActions[0].detail).toContain("1.5");
    expect(closeActions[0].detail).toContain("ETH");
    expect(closeActions[0].detail).toContain("reduce-only");
    expect(result.actions.some((a) => a.kind === "dead-man-schedule")).toBe(true);
  });

  it("spot flat close returns structured failure on embedded order rejection", async () => {
    const rejectedDeps = createMockDeps({
      getPositionSize: async () => "1.5",
      placeOrder: async () => ({
        success: false,
        statuses: [{ error: "Reduce only order would increase position." }],
      }),
    });

    const decision = createSpotTargetDecision({
      target: { side: "flat", targetFraction: "0", leverage: 0 },
    });

    const result = await executeDecision(decision, state, rejectedDeps, EXECUTED_AT);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("order-rejected");
    expect(result.judgmentSummary).toContain("failed");

    const closeActions = result.actions.filter((a) => a.kind === "close-position");
    expect(closeActions).toHaveLength(1);
    expect(closeActions[0].detail).toContain("success=false");
    expect(closeActions[0].detail).toContain("Reduce only order would increase position.");
    expect(result.actions.some((a) => a.kind === "dead-man-schedule")).toBe(true);
    expect(result.actions.some((a) => a.kind === "dead-man-clear")).toBe(false);
  });

  it("spot flat close uses base asset ETH for position lookup not ETH/USDC", async () => {
    let positionCoin: string | null = null;
    const trackingDeps = createMockDeps({
      getPositionSize: async (coin) => {
        positionCoin = coin;
        return "2.0";
      },
    });

    const decision = createSpotTargetDecision({
      target: { side: "flat", targetFraction: "0", leverage: 0 },
    });

    await executeDecision(decision, state, trackingDeps, EXECUTED_AT);

    expect(positionCoin).toBe("ETH");
  });

  it("market mismatch throws ExecutionError", async () => {
    const decision = createHoldDecision({
      marketId: "perps:hyperliquid:BTC-PERP",
      mode: "perp",
    });

    await expect(executeDecision(decision, state, deps, EXECUTED_AT)).rejects.toThrow(
      ExecutionError,
    );
    await expect(executeDecision(decision, state, deps, EXECUTED_AT)).rejects.toThrow(
      /Market mismatch/,
    );
  });

  it("no mid price falls back to no-trade without arming dead-man", async () => {
    const noMidDeps = createMockDeps({ getMidPrice: async () => null });
    const decision = createSpotTargetDecision();
    const result = await executeDecision(decision, state, noMidDeps, EXECUTED_AT);

    expect(result.actions.some((a) => a.kind === "no-trade")).toBe(true);
    expect(result.actions.some((a) => a.kind === "dead-man-schedule")).toBe(true);
    expect(result.actions.some((a) => a.kind === "dead-man-clear")).toBe(false);
    expect(result.judgmentSummary).toContain("no mid price");
  });

  it("buildAuditEntry extracts audit fields from result", async () => {
    const decision = createSpotTargetDecision();
    const result = await executeDecision(decision, state, deps, EXECUTED_AT);
    const audit = buildAuditEntry(result);

    expect(audit.slotId).toBe(SLOT_ID);
    expect(audit.suggestionId).toBe("sugg-001");
    expect(audit.marketId).toBe("spot:hyperliquid:ETH/USDC");
    expect(audit.mode).toBe("spot");
    expect(audit.skipped).toBe(false);
    expect(audit.skipReason).toBeNull();
    expect(audit.actions.length).toBeGreaterThan(0);
    expect(audit.exchangeIds.length).toBe(audit.actions.length);
    expect(audit.executedAt).toBe(EXECUTED_AT.toISOString());
  });
});

describe("execution audit persistence", () => {
  let auditFilePath: string;

  beforeEach(() => {
    auditFilePath = join(
      tmpdir(),
      `execution-test-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
    );
  });

  afterEach(() => {
    try {
      rmSync(auditFilePath, { force: true });
    } catch {
      // ignore
    }
  });

  it("appendAuditEntry writes NDJSON line to file", async () => {
    const entry: ExecutionAuditEntry = {
      slotId: SLOT_ID,
      suggestionId: "sugg-001",
      marketId: "spot:hyperliquid:ETH/USDC",
      mode: "spot",
      judgmentSummary: "Hold: no-suggestion",
      actions: [
        {
          kind: "no-trade",
          detail: "Hold: no-suggestion — No fresh suggestion.",
          exchangeId: null,
        },
      ],
      exchangeIds: [null],
      skipped: false,
      skipReason: null,
      executedAt: EXECUTED_AT.toISOString(),
      retryMetadata: null,
      reshapingMetadata: null,
    };

    await appendAuditEntry(entry, auditFilePath);

    const content = readFileSync(auditFilePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]) as ExecutionAuditEntry;
    expect(parsed.slotId).toBe(SLOT_ID);
    expect(parsed.suggestionId).toBe("sugg-001");
    expect(parsed.judgmentSummary).toBe("Hold: no-suggestion");
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.exchangeIds).toHaveLength(1);
  });

  it("appendAuditEntry appends multiple entries as separate lines", async () => {
    const entry1: ExecutionAuditEntry = {
      slotId: "2026-03-27T12:30:00.000Z",
      suggestionId: null,
      marketId: "spot:hyperliquid:ETH/USDC",
      mode: "spot",
      judgmentSummary: "Hold: no-suggestion",
      actions: [],
      exchangeIds: [],
      skipped: false,
      skipReason: null,
      executedAt: "2026-03-27T12:31:00.000Z",
      retryMetadata: null,
      reshapingMetadata: null,
    };
    const entry2: ExecutionAuditEntry = {
      slotId: "2026-03-27T13:30:00.000Z",
      suggestionId: "sugg-002",
      marketId: "perps:hyperliquid:ETH",
      mode: "perp",
      judgmentSummary: "Target-position: long 0.5 @ 3x",
      actions: [
        {
          kind: "place-order",
          detail: "Buy 0.5 @ 3500 (IOC)",
          exchangeId: '{"oid":42}',
        },
      ],
      exchangeIds: ['{"oid":42}'],
      skipped: false,
      skipReason: null,
      executedAt: "2026-03-27T13:31:00.000Z",
      retryMetadata: null,
      reshapingMetadata: null,
    };

    await appendAuditEntry(entry1, auditFilePath);
    await appendAuditEntry(entry2, auditFilePath);

    const content = readFileSync(auditFilePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const p1 = JSON.parse(lines[0]) as ExecutionAuditEntry;
    const p2 = JSON.parse(lines[1]) as ExecutionAuditEntry;
    expect(p1.slotId).toBe("2026-03-27T12:30:00.000Z");
    expect(p2.slotId).toBe("2026-03-27T13:30:00.000Z");
    expect(p2.exchangeIds).toEqual(['{"oid":42}']);
  });

  it("executeDecision invokes injected appendAuditEntry automatically", async () => {
    const captured: ExecutionAuditEntry[] = [];
    const state = createTestState();
    const deps = createMockDeps({
      appendAuditEntry: async (entry) => {
        captured.push(entry);
      },
    });
    const decision = createHoldDecision();

    const result = await executeDecision(decision, state, deps, EXECUTED_AT);

    expect(captured).toHaveLength(1);
    expect(captured[0].slotId).toBe(result.slotId);
    expect(captured[0].judgmentSummary).toBe(result.judgmentSummary);
  });
});
