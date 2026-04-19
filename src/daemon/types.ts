import type { ALLOWED_ORDER_STYLES } from "../config/constants";
import type { ExecutionAuditEntry, ExecutionResult } from "../execution";
import type { CollateralPrepResult, OnboardingStatusResult } from "../onboarding";
import type {
  LocalPolicyDecision,
  PolicyExecutionIntent,
  PolicyHoldReason,
  PolicyUserPreferences,
  PriorInteractionSummary,
} from "../policy";
import type {
  AgentMdCacheState,
  LiveTradingConsent,
  RuntimeState,
  TradingSelection,
} from "../state";
import type {
  AgentMdPolicyView,
  AgentMdRefreshResult,
  RecommendationDirection,
  TickRecommendationProvider,
  TickRecommendationRequest,
  TickRecommendationResult,
} from "../v4t";
import type { PidLockHandle } from "./pid-lock";
import type { ReconcileRuntimeStateResult } from "./reconcile";
import type { RuntimeStateUpdater } from "./runtime-state-file";

export type DaemonDeps = {
  readonly readState: () => Promise<RuntimeState>;
  readonly updateState?: (updater: RuntimeStateUpdater) => Promise<RuntimeState>;
  readonly acquirePidLock: () => Promise<PidLockHandle>;
  readonly reconcileState: (state: RuntimeState) => Promise<ReconcileRuntimeStateResult>;
  readonly reconcilePendingBridgeTransfers?: (state: RuntimeState) => Promise<RuntimeState>;
  readonly reconcilePendingBridgeTransfersWithCollateral?: (
    state: RuntimeState,
  ) => Promise<{ state: RuntimeState; collateralResult: CollateralPrepResult | null }>;
  readonly refreshAgentMd: (now: Date) => Promise<AgentMdRefreshResult>;
  readonly fetchSuggestion: TickRecommendationProvider;
  readonly getOnboardingStatus: (
    state: RuntimeState,
    collateralPrepStatus?: "pending" | "failed" | null,
  ) => Promise<OnboardingStatusResult>;
  readonly evaluatePolicy: (input: {
    runtimeState: RuntimeState;
    suggestionResult: TickRecommendationResult | null;
    agentMdResult: AgentMdRefreshResult;
    onboardingStatus: OnboardingStatusResult;
    now: Date;
    slotId: string;
    userPreferences?: PolicyUserPreferences;
    priorInteractionSummary?: PriorInteractionSummary;
    executionIntent?: PolicyExecutionIntent;
  }) => LocalPolicyDecision;
  readonly executeDecision: (
    decision: LocalPolicyDecision,
    state: RuntimeState,
    now: Date,
    executionContext: DaemonExecutionContext,
  ) => Promise<ExecutionResult>;
  readonly cancelOutstandingOrders: (
    state: RuntimeState,
  ) => Promise<CancelOutstandingOrdersResult | number>;
  readonly clearDeadMan: () => Promise<void>;
  readonly readTradeHistory: (limit?: number) => Promise<readonly ExecutionAuditEntry[]>;
  readonly now: () => Date;
};

export type CancelOutstandingOrdersResult = {
  readonly cancelledCount: number;
  readonly hadFailures: boolean;
  readonly confirmedNoPendingOrders: boolean;
};

export class LiveTradingConsentRequiredError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LiveTradingConsentRequiredError";
  }
}

export type NetworkTarget = "mainnet" | "testnet";

/**
 * Resolve the active network target using locked env semantics:
 *   1. `HL_NETWORK=mainnet|testnet` is the primary env var.
 *   2. When `HL_NETWORK` is absent/empty, fall back to deprecated `HL_TESTNET`:
 *      `"0"` => mainnet, any other non-empty value => testnet.
 *   3. When both are absent/empty, default to **mainnet**.
 */
export function resolveNetworkTarget(): NetworkTarget {
  const hlNetwork = (process.env.HL_NETWORK ?? "").trim().toLowerCase();
  if (hlNetwork === "mainnet") return "mainnet";
  if (hlNetwork === "testnet") return "testnet";

  // HL_NETWORK absent/empty — legacy fallback
  const hlTestnet = process.env.HL_TESTNET ?? "";
  if (hlTestnet === "") return "mainnet"; // both absent → mainnet
  if (hlTestnet === "0") return "mainnet";
  return "testnet";
}

export type DaemonStatusSnapshot = {
  readonly daemonStatus: RuntimeState["daemonStatus"];
  readonly lastExecutedSlot: string | null;
  readonly lastSuggestionId: string | null;
  readonly exchangeActivity: RuntimeState["exchangeActivity"];
  readonly haltReason: string | null;
  readonly currentSlot: string;
  readonly network: NetworkTarget;
  readonly walletBackup: RuntimeState["walletBackup"];
  readonly tradingSelection: TradingSelection | null;
  readonly liveTradingConsent: LiveTradingConsent;
  readonly fundingReadiness: OnboardingStatusResult | null;
  readonly cancelHadFailures?: boolean;
};

export type DaemonTickResult = {
  readonly outcome: "executed" | "skipped" | "refused";
  readonly slotId: string;
  readonly state: RuntimeState;
  readonly executionResult: ExecutionResult | null;
  readonly reason: string | null;
  readonly reconciliation: ReconcileRuntimeStateResult;
  readonly onboardingStatus: OnboardingStatusResult | null;
  readonly collateralPrepResult: CollateralPrepResult | null;
  readonly network: NetworkTarget;
  readonly holdContext: {
    readonly code: string | null;
    readonly message: string | null;
    readonly source: string | null;
  } | null;
};

export type AllowedOrderStyle = (typeof ALLOWED_ORDER_STYLES)[number];
export type ExecuteTickIntentAction = "hold" | "target-position";

export type ExecuteTickIntent = {
  readonly action: ExecuteTickIntentAction;
  readonly side?: RecommendationDirection;
  readonly targetFraction?: string;
  readonly leverage?: number;
  readonly orderStyle?: AllowedOrderStyle;
  readonly rationale?: string;
};

export type ExecuteTickInput = {
  readonly slotId?: string;
  readonly intent?: ExecuteTickIntent;
};

export type DaemonExecutionContext = {
  readonly orderStyle: AllowedOrderStyle;
};

export type TickSelectionValidation = {
  readonly status:
    | "missing"
    | "validated"
    | "agent-md-unavailable"
    | "option-not-found"
    | "option-mismatch";
  readonly reason: string | null;
};

export type TickSelectionContext = {
  readonly selection: TradingSelection | null;
  readonly recommendedOptionId: string | null;
  readonly agentOptionLabel: string | null;
  readonly validation: TickSelectionValidation;
};

export type SelectionResolution = {
  readonly selection: TradingSelection | null;
  readonly validation: TickSelectionValidation;
};

export type DaemonTickContextSnapshot = {
  readonly currentSlot: string;
  readonly daemonStatus: RuntimeState["daemonStatus"];
  readonly haltReason: string | null;
  readonly network: "mainnet" | "testnet";
  readonly selection: TickSelectionContext;
  readonly onboardingStatus: OnboardingStatusResult;
  readonly agentMd: {
    readonly kind: AgentMdRefreshResult["kind"];
    readonly status: AgentMdPolicyView["status"] | null;
    readonly version: string | null;
    readonly fetchedAt: string | null;
  };
  readonly suggestionRequest: TickRecommendationRequest | null;
  readonly suggestionResult: TickRecommendationResult | null;
  readonly holdContext: {
    readonly lifecycleReason: "stopped" | "halted" | null;
    readonly policyKind: LocalPolicyDecision["kind"];
    readonly policyHoldReason: PolicyHoldReason | null;
    readonly message: string | null;
  };
  readonly execution: {
    readonly allowedOrderStyles: readonly AllowedOrderStyle[];
    readonly defaultOrderStyle: AllowedOrderStyle;
    readonly selectedOrderStyle: AllowedOrderStyle;
  };
};

export type NormalizedExecuteTickInput = {
  readonly slotId: string;
  readonly userPreferences?: PolicyUserPreferences;
  readonly priorInteractionSummary?: PriorInteractionSummary;
  readonly executionIntent?: PolicyExecutionIntent;
  readonly executionContext: DaemonExecutionContext;
};

export type CancelOrderEntry = {
  readonly oid: number;
  readonly coin: string;
};
