import { afterEach, describe, expect, it, vi } from "vitest";

const { mockReadFile, mockFetchPerpMeta } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockFetchPerpMeta: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
}));

vi.mock("../src/chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chain")>();
  return {
    ...actual,
    fetchPerpMeta: mockFetchPerpMeta,
  };
});

import type { HyperliquidReadClient } from "../src/chain";
import { AUDIT_LOG_FILE_PATH } from "../src/config/paths";
import {
  createProcessLivenessChecker,
  isMainnet,
  readTradeHistory,
  resolveAssetIndex,
} from "../src/daemon/production-deps";

type MockSpotClient = HyperliquidReadClient & {
  info: {
    spotMeta: ReturnType<typeof vi.fn>;
  };
};

const savedHlNetwork = process.env.HL_NETWORK;
const savedHlTestnet = process.env.HL_TESTNET;
const savedOpenClawNetwork = process.env.OPENCLAW_NETWORK;

function restoreEnv(name: "HL_NETWORK" | "HL_TESTNET" | "OPENCLAW_NETWORK", value?: string) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function createMockClient(): MockSpotClient {
  return {
    info: {
      spotMeta: vi.fn(),
    },
    isTestnet: true,
  } as unknown as MockSpotClient;
}

afterEach(() => {
  mockReadFile.mockReset();
  mockFetchPerpMeta.mockReset();
  vi.restoreAllMocks();
  restoreEnv("HL_NETWORK", savedHlNetwork);
  restoreEnv("HL_TESTNET", savedHlTestnet);
  restoreEnv("OPENCLAW_NETWORK", savedOpenClawNetwork);
});

describe("readTradeHistory", () => {
  it("reads NDJSON, skips malformed and incomplete lines, and respects limit", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entry1 = {
      slotId: "2026-03-27T10:30:00.000Z",
      suggestionId: "sugg-1",
      marketId: "perps:hyperliquid:ETH",
      mode: "perp",
      judgmentSummary: "Hold: no-suggestion",
      actions: [],
      exchangeIds: [],
      skipped: false,
      skipReason: null,
      executedAt: "2026-03-27T10:30:05.000Z",
      retryMetadata: null,
      reshapingMetadata: null,
    };
    const entry2 = {
      slotId: "2026-03-27T11:30:00.000Z",
      suggestionId: "sugg-2",
      marketId: "perps:hyperliquid:ETH",
      mode: "perp",
      judgmentSummary: "Buy ETH",
      actions: [],
      exchangeIds: ["order-2"],
      skipped: false,
      skipReason: null,
      executedAt: "2026-03-27T11:30:05.000Z",
      retryMetadata: null,
      reshapingMetadata: null,
    };
    const entry3 = {
      slotId: "2026-03-27T12:30:00.000Z",
      suggestionId: null,
      marketId: "spot:hyperliquid:ETH/USDC",
      mode: "spot",
      judgmentSummary: "Sell BTC",
      actions: [],
      exchangeIds: [null],
      skipped: true,
      skipReason: "order-rejected",
      executedAt: "2026-03-27T12:30:05.000Z",
      retryMetadata: null,
      reshapingMetadata: null,
    };

    mockReadFile.mockResolvedValue(
      [
        JSON.stringify(entry1),
        "{not-json",
        JSON.stringify(entry2),
        JSON.stringify({
          slotId: "missing-executed-at",
          judgmentSummary: "Missing executedAt",
          actions: [],
        }),
        "",
        JSON.stringify({
          slotId: "missing-actions",
          judgmentSummary: "Missing actions",
          executedAt: "2026-03-27T12:29:00.000Z",
        }),
        JSON.stringify(entry3),
      ].join("\n"),
    );

    const result = await readTradeHistory(2);

    expect(mockReadFile).toHaveBeenCalledWith(AUDIT_LOG_FILE_PATH, "utf8");
    expect(result).toEqual([entry2, entry3]);
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it("fills in missing legacy audit retry and reshaping metadata as null", async () => {
    mockReadFile.mockResolvedValue(
      `${JSON.stringify({
        slotId: "2026-03-27T10:30:00.000Z",
        suggestionId: "sugg-legacy",
        judgmentSummary: "Legacy entry",
        actions: [],
        exchangeIds: [],
        executedAt: "2026-03-27T10:30:05.000Z",
      })}\n`,
    );

    await expect(readTradeHistory()).resolves.toEqual([
      {
        slotId: "2026-03-27T10:30:00.000Z",
        suggestionId: "sugg-legacy",
        marketId: "unknown",
        mode: "perp",
        judgmentSummary: "Legacy entry",
        actions: [],
        exchangeIds: [],
        skipped: false,
        skipReason: null,
        executedAt: "2026-03-27T10:30:05.000Z",
        retryMetadata: null,
        reshapingMetadata: null,
      },
    ]);
  });

  it("excludes unknown fields from normalized audit entries", async () => {
    const entryWithExtras = {
      slotId: "2026-03-27T10:30:00.000Z",
      suggestionId: "sugg-extra",
      marketId: "perps:hyperliquid:ETH",
      mode: "perp",
      judgmentSummary: "Hold: no-suggestion",
      actions: [],
      exchangeIds: [],
      skipped: false,
      skipReason: null,
      executedAt: "2026-03-27T10:30:05.000Z",
      retryMetadata: null,
      reshapingMetadata: null,
      _secret: "leaked-credential",
      internalDebug: { foo: "bar" },
      extraNumeric: 42,
    };

    mockReadFile.mockResolvedValue(`${JSON.stringify(entryWithExtras)}\n`);

    const result = await readTradeHistory();

    expect(result).toHaveLength(1);
    const entry = result[0] as Record<string, unknown>;
    expect(entry).not.toHaveProperty("_secret");
    expect(entry).not.toHaveProperty("internalDebug");
    expect(entry).not.toHaveProperty("extraNumeric");
    expect(Object.keys(entry).sort()).toEqual([
      "actions",
      "exchangeIds",
      "executedAt",
      "judgmentSummary",
      "marketId",
      "mode",
      "reshapingMetadata",
      "retryMetadata",
      "skipReason",
      "skipped",
      "slotId",
      "suggestionId",
    ]);
  });

  it("returns an empty array when the audit log does not exist", async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));

    await expect(readTradeHistory()).resolves.toEqual([]);
  });
});

describe("resolveAssetIndex", () => {
  it("uses spotMeta for spot coins", async () => {
    const client = createMockClient();
    client.info.spotMeta.mockResolvedValue({
      universe: [
        { name: "ETH/USDC", index: 3 },
        { name: "PURR/USDC", index: 7 },
      ],
    });

    await expect(resolveAssetIndex(client, "PURR/USDC")).resolves.toBe(7);
    expect(client.info.spotMeta).toHaveBeenCalledOnce();
    expect(mockFetchPerpMeta).not.toHaveBeenCalled();
  });

  it("uses perp metadata for perp coins", async () => {
    const client = createMockClient();
    mockFetchPerpMeta.mockResolvedValue({
      universe: [
        { name: "BTC", szDecimals: 5 },
        { name: "ETH", szDecimals: 4 },
      ],
    });

    await expect(resolveAssetIndex(client, "ETH")).resolves.toBe(1);
    expect(mockFetchPerpMeta).toHaveBeenCalledWith(client);
    expect(client.info.spotMeta).not.toHaveBeenCalled();
  });

  it("throws when a spot coin is unknown", async () => {
    const client = createMockClient();
    client.info.spotMeta.mockResolvedValue({ universe: [{ name: "ETH/USDC", index: 3 }] });

    await expect(resolveAssetIndex(client, "DOGE/USDC")).rejects.toThrow(
      "Unable to resolve spot asset index for DOGE/USDC.",
    );
  });

  it("throws when a perp coin is unknown", async () => {
    const client = createMockClient();
    mockFetchPerpMeta.mockResolvedValue({ universe: [{ name: "BTC", szDecimals: 5 }] });

    await expect(resolveAssetIndex(client, "SOL")).rejects.toThrow(
      "Unable to resolve perp asset index for SOL.",
    );
  });
});

describe("createProcessLivenessChecker", () => {
  it("returns true when process.kill(pid, 0) succeeds", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const isProcessAlive = createProcessLivenessChecker();

    expect(isProcessAlive(1234)).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(1234, 0);
  });

  it("returns false when process.kill(pid, 0) throws", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const isProcessAlive = createProcessLivenessChecker();

    expect(isProcessAlive(1234)).toBe(false);
  });
});

describe("isMainnet", () => {
  it("returns true when the resolved network target is mainnet", () => {
    process.env.OPENCLAW_NETWORK = "mainnet";
    process.env.HL_NETWORK = "mainnet";
    process.env.HL_TESTNET = "";

    expect(isMainnet()).toBe(true);
  });

  it("returns false when the resolved network target is not mainnet", () => {
    process.env.OPENCLAW_NETWORK = "testnet";
    process.env.HL_NETWORK = "testnet";
    process.env.HL_TESTNET = "";

    expect(isMainnet()).toBe(false);
  });
});
