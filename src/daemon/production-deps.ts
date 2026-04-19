import { readFile } from "node:fs/promises";

import { privateKeyToAccount } from "viem/accounts";

import {
  assertArray,
  assertNumber,
  assertObject,
  assertString,
  clearDeadManCancel,
  confirmBridgeTransfer,
  createArbitrumClient,
  createReadClient,
  createWriteClient,
  estimateBridgeGas,
  fetchAllMids,
  fetchClearinghouseState,
  fetchOpenOrders,
  fetchPerpMeta,
  fetchSpotBalances,
  getEthBalance,
  getUsdcBalance,
  placeOrder,
  scheduleDeadManCancel,
  cancelOrder as submitCancelOrder,
  transferBetweenPerpAndSpot,
} from "../chain";
import type { HyperliquidReadClient, HyperliquidWriteClient } from "../chain";
import { HYPERLIQUID_CLIENT_TIMEOUT_MS, MAX_POSITION_NOTIONAL_FRACTION } from "../config/constants";
import { AUDIT_LOG_FILE_PATH } from "../config/paths";
import { executeDecision as runExecutionDecision } from "../execution";
import type { ExecutionAuditEntry, ExecutionDeps } from "../execution";
import { ExecutionError } from "../execution";
import {
  getOnboardingStatus as computeOnboardingStatus,
  reconcileWithCollateralPrep,
  refreshPendingBridgeTransfers,
} from "../onboarding";
import type { CollateralPrepDeps } from "../onboarding";
import { evaluateOpenClawPolicy as runPolicyEvaluation } from "../policy";
import type { PolicyAccountState } from "../policy";
import type { RuntimeState } from "../state";
import { refreshAgentMdCache } from "../v4t";
import { createHttpTickRecommendationProvider } from "../v4t";
import { isNodeError } from "./errors";
import { cancelOrdersWithPartialFailure, toErrorMessage } from "./helpers";
import { acquireDaemonPidLock } from "./pid-lock";
import type { ProcessLivenessChecker } from "./pid-lock";
import { reconcileRuntimeState } from "./reconcile";
import { readRuntimeStateFile, updateRuntimeStateFile } from "./runtime-state-file";
import type { DaemonDeps } from "./types";
import { resolveNetworkTarget } from "./types";

export function createProductionDaemonDeps(): DaemonDeps {
  const arbitrumClient = createArbitrumClient();

  return {
    readState: () => readRuntimeStateFile(),
    updateState: (updater) => updateRuntimeStateFile(updater),
    acquirePidLock: () =>
      acquireDaemonPidLock({
        currentPid: process.pid,
        isProcessAlive: createProcessLivenessChecker(),
      }),
    reconcileState: async (state) => {
      const readClient = createHyperliquidReadClient();
      return reconcileRuntimeState(state, {
        readPerpPositions: async (walletAddress) => {
          const clearinghouseState = await fetchClearinghouseState(readClient, walletAddress);
          return clearinghouseState.assetPositions.map((entry) => ({
            coin: entry.position.coin,
            size: entry.position.szi,
          }));
        },
        readSpotBalances: async (walletAddress) => {
          const spotState = await fetchSpotBalances(readClient, walletAddress);
          return spotState.balances;
        },
        readOpenOrders: async (walletAddress) => fetchOpenOrders(readClient, walletAddress),
      });
    },
    reconcilePendingBridgeTransfers: async (state) => {
      const refreshedPendingTransfers = await refreshPendingBridgeTransfers(state, {
        confirmBridgeTransfer: async (txHash) => confirmBridgeTransfer(arbitrumClient, txHash),
      });
      return refreshedPendingTransfers.state;
    },
    reconcilePendingBridgeTransfersWithCollateral: async (state) => {
      const bridgeDeps = {
        confirmBridgeTransfer: async (txHash: string) =>
          confirmBridgeTransfer(arbitrumClient, txHash),
      };
      // Lazy collateral deps: the write client (which reads the mnemonic file)
      // is only created when transferBetweenPerpAndSpot is actually called,
      // i.e. after a bridge confirmation is detected for a perp market.
      let collateralDeps: CollateralPrepDeps | null = null;
      if (state.market.mode === "perp") {
        let cachedWriteClient: HyperliquidWriteClient | null = null;
        collateralDeps = {
          transferBetweenPerpAndSpot: async (amountUsd: string, toPerp: boolean) => {
            if (cachedWriteClient === null) {
              cachedWriteClient = await createHyperliquidWriteClient(state);
            }
            return transferBetweenPerpAndSpot(cachedWriteClient, amountUsd, toPerp);
          },
        };
      }
      const result = await reconcileWithCollateralPrep(
        state,
        bridgeDeps,
        collateralDeps,
        state.market,
      );
      return { state: result.state, collateralResult: result.collateralResult };
    },
    refreshAgentMd: (now) => refreshAgentMdCache({ now }),
    fetchSuggestion: createHttpTickRecommendationProvider(),
    getOnboardingStatus: async (state, collateralPrepStatus) => {
      return computeOnboardingStatus(
        state,
        {
          getUsdcBalance: async (address) => getUsdcBalance(arbitrumClient, address),
          getEthBalance: async (address) => getEthBalance(arbitrumClient, address),
          estimateBridgeGas: async (address, amountUsdc) =>
            estimateBridgeGas(arbitrumClient, address, amountUsdc),
        },
        state.pendingBridgeTransfers,
        collateralPrepStatus,
      );
    },
    evaluatePolicy: ({
      runtimeState,
      suggestionResult,
      agentMdResult,
      onboardingStatus,
      now,
      userPreferences,
      priorInteractionSummary,
      executionIntent,
    }) => {
      const maxTradableFraction =
        onboardingStatus.status === "ready" ||
        runtimeState.exchangeActivity.hasOpenPosition ||
        runtimeState.exchangeActivity.hasPendingOrder
          ? String(MAX_POSITION_NOTIONAL_FRACTION)
          : "0";
      const accountState: PolicyAccountState = {
        supportedModes: [runtimeState.market.mode],
        maxTradableFraction,
      };
      return runPolicyEvaluation({
        now,
        runtimeState,
        suggestionResult,
        agentMdPolicy: agentMdResult.policy,
        agentMdFetchedAt: agentMdResult.cache?.fetchedAt ?? null,
        userPreferences,
        priorInteractionSummary,
        executionIntent,
        accountState,
      });
    },
    executeDecision: async (decision, state, now, executionContext) => {
      const executionDeps = await createExecutionDeps(state);
      return runExecutionDecision(decision, state, executionDeps, now, executionContext);
    },
    cancelOutstandingOrders: async (state) => {
      const writeClient = await createHyperliquidWriteClient(state);
      const openOrders = await fetchOpenOrders(writeClient, state.wallet.address);
      const cancelResult = await cancelOrdersWithPartialFailure(openOrders, async (order) => {
        const assetIndex = await resolveAssetIndex(writeClient, order.coin);
        await submitCancelOrder(writeClient, {
          assetIndex,
          orderId: order.oid,
        });
      });

      if (!cancelResult.hadFailures) {
        return {
          ...cancelResult,
          confirmedNoPendingOrders: true,
        };
      }

      try {
        const remainingOpenOrders = await fetchOpenOrders(writeClient, state.wallet.address);
        return {
          ...cancelResult,
          confirmedNoPendingOrders: remainingOpenOrders.length === 0,
        };
      } catch (error) {
        console.warn(
          `cancelOutstandingOrders: unable to verify remaining open orders after partial cancellation failure — ${toErrorMessage(error)}`,
        );
        return {
          ...cancelResult,
          confirmedNoPendingOrders: false,
        };
      }
    },
    clearDeadMan: async () => {
      const state = await readRuntimeStateFile();
      const writeClient = await createHyperliquidWriteClient(state);
      await clearDeadManCancel(writeClient);
    },
    readTradeHistory: (limit) => readTradeHistory(limit),
    now: () => new Date(),
  };
}

function createHyperliquidReadClient(): HyperliquidReadClient {
  return createReadClient({
    isTestnet: resolveNetworkTarget() === "testnet",
    timeoutMs: HYPERLIQUID_CLIENT_TIMEOUT_MS,
  });
}

async function createHyperliquidWriteClient(state: RuntimeState): Promise<HyperliquidWriteClient> {
  const wallet = privateKeyToAccount(state.wallet.privateKey as `0x${string}`);
  return createWriteClient({
    isTestnet: resolveNetworkTarget() === "testnet",
    timeoutMs: HYPERLIQUID_CLIENT_TIMEOUT_MS,
    wallet,
  });
}

async function createExecutionDeps(state: RuntimeState): Promise<ExecutionDeps> {
  const readClient = createHyperliquidReadClient();
  const writeClient = await createHyperliquidWriteClient(state);
  return {
    syncLeverage: async (assetIndex, leverage, isCross) => {
      const result = await writeClient.exchange.updateLeverage({
        asset: assetIndex,
        leverage,
        isCross,
      });
      return {
        success: result.status === "ok",
        exchangeId: result.status,
      };
    },
    placeOrder: (params) => placeOrder(writeClient, params),
    cancelOrder: (params) => submitCancelOrder(writeClient, params),
    scheduleDeadMan: (nowMs) => scheduleDeadManCancel(writeClient, nowMs),
    clearDeadMan: async () => {
      await clearDeadManCancel(writeClient);
    },
    getMidPrice: async (coin) => {
      const mids = await fetchAllMids(readClient);
      return mids[coin] ?? mids[coin.split("/")[0] ?? coin] ?? null;
    },
    getAccountEquity: async () => {
      const clearinghouseState = await fetchClearinghouseState(readClient, state.wallet.address);
      return clearinghouseState.marginSummary.accountValue;
    },
    getSizeDecimals: async (coin) => {
      if (state.market.mode === "perp") {
        const perpMeta = await fetchPerpMeta(readClient);
        const perpAsset = perpMeta.universe.find((entry) => entry.name === coin);
        if (!perpAsset) {
          throw new ExecutionError(`Unable to resolve perp size decimals for ${coin}.`);
        }
        return perpAsset.szDecimals;
      }

      const spotMetaResponse = await readClient.info.spotMeta();
      const spotMeta = assertObject(
        spotMetaResponse,
        "createExecutionDeps.getSizeDecimals spotMeta response",
      );
      const spotMetaTokens = assertArray(
        spotMeta.tokens,
        "createExecutionDeps.getSizeDecimals spotMeta response.tokens",
      );
      const firstSpotToken = spotMetaTokens[0];
      if (firstSpotToken !== undefined) {
        const token = assertObject(
          firstSpotToken,
          "createExecutionDeps.getSizeDecimals spotMeta response.tokens[0]",
        );
        assertString(
          token.name,
          "createExecutionDeps.getSizeDecimals spotMeta response.tokens[0].name",
        );
        assertNumber(
          token.szDecimals,
          "createExecutionDeps.getSizeDecimals spotMeta response.tokens[0].szDecimals",
        );
      }
      const tokens = spotMetaTokens as readonly { name: string; szDecimals: number }[];
      const baseAsset = coin.split("/")[0] ?? coin;
      const spotToken = tokens.find((entry) => entry.name === baseAsset);
      if (!spotToken) {
        throw new ExecutionError(`Unable to resolve spot size decimals for ${coin}.`);
      }
      return spotToken.szDecimals;
    },
    getAssetIndex: (coin) => resolveAssetIndex(writeClient, coin),
    getPositionSize: async (coin) => {
      if (state.market.mode === "perp") {
        const clearinghouseState = await fetchClearinghouseState(readClient, state.wallet.address);
        return (
          clearinghouseState.assetPositions.find((entry) => entry.position.coin === coin)?.position
            .szi ?? "0"
        );
      }
      const spotStateResponse = await writeClient.info.spotClearinghouseState({
        user: state.wallet.address as `0x${string}`,
      });
      const spotState = assertObject(
        spotStateResponse,
        "createExecutionDeps.getPositionSize spotClearinghouseState response",
      );
      const spotBalances = assertArray(
        spotState.balances,
        "createExecutionDeps.getPositionSize spotClearinghouseState response.balances",
      );
      const firstSpotBalance = spotBalances[0];
      if (firstSpotBalance !== undefined) {
        const balance = assertObject(
          firstSpotBalance,
          "createExecutionDeps.getPositionSize spotClearinghouseState response.balances[0]",
        );
        assertString(
          balance.coin,
          "createExecutionDeps.getPositionSize spotClearinghouseState response.balances[0].coin",
        );
        assertString(
          balance.total,
          "createExecutionDeps.getPositionSize spotClearinghouseState response.balances[0].total",
        );
      }
      const balances = spotBalances as readonly { coin: string; total: string }[];
      return balances.find((entry) => entry.coin === coin)?.total ?? "0";
    },
    getOpenOrders: async (coin) => {
      const orders = await fetchOpenOrders(readClient, state.wallet.address);
      return orders.filter((order) => order.coin === coin);
    },
  };
}

export async function resolveAssetIndex(
  client: HyperliquidReadClient | HyperliquidWriteClient,
  coin: string,
): Promise<number> {
  if (coin.includes("/")) {
    const spotMetaResponse = await client.info.spotMeta();
    const spotMeta = assertObject(spotMetaResponse, "resolveAssetIndex spotMeta response");
    const spotUniverse = assertArray(
      spotMeta.universe,
      "resolveAssetIndex spotMeta response.universe",
    );
    const firstSpotUniverseEntry = spotUniverse[0];
    if (firstSpotUniverseEntry !== undefined) {
      const universeEntry = assertObject(
        firstSpotUniverseEntry,
        "resolveAssetIndex spotMeta response.universe[0]",
      );
      assertString(universeEntry.name, "resolveAssetIndex spotMeta response.universe[0].name");
      assertNumber(universeEntry.index, "resolveAssetIndex spotMeta response.universe[0].index");
    }
    const universe = spotUniverse as readonly { name: string; index: number }[];
    const spotAsset = universe.find((entry) => entry.name === coin);
    if (!spotAsset) {
      throw new ExecutionError(`Unable to resolve spot asset index for ${coin}.`);
    }
    return spotAsset.index;
  }

  const perpMeta = await fetchPerpMeta(client);
  const assetIndex = perpMeta.universe.findIndex((entry) => entry.name === coin);
  if (assetIndex === -1) {
    throw new ExecutionError(`Unable to resolve perp asset index for ${coin}.`);
  }
  return assetIndex;
}

export async function readTradeHistory(limit?: number): Promise<readonly ExecutionAuditEntry[]> {
  try {
    const content = await readFile(AUDIT_LOG_FILE_PATH, "utf8");
    const entries: ExecutionAuditEntry[] = [];
    for (const line of content.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        const normalizedEntry = normalizeAuditEntry(parsed);
        if (normalizedEntry !== null) {
          entries.push(normalizedEntry);
        } else {
          console.warn("readTradeHistory: skipping audit line with missing required fields");
        }
      } catch (error) {
        console.warn(`readTradeHistory: skipping malformed audit line — ${toErrorMessage(error)}`);
      }
    }
    if (limit === undefined || limit <= 0) {
      return entries;
    }
    return entries.slice(-limit);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function createProcessLivenessChecker(): ProcessLivenessChecker {
  return (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "EPERM") {
        return true;
      }
      return false;
    }
  };
}

export function isMainnet(): boolean {
  return resolveNetworkTarget() === "mainnet";
}

export type EmergencyCleanupResult = {
  readonly cancelAttempted: boolean;
  readonly cancelledCount: number;
  readonly clearDeadManAttempted: boolean;
  readonly errors: readonly string[];
};

export async function emergencyCancelAndClearDeadMan(
  walletAddress: string,
  privateKey: string,
): Promise<EmergencyCleanupResult> {
  const errors: string[] = [];
  let cancelAttempted = false;
  let cancelledCount = 0;
  let clearDeadManAttempted = false;

  let writeClient: HyperliquidWriteClient;
  try {
    const wallet = privateKeyToAccount(privateKey as `0x${string}`);
    writeClient = createWriteClient({
      isTestnet: resolveNetworkTarget() === "testnet",
      timeoutMs: HYPERLIQUID_CLIENT_TIMEOUT_MS,
      wallet,
    });
  } catch (error) {
    return {
      cancelAttempted: false,
      cancelledCount: 0,
      clearDeadManAttempted: false,
      errors: [`Failed to create write client: ${toErrorMessage(error)}`],
    };
  }

  try {
    cancelAttempted = true;
    const openOrders = await fetchOpenOrders(writeClient, walletAddress);
    const cancelResult = await cancelOrdersWithPartialFailure(openOrders, async (order) => {
      const assetIndex = await resolveAssetIndex(writeClient, order.coin);
      await submitCancelOrder(writeClient, { assetIndex, orderId: order.oid });
    });
    cancelledCount = cancelResult.cancelledCount;
    if (cancelResult.hadFailures) {
      errors.push("Some order cancellations failed.");
    }
  } catch (error) {
    errors.push(`Emergency cancel failed: ${toErrorMessage(error)}`);
  }

  try {
    clearDeadManAttempted = true;
    await clearDeadManCancel(writeClient);
  } catch (error) {
    errors.push(`Emergency clearDeadMan failed: ${toErrorMessage(error)}`);
  }

  return { cancelAttempted, cancelledCount, clearDeadManAttempted, errors };
}

function normalizeAuditEntry(value: unknown): ExecutionAuditEntry | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  if (
    !("slotId" in value) ||
    !("suggestionId" in value) ||
    !("judgmentSummary" in value) ||
    !("actions" in value) ||
    !("exchangeIds" in value) ||
    !("executedAt" in value)
  ) {
    return null;
  }

  const rec = value as Record<string, unknown>;

  return {
    slotId: rec.slotId as string,
    suggestionId: rec.suggestionId as string | null,
    judgmentSummary: rec.judgmentSummary as string,
    actions: rec.actions as ExecutionAuditEntry["actions"],
    exchangeIds: rec.exchangeIds as ExecutionAuditEntry["exchangeIds"],
    executedAt: rec.executedAt as string,
    marketId: "marketId" in value && typeof rec.marketId === "string" ? rec.marketId : "unknown",
    mode: "mode" in value && (rec.mode === "perp" || rec.mode === "spot") ? rec.mode : "perp",
    skipped: "skipped" in value && typeof rec.skipped === "boolean" ? rec.skipped : false,
    skipReason:
      "skipReason" in value && (typeof rec.skipReason === "string" || rec.skipReason === null)
        ? (rec.skipReason as string | null)
        : null,
    retryMetadata:
      "retryMetadata" in value ? (rec.retryMetadata as ExecutionAuditEntry["retryMetadata"]) : null,
    reshapingMetadata:
      "reshapingMetadata" in value
        ? (rec.reshapingMetadata as ExecutionAuditEntry["reshapingMetadata"])
        : null,
  };
}
