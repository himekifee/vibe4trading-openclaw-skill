import { describe, expect, it } from "vitest";
import { extractBaseAsset, normalizeMarketAsset } from "../src/chain/normalization";
import type { SingleMarketConfig } from "../src/config/market";

describe("normalizeMarketAsset", () => {
  const perpConfig: SingleMarketConfig = {
    venue: "hyperliquid",
    mode: "perp",
    marketId: "perps:hyperliquid:ETH",
    symbol: "ETH",
  };

  const spotConfig: SingleMarketConfig = {
    venue: "hyperliquid",
    mode: "spot",
    marketId: "spot:hyperliquid:ETH/USDC",
    symbol: "ETH/USDC",
  };

  it("normalizes perp market without universe", () => {
    const asset = normalizeMarketAsset(perpConfig);
    expect(asset.coin).toBe("ETH");
    expect(asset.isPerp).toBe(true);
    expect(asset.assetIndex).toBeUndefined();
    expect(asset.quoteCurrency).toBe("USDC");
  });

  it("normalizes perp market with universe lookup", () => {
    const universe = [{ name: "BTC" }, { name: "ETH" }, { name: "SOL" }];
    const asset = normalizeMarketAsset(perpConfig, universe);
    expect(asset.coin).toBe("ETH");
    expect(asset.assetIndex).toBe(1);
    expect(asset.isPerp).toBe(true);
  });

  it("throws when perp coin not in universe", () => {
    const universe = [{ name: "BTC" }, { name: "SOL" }];
    expect(() => normalizeMarketAsset(perpConfig, universe)).toThrow(
      'Coin "ETH" not found in Hyperliquid perp universe.',
    );
  });

  it("normalizes spot market", () => {
    const asset = normalizeMarketAsset(spotConfig);
    expect(asset.coin).toBe("ETH/USDC");
    expect(asset.isPerp).toBe(false);
    expect(asset.assetIndex).toBeUndefined();
    expect(asset.quoteCurrency).toBe("USDC");
  });

  it("rejects unsupported venue", () => {
    const badConfig = { ...perpConfig, venue: "binance" as "hyperliquid" };
    expect(() => normalizeMarketAsset(badConfig)).toThrow("Unsupported venue");
  });
});

describe("extractBaseAsset", () => {
  it("returns coin directly for perps", () => {
    expect(
      extractBaseAsset({ coin: "ETH", assetIndex: 1, isPerp: true, quoteCurrency: "USDC" }),
    ).toBe("ETH");
  });

  it("extracts base from spot pair", () => {
    expect(
      extractBaseAsset({
        coin: "ETH/USDC",
        assetIndex: undefined,
        isPerp: false,
        quoteCurrency: "USDC",
      }),
    ).toBe("ETH");
  });
});
