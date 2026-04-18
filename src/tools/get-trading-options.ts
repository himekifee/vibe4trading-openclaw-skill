import { readAgentMdCache } from "../v4t/agent-md";

export async function get_trading_options() {
  const cache = await readAgentMdCache();

  if (cache === null) {
    return {
      available: false,
      reason: "agent-md-cache-missing",
      message:
        "No agent.md cache found. Trading options are unavailable until agent.md is fetched by a cache-refreshing surface such as get_tick_context or execute_tick.",
      options: [],
      recommendedOptionId: null,
      agentMdVersion: null,
      agentMdFetchedAt: null,
    };
  }

  if (cache.tradingOptions === null) {
    return {
      available: false,
      reason: "trading-options-missing",
      message:
        "Agent.md cache exists but contains no trading options catalog. The upstream agent.md may be missing the required # Trading Options section.",
      options: [],
      recommendedOptionId: null,
      agentMdVersion: cache.version,
      agentMdFetchedAt: cache.fetchedAt,
    };
  }

  return {
    available: true,
    reason: null,
    message: null,
    options: cache.tradingOptions.options.map((option) => ({
      id: option.id,
      label: option.label,
      market: option.market,
      modelKey: option.modelKey,
      strategyKey: option.strategyKey,
      strategyProfile: option.strategyProfile,
    })),
    recommendedOptionId: cache.tradingOptions.recommendedOptionId,
    agentMdVersion: cache.version,
    agentMdFetchedAt: cache.fetchedAt,
  };
}
