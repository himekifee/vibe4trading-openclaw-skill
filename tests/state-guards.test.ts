import { describe, expect, it } from "vitest";

import { assertMarketConfigChangeAllowed, replaceMarketConfig } from "../src/state/guards";
import { createRuntimeState } from "../src/state/runtime-state";

function stateWithExposure(hasOpenPosition: boolean, hasPendingOrder: boolean) {
  return createRuntimeState({
    wallet: {
      address: "0x1234567890abcdef1234567890ABCDEF12345678",
      privateKey: `0x${"ab".repeat(32)}`,
    },
    market: {
      venue: "hyperliquid",
      mode: "perp",
      marketId: "perps:hyperliquid:BTC-PERP",
      symbol: "BTC-PERP",
    },
    exchangeActivity: { hasOpenPosition, hasPendingOrder },
  });
}

const NEXT_MARKET = {
  venue: "hyperliquid",
  mode: "perp",
  marketId: "perps:hyperliquid:ETH-PERP",
  symbol: "ETH-PERP",
};

describe("assertMarketConfigChangeAllowed", () => {
  it("allows when no exposure (hasOpenPosition=false, hasPendingOrder=false)", () => {
    expect(() => assertMarketConfigChangeAllowed(stateWithExposure(false, false))).not.toThrow();
  });

  it("throws when open position only", () => {
    expect(() => assertMarketConfigChangeAllowed(stateWithExposure(true, false))).toThrowError(
      /cannot change while an open position or pending order exists/i,
    );
  });

  it("throws when pending order only", () => {
    expect(() => assertMarketConfigChangeAllowed(stateWithExposure(false, true))).toThrowError(
      /cannot change while an open position or pending order exists/i,
    );
  });

  it("throws when both open position and pending order", () => {
    expect(() => assertMarketConfigChangeAllowed(stateWithExposure(true, true))).toThrowError(
      /cannot change while an open position or pending order exists/i,
    );
  });
});

describe("replaceMarketConfig", () => {
  it("returns new state with replaced market when no exposure", () => {
    const original = stateWithExposure(false, false);
    const updated = replaceMarketConfig(original, NEXT_MARKET);

    expect(updated.market).toEqual({
      venue: "hyperliquid",
      mode: "perp",
      marketId: "perps:hyperliquid:ETH-PERP",
      symbol: "ETH-PERP",
    });
    expect(updated.wallet).toEqual(original.wallet);
    expect(updated.exchangeActivity).toEqual(original.exchangeActivity);
    expect(updated.daemonStatus).toBe(original.daemonStatus);
  });

  it("throws when blocked by open position", () => {
    expect(() => replaceMarketConfig(stateWithExposure(true, false), NEXT_MARKET)).toThrowError(
      /cannot change while an open position or pending order exists/i,
    );
  });

  it("throws when blocked by pending order", () => {
    expect(() => replaceMarketConfig(stateWithExposure(false, true), NEXT_MARKET)).toThrowError(
      /cannot change while an open position or pending order exists/i,
    );
  });

  it("rejects invalid market config shape", () => {
    expect(() =>
      replaceMarketConfig(stateWithExposure(false, false), { venue: "unknown" }),
    ).toThrow();
  });
});
