import {
  compareDecimalStrings,
  ensureNonNegativeDecimalString,
  parseSingleMarketConfig,
  sumDecimalStrings,
} from "../config";
import type { SingleMarketConfig } from "../config/market";
import {
  SchemaValidationError,
  assertExactKeys,
  expectPlainObject,
  parseJsonText,
  readArray,
  readBoolean,
  readEnumString,
  readNestedObject,
  readNullableNestedObject,
  readNullableString,
  readRequiredString,
} from "../config/validation";
import { parseCanonicalUtcTimestamp, parseTickSlotUtc } from "./slots";

const DAEMON_STATUSES = ["stopped", "running", "halted"] as const;

export type DaemonStatus = (typeof DAEMON_STATUSES)[number];

export type WalletState = {
  readonly address: string;
  readonly mnemonicFilePath: string;
};

export type BridgeTransferRecord = {
  readonly transferId: string;
  readonly amountUsd: string;
  readonly confirmedAt: string;
};

export type PendingBridgeTransfer = {
  readonly idempotencyKey: string;
  readonly txHash: string | null;
  readonly amountUsdc: string;
  readonly submittedAt: string;
};

export type ExchangeActivityState = {
  readonly hasOpenPosition: boolean;
  readonly hasPendingOrder: boolean;
};

const V4T_STRATEGY_PROFILES = ["aggressive", "balanced", "conservative"] as const;

export type V4tStrategyProfile = (typeof V4T_STRATEGY_PROFILES)[number];

export type TradingSelection = {
  readonly optionId: string;
  readonly market: SingleMarketConfig;
  readonly modelKey: string;
  readonly strategyKey: string;
  readonly strategyProfile: V4tStrategyProfile;
  readonly recommendationId: string | null;
  readonly sourceAgentMdVersion: string | null;
  readonly sourceAgentMdFetchedAt: string | null;
};

const WALLET_BACKUP_STATUSES = ["pending", "confirmed", "archived", "deleted"] as const;

export type WalletBackupStatus = (typeof WALLET_BACKUP_STATUSES)[number];

export type WalletBackupState = {
  readonly status: WalletBackupStatus;
  readonly mnemonicDisplayedAt: string | null;
  readonly confirmedAt: string | null;
  readonly cleanedUpAt: string | null;
};

export type LiveTradingConsent = {
  readonly acknowledged: boolean;
  readonly acknowledgedAt: string | null;
};

export type RuntimeState = {
  readonly wallet: WalletState;
  readonly vibe4tradingToken: string | null;
  readonly market: SingleMarketConfig;
  readonly overridePhraseAccepted: boolean;
  readonly cumulativeBridgeUsd: string;
  readonly bridgeHistory: BridgeTransferRecord[];
  readonly pendingBridgeTransfers: PendingBridgeTransfer[];
  readonly lastExecutedSlot: string | null;
  readonly executingSlot: string | null;
  readonly lastSuggestionId: string | null;
  readonly daemonStatus: DaemonStatus;
  readonly exchangeActivity: ExchangeActivityState;
  readonly haltReason: string | null;
  readonly tradingSelection: TradingSelection | null;
  readonly walletBackup: WalletBackupState;
  readonly liveTradingConsent: LiveTradingConsent;
};

export type CreateRuntimeStateInput = {
  readonly wallet: WalletState;
  readonly market: SingleMarketConfig;
  readonly vibe4tradingToken?: string | null;
  readonly overridePhraseAccepted?: boolean;
  readonly bridgeHistory?: BridgeTransferRecord[];
  readonly pendingBridgeTransfers?: PendingBridgeTransfer[];
  readonly lastExecutedSlot?: string | null;
  readonly executingSlot?: string | null;
  readonly lastSuggestionId?: string | null;
  readonly daemonStatus?: DaemonStatus;
  readonly exchangeActivity?: ExchangeActivityState;
  readonly haltReason?: string | null;
  readonly tradingSelection?: TradingSelection | null;
  readonly walletBackup?: WalletBackupState;
  readonly liveTradingConsent?: LiveTradingConsent;
};

const ETH_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export function createRuntimeState(input: CreateRuntimeStateInput): RuntimeState {
  const bridgeHistory = [...(input.bridgeHistory ?? [])];
  const pendingBridgeTransfers = [...(input.pendingBridgeTransfers ?? [])];
  const cumulativeBridgeUsd = sumDecimalStrings(
    bridgeHistory.map((transfer) => transfer.amountUsd),
  );

  return parseRuntimeState({
    wallet: input.wallet,
    vibe4tradingToken: input.vibe4tradingToken ?? null,
    market: input.market,
    overridePhraseAccepted: input.overridePhraseAccepted ?? false,
    cumulativeBridgeUsd,
    bridgeHistory,
    pendingBridgeTransfers,
    lastExecutedSlot: input.lastExecutedSlot ?? null,
    executingSlot: input.executingSlot ?? null,
    lastSuggestionId: input.lastSuggestionId ?? null,
    daemonStatus: input.daemonStatus ?? "stopped",
    exchangeActivity: input.exchangeActivity ?? {
      hasOpenPosition: false,
      hasPendingOrder: false,
    },
    haltReason: input.haltReason ?? null,
    tradingSelection: input.tradingSelection ?? null,
    walletBackup: input.walletBackup ?? {
      status: "pending",
      mnemonicDisplayedAt: null,
      confirmedAt: null,
      cleanedUpAt: null,
    },
    liveTradingConsent: input.liveTradingConsent ?? {
      acknowledged: false,
      acknowledgedAt: null,
    },
  });
}

export function parseRuntimeState(value: unknown): RuntimeState {
  const context = "RuntimeState";
  const rawInput = expectPlainObject(value, context);
  const withPendingBridge =
    "pendingBridgeTransfers" in rawInput ? rawInput : { ...rawInput, pendingBridgeTransfers: [] };
  const withExecutingSlot =
    "executingSlot" in withPendingBridge
      ? withPendingBridge
      : { ...withPendingBridge, executingSlot: null };
  const withHaltReason =
    "haltReason" in withExecutingSlot
      ? withExecutingSlot
      : { ...withExecutingSlot, haltReason: null };
  const withTradingSelection =
    "tradingSelection" in withHaltReason
      ? withHaltReason
      : { ...withHaltReason, tradingSelection: null };
  const withWalletBackup =
    "walletBackup" in withTradingSelection
      ? withTradingSelection
      : {
          ...withTradingSelection,
          walletBackup: {
            status: "pending",
            mnemonicDisplayedAt: null,
            confirmedAt: null,
            cleanedUpAt: null,
          },
        };
  const withLiveTradingConsent =
    "liveTradingConsent" in withWalletBackup
      ? withWalletBackup
      : {
          ...withWalletBackup,
          liveTradingConsent: {
            acknowledged: false,
            acknowledgedAt: null,
          },
        };
  const input = withLiveTradingConsent;
  assertExactKeys(
    input,
    [
      "wallet",
      "vibe4tradingToken",
      "market",
      "overridePhraseAccepted",
      "cumulativeBridgeUsd",
      "bridgeHistory",
      "pendingBridgeTransfers",
      "lastExecutedSlot",
      "executingSlot",
      "lastSuggestionId",
      "daemonStatus",
      "exchangeActivity",
      "haltReason",
      "tradingSelection",
      "walletBackup",
      "liveTradingConsent",
    ],
    context,
  );

  const wallet = parseWalletState(readNestedObject(input, "wallet", context));
  const vibe4tradingToken = readNullableString(input, "vibe4tradingToken", context, {
    minLength: 1,
  });
  const market = parseSingleMarketConfig(input.market);
  const overridePhraseAccepted = readBoolean(input, "overridePhraseAccepted", context);
  const cumulativeBridgeUsd = ensureNonNegativeDecimalString(
    readRequiredString(input, "cumulativeBridgeUsd", context),
    `${context}.cumulativeBridgeUsd`,
  );
  const bridgeHistory = readArray(input, "bridgeHistory", context, (item, index) =>
    parseBridgeTransferRecord(item, index),
  );
  const pendingBridgeTransfers = readArray(
    input,
    "pendingBridgeTransfers",
    context,
    (item, index) => parsePendingBridgeTransfer(item, index),
  );
  const lastExecutedSlot = parseNullableTickSlot(
    input.lastExecutedSlot,
    `${context}.lastExecutedSlot`,
  );
  const executingSlot = parseNullableTickSlot(input.executingSlot, `${context}.executingSlot`);
  const lastSuggestionId = readNullableString(input, "lastSuggestionId", context, {
    minLength: 1,
  });
  const daemonStatus = readEnumString(input, "daemonStatus", context, DAEMON_STATUSES);
  const exchangeActivity = parseExchangeActivityState(
    readNestedObject(input, "exchangeActivity", context),
  );
  const haltReason = readNullableString(input, "haltReason", context, { minLength: 1 });
  const tradingSelection = parseTradingSelection(
    readNullableNestedObject(input, "tradingSelection", context),
  );
  const walletBackup = parseWalletBackupState(readNestedObject(input, "walletBackup", context));
  const liveTradingConsent = parseLiveTradingConsent(
    readNestedObject(input, "liveTradingConsent", context),
  );

  const expectedCumulativeBridgeUsd = sumDecimalStrings(
    bridgeHistory.map((transfer) => transfer.amountUsd),
  );
  if (compareDecimalStrings(cumulativeBridgeUsd, expectedCumulativeBridgeUsd) !== 0) {
    throw new SchemaValidationError(
      "RuntimeState.cumulativeBridgeUsd must exactly match the confirmed bridge history total.",
    );
  }

  return {
    wallet,
    vibe4tradingToken,
    market,
    overridePhraseAccepted,
    cumulativeBridgeUsd,
    bridgeHistory,
    pendingBridgeTransfers,
    lastExecutedSlot,
    executingSlot,
    lastSuggestionId,
    daemonStatus,
    exchangeActivity,
    haltReason,
    tradingSelection,
    walletBackup,
    liveTradingConsent,
  };
}

export function serializeRuntimeState(value: RuntimeState): string {
  return `${JSON.stringify(parseRuntimeState(value), null, 2)}\n`;
}

export function deserializeRuntimeState(jsonText: string): RuntimeState {
  return parseJsonText(jsonText, parseRuntimeState, "runtime state file");
}

function parseWalletState(value: unknown): WalletState {
  const context = "RuntimeState.wallet";
  const input = expectPlainObject(value, context);
  assertExactKeys(input, ["address", "mnemonicFilePath"], context);

  return {
    address: readRequiredString(input, "address", context, {
      pattern: ETH_ADDRESS_PATTERN,
    }),
    mnemonicFilePath: readRequiredString(input, "mnemonicFilePath", context, {
      absolutePath: true,
    }),
  };
}

function parseBridgeTransferRecord(value: unknown, index: number): BridgeTransferRecord {
  const context = `RuntimeState.bridgeHistory[${index}]`;
  const input = expectPlainObject(value, context);
  assertExactKeys(input, ["transferId", "amountUsd", "confirmedAt"], context);

  return {
    transferId: readRequiredString(input, "transferId", context, { minLength: 1 }),
    amountUsd: ensureNonNegativeDecimalString(
      readRequiredString(input, "amountUsd", context),
      `${context}.amountUsd`,
    ),
    confirmedAt: parseCanonicalUtcTimestamp(
      readRequiredString(input, "confirmedAt", context),
      `${context}.confirmedAt`,
    ).toISOString(),
  };
}

function parsePendingBridgeTransfer(value: unknown, index: number): PendingBridgeTransfer {
  const context = `RuntimeState.pendingBridgeTransfers[${index}]`;
  const input = expectPlainObject(value, context);
  assertExactKeys(input, ["idempotencyKey", "txHash", "amountUsdc", "submittedAt"], context);

  return {
    idempotencyKey: readRequiredString(input, "idempotencyKey", context, { minLength: 1 }),
    txHash: readNullableString(input, "txHash", context, { minLength: 1 }),
    amountUsdc: ensureNonNegativeDecimalString(
      readRequiredString(input, "amountUsdc", context),
      `${context}.amountUsdc`,
    ),
    submittedAt: parseCanonicalUtcTimestamp(
      readRequiredString(input, "submittedAt", context),
      `${context}.submittedAt`,
    ).toISOString(),
  };
}

function parseExchangeActivityState(value: unknown): ExchangeActivityState {
  const context = "RuntimeState.exchangeActivity";
  const input = expectPlainObject(value, context);
  assertExactKeys(input, ["hasOpenPosition", "hasPendingOrder"], context);

  return {
    hasOpenPosition: readBoolean(input, "hasOpenPosition", context),
    hasPendingOrder: readBoolean(input, "hasPendingOrder", context),
  };
}

function parseTradingSelection(value: unknown): TradingSelection | null {
  if (value === null) {
    return null;
  }

  const context = "RuntimeState.tradingSelection";
  const input = expectPlainObject(value, context);
  assertExactKeys(
    input,
    [
      "optionId",
      "market",
      "modelKey",
      "strategyKey",
      "strategyProfile",
      "recommendationId",
      "sourceAgentMdVersion",
      "sourceAgentMdFetchedAt",
    ],
    context,
  );

  const sourceAgentMdFetchedAt = readNullableString(input, "sourceAgentMdFetchedAt", context, {
    minLength: 1,
  });
  if (sourceAgentMdFetchedAt !== null) {
    parseCanonicalUtcTimestamp(sourceAgentMdFetchedAt, `${context}.sourceAgentMdFetchedAt`);
  }

  return {
    optionId: readRequiredString(input, "optionId", context, { minLength: 1 }),
    market: parseSingleMarketConfig(input.market),
    modelKey: readRequiredString(input, "modelKey", context, { minLength: 1 }),
    strategyKey: readRequiredString(input, "strategyKey", context, { minLength: 1 }),
    strategyProfile: readEnumString(input, "strategyProfile", context, V4T_STRATEGY_PROFILES),
    recommendationId: readNullableString(input, "recommendationId", context, { minLength: 1 }),
    sourceAgentMdVersion: readNullableString(input, "sourceAgentMdVersion", context, {
      minLength: 1,
    }),
    sourceAgentMdFetchedAt,
  };
}

function parseWalletBackupState(value: unknown): WalletBackupState {
  const context = "RuntimeState.walletBackup";
  const input = expectPlainObject(value, context);
  assertExactKeys(input, ["status", "mnemonicDisplayedAt", "confirmedAt", "cleanedUpAt"], context);

  const mnemonicDisplayedAt = readNullableString(input, "mnemonicDisplayedAt", context, {
    minLength: 1,
  });
  if (mnemonicDisplayedAt !== null) {
    parseCanonicalUtcTimestamp(mnemonicDisplayedAt, `${context}.mnemonicDisplayedAt`);
  }

  const confirmedAt = readNullableString(input, "confirmedAt", context, { minLength: 1 });
  if (confirmedAt !== null) {
    parseCanonicalUtcTimestamp(confirmedAt, `${context}.confirmedAt`);
  }

  const cleanedUpAt = readNullableString(input, "cleanedUpAt", context, { minLength: 1 });
  if (cleanedUpAt !== null) {
    parseCanonicalUtcTimestamp(cleanedUpAt, `${context}.cleanedUpAt`);
  }

  return {
    status: readEnumString(input, "status", context, WALLET_BACKUP_STATUSES),
    mnemonicDisplayedAt,
    confirmedAt,
    cleanedUpAt,
  };
}

function parseLiveTradingConsent(value: unknown): LiveTradingConsent {
  const context = "RuntimeState.liveTradingConsent";
  const input = expectPlainObject(value, context);
  assertExactKeys(input, ["acknowledged", "acknowledgedAt"], context);

  const acknowledgedAt = readNullableString(input, "acknowledgedAt", context, { minLength: 1 });
  if (acknowledgedAt !== null) {
    parseCanonicalUtcTimestamp(acknowledgedAt, `${context}.acknowledgedAt`);
  }

  return {
    acknowledged: readBoolean(input, "acknowledged", context),
    acknowledgedAt,
  };
}

function parseNullableTickSlot(value: unknown, context: string): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new SchemaValidationError(`${context} must be a string or null.`);
  }

  return parseTickSlotUtc(value);
}
