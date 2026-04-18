import {
  SchemaValidationError,
  assertExactKeys,
  expectPlainObject,
  readEnumString,
  readRequiredString,
} from "./validation";

const MARKET_MODES = ["spot", "perp"] as const;
const TRADING_VENUES = ["hyperliquid"] as const;

export type MarketMode = (typeof MARKET_MODES)[number];
export type TradingVenue = (typeof TRADING_VENUES)[number];

export type SingleMarketConfig = {
  readonly venue: TradingVenue;
  readonly mode: MarketMode;
  readonly marketId: string;
  readonly symbol: string;
};

const SPOT_MARKET_ID_PATTERN = /^spot:hyperliquid:[A-Z0-9]+\/[A-Z0-9]+$/;
const PERP_MARKET_ID_PATTERN = /^perps:hyperliquid:[A-Z0-9-]+$/;
const SYMBOL_PATTERN = /^[A-Z0-9]+(?:[/-][A-Z0-9]+)*$/;

export function parseSingleMarketConfig(value: unknown): SingleMarketConfig {
  const context = "SingleMarketConfig";
  const input = expectPlainObject(value, context);
  assertExactKeys(input, ["venue", "mode", "marketId", "symbol"], context);

  const venue = readEnumString(input, "venue", context, TRADING_VENUES);
  const mode = readEnumString(input, "mode", context, MARKET_MODES);
  const marketId = readRequiredString(input, "marketId", context, { minLength: 5 });
  const symbol = readRequiredString(input, "symbol", context, {
    minLength: 3,
    pattern: SYMBOL_PATTERN,
  });

  assertMarketIdMatchesMode(marketId, mode);
  assertMarketIdMatchesSymbol(marketId, symbol);

  return {
    venue,
    mode,
    marketId,
    symbol,
  };
}

function assertMarketIdMatchesMode(marketId: string, mode: MarketMode): void {
  const isValidForMode =
    mode === "spot" ? SPOT_MARKET_ID_PATTERN.test(marketId) : PERP_MARKET_ID_PATTERN.test(marketId);

  if (!isValidForMode) {
    throw new SchemaValidationError(
      `SingleMarketConfig.marketId must match ${mode} market format.`,
    );
  }
}

function assertMarketIdMatchesSymbol(marketId: string, symbol: string): void {
  const marketIdSuffix = marketId.split(":").at(-1);
  if (marketIdSuffix !== symbol) {
    throw new SchemaValidationError(
      "SingleMarketConfig.symbol must match the configured marketId suffix.",
    );
  }
}
