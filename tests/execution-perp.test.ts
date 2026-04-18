import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ORDER_STYLE, MAX_IOC_SAME_TICK_RETRIES } from "../src/config/constants";
import type { ExecutionAuditEntry, ExecutionDeps } from "../src/execution/engine";
import { executeDecision } from "../src/execution/engine";
import type { LocalPolicyDecision } from "../src/policy/engine";
import { createRuntimeState } from "../src/state";
import type { RuntimeState } from "../src/state/runtime-state";

const SLOT_ID = "2026-03-27T12:30:00.000Z";
const EXECUTED_AT = new Date("2026-03-27T12:31:00.000Z");

function noopAudit(_entry: ExecutionAuditEntry): Promise<void> {
  return Promise.resolve();
}

function createPerpState(overrides: Partial<RuntimeState> = {}): RuntimeState {
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
    ...overrides,
  });
}

function createMockDeps(overrides: Partial<ExecutionDeps> = {}): ExecutionDeps {
  return {
    syncLeverage: async () => ({ success: true, exchangeId: "lev-001" }),
    placeOrder: async () => ({
      success: true,
      statuses: [{ oid: 99999 }],
    }),
    cancelOrder: async () => ({ success: true }),
    scheduleDeadMan: async () => ({
      scheduled: true,
      cancelTimeMs: Date.now() + 90_000,
    }),
    clearDeadMan: async () => {},
    getMidPrice: async () => "3500.25",
    getAccountEquity: async () => "10000",
    getSizeDecimals: async () => 3,
    getAssetIndex: async () => 1,
    getPositionSize: async () => "0",
    getOpenOrders: async () => [],
    appendAuditEntry: noopAudit,
    ...overrides,
  };
}

function createPerpTargetDecision(overrides: Record<string, unknown> = {}): LocalPolicyDecision {
  return {
    kind: "target-position",
    marketId: "perps:hyperliquid:ETH",
    mode: "perp",
    evaluatedAt: "2026-03-27T12:30:30.000Z",
    slotId: SLOT_ID,
    suggestionId: "sugg-perp-001",
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
    confidence: "0.85",
    rationale: "Strong perp momentum.",
    keySignals: ["trend_up", "funding_positive"],
    stopLossPct: "0.02",
    takeProfitPct: "0.06",
    ...overrides,
  } as unknown as LocalPolicyDecision;
}

describe("execution engine — perp", () => {
  let state: RuntimeState;
  let deps: ExecutionDeps;

  beforeEach(() => {
    state = createPerpState();
    deps = createMockDeps();
  });

  it("perp long target syncs leverage before placing order", async () => {
    let leverageSynced = false;
    let orderPlaced = false;
    const callOrder: string[] = [];

    const trackedDeps = createMockDeps({
      syncLeverage: async (_assetIndex, leverage) => {
        leverageSynced = true;
        callOrder.push("leverage");
        return { success: true, exchangeId: `lev-${leverage}x` };
      },
      placeOrder: async () => {
        orderPlaced = true;
        callOrder.push("order");
        return { success: true, statuses: [{ oid: 42 }] };
      },
    });

    const decision = createPerpTargetDecision();
    const result = await executeDecision(decision, state, trackedDeps, EXECUTED_AT);

    expect(leverageSynced).toBe(true);
    expect(orderPlaced).toBe(true);
    expect(callOrder).toEqual(["leverage", "order"]);

    const leverageAction = result.actions.find((a) => a.kind === "leverage-sync");
    expect(leverageAction).toBeDefined();
    expect(leverageAction?.detail).toContain("3x");
    expect(leverageAction?.exchangeId).toBe("lev-3x");

    const orderAction = result.actions.find((a) => a.kind === "place-order");
    expect(orderAction).toBeDefined();
    expect(orderAction?.detail).toContain("Buy");
    expect(orderAction?.detail).toContain(DEFAULT_ORDER_STYLE.toUpperCase());
  });

  it("passes validated agent-directed order style to exchange placement", async () => {
    const placeOrder = vi.fn(async () => ({
      success: true,
      statuses: [{ oid: 70001 }],
    }));

    await executeDecision(
      createPerpTargetDecision(),
      state,
      createMockDeps({ placeOrder }),
      EXECUTED_AT,
      { orderStyle: "gtc" },
    );

    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        orderType: "gtc",
        clientOrderId: `oc-${SLOT_ID}-long`,
      }),
    );
  });

  it("perp long target returns structured failure on embedded order rejection", async () => {
    const rejectedDeps = createMockDeps({
      placeOrder: async () => ({
        success: false,
        statuses: [{ error: "Insufficient margin to place order." }],
      }),
    });

    const decision = createPerpTargetDecision();
    const result = await executeDecision(decision, state, rejectedDeps, EXECUTED_AT);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("order-rejected");
    expect(result.judgmentSummary).toContain("failed");

    const orderAction = result.actions.find((a) => a.kind === "place-order");
    expect(orderAction).toBeDefined();
    expect(orderAction?.detail).toContain("success=false");
    expect(orderAction?.detail).toContain("Insufficient margin to place order.");
    expect(result.actions.some((a) => a.kind === "dead-man-clear")).toBe(true);
  });

  it("computes perp order size from target minus current position delta", async () => {
    const placeOrder = vi.fn(async () => ({
      success: true,
      statuses: [{ oid: 4242 }],
    }));
    const sizedDeps = createMockDeps({
      getAccountEquity: async () => "10000",
      getMidPrice: async () => "3500",
      getSizeDecimals: async () => 3,
      getPositionSize: async () => "0.428",
      placeOrder,
    });

    await executeDecision(createPerpTargetDecision(), state, sizedDeps, EXECUTED_AT);

    expect(placeOrder).toHaveBeenCalledWith({
      assetIndex: 1,
      isBuy: true,
      price: "3500",
      size: "1",
      reduceOnly: false,
      orderType: "ioc",
      clientOrderId: `oc-${SLOT_ID}-long`,
    });
  });

  it("skips placing order when delta to target normalizes to zero", async () => {
    const placeOrder = vi.fn(async () => ({
      success: true,
      statuses: [{ oid: 5151 }],
    }));
    const zeroFractionDeps = createMockDeps({
      placeOrder,
      getAccountEquity: async () => "10000",
      getMidPrice: async () => "3500",
      getSizeDecimals: async () => 3,
      getPositionSize: async () => "1.428",
    });
    const decision = createPerpTargetDecision();

    const result = await executeDecision(decision, state, zeroFractionDeps, EXECUTED_AT);

    expect(placeOrder).not.toHaveBeenCalled();
    expect(result.actions.some((action) => action.kind === "place-order")).toBe(false);
    expect(result.actions.some((action) => action.kind === "no-trade")).toBe(true);
    expect(result.judgmentSummary).toContain("delta is zero");
    expect(result.actions.some((action) => action.kind === "dead-man-clear")).toBe(false);
  });

  it("perp short target places sell order", async () => {
    const decision = createPerpTargetDecision({
      target: { side: "short", targetFraction: "0.3", leverage: 2 },
    });

    const result = await executeDecision(decision, state, deps, EXECUTED_AT);

    const orderAction = result.actions.find((a) => a.kind === "place-order");
    expect(orderAction).toBeDefined();
    expect(orderAction?.detail).toContain("Sell");
  });

  it("perp reversal closes existing exposure before opening replacement leg", async () => {
    const placeOrder = vi
      .fn<ExecutionDeps["placeOrder"]>()
      .mockResolvedValueOnce({ success: true, statuses: [{ oid: 88001 }] })
      .mockResolvedValueOnce({ success: true, statuses: [{ oid: 88002 }] });
    const getPositionSize = vi
      .fn<ExecutionDeps["getPositionSize"]>()
      .mockResolvedValueOnce("2")
      .mockResolvedValueOnce("0")
      .mockResolvedValue("-1.5");
    const decision = createPerpTargetDecision({
      baselineTarget: { side: "short", targetFraction: "0.3", leverage: 3 },
      requestedTarget: { side: "short", targetFraction: "0.3", leverage: 3 },
      target: { side: "short", targetFraction: "0.3", leverage: 3 },
    });

    const result = await executeDecision(
      decision,
      state,
      createMockDeps({
        getMidPrice: async () => "2000",
        getAccountEquity: async () => "10000",
        getSizeDecimals: async () => 3,
        getPositionSize,
        placeOrder,
      }),
      EXECUTED_AT,
    );

    expect(placeOrder).toHaveBeenNthCalledWith(1, {
      assetIndex: 1,
      isBuy: false,
      price: "2000",
      size: "2",
      reduceOnly: true,
      orderType: "ioc",
      clientOrderId: `oc-${SLOT_ID}-close`,
    });
    expect(placeOrder).toHaveBeenNthCalledWith(2, {
      assetIndex: 1,
      isBuy: false,
      price: "2000",
      size: "1.5",
      reduceOnly: false,
      orderType: "ioc",
      clientOrderId: `oc-${SLOT_ID}-short`,
    });
    expect(result.actions.map((action) => action.kind)).toContain("close-position");
    expect(result.actions.map((action) => action.kind)).toContain("place-order");
  });

  it("perp reversal aborts reopen when close leg does not flatten", async () => {
    const placeOrder = vi.fn<ExecutionDeps["placeOrder"]>().mockResolvedValue({
      success: true,
      statuses: [{ oid: 88003 }],
    });
    // Position starts at 2, stays at 2 after close attempt (no fill at all),
    // so the retry loop detects zero progress and aborts after 1 attempt.
    const getPositionSize = vi
      .fn<ExecutionDeps["getPositionSize"]>()
      .mockResolvedValueOnce("2")
      .mockResolvedValue("2");
    const decision = createPerpTargetDecision({
      baselineTarget: { side: "short", targetFraction: "0.3", leverage: 3 },
      requestedTarget: { side: "short", targetFraction: "0.3", leverage: 3 },
      target: { side: "short", targetFraction: "0.3", leverage: 3 },
    });

    const result = await executeDecision(
      decision,
      state,
      createMockDeps({
        getMidPrice: async () => "2000",
        getAccountEquity: async () => "10000",
        getSizeDecimals: async () => 3,
        getPositionSize,
        placeOrder,
      }),
      EXECUTED_AT,
    );

    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("position-not-flat");
    expect(result.judgmentSummary).toContain("did not flatten");
  });

  it("perp flat cancels orders and closes existing short position", async () => {
    const getOpenOrders = vi
      .fn<ExecutionDeps["getOpenOrders"]>()
      .mockResolvedValueOnce([{ oid: 500, coin: "ETH" }])
      .mockResolvedValueOnce([]);
    const getPositionSize = vi
      .fn<ExecutionDeps["getPositionSize"]>()
      .mockResolvedValueOnce("-2.5")
      .mockResolvedValueOnce("0");
    const depsWithPosition = createMockDeps({
      getOpenOrders,
      getPositionSize,
      placeOrder: async () => ({
        success: true,
        statuses: [{ oid: 88888 }],
      }),
    });

    const decision = createPerpTargetDecision({
      target: { side: "flat", targetFraction: "0", leverage: 0 },
    });

    const result = await executeDecision(decision, state, depsWithPosition, EXECUTED_AT);

    expect(result.actions.some((a) => a.kind === "cancel-order")).toBe(true);
    const closeActions = result.actions.filter((a) => a.kind === "close-position");
    expect(closeActions).toHaveLength(1);
    expect(closeActions[0].detail).toContain("Close");
    expect(closeActions[0].detail).toContain("-2.5");
    expect(closeActions[0].detail).toContain("reduce-only");
    expect(result.actions.some((a) => a.kind === "dead-man-clear")).toBe(true);
    expect(result.judgmentSummary).toContain("flat");
  });

  it("perp flat close returns structured failure on embedded order rejection", async () => {
    const rejectedDeps = createMockDeps({
      getPositionSize: async () => "2.5",
      placeOrder: async () => ({
        success: false,
        statuses: [{ error: "Order could not immediately match against any resting orders." }],
      }),
    });

    const decision = createPerpTargetDecision({
      target: { side: "flat", targetFraction: "0", leverage: 0 },
    });

    const result = await executeDecision(decision, state, rejectedDeps, EXECUTED_AT);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("order-rejected");
    expect(result.judgmentSummary).toContain("failed");

    const closeAction = result.actions.find((a) => a.kind === "close-position");
    expect(closeAction).toBeDefined();
    expect(closeAction?.detail).toContain("success=false");
    expect(closeAction?.detail).toContain(
      "Order could not immediately match against any resting orders.",
    );
    expect(result.actions.some((a) => a.kind === "dead-man-schedule")).toBe(true);
    expect(result.actions.some((a) => a.kind === "dead-man-clear")).toBe(false);
  });

  it("perp flat with long position closes via sell", async () => {
    let placedBuy: boolean | null = null;
    const depsWithLong = createMockDeps({
      getPositionSize: async () => "3.0",
      placeOrder: async (params) => {
        placedBuy = params.isBuy;
        return { success: true, statuses: [{ oid: 55555 }] };
      },
    });

    const decision = createPerpTargetDecision({
      target: { side: "flat", targetFraction: "0", leverage: 0 },
    });

    await executeDecision(decision, state, depsWithLong, EXECUTED_AT);

    expect(placedBuy).toBe(false);
  });

  it("perp flat with short position closes via buy", async () => {
    let placedBuy: boolean | null = null;
    const depsWithShort = createMockDeps({
      getPositionSize: async () => "-1.0",
      placeOrder: async (params) => {
        placedBuy = params.isBuy;
        return { success: true, statuses: [{ oid: 66666 }] };
      },
    });

    const decision = createPerpTargetDecision({
      target: { side: "flat", targetFraction: "0", leverage: 0 },
    });

    await executeDecision(decision, state, depsWithShort, EXECUTED_AT);

    expect(placedBuy).toBe(true);
  });

  it("perp result includes correct audit fields", async () => {
    const decision = createPerpTargetDecision();
    const result = await executeDecision(decision, state, deps, EXECUTED_AT);

    expect(result.slotId).toBe(SLOT_ID);
    expect(result.suggestionId).toBe("sugg-perp-001");
    expect(result.marketId).toBe("perps:hyperliquid:ETH");
    expect(result.mode).toBe("perp");
    expect(result.judgmentSummary).toContain("long");
    expect(result.judgmentSummary).toContain("3x");
  });

  it("perp hold decision clears dead-man when flat with no orders", async () => {
    const holdDecision: LocalPolicyDecision = {
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
      message: "No fresh suggestion available.",
    };

    const result = await executeDecision(holdDecision, state, deps, EXECUTED_AT);

    expect(result.actions.some((a) => a.kind === "dead-man-clear")).toBe(true);
    expect(result.actions.some((a) => a.kind === "no-trade")).toBe(true);
  });

  it("syncLeverage uses isolated margin (isCross: false)", async () => {
    const syncLeverage = vi.fn(async () => ({ success: true, exchangeId: "lev-ok" }));
    const trackedDeps = createMockDeps({ syncLeverage });

    const result = await executeDecision(
      createPerpTargetDecision(),
      state,
      trackedDeps,
      EXECUTED_AT,
    );

    expect(syncLeverage).toHaveBeenCalledWith(1, 3, false);
    const leverageAction = result.actions.find((a) => a.kind === "leverage-sync");
    expect(leverageAction?.detail).toContain("isolated");
    expect(leverageAction?.detail).not.toContain("cross");
  });

  it("IOC partial fill retries up to bounded cap with refreshed mid-price and position", async () => {
    const placeOrder = vi.fn<ExecutionDeps["placeOrder"]>().mockResolvedValue({
      success: true,
      statuses: [{ oid: 10001 }],
    });
    const getPositionSize = vi
      .fn<ExecutionDeps["getPositionSize"]>()
      .mockResolvedValueOnce("0")
      .mockResolvedValueOnce("0.5")
      .mockResolvedValueOnce("0.9")
      .mockResolvedValueOnce("1.2");
    const getMidPrice = vi
      .fn<ExecutionDeps["getMidPrice"]>()
      .mockResolvedValueOnce("3500")
      .mockResolvedValueOnce("3501")
      .mockResolvedValueOnce("3502");

    const result = await executeDecision(
      createPerpTargetDecision(),
      state,
      createMockDeps({ placeOrder, getPositionSize, getMidPrice }),
      EXECUTED_AT,
      { orderStyle: "ioc" },
    );

    expect(placeOrder).toHaveBeenCalledTimes(1 + MAX_IOC_SAME_TICK_RETRIES);
    expect(placeOrder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        clientOrderId: `oc-${SLOT_ID}-long`,
        orderType: "ioc",
      }),
    );
    expect(placeOrder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        clientOrderId: `oc-${SLOT_ID}-long-r1`,
        orderType: "ioc",
      }),
    );
    expect(placeOrder).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        clientOrderId: `oc-${SLOT_ID}-long-r2`,
        orderType: "ioc",
      }),
    );
    const placeActions = result.actions.filter((a) => a.kind === "place-order");
    expect(placeActions).toHaveLength(3);
    expect(placeActions[1].detail).toContain("retry 1/2");
    expect(placeActions[2].detail).toContain("retry 2/2");
    expect(result.skipped).toBe(false);
  });

  it("IOC stops retrying when position is unchanged after order (no fill)", async () => {
    const placeOrder = vi.fn<ExecutionDeps["placeOrder"]>().mockResolvedValue({
      success: true,
      statuses: [{ oid: 20001 }],
    });
    const getPositionSize = vi
      .fn<ExecutionDeps["getPositionSize"]>()
      .mockResolvedValueOnce("0")
      .mockResolvedValueOnce("0")
      .mockResolvedValue("0");

    await executeDecision(
      createPerpTargetDecision(),
      state,
      createMockDeps({ placeOrder, getPositionSize }),
      EXECUTED_AT,
      { orderStyle: "ioc" },
    );

    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it("IOC stops retrying when remaining notional is below exchange minimum", async () => {
    const placeOrder = vi.fn<ExecutionDeps["placeOrder"]>().mockResolvedValue({
      success: true,
      statuses: [{ oid: 30001 }],
    });
    const getPositionSize = vi
      .fn<ExecutionDeps["getPositionSize"]>()
      .mockResolvedValueOnce("0")
      .mockResolvedValueOnce("1.426")
      .mockResolvedValue("1.426");
    const getMidPrice = vi
      .fn<ExecutionDeps["getMidPrice"]>()
      .mockResolvedValueOnce("3500")
      .mockResolvedValueOnce("3500");

    const result = await executeDecision(
      createPerpTargetDecision(),
      state,
      createMockDeps({ placeOrder, getPositionSize, getMidPrice }),
      EXECUTED_AT,
      { orderStyle: "ioc" },
    );

    expect(placeOrder).toHaveBeenCalledTimes(1);
    const noTradeActions = result.actions.filter((a) => a.kind === "no-trade");
    expect(noTradeActions.some((a) => a.detail.includes("below minimum"))).toBe(true);
  });

  it("IOC stops retrying when order is outright rejected", async () => {
    const placeOrder = vi.fn<ExecutionDeps["placeOrder"]>().mockResolvedValue({
      success: false,
      statuses: [{ error: "Insufficient margin" }],
    });

    const result = await executeDecision(
      createPerpTargetDecision(),
      state,
      createMockDeps({ placeOrder }),
      EXECUTED_AT,
      { orderStyle: "ioc" },
    );

    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("order-rejected");
  });

  it("IOC fully filled on first attempt does not retry", async () => {
    const placeOrder = vi.fn<ExecutionDeps["placeOrder"]>().mockResolvedValue({
      success: true,
      statuses: [{ oid: 40001 }],
    });
    const getPositionSize = vi
      .fn<ExecutionDeps["getPositionSize"]>()
      .mockResolvedValueOnce("0")
      .mockResolvedValueOnce("1.428")
      .mockResolvedValue("1.428");

    await executeDecision(
      createPerpTargetDecision(),
      state,
      createMockDeps({ placeOrder, getPositionSize }),
      EXECUTED_AT,
      { orderStyle: "ioc" },
    );

    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it("GTC bypasses same-tick retry logic and places exactly one order", async () => {
    const placeOrder = vi.fn<ExecutionDeps["placeOrder"]>().mockResolvedValue({
      success: true,
      statuses: [{ oid: 50001 }],
    });
    const getPositionSize = vi
      .fn<ExecutionDeps["getPositionSize"]>()
      .mockResolvedValueOnce("0")
      .mockResolvedValueOnce("0.5");

    const result = await executeDecision(
      createPerpTargetDecision(),
      state,
      createMockDeps({ placeOrder, getPositionSize }),
      EXECUTED_AT,
      { orderStyle: "gtc" },
    );

    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ orderType: "gtc" }));
    const placeActions = result.actions.filter((a) => a.kind === "place-order");
    expect(placeActions).toHaveLength(1);
    expect(placeActions[0].detail).toContain("GTC");
    expect(placeActions[0].detail).not.toContain("retry");
    expect(result.skipped).toBe(false);
  });

  it("each IOC retry attempt produces a deterministic audit action", async () => {
    const auditEntries: ExecutionAuditEntry[] = [];
    const placeOrder = vi.fn<ExecutionDeps["placeOrder"]>().mockResolvedValue({
      success: true,
      statuses: [{ oid: 60001 }],
    });
    const getPositionSize = vi
      .fn<ExecutionDeps["getPositionSize"]>()
      .mockResolvedValueOnce("0")
      .mockResolvedValueOnce("0.3")
      .mockResolvedValueOnce("0.8")
      .mockResolvedValue("1.428");
    const getMidPrice = vi
      .fn<ExecutionDeps["getMidPrice"]>()
      .mockResolvedValueOnce("3500")
      .mockResolvedValueOnce("3500.5")
      .mockResolvedValueOnce("3501");

    const result = await executeDecision(
      createPerpTargetDecision(),
      state,
      createMockDeps({
        placeOrder,
        getPositionSize,
        getMidPrice,
        appendAuditEntry: async (entry) => {
          auditEntries.push(entry);
        },
      }),
      EXECUTED_AT,
      { orderStyle: "ioc" },
    );

    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].actions.filter((a) => a.kind === "place-order")).toHaveLength(3);
    expect(result.actions.filter((a) => a.kind === "place-order")).toHaveLength(3);
    for (const action of result.actions.filter((a) => a.kind === "place-order")) {
      expect(action.detail).toContain("success=true");
    }
  });

  describe("structured metadata in execution results and audit entries", () => {
    it("reshapingMetadata reflects decision targets and sources for a successful trade", async () => {
      const decision = createPerpTargetDecision({
        baselineTarget: { side: "long", targetFraction: "0.6", leverage: 4 },
        requestedTarget: { side: "long", targetFraction: "0.5", leverage: 3 },
        target: { side: "long", targetFraction: "0.5", leverage: 3 },
        sources: {
          side: "suggestion",
          targetFraction: "user-preferences",
          leverage: "execution-intent",
        },
      });
      const auditEntries: ExecutionAuditEntry[] = [];

      const result = await executeDecision(
        decision,
        state,
        createMockDeps({
          appendAuditEntry: async (entry) => {
            auditEntries.push(entry);
          },
        }),
        EXECUTED_AT,
      );

      expect(result.reshapingMetadata).toEqual({
        baselineTarget: { side: "long", targetFraction: "0.6", leverage: 4 },
        requestedTarget: { side: "long", targetFraction: "0.5", leverage: 3 },
        finalTarget: { side: "long", targetFraction: "0.5", leverage: 3 },
        sources: {
          side: "suggestion",
          targetFraction: "user-preferences",
          leverage: "execution-intent",
        },
      });
      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0].reshapingMetadata).toEqual(result.reshapingMetadata);
    });

    it("retryMetadata shows single attempt for explicit GTC order", async () => {
      const auditEntries: ExecutionAuditEntry[] = [];

      const result = await executeDecision(
        createPerpTargetDecision(),
        state,
        createMockDeps({
          appendAuditEntry: async (entry) => {
            auditEntries.push(entry);
          },
        }),
        EXECUTED_AT,
        { orderStyle: "gtc" },
      );

      expect(result.retryMetadata).toEqual({
        orderStyle: "gtc",
        maxAttempts: 1,
        attemptCount: 1,
        partialFill: false,
      });
      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0].retryMetadata).toEqual(result.retryMetadata);
    });

    it("retryMetadata captures IOC retry attempts with partial fill", async () => {
      const getPositionSize = vi
        .fn<ExecutionDeps["getPositionSize"]>()
        .mockResolvedValueOnce("0")
        .mockResolvedValueOnce("0.5")
        .mockResolvedValue("1.428");
      const getMidPrice = vi
        .fn<ExecutionDeps["getMidPrice"]>()
        .mockResolvedValueOnce("3500")
        .mockResolvedValueOnce("3501");
      const auditEntries: ExecutionAuditEntry[] = [];

      const result = await executeDecision(
        createPerpTargetDecision(),
        state,
        createMockDeps({
          getPositionSize,
          getMidPrice,
          appendAuditEntry: async (entry) => {
            auditEntries.push(entry);
          },
        }),
        EXECUTED_AT,
        { orderStyle: "ioc" },
      );

      expect(result.retryMetadata).not.toBeNull();
      expect(result.retryMetadata).toEqual(
        expect.objectContaining({
          orderStyle: "ioc",
          maxAttempts: 1 + MAX_IOC_SAME_TICK_RETRIES,
          attemptCount: 2,
          partialFill: true,
        }),
      );
      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0].retryMetadata).toEqual(result.retryMetadata);
    });

    it("reshapingMetadata is null for hold decisions", async () => {
      const holdDecision: LocalPolicyDecision = {
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
        message: "No suggestion available.",
      };
      const auditEntries: ExecutionAuditEntry[] = [];

      const result = await executeDecision(
        holdDecision,
        state,
        createMockDeps({
          appendAuditEntry: async (entry) => {
            auditEntries.push(entry);
          },
        }),
        EXECUTED_AT,
      );

      expect(result.reshapingMetadata).toBeNull();
      expect(result.retryMetadata).toBeNull();
      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0].reshapingMetadata).toBeNull();
      expect(auditEntries[0].retryMetadata).toBeNull();
    });

    it("retryMetadata is null when no orders are placed (delta zero)", async () => {
      const getPositionSize = vi.fn<ExecutionDeps["getPositionSize"]>().mockResolvedValue("1.428");
      const auditEntries: ExecutionAuditEntry[] = [];

      const result = await executeDecision(
        createPerpTargetDecision(),
        state,
        createMockDeps({
          getPositionSize,
          appendAuditEntry: async (entry) => {
            auditEntries.push(entry);
          },
        }),
        EXECUTED_AT,
      );

      expect(result.retryMetadata).toBeNull();
      expect(result.reshapingMetadata).not.toBeNull();
      expect(auditEntries).toHaveLength(1);
    });
  });
});
