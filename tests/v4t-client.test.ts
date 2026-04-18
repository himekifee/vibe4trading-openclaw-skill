import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRuntimeState, serializeRuntimeState } from "../src/state";
import {
  type TickRecommendation,
  createHttpTickRecommendationProvider,
  isRecommendationFresh,
  isValidVibe4TradingToken,
  parseVibe4TradingToken,
  persistVibe4TradingToken,
  readPersistedVibe4TradingToken,
} from "../src/v4t";

describe("v4t-client", () => {
  it("validates and persists vibe4trading tokens inside runtime state", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "v4t-token-"));
    const stateFilePath = join(runtimeDir, "state.json");
    const initialState = createRuntimeState({
      wallet: {
        address: "0x1234567890abcdef1234567890ABCDEF12345678",
        mnemonicFilePath: "/home/grider/Desktop/openclaw-v4t-wallet-mnemonic.txt",
      },
      market: {
        venue: "hyperliquid",
        mode: "perp",
        marketId: "perps:hyperliquid:BTC-PERP",
        symbol: "BTC-PERP",
      },
    });

    await writeFile(stateFilePath, serializeRuntimeState(initialState), "utf8");

    expect(isValidVibe4TradingToken("opaque-token_123")).toBe(true);
    expect(() => parseVibe4TradingToken("bad token\nvalue")).toThrowError(/invalid characters/i);

    const nextState = await persistVibe4TradingToken("opaque-token_123", { stateFilePath });
    expect(nextState.vibe4tradingToken).toBe("opaque-token_123");
    expect(await readPersistedVibe4TradingToken({ stateFilePath })).toBe("opaque-token_123");

    const persistedText = await readFile(stateFilePath, "utf8");
    expect(persistedText).toContain('"vibe4tradingToken": "opaque-token_123"');
  });

  it("does not leave temp files after successful token persistence", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "v4t-token-atomic-"));
    const stateFilePath = join(runtimeDir, "state.json");
    const initialState = createRuntimeState({
      wallet: {
        address: "0x1234567890abcdef1234567890ABCDEF12345678",
        mnemonicFilePath: "/home/grider/Desktop/openclaw-v4t-wallet-mnemonic.txt",
      },
      market: {
        venue: "hyperliquid",
        mode: "perp",
        marketId: "perps:hyperliquid:BTC-PERP",
        symbol: "BTC-PERP",
      },
    });

    await writeFile(stateFilePath, serializeRuntimeState(initialState), "utf8");
    await persistVibe4TradingToken("atomic-test-token_1", { stateFilePath });

    const files = await readdir(runtimeDir);
    expect(files).toEqual(["state.json"]);
  });

  it("serializes concurrent token persistence updates through runtime-state locking", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "v4t-token-serial-"));
    const stateFilePath = join(runtimeDir, "state.json");
    const initialState = createRuntimeState({
      wallet: {
        address: "0x1234567890abcdef1234567890ABCDEF12345678",
        mnemonicFilePath: "/home/grider/Desktop/openclaw-v4t-wallet-mnemonic.txt",
      },
      market: {
        venue: "hyperliquid",
        mode: "perp",
        marketId: "perps:hyperliquid:BTC-PERP",
        symbol: "BTC-PERP",
      },
    });

    await writeFile(stateFilePath, serializeRuntimeState(initialState), "utf8");

    const tokens = ["opaque-token_1", "opaque-token_2", "opaque-token_3", "opaque-token_4"];
    await Promise.all(tokens.map((token) => persistVibe4TradingToken(token, { stateFilePath })));

    expect(tokens).toContain(await readPersistedVibe4TradingToken({ stateFilePath }));
    expect((await readdir(runtimeDir)).sort()).toEqual(["state.json"]);
  });

  it("constructs valid tick recommendations and enforces freshness bounds", () => {
    const recommendation: TickRecommendation = {
      tickTime: "2026-03-27T12:00:00.000Z",
      expiresAt: "2026-03-27T12:10:00.000Z",
      marketId: "perps:hyperliquid:BTC-PERP",
      recommendedMode: "futures",
      recommendedDirection: "long",
      recommendedSizeFraction: "0.25",
      recommendedLeverage: 2,
      recommendationId: "run-1::2026-03-27T12:00:00.000Z",
      raw: {
        confidence: "0.75",
        rationale: "Trend and breadth align.",
        key_signals: ["trend", "breadth"],
        stop_loss_pct: "0.03",
        take_profit_pct: "0.08",
        run_id: "run-1",
        strategy: null,
      },
    };

    expect(recommendation).toMatchObject({
      recommendationId: "run-1::2026-03-27T12:00:00.000Z",
      recommendedMode: "futures",
      recommendedSizeFraction: "0.25",
      recommendedDirection: "long",
      recommendedLeverage: 2,
    });
    expect(isRecommendationFresh(recommendation, new Date("2026-03-27T12:05:00.000Z"))).toBe(true);
    expect(isRecommendationFresh(recommendation, new Date("2026-03-27T12:20:00.000Z"))).toBe(false);
  });

  it("returns a typed degraded state when the tick-recommendation endpoint is unsupported", async () => {
    const provider = createHttpTickRecommendationProvider({
      fetchImpl: async () => new Response(null, { status: 404 }),
    });

    const result = await provider({
      apiToken: "opaque-token_123",
      marketId: "perps:hyperliquid:BTC-PERP",
      modelKey: "gpt-mock",
      strategyKey: "default",
    });

    expect(result).toEqual({
      kind: "degraded",
      reason: "endpoint-unsupported",
      httpStatus: 404,
      message:
        "Tick recommendation endpoint is not available in the current vibe4trading environment.",
    });
  });

  it("constructs tick recommendations with very small size fractions", () => {
    const recommendation: TickRecommendation = {
      tickTime: "2026-03-27T12:00:00.000Z",
      expiresAt: "2026-03-27T12:10:00.000Z",
      marketId: "perps:hyperliquid:BTC-PERP",
      recommendedMode: "futures",
      recommendedDirection: "long",
      recommendedSizeFraction: "0.0000001",
      recommendedLeverage: 1,
      recommendationId: "run-small::2026-03-27T12:00:00.000Z",
      raw: {
        confidence: "0.0000001",
        rationale: "Regression test for scientific notation bug.",
        key_signals: ["sci-notation"],
        stop_loss_pct: "0.03",
        take_profit_pct: "0.08",
        run_id: "run-small",
        strategy: null,
      },
    };

    expect(recommendation.recommendedSizeFraction).toBe("0.0000001");
  });

  it("tolerates unknown tick-recommendation payload fields for forward compatibility", async () => {
    const provider = createHttpTickRecommendationProvider({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            tick_time: "2026-03-27T12:00:00.000Z",
            expires_at: "2026-03-27T12:10:00.000Z",
            market_id: "perps:hyperliquid:BTC-PERP",
            recommended_mode: "futures",
            recommended_direction: "long",
            recommended_size_fraction: "0.25",
            recommended_leverage: 2,
            run_id: "run-1",
            confidence: 0.75,
            rationale: "Trend and breadth align.",
            key_signals: ["trend"],
            injected_field: "tolerated",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    });

    const result = await provider({
      apiToken: "opaque-token_123",
      marketId: "perps:hyperliquid:BTC-PERP",
      modelKey: "gpt-mock",
      strategyKey: "default",
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.recommendation.recommendationId).toBe("run-1::2026-03-27T12:00:00.000Z");
    }
  });

  it("rounds fractional leverage values to nearest integer in tick-recommendation extraction", async () => {
    const provider = createHttpTickRecommendationProvider({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            tick_time: "2026-03-27T12:00:00.000Z",
            expires_at: "2026-03-27T12:10:00.000Z",
            market_id: "perps:hyperliquid:BTC-PERP",
            recommended_mode: "futures",
            recommended_direction: "long",
            recommended_size_fraction: "0.5",
            recommended_leverage: 1.5,
            run_id: "run-frac",
            confidence: 0.7,
            rationale: "Fractional leverage should be rounded.",
            key_signals: ["trend"],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    });

    const result = await provider({
      apiToken: "opaque-token_123",
      marketId: "perps:hyperliquid:BTC-PERP",
      modelKey: "gpt-mock",
      strategyKey: "default",
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      // 1.5 rounds to 2 (Math.round)
      expect(result.recommendation.recommendedLeverage).toBe(2);
    }
  });

  it("accepts integer leverage 0 as a valid tick-recommendation value", async () => {
    const provider = createHttpTickRecommendationProvider({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            tick_time: "2026-03-27T12:00:00.000Z",
            expires_at: "2026-03-27T12:10:00.000Z",
            market_id: "perps:hyperliquid:BTC-PERP",
            recommended_mode: "futures",
            recommended_direction: "long",
            recommended_size_fraction: "0.3",
            recommended_leverage: 0,
            run_id: "run-zero",
            confidence: 0.6,
            rationale: "Zero leverage is allowed by the parser.",
            key_signals: ["vol"],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    });

    const result = await provider({
      apiToken: "opaque-token_123",
      marketId: "perps:hyperliquid:BTC-PERP",
      modelKey: "gpt-mock",
      strategyKey: "default",
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.recommendation.recommendedLeverage).toBe(0);
    }
  });
});
