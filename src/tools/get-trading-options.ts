import { readAgentMdCache } from "../v4t/agent-md";

export async function get_trading_options() {
  const cache = await readAgentMdCache();

  if (cache === null) {
    return {
      available: false,
      reason: "agent-md-cache-missing",
      message:
        "No agents.md cache found. Trading options are unavailable until agents.md is fetched by a cache-refreshing surface such as get_tick_context or execute_tick.",
      models: [],
      strategies: [],
      pairs: [],
      recommended: null,
      agentMdVersion: null,
      agentMdFetchedAt: null,
    };
  }

  if (cache.tradingOptions === null) {
    return {
      available: false,
      reason: "trading-options-missing",
      message:
        "Agent.md cache exists but contains no trading options catalog. The upstream agents.md may be missing the required # Trading Options section.",
      models: [],
      strategies: [],
      pairs: [],
      recommended: null,
      agentMdVersion: cache.version,
      agentMdFetchedAt: cache.fetchedAt,
    };
  }

  return {
    available: true,
    reason: null,
    message: null,
    models: [...cache.tradingOptions.models],
    strategies: [...cache.tradingOptions.strategies],
    pairs: cache.tradingOptions.pairs.map((pair) => ({
      symbol: pair.symbol,
      marketId: pair.marketId,
      venue: pair.venue,
      mode: pair.mode,
    })),
    recommended:
      cache.tradingOptions.recommended === null
        ? null
        : {
            pair: cache.tradingOptions.recommended.pair,
            strategy: cache.tradingOptions.recommended.strategy,
            model: cache.tradingOptions.recommended.model,
          },
    agentMdVersion: cache.version,
    agentMdFetchedAt: cache.fetchedAt,
  };
}
