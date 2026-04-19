import { buildOptionId } from "../config/agent-md";
import type { AgentMdStrategyProfile } from "../config/agent-md";
import { updateRuntimeStateFile } from "../daemon/runtime-state-file";
import { parseRuntimeState } from "../state";
import type { TradingSelection } from "../state";
import { assertMarketConfigChangeAllowed } from "../state/guards";
import { readAgentMdCache } from "../v4t/agent-md";

export async function set_trading_selection(args: {
  readonly pair: string;
  readonly strategy: string;
  readonly model: string;
}): Promise<{
  readonly selected: boolean;
  readonly tradingSelection: TradingSelection;
  readonly message: string;
}> {
  const { pair, strategy, model } = args;

  if (typeof pair !== "string" || pair.length === 0) {
    throw new Error("pair must be a non-empty string.");
  }
  if (typeof strategy !== "string" || strategy.length === 0) {
    throw new Error("strategy must be a non-empty string.");
  }
  if (typeof model !== "string" || model.length === 0) {
    throw new Error("model must be a non-empty string.");
  }

  const cache = await readAgentMdCache();
  if (cache === null) {
    throw new Error(
      "Cannot set trading selection: no agents.md cache found. Trading options are unavailable until agents.md is fetched.",
    );
  }

  if (cache.tradingOptions === null) {
    throw new Error(
      "Cannot set trading selection: agents.md cache contains no trading options catalog.",
    );
  }

  const matchingPair = cache.tradingOptions.pairs.find((entry) => entry.symbol === pair);
  if (matchingPair === undefined) {
    const availablePairs = cache.tradingOptions.pairs.map((entry) => entry.symbol).join(", ");
    throw new Error(`Invalid pair "${pair}". Available pairs: ${availablePairs}.`);
  }

  if (!cache.tradingOptions.strategies.includes(strategy as AgentMdStrategyProfile)) {
    const availableStrategies = cache.tradingOptions.strategies.join(", ");
    throw new Error(
      `Invalid strategy "${strategy}". Available strategies: ${availableStrategies}.`,
    );
  }

  if (!cache.tradingOptions.models.includes(model)) {
    const availableModels = cache.tradingOptions.models.join(", ");
    throw new Error(`Invalid model "${model}". Available models: ${availableModels}.`);
  }

  const selection: TradingSelection = {
    optionId: buildOptionId({ pair, strategy, model }),
    market: matchingPair,
    modelKey: model,
    strategyProfile: strategy as AgentMdStrategyProfile,
    recommendationId: null,
    sourceAgentMdVersion: cache.version,
    sourceAgentMdFetchedAt: cache.fetchedAt,
  };

  const updatedState = await updateRuntimeStateFile((state) => {
    // If the market is changing, enforce the exchange-activity guard.
    // Note: exchangeActivity here reflects the last reconciled snapshot.
    // start_trading / execute_tick reconcile before calling us, so this is
    // as fresh as the persisted state allows for a standalone MCP tool call.
    if (state.market.marketId !== matchingPair.marketId) {
      assertMarketConfigChangeAllowed(state);
    }

    return parseRuntimeState({
      ...state,
      tradingSelection: selection,
      market: matchingPair,
    });
  });

  return {
    selected: true,
    tradingSelection: updatedState.tradingSelection ?? selection,
    message: `Trading selection set to ${pair} / ${strategy} / ${model}.`,
  };
}
