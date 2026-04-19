import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type CancelOutstandingOrdersResult,
  DaemonService,
  cancelOrdersWithPartialFailure,
  resetDefaultService,
  resolveNetworkTarget,
  validateExecuteTickInput,
} from "../src/daemon/engine";
import type { CancelOrderEntry, DaemonDeps } from "../src/daemon/engine";
import { DaemonPidLockError } from "../src/daemon/pid-lock";
import { StateWriteError } from "../src/daemon/runtime-state-file";
import type { ExecutionResult } from "../src/execution";
import { createRuntimeState, slotIdFromDate } from "../src/state";
import type { RuntimeState } from "../src/state";
import type { AgentMdRefreshResult, TickRecommendationResult } from "../src/v4t";

function createState(overrides: Partial<RuntimeState> = {}): RuntimeState {
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
    vibe4tradingToken: "mock-token",
    ...overrides,
  });
}

function createTradingSelection() {
  return {
    optionId: "ETH|aggressive|agent-model",
    market: {
      venue: "hyperliquid" as const,
      mode: "perp" as const,
      marketId: "perps:hyperliquid:ETH",
      symbol: "ETH",
    },
    modelKey: "agent-model",
    strategyProfile: "aggressive" as const,
    recommendationId: "rec-eth-1",
    sourceAgentMdVersion: "7",
    sourceAgentMdFetchedAt: "2026-03-27T12:31:00.000Z",
  };
}

function createAgentMdResult(): AgentMdRefreshResult {
  return {
    kind: "updated",
    httpStatus: 200,
    cache: {
      url: "https://vibe4trading.ai/agents.md",
      version: "1",
      lastUpdated: "2026-03-27T12:00:00.000Z",
      apiContractVersion: "1",
      status: "active",
      etag: '"etag-1"',
      hash: "hash-1",
      fetchedAt: "2026-03-27T12:31:00.000Z",
      tradingOptions: {
        models: ["agent-model"],
        strategies: ["aggressive"],
        pairs: [
          {
            venue: "hyperliquid",
            mode: "perp",
            marketId: "perps:hyperliquid:ETH",
            symbol: "ETH",
          },
        ],
        recommended: {
          pair: "ETH",
          strategy: "aggressive",
          model: "agent-model",
        },
      },
    },
    policy: {
      version: "1",
      lastUpdated: "2026-03-27T12:00:00.000Z",
      apiContractVersion: "1",
      status: "active",
    },
  };
}

function createSuggestionResult(): TickRecommendationResult {
  return {
    kind: "ok",
    httpStatus: 200,
    recommendation: {
      tickTime: "2026-03-27T12:30:10.000Z",
      expiresAt: "2026-03-27T12:40:00.000Z",
      marketId: "perps:hyperliquid:ETH",
      recommendedMode: "futures",
      recommendedDirection: "long",
      recommendedSizeFraction: "0.4",
      recommendedLeverage: 2,
      recommendationId: "run-1::2026-03-27T12:30:10.000Z",
      raw: {
        confidence: "0.8",
        rationale: "Test rationale.",
        key_signals: ["trend_up"],
        stop_loss_pct: null,
        take_profit_pct: null,
        run_id: "run-1",
        strategy: null,
      },
    },
  };
}

function createExecutionResult(slotId: string): ExecutionResult {
  return {
    slotId,
    suggestionId: "sugg-1",
    marketId: "perps:hyperliquid:ETH",
    mode: "perp",
    judgmentSummary: "Hold: no-suggestion",
    actions: [],
    skipped: false,
    skipReason: null,
    executedAt: "2026-03-27T12:31:00.000Z",
    retryMetadata: null,
    reshapingMetadata: null,
  };
}

function createCancelResult(
  overrides: Partial<CancelOutstandingOrdersResult> = {},
): CancelOutstandingOrdersResult {
  return {
    cancelledCount: 0,
    hadFailures: false,
    confirmedNoPendingOrders: false,
    ...overrides,
  };
}

function createServiceHarness(
  initialState: RuntimeState,
  options: {
    readonly persistFailure?: boolean;
    readonly cancelResult?: CancelOutstandingOrdersResult | number;
  } = {},
) {
  let state = initialState;
  let pidReleased = 0;
  let persistedStates: RuntimeState[] = [];
  let clearedDeadMan = 0;
  let onboardingCalls = 0;
  let refreshCalls = 0;
  let suggestionCalls = 0;
  let lastSuggestionRequest: {
    apiToken: string;
    marketId: string;
    modelKey: string;
    strategyKey: string;
  } | null = null;
  let lastExecutionContext: { orderStyle: "ioc" | "gtc" } | null = null;
  let cancelCalls = 0;
  const now = new Date("2026-03-27T12:31:00.000Z");
  const slotId = slotIdFromDate(now);

  const service = new DaemonService({
    readState: async () => state,
    updateState: async (updater) => {
      const nextState = updater(state);
      if (options.persistFailure === true && nextState.lastExecutedSlot === slotId) {
        throw new StateWriteError("disk full");
      }
      state = nextState;
      persistedStates = [...persistedStates, nextState];
      return nextState;
    },
    acquirePidLock: async () => ({
      replacedStalePid: false,
      existingPid: null,
      release: async () => {
        pidReleased += 1;
      },
    }),
    reconcileState: async (currentState) => ({
      state: currentState,
      driftDetected: false,
      rpcFailed: false,
      previousActivity: currentState.exchangeActivity,
      nextActivity: currentState.exchangeActivity,
    }),
    getOnboardingStatus: async () => {
      onboardingCalls += 1;
      return {
        status: "ready",
        message: "ready",
        bridgeableAmount: "25",
      };
    },
    refreshAgentMd: async () => {
      refreshCalls += 1;
      return createAgentMdResult();
    },
    fetchSuggestion: async (request) => {
      suggestionCalls += 1;
      lastSuggestionRequest = request;
      return createSuggestionResult();
    },
    evaluatePolicy: ({ runtimeState, now: tickNow, suggestionResult }) => ({
      kind: "hold",
      marketId: runtimeState.market.marketId,
      mode: runtimeState.market.mode,
      evaluatedAt: tickNow.toISOString(),
      slotId: slotIdFromDate(tickNow),
      suggestionId:
        suggestionResult !== null && suggestionResult.kind === "ok"
          ? suggestionResult.recommendation.recommendationId
          : null,
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
    }),
    executeDecision: async (_decision, _state, tickNow, executionContext) => {
      lastExecutionContext = executionContext;
      return createExecutionResult(slotIdFromDate(tickNow));
    },
    cancelOutstandingOrders: async () => {
      cancelCalls += 1;
      return typeof options.cancelResult === "number"
        ? createCancelResult({
            cancelledCount: options.cancelResult,
            confirmedNoPendingOrders: options.cancelResult > 0,
          })
        : (options.cancelResult ?? createCancelResult());
    },
    clearDeadMan: async () => {
      clearedDeadMan += 1;
    },
    readTradeHistory: async (limit) => {
      const entries = [
        {
          slotId,
          suggestionId: "sugg-1",
          marketId: "perps:hyperliquid:ETH",
          mode: "perp" as const,
          judgmentSummary: "summary",
          actions: [],
          exchangeIds: [],
          skipped: false,
          skipReason: null,
          executedAt: now.toISOString(),
          retryMetadata: null,
          reshapingMetadata: null,
        },
      ];
      return limit === undefined ? entries : entries.slice(-limit);
    },
    now: () => now,
  });

  return {
    service,
    getState: () => state,
    getPersistedStates: () => persistedStates,
    getPidReleased: () => pidReleased,
    getClearedDeadMan: () => clearedDeadMan,
    getOnboardingCalls: () => onboardingCalls,
    getRefreshCalls: () => refreshCalls,
    getSuggestionCalls: () => suggestionCalls,
    getLastSuggestionRequest: () => lastSuggestionRequest,
    getLastExecutionContext: () => lastExecutionContext,
    getCancelCalls: () => cancelCalls,
    slotId,
  };
}

describe("daemon service", () => {
  afterEach(() => {
    resetDefaultService();
  });

  it("executes exactly one slot and persists lastExecutedSlot", async () => {
    const harness = createServiceHarness(
      createState({ daemonStatus: "running", tradingSelection: createTradingSelection() }),
    );

    const result = await harness.service.executeTick();

    expect(result.outcome).toBe("executed");
    expect(result.slotId).toBe(harness.slotId);
    expect(harness.getState().lastExecutedSlot).toBe(harness.slotId);
    expect(harness.getState().executingSlot).toBeNull();
    expect(harness.getState().lastSuggestionId).toBe("run-1::2026-03-27T12:30:10.000Z");
    expect(harness.getPersistedStates().at(0)?.executingSlot).toBe(harness.slotId);
    expect(harness.getPersistedStates().at(-1)?.lastExecutedSlot).toBe(harness.slotId);
    expect(harness.getPersistedStates().at(-1)?.executingSlot).toBeNull();
    expect(harness.getLastSuggestionRequest()).toEqual({
      apiToken: "mock-token",
      marketId: "perps:hyperliquid:ETH",
      modelKey: "agent-model",
      strategyKey: "aggressive",
    });
    expect(harness.getLastExecutionContext()).toEqual({ orderStyle: "ioc" });
  });

  it("returns tick context with selection, onboarding, hold, and execution preview", async () => {
    const harness = createServiceHarness(
      createState({ daemonStatus: "running", tradingSelection: createTradingSelection() }),
    );

    const context = await harness.service.getTickContext({
      intent: {
        action: "target-position",
        side: "short",
        orderStyle: "gtc",
        leverage: 4,
        rationale: "Favor the short setup for this tick.",
      },
    });

    expect(context.selection.selection?.optionId).toBe("ETH|aggressive|agent-model");
    expect(context.selection.validation.status).toBe("validated");
    expect(context.agentMd.status).toBe("active");
    expect(context.onboardingStatus.status).toBe("ready");
    expect(context.suggestionRequest).toMatchObject({
      marketId: "perps:hyperliquid:ETH",
      modelKey: "agent-model",
    });
    expect(context.execution.allowedOrderStyles).toEqual(["ioc", "gtc"]);
    expect(context.execution.defaultOrderStyle).toBe("ioc");
    expect(context.execution.selectedOrderStyle).toBe("gtc");
    expect(context.holdContext.policyKind).toBe("hold");
  });

  it("getTickContext falls back to unfunded onboarding status when onboarding lookup throws", async () => {
    const now = new Date("2026-03-27T12:31:00.000Z");
    let state = createState({
      daemonStatus: "running",
      tradingSelection: createTradingSelection(),
    });
    let receivedOnboardingStatus: unknown = null;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const service = new DaemonService({
      readState: async () => state,
      updateState: async (updater) => {
        const nextState = updater(state);
        state = nextState;
        return nextState;
      },
      acquirePidLock: async () => ({
        replacedStalePid: false,
        existingPid: null,
        release: async () => {},
      }),
      reconcileState: async (currentState) => ({
        state: currentState,
        driftDetected: false,
        rpcFailed: false,
        previousActivity: currentState.exchangeActivity,
        nextActivity: currentState.exchangeActivity,
      }),
      getOnboardingStatus: async () => {
        throw new Error("RPC unavailable");
      },
      refreshAgentMd: async () => createAgentMdResult(),
      fetchSuggestion: async () => createSuggestionResult(),
      evaluatePolicy: (input) => {
        receivedOnboardingStatus = input.onboardingStatus;
        return {
          kind: "hold",
          marketId: input.runtimeState.market.marketId,
          mode: input.runtimeState.market.mode,
          evaluatedAt: input.now.toISOString(),
          slotId: slotIdFromDate(input.now),
          suggestionId:
            input.suggestionResult !== null && input.suggestionResult.kind === "ok"
              ? input.suggestionResult.recommendation.recommendationId
              : null,
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
      },
      executeDecision: async (_decision, _state, tickNow) =>
        createExecutionResult(slotIdFromDate(tickNow)),
      cancelOutstandingOrders: async () => createCancelResult(),
      clearDeadMan: async () => {},
      readTradeHistory: async () => [],
      now: () => now,
    });

    const context = await service.getTickContext();

    expect(context.onboardingStatus).toEqual({
      status: "unfunded",
      message: "Onboarding status unavailable: RPC unavailable",
      bridgeableAmount: null,
    });
    expect(receivedOnboardingStatus).toEqual(context.onboardingStatus);
    expect(warnSpy).toHaveBeenCalledWith(
      "getTickContext: best-effort onboarding status failed — RPC unavailable",
    );
    warnSpy.mockRestore();
  });

  it("skips suggestion fetch when tradingSelection is missing", async () => {
    const harness = createServiceHarness(
      createState({ daemonStatus: "running", tradingSelection: null }),
    );

    const result = await harness.service.executeTick();

    expect(result.outcome).toBe("executed");
    expect(harness.getSuggestionCalls()).toBe(0);
    expect(harness.getLastSuggestionRequest()).toBeNull();
  });

  it("validates execute_tick order style allowlist", () => {
    expect(() =>
      validateExecuteTickInput({
        intent: {
          action: "target-position",
          orderStyle: "day" as never,
          rationale: "invalid",
        },
      }),
    ).toThrow(/must be one of: ioc, gtc/i);
  });

  it("validates execute_tick explicit action contract", () => {
    expect(() =>
      validateExecuteTickInput({
        intent: { orderStyle: "ioc", rationale: "missing action" } as never,
      }),
    ).toThrow(/intent.action must be one of: hold, target-position/i);

    expect(() =>
      validateExecuteTickInput({
        intent: { action: "hold", rationale: "   " },
      }),
    ).toThrow(/intent.rationale must be a non-empty string/i);

    expect(() =>
      validateExecuteTickInput({
        intent: {
          action: "hold",
          side: "short",
          rationale: "Hold instead of trading.",
        },
      }),
    ).toThrow(/intent.side is only supported when intent.action is "target-position"/i);
  });

  it("explicit hold intent produces visible hold with zero trade actions", async () => {
    const harness = createServiceHarness(
      createState({ daemonStatus: "running", tradingSelection: createTradingSelection() }),
    );

    const result = await harness.service.executeTick({
      intent: {
        action: "hold",
        orderStyle: "gtc",
        rationale: "Stand down for this tick.",
      },
    });

    expect(result.outcome).toBe("executed");
    expect(result.executionResult?.judgmentSummary).toBe("Hold: no-suggestion");
    expect(result.executionResult?.actions).toEqual([]);
    expect(harness.getLastExecutionContext()).toEqual({ orderStyle: "gtc" });
  });

  it("skips duplicate execution for the same slot", async () => {
    const harness = createServiceHarness(
      createState({ daemonStatus: "running", lastExecutedSlot: "2026-03-27T12:30:00.000Z" }),
    );

    const result = await harness.service.executeTick();

    expect(result.outcome).toBe("skipped");
    expect(result.reason).toBe("duplicate-slot");
    expect(harness.getPersistedStates()).toHaveLength(0);
    expect(harness.getOnboardingCalls()).toBe(0);
    expect(harness.getRefreshCalls()).toBe(0);
    expect(harness.getSuggestionCalls()).toBe(0);
    expect(result.onboardingStatus).toBeNull();
  });

  it("skips same-slot execution when executingSlot is already persisted", async () => {
    const harness = createServiceHarness(
      createState({ daemonStatus: "running", executingSlot: "2026-03-27T12:30:00.000Z" }),
    );

    const result = await harness.service.executeTick();

    expect(result.outcome).toBe("skipped");
    expect(result.reason).toBe("duplicate-slot");
    expect(harness.getPersistedStates()).toHaveLength(0);
    expect(harness.getOnboardingCalls()).toBe(0);
    expect(harness.getRefreshCalls()).toBe(0);
    expect(harness.getSuggestionCalls()).toBe(0);
  });

  it("persists halted status and haltReason and refuses further ticks until resumed", async () => {
    const harness = createServiceHarness(createState({ daemonStatus: "running" }), {
      cancelResult: 2,
    });

    const stopped = await harness.service.stopTrading();
    const tickResult = await harness.service.executeTick();

    expect(stopped.daemonStatus).toBe("halted");
    expect(stopped.haltReason).toBe("emergency-stop");
    expect(harness.getState().daemonStatus).toBe("halted");
    expect(harness.getState().haltReason).toBe("emergency-stop");
    expect(harness.getState().exchangeActivity.hasPendingOrder).toBe(false);
    expect(harness.getClearedDeadMan()).toBe(1);
    expect(tickResult.outcome).toBe("refused");
    expect(tickResult.reason).toBe("halted");
    expect(harness.getOnboardingCalls()).toBe(1);
    expect(tickResult.onboardingStatus).toBeNull();
  });

  it("stop_trading persists haltReason 'halted' when no orders are cancelled", async () => {
    const harness = createServiceHarness(createState({ daemonStatus: "running" }), {
      cancelResult: 0,
    });

    const stopped = await harness.service.stopTrading();

    expect(stopped.daemonStatus).toBe("halted");
    expect(stopped.haltReason).toBe("halted");
    expect(harness.getState().daemonStatus).toBe("halted");
    expect(harness.getState().haltReason).toBe("halted");
    expect(harness.getClearedDeadMan()).toBe(1);
  });

  it("stop_trading preserves hasPendingOrder after partial cancel failure without zero-order proof", async () => {
    const harness = createServiceHarness(
      createState({
        daemonStatus: "running",
        exchangeActivity: { hasOpenPosition: true, hasPendingOrder: true },
      }),
      {
        cancelResult: {
          cancelledCount: 1,
          hadFailures: true,
          confirmedNoPendingOrders: false,
        },
      },
    );

    const stopped = await harness.service.stopTrading();

    expect(stopped.daemonStatus).toBe("halted");
    expect(stopped.haltReason).toBe("emergency-stop");
    expect(harness.getState().exchangeActivity.hasPendingOrder).toBe(true);
  });

  it("stop_trading clears hasPendingOrder only when post-cancel proof confirms zero live orders", async () => {
    const harness = createServiceHarness(
      createState({
        daemonStatus: "running",
        exchangeActivity: { hasOpenPosition: true, hasPendingOrder: true },
      }),
      {
        cancelResult: {
          cancelledCount: 1,
          hadFailures: true,
          confirmedNoPendingOrders: true,
        },
      },
    );

    const stopped = await harness.service.stopTrading();

    expect(stopped.daemonStatus).toBe("halted");
    expect(harness.getState().exchangeActivity.hasPendingOrder).toBe(false);
  });

  it("stop_trading works without a prior lock hold from arming", async () => {
    const harness = createServiceHarness(
      createState({
        daemonStatus: "running",
        liveTradingConsent: { acknowledged: true, acknowledgedAt: "2026-01-01T00:00:00.000Z" },
      }),
    );

    await harness.service.startTrading();
    const stopped = await harness.service.stopTrading();

    expect(stopped.daemonStatus).toBe("halted");
    expect(harness.getPidReleased()).toBe(0);
  });

  it("releases pid lock when final state persistence fails", async () => {
    const harness = createServiceHarness(createState({ daemonStatus: "running" }), {
      persistFailure: true,
    });

    await expect(harness.service.executeTick()).rejects.toThrow(StateWriteError);
    expect(harness.getState().lastExecutedSlot).toBeNull();
    expect(harness.getState().executingSlot).toBe(harness.slotId);
    expect(harness.getPersistedStates()).toHaveLength(1);
    expect(harness.getPersistedStates().at(0)?.executingSlot).toBe(harness.slotId);
    expect(harness.getPidReleased()).toBe(1);
  });

  it("does not reopen the same slot after completion-state persistence fails", async () => {
    const harness = createServiceHarness(
      createState({ daemonStatus: "running", tradingSelection: createTradingSelection() }),
      {
        persistFailure: true,
      },
    );

    await expect(harness.service.executeTick()).rejects.toThrow(StateWriteError);

    const replay = await harness.service.executeTick();

    expect(replay.outcome).toBe("skipped");
    expect(replay.reason).toBe("duplicate-slot");
    expect(harness.getState().executingSlot).toBe(harness.slotId);
    expect(harness.getOnboardingCalls()).toBe(1);
    expect(harness.getRefreshCalls()).toBe(1);
    expect(harness.getSuggestionCalls()).toBe(1);
  });

  it("refuses executeTick when daemonStatus is stopped", async () => {
    const harness = createServiceHarness(createState({ daemonStatus: "stopped" }));

    const result = await harness.service.executeTick();

    expect(result.outcome).toBe("refused");
    expect(result.reason).toBe("stopped");
    expect(harness.getPersistedStates()).toHaveLength(0);
    expect(harness.getOnboardingCalls()).toBe(0);
    expect(harness.getRefreshCalls()).toBe(0);
    expect(harness.getSuggestionCalls()).toBe(0);
    expect(result.executionResult).toBeNull();
    expect(result.onboardingStatus).toBeNull();
  });

  it("returns skipped with lock-contention reason when ephemeral lock is held", async () => {
    let state = createState({ daemonStatus: "running" });
    const now = new Date("2026-03-27T12:31:00.000Z");
    const slotId = slotIdFromDate(now);

    const service = new DaemonService({
      readState: async () => state,
      updateState: async (updater) => {
        const nextState = updater(state);
        state = nextState;
        return nextState;
      },
      acquirePidLock: async () => {
        throw new DaemonPidLockError("Another daemon is already running (PID 9999).");
      },
      reconcileState: async (currentState) => ({
        state: currentState,
        driftDetected: false,
        rpcFailed: false,
        previousActivity: currentState.exchangeActivity,
        nextActivity: currentState.exchangeActivity,
      }),
      getOnboardingStatus: async () => ({
        status: "ready",
        message: "ready",
        bridgeableAmount: "25",
      }),
      refreshAgentMd: async () => createAgentMdResult(),
      fetchSuggestion: async (_request) => createSuggestionResult(),
      evaluatePolicy: () => {
        throw new Error("should not reach policy evaluation during lock contention");
      },
      executeDecision: async (_decision, _state, _tickNow, _executionContext) => {
        throw new Error("should not reach execution during lock contention");
      },
      cancelOutstandingOrders: async () => createCancelResult(),
      clearDeadMan: async () => {},
      readTradeHistory: async () => [],
      now: () => now,
    });

    const result = await service.executeTick();

    expect(result.outcome).toBe("skipped");
    expect(result.reason).toBe("lock-contention");
    expect(result.slotId).toBe(slotId);
    expect(result.state).toBeDefined();
    expect(result.executionResult).toBeNull();
    expect(result.onboardingStatus).toBeNull();
  });

  it("post-lock re-read catches duplicate-slot from concurrent process", async () => {
    const now = new Date("2026-03-27T12:31:00.000Z");
    const slotId = slotIdFromDate(now);
    let readCount = 0;
    let onboardingCalls = 0;
    let persistedState: RuntimeState | null = null;
    const readState = async () => {
      if (persistedState !== null) {
        return persistedState;
      }
      readCount++;
      if (readCount === 1) {
        return createState({ daemonStatus: "running", lastExecutedSlot: null });
      }
      return createState({ daemonStatus: "running", lastExecutedSlot: slotId });
    };

    const service = new DaemonService({
      readState,
      updateState: async (updater) => {
        const nextState = updater(await readState());
        persistedState = nextState;
        return nextState;
      },
      acquirePidLock: async () => ({
        replacedStalePid: false,
        existingPid: null,
        release: async () => {},
      }),
      reconcileState: async (currentState) => ({
        state: currentState,
        driftDetected: false,
        rpcFailed: false,
        previousActivity: currentState.exchangeActivity,
        nextActivity: currentState.exchangeActivity,
      }),
      getOnboardingStatus: async () => {
        onboardingCalls++;
        return { status: "ready", message: "ready", bridgeableAmount: "25" };
      },
      refreshAgentMd: async () => createAgentMdResult(),
      fetchSuggestion: async (_request) => createSuggestionResult(),
      evaluatePolicy: () => {
        throw new Error("should not reach policy — duplicate slot should be caught post-lock");
      },
      executeDecision: async (_decision, _state, _tickNow, _executionContext) => {
        throw new Error("should not reach execution — duplicate slot should be caught post-lock");
      },
      cancelOutstandingOrders: async () => createCancelResult(),
      clearDeadMan: async () => {},
      readTradeHistory: async () => [],
      now: () => now,
    });

    const result = await service.executeTick();

    expect(readCount).toBe(2);
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toBe("duplicate-slot");
    expect(onboardingCalls).toBe(0);
  });

  it("start_trading reconciles, persists running status, and clears haltReason", async () => {
    const reconcileSpy = vi.fn(async (state: RuntimeState) => ({
      state: {
        ...state,
        exchangeActivity: { hasOpenPosition: true, hasPendingOrder: false },
      },
      driftDetected: true,
      rpcFailed: false,
      previousActivity: state.exchangeActivity,
      nextActivity: { hasOpenPosition: true, hasPendingOrder: false },
    }));
    let state = createState({
      daemonStatus: "halted",
      haltReason: "emergency-stop",
      liveTradingConsent: { acknowledged: true, acknowledgedAt: "2026-01-01T00:00:00.000Z" },
    });
    const persisted: RuntimeState[] = [];

    const service = new DaemonService({
      readState: async () => state,
      updateState: async (updater) => {
        const nextState = updater(state);
        state = nextState;
        persisted.push(nextState);
        return nextState;
      },
      acquirePidLock: async () => ({
        replacedStalePid: false,
        existingPid: null,
        release: async () => {},
      }),
      reconcileState: reconcileSpy,
      refreshAgentMd: async () => createAgentMdResult(),
      fetchSuggestion: async (_request) => createSuggestionResult(),
      getOnboardingStatus: async () => ({
        status: "ready",
        message: "ready",
        bridgeableAmount: "25",
      }),
      evaluatePolicy: () => {
        throw new Error("not used");
      },
      executeDecision: async (_decision, _state, _tickNow, _executionContext) => {
        throw new Error("not used");
      },
      cancelOutstandingOrders: async () => ({
        cancelledCount: 0,
        hadFailures: false,
        confirmedNoPendingOrders: false,
      }),
      clearDeadMan: async () => {},
      readTradeHistory: async () => [],
      now: () => new Date("2026-03-27T12:31:00.000Z"),
    });

    const status = await service.startTrading();

    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    expect(status.daemonStatus).toBe("running");
    expect(status.haltReason).toBeNull();
    expect(state.daemonStatus).toBe("running");
    expect(state.haltReason).toBeNull();
    expect(state.exchangeActivity.hasOpenPosition).toBe(true);
    expect(persisted).toHaveLength(1);
    expect(persisted.at(0)?.haltReason).toBeNull();
  });

  it("start_trading never spawns a resident loop", async () => {
    const harness = createServiceHarness(
      createState({
        daemonStatus: "stopped",
        liveTradingConsent: { acknowledged: true, acknowledgedAt: "2026-01-01T00:00:00.000Z" },
      }),
    );

    const status = await harness.service.startTrading();

    expect(status.daemonStatus).toBe("running");
    expect(harness.getState().daemonStatus).toBe("running");
    const tickResult = await harness.service.executeTick();
    expect(tickResult.outcome).toBe("executed");
  });

  it("fresh service can execute_tick after a different service armed trading", async () => {
    // Simulate the no-daemon cron model: Process A arms, Process B ticks.
    // Both share the same persisted state but use independent DaemonService instances.
    let state = createState({
      daemonStatus: "stopped",
      liveTradingConsent: { acknowledged: true, acknowledgedAt: "2026-01-01T00:00:00.000Z" },
    });
    const now = new Date("2026-03-27T12:31:00.000Z");
    let pidLockHeld = false;

    function createSharedDeps(): DaemonDeps {
      return {
        readState: async () => state,
        updateState: async (updater) => {
          const nextState = updater(state);
          state = nextState;
          return nextState;
        },
        acquirePidLock: async () => {
          if (pidLockHeld) {
            throw new DaemonPidLockError("Lock already held by another process");
          }
          pidLockHeld = true;
          return {
            replacedStalePid: false,
            existingPid: null,
            release: async () => {
              pidLockHeld = false;
            },
          };
        },
        reconcileState: async (currentState: RuntimeState) => ({
          state: currentState,
          driftDetected: false,
          rpcFailed: false,
          previousActivity: currentState.exchangeActivity,
          nextActivity: currentState.exchangeActivity,
        }),
        getOnboardingStatus: async () => ({
          status: "ready" as const,
          message: "ready",
          bridgeableAmount: "25",
        }),
        refreshAgentMd: async () => createAgentMdResult(),
        fetchSuggestion: async (_request) => createSuggestionResult(),
        evaluatePolicy: ({ runtimeState, now: tickNow, suggestionResult }) => ({
          kind: "hold" as const,
          marketId: runtimeState.market.marketId,
          mode: runtimeState.market.mode,
          evaluatedAt: tickNow.toISOString(),
          slotId: slotIdFromDate(tickNow),
          suggestionId:
            suggestionResult !== null && suggestionResult.kind === "ok"
              ? suggestionResult.recommendation.recommendationId
              : null,
          overridePhrase: {
            wasAccepted: false,
            isAccepted: false,
            requiresAcceptance: false,
            shouldPersist: false,
          },
          agentStatus: "active" as const,
          clamps: [],
          holdReason: "no-suggestion",
          message: "No suggestion.",
        }),
        executeDecision: async (
          _decision: unknown,
          _state: RuntimeState,
          tickNow: Date,
          _executionContext,
        ) => createExecutionResult(slotIdFromDate(tickNow)),
        cancelOutstandingOrders: async () => ({
          cancelledCount: 0,
          hadFailures: false,
          confirmedNoPendingOrders: false,
        }),
        clearDeadMan: async () => {},
        readTradeHistory: async () => [],
        now: () => now,
      };
    }

    // Process A: arm trading
    const serviceA = new DaemonService(createSharedDeps());
    await serviceA.startTrading();
    expect(state.daemonStatus).toBe("running");
    // After arming, the PID lock must NOT be held
    expect(pidLockHeld).toBe(false);

    // Process B: fresh service instance executes a tick
    const serviceB = new DaemonService(createSharedDeps());
    const result = await serviceB.executeTick();

    expect(result.outcome).toBe("executed");
    expect(result.slotId).toBe(slotIdFromDate(now));
    // Ephemeral lock was acquired and released within the tick
    expect(pidLockHeld).toBe(false);
  });

  it("start_trading from stopped state clears haltReason in persisted state", async () => {
    const harness = createServiceHarness(
      createState({
        daemonStatus: "stopped",
        haltReason: null,
        liveTradingConsent: { acknowledged: true, acknowledgedAt: "2026-01-01T00:00:00.000Z" },
      }),
    );

    const status = await harness.service.startTrading();

    expect(status.daemonStatus).toBe("running");
    expect(status.haltReason).toBeNull();
    expect(harness.getState().haltReason).toBeNull();
  });

  it("getStatusSnapshot derives haltReason from persisted state in a fresh process", async () => {
    const harness = createServiceHarness(
      createState({ daemonStatus: "halted", haltReason: "emergency-stop" }),
    );

    const status = await harness.service.getStatusSnapshot();

    expect(status.daemonStatus).toBe("halted");
    expect(status.haltReason).toBe("emergency-stop");
  });

  it("getStatusSnapshot returns null haltReason for running state", async () => {
    const harness = createServiceHarness(
      createState({ daemonStatus: "running", haltReason: null }),
    );

    const status = await harness.service.getStatusSnapshot();

    expect(status.daemonStatus).toBe("running");
    expect(status.haltReason).toBeNull();
  });

  it("status snapshot does not contain pid or runningLoop fields", async () => {
    const harness = createServiceHarness(createState({ daemonStatus: "running" }));

    const status = await harness.service.getStatusSnapshot();

    expect("pid" in status).toBe(false);
    expect("runningLoop" in status).toBe(false);
    expect(status.daemonStatus).toBe("running");
    expect(status.currentSlot).toBeDefined();
  });

  it("persists overridePhraseAccepted when policy returns shouldPersist true", async () => {
    const now = new Date("2026-03-27T12:31:00.000Z");
    const slotId = slotIdFromDate(now);
    let state = createState({ daemonStatus: "running", overridePhraseAccepted: false });
    const persisted: RuntimeState[] = [];

    const service = new DaemonService({
      readState: async () => state,
      updateState: async (updater) => {
        const nextState = updater(state);
        state = nextState;
        persisted.push(nextState);
        return nextState;
      },
      acquirePidLock: async () => ({
        replacedStalePid: false,
        existingPid: null,
        release: async () => {},
      }),
      reconcileState: async (currentState) => ({
        state: currentState,
        driftDetected: false,
        rpcFailed: false,
        previousActivity: currentState.exchangeActivity,
        nextActivity: currentState.exchangeActivity,
      }),
      getOnboardingStatus: async () => ({
        status: "ready",
        message: "ready",
        bridgeableAmount: "25",
      }),
      refreshAgentMd: async () => createAgentMdResult(),
      fetchSuggestion: async (_request) => createSuggestionResult(),
      evaluatePolicy: ({ runtimeState, now: tickNow, suggestionResult }) => ({
        kind: "hold",
        marketId: runtimeState.market.marketId,
        mode: runtimeState.market.mode,
        evaluatedAt: tickNow.toISOString(),
        slotId: slotIdFromDate(tickNow),
        suggestionId:
          suggestionResult !== null && suggestionResult.kind === "ok"
            ? suggestionResult.recommendation.recommendationId
            : null,
        overridePhrase: {
          wasAccepted: false,
          isAccepted: true,
          requiresAcceptance: false,
          shouldPersist: true,
        },
        agentStatus: "active",
        clamps: [],
        holdReason: "no-suggestion",
        message: "No suggestion.",
      }),
      executeDecision: async (_decision, _state, tickNow, _executionContext) =>
        createExecutionResult(slotIdFromDate(tickNow)),
      cancelOutstandingOrders: async () => ({
        cancelledCount: 0,
        hadFailures: false,
        confirmedNoPendingOrders: false,
      }),
      clearDeadMan: async () => {},
      readTradeHistory: async () => [],
      now: () => now,
    });

    const result = await service.executeTick();

    expect(result.outcome).toBe("executed");
    expect(result.slotId).toBe(slotId);
    expect(state.overridePhraseAccepted).toBe(true);
    expect(persisted.at(-1)?.overridePhraseAccepted).toBe(true);
  });

  it("does not change overridePhraseAccepted when policy returns shouldPersist false", async () => {
    const now = new Date("2026-03-27T12:31:00.000Z");
    const slotId = slotIdFromDate(now);
    let state = createState({ daemonStatus: "running", overridePhraseAccepted: false });
    const persisted: RuntimeState[] = [];

    const service = new DaemonService({
      readState: async () => state,
      updateState: async (updater) => {
        const nextState = updater(state);
        state = nextState;
        persisted.push(nextState);
        return nextState;
      },
      acquirePidLock: async () => ({
        replacedStalePid: false,
        existingPid: null,
        release: async () => {},
      }),
      reconcileState: async (currentState) => ({
        state: currentState,
        driftDetected: false,
        rpcFailed: false,
        previousActivity: currentState.exchangeActivity,
        nextActivity: currentState.exchangeActivity,
      }),
      getOnboardingStatus: async () => ({
        status: "ready",
        message: "ready",
        bridgeableAmount: "25",
      }),
      refreshAgentMd: async () => createAgentMdResult(),
      fetchSuggestion: async (_request) => createSuggestionResult(),
      evaluatePolicy: ({ runtimeState, now: tickNow, suggestionResult }) => ({
        kind: "hold",
        marketId: runtimeState.market.marketId,
        mode: runtimeState.market.mode,
        evaluatedAt: tickNow.toISOString(),
        slotId: slotIdFromDate(tickNow),
        suggestionId:
          suggestionResult !== null && suggestionResult.kind === "ok"
            ? suggestionResult.recommendation.recommendationId
            : null,
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
      }),
      executeDecision: async (_decision, _state, tickNow, _executionContext) =>
        createExecutionResult(slotIdFromDate(tickNow)),
      cancelOutstandingOrders: async () => ({
        cancelledCount: 0,
        hadFailures: false,
        confirmedNoPendingOrders: false,
      }),
      clearDeadMan: async () => {},
      readTradeHistory: async () => [],
      now: () => now,
    });

    const result = await service.executeTick();

    expect(result.outcome).toBe("executed");
    expect(result.slotId).toBe(slotId);
    expect(state.overridePhraseAccepted).toBe(false);
    expect(persisted.at(-1)?.overridePhraseAccepted).toBe(false);
  });

  describe("network and hold visibility", () => {
    const savedHlNetwork = process.env.HL_NETWORK;
    const savedHlTestnet = process.env.HL_TESTNET;

    afterEach(() => {
      if (savedHlNetwork === undefined) {
        process.env.HL_NETWORK = "";
      } else {
        process.env.HL_NETWORK = savedHlNetwork;
      }
      if (savedHlTestnet === undefined) {
        process.env.HL_TESTNET = "";
      } else {
        process.env.HL_TESTNET = savedHlTestnet;
      }
    });

    it("getStatusSnapshot includes network field defaulting to mainnet", async () => {
      process.env.HL_NETWORK = "";
      process.env.HL_TESTNET = "";
      const harness = createServiceHarness(createState({ daemonStatus: "running" }));

      const status = await harness.service.getStatusSnapshot();

      expect(status.network).toBe("mainnet");
    });

    it("getStatusSnapshot reflects HL_NETWORK=testnet", async () => {
      process.env.HL_NETWORK = "testnet";
      process.env.HL_TESTNET = "";
      const harness = createServiceHarness(createState({ daemonStatus: "running" }));

      const status = await harness.service.getStatusSnapshot();

      expect(status.network).toBe("testnet");
    });

    it("getStatusSnapshot omits retired lastBlockingHold field", async () => {
      process.env.HL_NETWORK = "";
      process.env.HL_TESTNET = "";
      const harness = createServiceHarness(createState({ daemonStatus: "running" }));

      const status = await harness.service.getStatusSnapshot();

      expect("lastBlockingHold" in status).toBe(false);
    });

    it("executeTick result includes network field", async () => {
      process.env.HL_NETWORK = "testnet";
      process.env.HL_TESTNET = "";
      const harness = createServiceHarness(createState({ daemonStatus: "running" }));

      const result = await harness.service.executeTick();

      expect(result.network).toBe("testnet");
    });

    it("executeTick result holdContext is null when no explicit hold context is supplied", async () => {
      process.env.HL_NETWORK = "";
      process.env.HL_TESTNET = "";
      const harness = createServiceHarness(createState({ daemonStatus: "running" }));

      const result = await harness.service.executeTick();

      expect(result.holdContext).toBeNull();
    });

    it("startTrading returns network without retired lastBlockingHold field", async () => {
      process.env.HL_NETWORK = "mainnet";
      process.env.HL_TESTNET = "";
      const harness = createServiceHarness(
        createState({
          daemonStatus: "stopped",
          liveTradingConsent: { acknowledged: true, acknowledgedAt: "2026-01-01T00:00:00.000Z" },
        }),
      );

      const status = await harness.service.startTrading();

      expect(status.network).toBe("mainnet");
      expect("lastBlockingHold" in status).toBe(false);
    });

    it("stopTrading returns network without retired lastBlockingHold field", async () => {
      process.env.HL_NETWORK = "testnet";
      process.env.HL_TESTNET = "";
      const harness = createServiceHarness(createState({ daemonStatus: "running" }));

      const status = await harness.service.stopTrading();

      expect(status.network).toBe("testnet");
      expect("lastBlockingHold" in status).toBe(false);
    });

    it("getStatusSnapshot includes tradingSelection when set", async () => {
      const selection = createTradingSelection();
      const harness = createServiceHarness(
        createState({ daemonStatus: "running", tradingSelection: selection }),
      );

      const status = await harness.service.getStatusSnapshot();

      expect(status.tradingSelection).toEqual(selection);
    });

    it("getStatusSnapshot returns null tradingSelection when not set", async () => {
      const harness = createServiceHarness(
        createState({ daemonStatus: "running", tradingSelection: null }),
      );

      const status = await harness.service.getStatusSnapshot();

      expect(status.tradingSelection).toBeNull();
    });

    it("getStatusSnapshot includes liveTradingConsent when acknowledged", async () => {
      const harness = createServiceHarness(
        createState({
          daemonStatus: "running",
          liveTradingConsent: { acknowledged: true, acknowledgedAt: "2026-01-01T00:00:00.000Z" },
        }),
      );

      const status = await harness.service.getStatusSnapshot();

      expect(status.liveTradingConsent).toEqual({
        acknowledged: true,
        acknowledgedAt: "2026-01-01T00:00:00.000Z",
      });
    });

    it("getStatusSnapshot includes liveTradingConsent when not acknowledged", async () => {
      const harness = createServiceHarness(
        createState({
          daemonStatus: "running",
          liveTradingConsent: { acknowledged: false, acknowledgedAt: null },
        }),
      );

      const status = await harness.service.getStatusSnapshot();

      expect(status.liveTradingConsent).toEqual({
        acknowledged: false,
        acknowledgedAt: null,
      });
    });

    it("getStatusSnapshot includes fundingReadiness from onboarding status", async () => {
      const harness = createServiceHarness(createState({ daemonStatus: "running" }));

      const status = await harness.service.getStatusSnapshot();

      expect(status.fundingReadiness).toEqual({
        status: "ready",
        message: "ready",
        bridgeableAmount: "25",
      });
      expect(harness.getOnboardingCalls()).toBeGreaterThanOrEqual(1);
    });

    it("getStatusSnapshot returns null fundingReadiness when onboarding status fetch fails", async () => {
      const now = new Date("2026-03-27T12:31:00.000Z");
      let state = createState({ daemonStatus: "running" });
      const service = new DaemonService({
        readState: async () => state,
        updateState: async (updater) => {
          const nextState = updater(state);
          state = nextState;
          return nextState;
        },
        acquirePidLock: async () => ({
          replacedStalePid: false,
          existingPid: null,
          release: async () => {},
        }),
        reconcileState: async (currentState) => ({
          state: currentState,
          driftDetected: false,
          rpcFailed: false,
          previousActivity: currentState.exchangeActivity,
          nextActivity: currentState.exchangeActivity,
        }),
        getOnboardingStatus: async () => {
          throw new Error("RPC unavailable");
        },
        refreshAgentMd: async () => createAgentMdResult(),
        fetchSuggestion: async () => createSuggestionResult(),
        evaluatePolicy: ({ runtimeState, now: tickNow }) => ({
          kind: "hold",
          marketId: runtimeState.market.marketId,
          mode: runtimeState.market.mode,
          evaluatedAt: tickNow.toISOString(),
          slotId: slotIdFromDate(tickNow),
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
        }),
        executeDecision: async (_decision, _state, tickNow) =>
          createExecutionResult(slotIdFromDate(tickNow)),
        cancelOutstandingOrders: async () => 0,
        clearDeadMan: async () => {},
        readTradeHistory: async () => [],
        now: () => now,
      });

      const status = await service.getStatusSnapshot();

      expect(status.fundingReadiness).toBeNull();
    });

    it("startTrading includes fundingReadiness in returned snapshot", async () => {
      const harness = createServiceHarness(
        createState({
          daemonStatus: "stopped",
          liveTradingConsent: { acknowledged: true, acknowledgedAt: "2026-01-01T00:00:00.000Z" },
        }),
      );

      const status = await harness.service.startTrading();

      expect(status.fundingReadiness).toEqual({
        status: "ready",
        message: "ready",
        bridgeableAmount: "25",
      });
    });

    it("stopTrading includes fundingReadiness in returned snapshot", async () => {
      const harness = createServiceHarness(createState({ daemonStatus: "running" }));

      const status = await harness.service.stopTrading();

      expect(status.fundingReadiness).toEqual({
        status: "ready",
        message: "ready",
        bridgeableAmount: "25",
      });
    });
  });

  describe("collateral prep result flow", () => {
    it("executeTick surfaces collateralPrepResult when bridge confirms and perp collateral succeeds", async () => {
      const now = new Date("2026-03-27T12:31:00.000Z");
      let state = createState({
        daemonStatus: "running",
        pendingBridgeTransfers: [
          {
            idempotencyKey: "k1",
            txHash: "0xbridge",
            amountUsdc: "25",
            submittedAt: "2026-03-27T12:00:00.000Z",
          },
        ],
      });
      const persisted: RuntimeState[] = [];

      const service = new DaemonService({
        readState: async () => state,
        updateState: async (updater) => {
          const nextState = updater(state);
          state = nextState;
          persisted.push(nextState);
          return nextState;
        },
        acquirePidLock: async () => ({
          replacedStalePid: false,
          existingPid: null,
          release: async () => {},
        }),
        reconcileState: async (currentState) => ({
          state: currentState,
          driftDetected: false,
          rpcFailed: false,
          previousActivity: currentState.exchangeActivity,
          nextActivity: currentState.exchangeActivity,
        }),
        reconcilePendingBridgeTransfersWithCollateral: async (currentState) => ({
          state: {
            ...currentState,
            pendingBridgeTransfers: [],
            cumulativeBridgeUsd: "25",
            bridgeHistory: [
              { transferId: "k1", amountUsd: "25", confirmedAt: "2026-03-27T12:31:00.000Z" },
            ],
          },
          collateralResult: { kind: "prepared", amountUsd: "25" },
        }),
        getOnboardingStatus: async () => ({
          status: "ready",
          message: "ready",
          bridgeableAmount: "25",
        }),
        refreshAgentMd: async () => createAgentMdResult(),
        fetchSuggestion: async () => createSuggestionResult(),
        evaluatePolicy: ({ runtimeState, now: tickNow, suggestionResult }) => ({
          kind: "hold",
          marketId: runtimeState.market.marketId,
          mode: runtimeState.market.mode,
          evaluatedAt: tickNow.toISOString(),
          slotId: slotIdFromDate(tickNow),
          suggestionId:
            suggestionResult !== null && suggestionResult.kind === "ok"
              ? suggestionResult.recommendation.recommendationId
              : null,
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
        }),
        executeDecision: async (_decision, _state, tickNow, _executionContext) =>
          createExecutionResult(slotIdFromDate(tickNow)),
        cancelOutstandingOrders: async () => createCancelResult(),
        clearDeadMan: async () => {},
        readTradeHistory: async () => [],
        now: () => now,
      });

      const result = await service.executeTick();

      expect(result.outcome).toBe("executed");
      expect(result.collateralPrepResult).toEqual({ kind: "prepared", amountUsd: "25" });
    });

    it("executeTick surfaces collateralPrepResult failed when perp transfer fails", async () => {
      const now = new Date("2026-03-27T12:31:00.000Z");
      let state = createState({
        daemonStatus: "running",
        pendingBridgeTransfers: [
          {
            idempotencyKey: "k1",
            txHash: "0xbridge",
            amountUsdc: "25",
            submittedAt: "2026-03-27T12:00:00.000Z",
          },
        ],
      });

      const service = new DaemonService({
        readState: async () => state,
        updateState: async (updater) => {
          const nextState = updater(state);
          state = nextState;
          return nextState;
        },
        acquirePidLock: async () => ({
          replacedStalePid: false,
          existingPid: null,
          release: async () => {},
        }),
        reconcileState: async (currentState) => ({
          state: currentState,
          driftDetected: false,
          rpcFailed: false,
          previousActivity: currentState.exchangeActivity,
          nextActivity: currentState.exchangeActivity,
        }),
        reconcilePendingBridgeTransfersWithCollateral: async (currentState) => ({
          state: {
            ...currentState,
            pendingBridgeTransfers: [],
            cumulativeBridgeUsd: "25",
            bridgeHistory: [
              { transferId: "k1", amountUsd: "25", confirmedAt: "2026-03-27T12:31:00.000Z" },
            ],
          },
          collateralResult: { kind: "failed", reason: "exchange rejected transfer" },
        }),
        getOnboardingStatus: async () => ({
          status: "collateral_prep_failed",
          message: "Collateral preparation failed",
          bridgeableAmount: null,
        }),
        refreshAgentMd: async () => createAgentMdResult(),
        fetchSuggestion: async () => createSuggestionResult(),
        evaluatePolicy: ({ runtimeState, now: tickNow, suggestionResult }) => ({
          kind: "hold",
          marketId: runtimeState.market.marketId,
          mode: runtimeState.market.mode,
          evaluatedAt: tickNow.toISOString(),
          slotId: slotIdFromDate(tickNow),
          suggestionId:
            suggestionResult !== null && suggestionResult.kind === "ok"
              ? suggestionResult.recommendation.recommendationId
              : null,
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
        }),
        executeDecision: async (_decision, _state, tickNow, _executionContext) =>
          createExecutionResult(slotIdFromDate(tickNow)),
        cancelOutstandingOrders: async () => createCancelResult(),
        clearDeadMan: async () => {},
        readTradeHistory: async () => [],
        now: () => now,
      });

      const result = await service.executeTick();

      expect(result.outcome).toBe("executed");
      expect(result.collateralPrepResult).toEqual({
        kind: "failed",
        reason: "exchange rejected transfer",
      });
      expect(result.onboardingStatus?.status).toBe("collateral_prep_failed");
    });

    it("executeTick returns null collateralPrepResult when no collateral reconciliation dep is provided", async () => {
      const harness = createServiceHarness(createState({ daemonStatus: "running" }));

      const result = await harness.service.executeTick();

      expect(result.outcome).toBe("executed");
      expect(result.collateralPrepResult).toBeNull();
    });

    it("executeTick passes collateral prep status to onboarding status check", async () => {
      const now = new Date("2026-03-27T12:31:00.000Z");
      let state = createState({ daemonStatus: "running" });
      let receivedCollateralPrepStatus: "pending" | "failed" | null | undefined;

      const service = new DaemonService({
        readState: async () => state,
        updateState: async (updater) => {
          const nextState = updater(state);
          state = nextState;
          return nextState;
        },
        acquirePidLock: async () => ({
          replacedStalePid: false,
          existingPid: null,
          release: async () => {},
        }),
        reconcileState: async (currentState) => ({
          state: currentState,
          driftDetected: false,
          rpcFailed: false,
          previousActivity: currentState.exchangeActivity,
          nextActivity: currentState.exchangeActivity,
        }),
        reconcilePendingBridgeTransfersWithCollateral: async (currentState) => ({
          state: currentState,
          collateralResult: { kind: "failed", reason: "transfer rejected" },
        }),
        getOnboardingStatus: async (_s, collateralPrepStatus) => {
          receivedCollateralPrepStatus = collateralPrepStatus;
          return {
            status: "collateral_prep_failed" as const,
            message: "Collateral preparation failed",
            bridgeableAmount: null,
          };
        },
        refreshAgentMd: async () => createAgentMdResult(),
        fetchSuggestion: async () => createSuggestionResult(),
        evaluatePolicy: ({ runtimeState, now: tickNow, suggestionResult }) => ({
          kind: "hold",
          marketId: runtimeState.market.marketId,
          mode: runtimeState.market.mode,
          evaluatedAt: tickNow.toISOString(),
          slotId: slotIdFromDate(tickNow),
          suggestionId:
            suggestionResult !== null && suggestionResult.kind === "ok"
              ? suggestionResult.recommendation.recommendationId
              : null,
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
        }),
        executeDecision: async (_decision, _state, tickNow, _executionContext) =>
          createExecutionResult(slotIdFromDate(tickNow)),
        cancelOutstandingOrders: async () => createCancelResult(),
        clearDeadMan: async () => {},
        readTradeHistory: async () => [],
        now: () => now,
      });

      await service.executeTick();

      expect(receivedCollateralPrepStatus).toBe("failed");
    });
  });
});

describe("cancelOrdersWithPartialFailure", () => {
  const orders: CancelOrderEntry[] = [
    { oid: 1, coin: "ETH" },
    { oid: 2, coin: "BTC" },
    { oid: 3, coin: "SOL" },
  ];

  it("returns count of all orders when none fail", async () => {
    const cancelOne = vi.fn().mockResolvedValue(undefined);

    const result = await cancelOrdersWithPartialFailure(orders, cancelOne);

    expect(result).toEqual({ cancelledCount: 3, hadFailures: false });
    expect(cancelOne).toHaveBeenCalledTimes(3);
  });

  it("returns 0 for empty order list", async () => {
    const cancelOne = vi.fn();

    const result = await cancelOrdersWithPartialFailure([], cancelOne);

    expect(result).toEqual({ cancelledCount: 0, hadFailures: false });
    expect(cancelOne).not.toHaveBeenCalled();
  });

  it("continues cancelling after one failure and returns successful count", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const callOrder: number[] = [];
    const cancelOne = vi.fn().mockImplementation(async (order: CancelOrderEntry) => {
      callOrder.push(order.oid);
      if (order.oid === 2) {
        throw new Error("exchange rejected cancel for order 2");
      }
    });

    const result = await cancelOrdersWithPartialFailure(orders, cancelOne);

    expect(result).toEqual({ cancelledCount: 2, hadFailures: true });
    expect(cancelOne).toHaveBeenCalledTimes(3);
    expect(callOrder).toEqual([1, 2, 3]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("continues cancelling when first order fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cancelOne = vi.fn().mockImplementation(async (order: CancelOrderEntry) => {
      if (order.oid === 1) {
        throw new Error("first order failed");
      }
    });

    const result = await cancelOrdersWithPartialFailure(orders, cancelOne);

    expect(result).toEqual({ cancelledCount: 2, hadFailures: true });
    expect(cancelOne).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("logs warning with success count and failure details on partial failure", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cancelOne = vi.fn().mockImplementation(async (order: CancelOrderEntry) => {
      if (order.oid === 2) {
        throw new Error("exchange rejected cancel for order 2");
      }
    });

    await cancelOrdersWithPartialFailure(orders, cancelOne);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("2 succeeded, 1 failed"));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("order 2 (BTC): exchange rejected cancel for order 2"),
    );
    warnSpy.mockRestore();
  });

  it("does not warn when all cancellations succeed", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cancelOne = vi.fn().mockResolvedValue(undefined);

    await cancelOrdersWithPartialFailure(orders, cancelOne);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns zero count with hadFailures when all cancellations fail", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cancelOne = vi.fn().mockImplementation(async (order: CancelOrderEntry) => {
      throw new Error(`cancel failed for ${order.coin}`);
    });

    const result = await cancelOrdersWithPartialFailure(orders, cancelOne);

    expect(result).toEqual({ cancelledCount: 0, hadFailures: true });
    expect(cancelOne).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("0 succeeded, 3 failed"));
    warnSpy.mockRestore();
  });

  it("warning includes details from each failed order when all fail", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cancelOne = vi.fn().mockImplementation(async (order: CancelOrderEntry) => {
      throw new Error(`timeout for ${order.coin}`);
    });

    await cancelOrdersWithPartialFailure(orders, cancelOne);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /order 1 \(ETH\): timeout for ETH.*order 2 \(BTC\): timeout for BTC.*order 3 \(SOL\): timeout for SOL/,
      ),
    );
    warnSpy.mockRestore();
  });

  it("handles non-Error thrown values in warning message", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cancelOne = vi.fn().mockImplementation(async () => {
      throw "string-error";
    });

    const result = await cancelOrdersWithPartialFailure([{ oid: 10, coin: "DOGE" }], cancelOne);

    expect(result).toEqual({ cancelledCount: 0, hadFailures: true });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("order 10 (DOGE): string-error"));
    warnSpy.mockRestore();
  });
});
