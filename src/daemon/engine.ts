import { ALLOWED_ORDER_STYLES, DEFAULT_ORDER_STYLE } from "../config/constants";
import type { ExecutionAuditEntry } from "../execution";
import type { CollateralPrepResult, OnboardingStatusResult } from "../onboarding";
import type { RuntimeState } from "../state";
import { slotIdFromDate } from "../state";
import type { AgentMdRefreshResult } from "../v4t";
import {
  buildSuggestionRequest,
  createNoopReconciliation,
  deriveCollateralPrepStatus,
  isDeadManSwitchExpired,
  isSlotAlreadyConsumed,
  mergeRuntimeStateForReconciliation,
  normalizeCancelOutstandingOrdersResult,
  normalizeExecuteTickInput,
  resolveSelectionValidation,
  toErrorMessage,
} from "./helpers";
import { DaemonPidLockError } from "./pid-lock";
import { createProductionDaemonDeps, isMainnet } from "./production-deps";
import type { RuntimeStateUpdater } from "./runtime-state-file";
import { StateWriteError } from "./runtime-state-file";
import type {
  AllowedOrderStyle,
  CancelOutstandingOrdersResult,
  DaemonDeps,
  DaemonStatusSnapshot,
  DaemonTickContextSnapshot,
  DaemonTickResult,
  ExecuteTickInput,
  ExecuteTickIntentAction,
} from "./types";
import { LiveTradingConsentRequiredError, resolveNetworkTarget } from "./types";

export * from "./types";
export * from "./helpers";
export * from "./production-deps";

function buildRefusedResult({
  slotId,
  state,
  reason,
  network,
  reconciliation = createNoopReconciliation(state),
  holdContext = null,
}: {
  slotId: string;
  state: RuntimeState;
  reason: NonNullable<DaemonTickResult["reason"]>;
  network: DaemonTickResult["network"];
  reconciliation?: DaemonTickResult["reconciliation"];
  holdContext?: DaemonTickResult["holdContext"];
}): DaemonTickResult {
  return {
    outcome: "refused",
    slotId,
    state,
    executionResult: null,
    reason,
    reconciliation,
    onboardingStatus: null,
    collateralPrepResult: null,
    network,
    holdContext,
  };
}

function buildSkippedResult({
  slotId,
  state,
  reason,
  network,
  reconciliation = createNoopReconciliation(state),
  holdContext = null,
}: {
  slotId: string;
  state: RuntimeState;
  reason: NonNullable<DaemonTickResult["reason"]>;
  network: DaemonTickResult["network"];
  reconciliation?: DaemonTickResult["reconciliation"];
  holdContext?: DaemonTickResult["holdContext"];
}): DaemonTickResult {
  return {
    outcome: "skipped",
    slotId,
    state,
    executionResult: null,
    reason,
    reconciliation,
    onboardingStatus: null,
    collateralPrepResult: null,
    network,
    holdContext,
  };
}

export class DaemonService {
  private pidLockHandle: import("./pid-lock").PidLockHandle | null = null;

  constructor(private readonly deps: DaemonDeps) {}

  async startTrading(): Promise<DaemonStatusSnapshot> {
    const reconciliation = await this.deps.reconcileState(await this.deps.readState());
    const nextState = await this.updateState((lockedState) => {
      if (isMainnet() && !lockedState.liveTradingConsent.acknowledged) {
        throw new LiveTradingConsentRequiredError(
          "Mainnet live trading requires explicit acknowledgment. Call acknowledge_live_trading first.",
        );
      }

      const merged = mergeRuntimeStateForReconciliation(lockedState, reconciliation.state);
      return {
        ...merged,
        daemonStatus: "running",
        haltReason: null,
        executingSlot: null,
      };
    });

    let onboardingStatus: OnboardingStatusResult | null = null;
    try {
      onboardingStatus = await this.deps.getOnboardingStatus(nextState);
    } catch (error) {
      console.warn(`startTrading: best-effort onboarding status failed — ${toErrorMessage(error)}`);
    }
    return this.buildStatus(nextState, onboardingStatus);
  }

  async stopTrading(): Promise<DaemonStatusSnapshot> {
    const state = await this.deps.readState();
    let cancelResult: CancelOutstandingOrdersResult;
    try {
      cancelResult = normalizeCancelOutstandingOrdersResult(
        await this.deps.cancelOutstandingOrders(state),
      );
    } catch (error) {
      console.error(
        `stopTrading: cancelOutstandingOrders failed — ${toErrorMessage(error)}. Proceeding with halt.`,
      );
      cancelResult = { cancelledCount: 0, hadFailures: true, confirmedNoPendingOrders: false };
    }
    try {
      await this.deps.clearDeadMan();
    } catch (error) {
      console.error(
        `stopTrading: clearDeadMan failed — ${toErrorMessage(error)}. Proceeding with halt.`,
      );
    }
    const haltReason = cancelResult.cancelledCount > 0 ? "emergency-stop" : "halted";
    const nextState = await this.updateState((lockedState) => ({
      ...lockedState,
      daemonStatus: "halted",
      haltReason,
      executingSlot: null,
      exchangeActivity: {
        hasOpenPosition: lockedState.exchangeActivity.hasOpenPosition,
        hasPendingOrder: cancelResult.confirmedNoPendingOrders
          ? false
          : cancelResult.cancelledCount > 0 || cancelResult.hadFailures
            ? true
            : lockedState.exchangeActivity.hasPendingOrder,
      },
    }));

    await this.releaseResources();
    let onboardingStatus: OnboardingStatusResult | null = null;
    try {
      onboardingStatus = await this.deps.getOnboardingStatus(nextState);
    } catch (error) {
      console.warn(`stopTrading: best-effort onboarding status failed — ${toErrorMessage(error)}`);
    }
    return this.buildStatus(nextState, onboardingStatus, {
      cancelHadFailures: cancelResult.hadFailures,
    });
  }

  async executeTick(input: ExecuteTickInput = {}): Promise<DaemonTickResult> {
    // Pre-lock read: used only for fast-fail paths (stopped/halted) and as
    // fallback state for lock-contention skip results. NOT used for the real
    // execution path — state is re-read after lock acquisition to close the
    // race window where another process could complete the same slot between
    // this read and the eventual lock acquisition.
    const now = this.deps.now();
    const normalizedInput = normalizeExecuteTickInput(input, now);
    const slotId = normalizedInput.slotId;
    const preReadState = await this.deps.readState();

    const network = resolveNetworkTarget();

    if (preReadState.daemonStatus === "stopped") {
      return buildRefusedResult({
        slotId,
        state: preReadState,
        reason: "stopped",
        network,
      });
    }

    if (preReadState.daemonStatus === "halted") {
      return buildRefusedResult({
        slotId,
        state: preReadState,
        reason: "halted",
        network,
      });
    }

    let releaseEphemeralLock: () => Promise<void>;
    try {
      releaseEphemeralLock = await this.acquireEphemeralLockIfNeeded();
    } catch (error) {
      if (error instanceof DaemonPidLockError) {
        return buildSkippedResult({
          slotId,
          state: preReadState,
          reason: "lock-contention",
          network,
        });
      }
      throw error;
    }

    try {
      // Post-lock authoritative read: close the TOCTOU race by re-reading
      // persisted state now that we hold the exclusive lock.
      let initialState = await this.deps.readState();

      if (
        initialState.executingSlot !== null &&
        initialState.executingSlot !== slotId &&
        initialState.lastExecutedSlot !== initialState.executingSlot
      ) {
        // A previous tick claimed executingSlot but never committed
        // lastExecutedSlot (likely crashed mid-execution). Promote the
        // stale slot to lastExecutedSlot so the trade is not retried,
        // then clear the executing marker.
        const staleSlot = initialState.executingSlot;
        initialState = await this.updateState((lockedState) => ({
          ...lockedState,
          executingSlot: null,
          lastExecutedSlot: staleSlot,
        }));
      }

      if (initialState.daemonStatus === "halted") {
        return buildRefusedResult({
          slotId,
          state: initialState,
          reason: "halted",
          network,
        });
      }

      if (initialState.daemonStatus === "stopped") {
        return buildRefusedResult({
          slotId,
          state: initialState,
          reason: "stopped",
          network,
        });
      }

      if (isSlotAlreadyConsumed(initialState, slotId)) {
        return buildSkippedResult({
          slotId,
          state: initialState,
          reason: "duplicate-slot",
          network,
        });
      }

      const reconciliation = await this.deps.reconcileState(initialState);

      if (reconciliation.rpcFailed) {
        return buildRefusedResult({
          slotId,
          state: reconciliation.state,
          reason: "rpc-failure",
          reconciliation,
          network,
          holdContext: {
            code: "rpc-failure",
            message: "Exchange RPC unavailable — holding to avoid trading on stale state.",
            source: "reconcile",
          },
        });
      }

      let reconciledState = reconciliation.state;
      let shouldPersistReconciledState = reconciliation.driftDetected;
      let collateralResult: CollateralPrepResult | null = null;

      if (this.deps.reconcilePendingBridgeTransfersWithCollateral !== undefined) {
        const result =
          await this.deps.reconcilePendingBridgeTransfersWithCollateral(reconciledState);
        if (result.state !== reconciledState) {
          reconciledState = result.state;
          shouldPersistReconciledState = true;
        }
        collateralResult = result.collateralResult;
      } else if (this.deps.reconcilePendingBridgeTransfers !== undefined) {
        const refreshedState = await this.deps.reconcilePendingBridgeTransfers(reconciledState);
        if (refreshedState !== reconciledState) {
          reconciledState = refreshedState;
          shouldPersistReconciledState = true;
        }
      }

      if (shouldPersistReconciledState) {
        reconciledState = await this.updateState((lockedState) =>
          mergeRuntimeStateForReconciliation(lockedState, reconciledState),
        );
      }

      if (
        reconciledState.exchangeActivity.hasPendingOrder &&
        isDeadManSwitchExpired(reconciledState.lastExecutedSlot, now)
      ) {
        await this.deps.cancelOutstandingOrders(reconciledState);
        const refreshedReconciliation = await this.deps.reconcileState(reconciledState);
        if (refreshedReconciliation.driftDetected) {
          reconciledState = await this.updateState((lockedState) =>
            mergeRuntimeStateForReconciliation(lockedState, refreshedReconciliation.state),
          );
        }
      }

      if (reconciledState.daemonStatus === "halted") {
        return buildRefusedResult({
          slotId,
          state: reconciledState,
          reason: "halted",
          reconciliation,
          network,
        });
      }

      if (isSlotAlreadyConsumed(reconciledState, slotId)) {
        return buildSkippedResult({
          slotId,
          state: reconciledState,
          reason: "duplicate-slot",
          reconciliation,
          network,
        });
      }

      const collateralPrepStatus = deriveCollateralPrepStatus(collateralResult);
      const onboardingStatus = await this.deps.getOnboardingStatus(
        reconciledState,
        collateralPrepStatus,
      );
      const agentMdResult = await this.deps.refreshAgentMd(now);
      const selectionResolution = resolveSelectionValidation(reconciledState, agentMdResult.cache);
      const suggestionRequest = buildSuggestionRequest(reconciledState, selectionResolution);
      const suggestionResult = await this.fetchSuggestionIfConfigured(
        reconciledState,
        suggestionRequest,
      );
      const decision = this.deps.evaluatePolicy({
        runtimeState: reconciledState,
        suggestionResult,
        agentMdResult,
        onboardingStatus,
        now,
        userPreferences: normalizedInput.userPreferences,
        priorInteractionSummary: normalizedInput.priorInteractionSummary,
        executionIntent: normalizedInput.executionIntent,
      });
      let claimedExecutionSlot = false;
      const executingState = await this.updateState((lockedState) => {
        if (lockedState.daemonStatus === "halted" || lockedState.daemonStatus === "stopped") {
          return lockedState;
        }

        if (isSlotAlreadyConsumed(lockedState, slotId)) {
          return lockedState;
        }

        claimedExecutionSlot = true;

        return {
          ...lockedState,
          executingSlot: slotId,
        };
      });

      if (executingState.daemonStatus === "halted") {
        return buildRefusedResult({
          slotId,
          state: executingState,
          reason: "halted",
          reconciliation,
          network,
        });
      }

      if (executingState.daemonStatus === "stopped") {
        return buildRefusedResult({
          slotId,
          state: executingState,
          reason: "stopped",
          reconciliation,
          network,
        });
      }

      if (!claimedExecutionSlot && isSlotAlreadyConsumed(executingState, slotId)) {
        return buildSkippedResult({
          slotId,
          state: executingState,
          reason: "duplicate-slot",
          reconciliation,
          network,
        });
      }

      const executionResult = await this.deps.executeDecision(
        decision,
        executingState,
        now,
        normalizedInput.executionContext,
      );

      try {
        const nextState = await this.updateState((lockedState) => ({
          ...lockedState,
          lastExecutedSlot: slotId,
          executingSlot: lockedState.executingSlot === slotId ? null : lockedState.executingSlot,
          lastSuggestionId: decision.suggestionId,
          daemonStatus:
            lockedState.daemonStatus === "running" ? "running" : lockedState.daemonStatus,
          overridePhraseAccepted: decision.overridePhrase.shouldPersist
            ? true
            : lockedState.overridePhraseAccepted,
        }));

        if (nextState.executingSlot === slotId) {
          throw new StateWriteError(
            `Failed to finalize runtime state after executing slot ${slotId}.`,
          );
        }

        return {
          outcome: executionResult.skipped ? "skipped" : "executed",
          slotId,
          state: nextState,
          executionResult,
          reason: executionResult.skipReason,
          reconciliation,
          onboardingStatus,
          collateralPrepResult: collateralResult,
          network,
          holdContext: null,
        };
      } catch (error) {
        await this.releaseResources();
        throw error;
      }
    } finally {
      await releaseEphemeralLock();
    }
  }

  async getTradeHistory(limit?: number): Promise<readonly ExecutionAuditEntry[]> {
    return this.deps.readTradeHistory(limit);
  }

  async getStatusSnapshot(): Promise<DaemonStatusSnapshot> {
    const state = await this.deps.readState();
    let onboardingStatus: OnboardingStatusResult | null = null;
    try {
      onboardingStatus = await this.deps.getOnboardingStatus(state);
    } catch (error) {
      console.warn(
        `getStatusSnapshot: best-effort onboarding status failed — ${toErrorMessage(error)}`,
      );
    }
    return this.buildStatus(state, onboardingStatus);
  }

  async getTickContext(input: ExecuteTickInput = {}): Promise<DaemonTickContextSnapshot> {
    const now = this.deps.now();
    const normalizedInput = normalizeExecuteTickInput(input, now);
    const state = await this.deps.readState();

    let onboardingStatus: OnboardingStatusResult;
    try {
      onboardingStatus = await this.deps.getOnboardingStatus(state);
    } catch (error) {
      console.warn(
        `getTickContext: best-effort onboarding status failed — ${toErrorMessage(error)}`,
      );
      onboardingStatus = {
        status: "unfunded",
        message: `Onboarding status unavailable: ${toErrorMessage(error)}`,
        bridgeableAmount: null,
      };
    }

    let agentMdResult: AgentMdRefreshResult;
    try {
      agentMdResult = await this.deps.refreshAgentMd(now);
    } catch (error) {
      console.warn(
        `getTickContext: agents.md refresh failed — ${toErrorMessage(error)}. Using stale cache.`,
      );
      agentMdResult = {
        kind: "degraded",
        reason: "network-error",
        httpStatus: null,
        message: `agents.md refresh failed: ${toErrorMessage(error)}`,
        cache: null,
        policy: null,
      };
    }

    const selectionResolution = resolveSelectionValidation(state, agentMdResult.cache);
    const suggestionRequest = buildSuggestionRequest(state, selectionResolution);

    let suggestionResult: import("../v4t").TickRecommendationResult | null = null;
    try {
      suggestionResult = await this.fetchSuggestionIfConfigured(state, suggestionRequest);
    } catch (error) {
      console.warn(
        `getTickContext: best-effort suggestion fetch failed — ${toErrorMessage(error)}`,
      );
    }

    const decision = this.deps.evaluatePolicy({
      runtimeState: state,
      suggestionResult,
      agentMdResult,
      onboardingStatus,
      now,
      userPreferences: normalizedInput.userPreferences,
      priorInteractionSummary: normalizedInput.priorInteractionSummary,
      executionIntent: normalizedInput.executionIntent,
    });

    const recommended = agentMdResult.cache?.tradingOptions?.recommended ?? null;
    const recommendedOptionId =
      recommended === null
        ? null
        : `${recommended.pair}|${recommended.strategy}|${recommended.model}`;
    const agentOptionLabel =
      selectionResolution.selection === null
        ? null
        : `${selectionResolution.selection.market.symbol} / ${selectionResolution.selection.strategyProfile} / ${selectionResolution.selection.modelKey}`;

    return {
      currentSlot: normalizedInput.slotId,
      daemonStatus: state.daemonStatus,
      haltReason: state.haltReason,
      network: isMainnet() ? "mainnet" : "testnet",
      selection: {
        selection: selectionResolution.selection,
        recommendedOptionId,
        agentOptionLabel,
        validation: selectionResolution.validation,
      },
      onboardingStatus,
      agentMd: {
        kind: agentMdResult.kind,
        status: agentMdResult.policy?.status ?? null,
        version: agentMdResult.policy?.version ?? null,
        fetchedAt: agentMdResult.cache?.fetchedAt ?? null,
      },
      suggestionRequest,
      suggestionResult,
      holdContext: {
        lifecycleReason:
          state.daemonStatus === "running"
            ? null
            : state.daemonStatus === "stopped"
              ? "stopped"
              : "halted",
        policyKind: decision.kind,
        policyHoldReason: decision.kind === "hold" ? decision.holdReason : null,
        message: decision.kind === "hold" ? decision.message : null,
      },
      execution: {
        allowedOrderStyles: ALLOWED_ORDER_STYLES,
        defaultOrderStyle: DEFAULT_ORDER_STYLE,
        selectedOrderStyle: normalizedInput.executionContext.orderStyle,
      },
    };
  }

  private buildStatus(
    state: RuntimeState,
    onboardingStatus: OnboardingStatusResult | null = null,
    options: { cancelHadFailures?: boolean } = {},
  ): DaemonStatusSnapshot {
    return {
      daemonStatus: state.daemonStatus,
      lastExecutedSlot: state.lastExecutedSlot,
      lastSuggestionId: state.lastSuggestionId,
      exchangeActivity: state.exchangeActivity,
      haltReason: state.haltReason,
      currentSlot: slotIdFromDate(this.deps.now()),
      network: resolveNetworkTarget(),
      walletBackup: state.walletBackup,
      tradingSelection: state.tradingSelection,
      liveTradingConsent: state.liveTradingConsent,
      fundingReadiness: onboardingStatus,
      ...(options.cancelHadFailures !== undefined && {
        cancelHadFailures: options.cancelHadFailures,
      }),
    };
  }

  private async fetchSuggestionIfConfigured(
    state: RuntimeState,
    request: import("../v4t").TickRecommendationRequest | null,
  ): Promise<import("../v4t").TickRecommendationResult | null> {
    if (state.vibe4tradingToken === null || request === null) {
      return null;
    }

    return this.deps.fetchSuggestion(request);
  }

  private async acquireEphemeralLockIfNeeded(): Promise<() => Promise<void>> {
    if (this.pidLockHandle !== null) {
      return async () => {};
    }

    const pidLock = await this.deps.acquirePidLock();
    this.pidLockHandle = pidLock;
    return async () => {
      await this.releaseResources();
    };
  }

  private async releaseResources(): Promise<void> {
    const pidLock = this.pidLockHandle;
    this.pidLockHandle = null;
    if (pidLock !== null) {
      await pidLock.release();
    }
  }

  private async updateState(updater: RuntimeStateUpdater): Promise<RuntimeState> {
    if (this.deps.updateState === undefined) {
      throw new StateWriteError("Daemon state persistence is not configured.");
    }

    return this.deps.updateState(updater);
  }
}

export function createDaemonService(overrides: Partial<DaemonDeps> = {}): DaemonService {
  return new DaemonService({
    ...createProductionDaemonDeps(),
    ...overrides,
  });
}

let defaultService: DaemonService | null = null;

export function resetDefaultService(): void {
  defaultService = null;
}

export async function start_trading(): Promise<DaemonStatusSnapshot> {
  const service = getDefaultService();
  return service.startTrading();
}

export async function stop_trading(): Promise<DaemonStatusSnapshot> {
  const service = getDefaultService();
  const status = await service.stopTrading();
  resetDefaultService();
  return status;
}

export async function execute_tick(input: ExecuteTickInput = {}): Promise<DaemonTickResult> {
  const service = getDefaultService();
  return service.executeTick(input);
}

export async function get_status(): Promise<DaemonStatusSnapshot> {
  const service = getDefaultService();
  return service.getStatusSnapshot();
}

export async function get_trade_history(limit?: number): Promise<readonly ExecutionAuditEntry[]> {
  const service = getDefaultService();
  return service.getTradeHistory(limit);
}

export async function get_tick_context(
  input: ExecuteTickInput = {},
): Promise<DaemonTickContextSnapshot> {
  const service = getDefaultService();
  return service.getTickContext(input);
}

export function validateExecuteTickInput(
  input: ExecuteTickInput,
  now: Date = new Date(),
): {
  readonly slotId: string;
  readonly orderStyle: AllowedOrderStyle;
  readonly action: ExecuteTickIntentAction | null;
} {
  const normalized = normalizeExecuteTickInput(input, now);
  return {
    slotId: normalized.slotId,
    orderStyle: normalized.executionContext.orderStyle,
    action: normalized.executionIntent?.action ?? null,
  };
}

function getDefaultService(): DaemonService {
  if (defaultService === null) {
    defaultService = createDaemonService();
  }
  return defaultService;
}
