import type { SingleMarketConfig } from "../config/market";

export type NormalizedAsset = {
  /** perp → "ETH", spot → "ETH/USDC" */
  readonly coin: string;
  /** Perp universe index; undefined for spot */
  readonly assetIndex: number | undefined;
  readonly isPerp: boolean;
  readonly quoteCurrency: "USDC";
};

/** marketId `perps:hyperliquid:ETH` → coin "ETH"; `spot:hyperliquid:ETH/USDC` → "ETH/USDC" */
export function normalizeMarketAsset(
  config: SingleMarketConfig,
  perpUniverse?: readonly { name: string }[],
): NormalizedAsset {
  if (config.venue !== "hyperliquid") {
    throw new Error(`Unsupported venue: ${config.venue}. Only "hyperliquid" is supported.`);
  }

  const suffix = config.marketId.split(":").at(-1);
  if (!suffix) {
    throw new Error(`Invalid marketId format: ${config.marketId}`);
  }

  const isPerp = config.mode === "perp";
  const coin = suffix;

  let assetIndex: number | undefined;
  if (isPerp && perpUniverse) {
    const idx = perpUniverse.findIndex((m) => m.name === coin);
    if (idx === -1) {
      throw new Error(`Coin "${coin}" not found in Hyperliquid perp universe.`);
    }
    assetIndex = idx;
  }

  return {
    coin,
    assetIndex,
    isPerp,
    quoteCurrency: "USDC",
  };
}

/**
 * Extract the base asset from a coin string or NormalizedAsset.
 * "ETH" → "ETH"; "ETH/USDC" → "ETH"
 */
export function extractBaseAsset(coinOrAsset: string | NormalizedAsset): string {
  if (typeof coinOrAsset === "string") {
    const slashIdx = coinOrAsset.indexOf("/");
    return slashIdx === -1 ? coinOrAsset : coinOrAsset.slice(0, slashIdx);
  }
  if (coinOrAsset.isPerp) {
    return coinOrAsset.coin;
  }
  const parts = coinOrAsset.coin.split("/");
  return parts[0] ?? coinOrAsset.coin;
}
