import { updateRuntimeStateFile } from "../daemon/runtime-state-file";
import { parseRuntimeState } from "../state";
import type { TradingSelection } from "../state";
import { assertMarketConfigChangeAllowed } from "../state/guards";
import { readAgentMdCache } from "../v4t/agent-md";

export async function set_trading_selection(args: {
  readonly optionId: string;
}): Promise<{
  readonly selected: boolean;
  readonly tradingSelection: TradingSelection;
  readonly message: string;
}> {
  const { optionId } = args;

  if (typeof optionId !== "string" || optionId.length === 0) {
    throw new Error("optionId must be a non-empty string.");
  }

  const cache = await readAgentMdCache();
  if (cache === null) {
    throw new Error(
      "Cannot set trading selection: no agent.md cache found. Trading options are unavailable until agent.md is fetched.",
    );
  }

  if (cache.tradingOptions === null) {
    throw new Error(
      "Cannot set trading selection: agent.md cache contains no trading options catalog.",
    );
  }

  const matchingOption = cache.tradingOptions.options.find((option) => option.id === optionId);
  if (matchingOption === undefined) {
    const availableIds = cache.tradingOptions.options.map((option) => option.id);
    throw new Error(
      `Invalid optionId "${optionId}". Available options: ${availableIds.join(", ")}.`,
    );
  }

  const selection: TradingSelection = {
    optionId: matchingOption.id,
    market: matchingOption.market,
    modelKey: matchingOption.modelKey,
    strategyKey: matchingOption.strategyKey,
    strategyProfile: matchingOption.strategyProfile,
    recommendationId: null,
    sourceAgentMdVersion: cache.version,
    sourceAgentMdFetchedAt: cache.fetchedAt,
  };

  const updatedState = await updateRuntimeStateFile((state) => {
    // If the market is changing, enforce the exchange-activity guard.
    // Note: exchangeActivity here reflects the last reconciled snapshot.
    // start_trading / execute_tick reconcile before calling us, so this is
    // as fresh as the persisted state allows for a standalone MCP tool call.
    if (state.market.marketId !== matchingOption.market.marketId) {
      assertMarketConfigChangeAllowed(state);
    }

    return parseRuntimeState({
      ...state,
      tradingSelection: selection,
      market: matchingOption.market,
    });
  });

  return {
    selected: true,
    tradingSelection: updatedState.tradingSelection ?? selection,
    message: `Trading selection set to "${matchingOption.label}" (${matchingOption.id}).`,
  };
}
