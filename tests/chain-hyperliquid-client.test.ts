import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

import { mnemonicToAccount } from "viem/accounts";

const {
  mockInfoInstance,
  mockExchangeInstance,
  mockHttpTransportInstance,
  MockHttpTransport,
  MockInfoClient,
  MockExchangeClient,
} = vi.hoisted(() => {
  const mockInfoInstance = {
    allMids: vi.fn(),
    clearinghouseState: vi.fn(),
    spotClearinghouseState: vi.fn(),
    openOrders: vi.fn(),
    meta: vi.fn(),
  };
  const mockExchangeInstance = {};
  const mockHttpTransportInstance = {};
  return {
    mockInfoInstance,
    mockExchangeInstance,
    mockHttpTransportInstance,
    MockHttpTransport: vi.fn(() => mockHttpTransportInstance),
    MockInfoClient: vi.fn(() => mockInfoInstance),
    MockExchangeClient: vi.fn(() => mockExchangeInstance),
  };
});

vi.mock("@nktkas/hyperliquid", () => ({
  HttpTransport: MockHttpTransport,
  InfoClient: MockInfoClient,
  ExchangeClient: MockExchangeClient,
}));

import type { HyperliquidReadClient } from "../src/chain/hyperliquid-client";
import {
  createReadClient,
  createWriteClient,
  fetchAllMids,
  fetchClearinghouseState,
  fetchOpenOrders,
  fetchPerpMeta,
  fetchSpotBalances,
} from "../src/chain/hyperliquid-client";

const FAKE_WALLET = {
  address: "0xFAKE",
} as unknown as Parameters<typeof createWriteClient>[0]["wallet"];

function createMockReadClient(): HyperliquidReadClient {
  return {
    info: {
      allMids: vi.fn(),
      clearinghouseState: vi.fn(),
      spotClearinghouseState: vi.fn(),
      openOrders: vi.fn(),
      meta: vi.fn(),
    } as unknown as HyperliquidReadClient["info"],
    isTestnet: true,
  };
}

type MockInfo = {
  allMids: Mock;
  clearinghouseState: Mock;
  spotClearinghouseState: Mock;
  openOrders: Mock;
  meta: Mock;
};

function asMockInfo(client: HyperliquidReadClient): MockInfo {
  return client.info as unknown as MockInfo;
}

describe("createReadClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates HttpTransport with testnet=true and default timeout", () => {
    createReadClient({ isTestnet: true });

    expect(MockHttpTransport).toHaveBeenCalledWith({
      isTestnet: true,
      timeout: 15_000,
    });
  });

  it("creates HttpTransport with testnet=false and custom timeout", () => {
    createReadClient({ isTestnet: false, timeoutMs: 30_000 });

    expect(MockHttpTransport).toHaveBeenCalledWith({
      isTestnet: false,
      timeout: 30_000,
    });
  });

  it("passes transport to InfoClient", () => {
    createReadClient({ isTestnet: true });

    expect(MockInfoClient).toHaveBeenCalledWith({
      transport: mockHttpTransportInstance,
    });
  });

  it("returns isTestnet matching config", () => {
    const readTrue = createReadClient({ isTestnet: true });
    expect(readTrue.isTestnet).toBe(true);

    vi.clearAllMocks();
    const readFalse = createReadClient({ isTestnet: false });
    expect(readFalse.isTestnet).toBe(false);
  });

  it("returns an info property that is an InfoClient instance", () => {
    const client = createReadClient({ isTestnet: true });
    expect(client.info).toBe(mockInfoInstance);
  });
});

describe("createWriteClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when wallet is not provided", () => {
    expect(() => createWriteClient({ isTestnet: true })).toThrow(
      "Wallet is required for write operations.",
    );
  });

  it("creates HttpTransport with testnet flag and default timeout", () => {
    createWriteClient({ isTestnet: true, wallet: FAKE_WALLET });

    expect(MockHttpTransport).toHaveBeenCalledWith({
      isTestnet: true,
      timeout: 15_000,
    });
  });

  it("creates HttpTransport with custom timeout", () => {
    createWriteClient({ isTestnet: false, wallet: FAKE_WALLET, timeoutMs: 5_000 });

    expect(MockHttpTransport).toHaveBeenCalledWith({
      isTestnet: false,
      timeout: 5_000,
    });
  });

  it("passes transport and wallet to ExchangeClient", () => {
    createWriteClient({ isTestnet: true, wallet: FAKE_WALLET });

    expect(MockExchangeClient).toHaveBeenCalledWith({
      transport: mockHttpTransportInstance,
      wallet: FAKE_WALLET,
    });
  });

  it("passes transport to InfoClient", () => {
    createWriteClient({ isTestnet: true, wallet: FAKE_WALLET });

    expect(MockInfoClient).toHaveBeenCalledWith({
      transport: mockHttpTransportInstance,
    });
  });

  it("returns exchange, info, and isTestnet", () => {
    const client = createWriteClient({ isTestnet: false, wallet: FAKE_WALLET });

    expect(client.exchange).toBe(mockExchangeInstance);
    expect(client.info).toBe(mockInfoInstance);
    expect(client.isTestnet).toBe(false);
  });
});

describe("fetchAllMids", () => {
  let client: HyperliquidReadClient;
  let mock: MockInfo;

  beforeEach(() => {
    client = createMockReadClient();
    mock = asMockInfo(client);
  });

  it("returns mid prices from info.allMids()", async () => {
    const mids = { ETH: "1850.0", BTC: "42000.0" };
    mock.allMids.mockResolvedValue(mids);

    const result = await fetchAllMids(client);
    expect(result).toEqual(mids);
    expect(mock.allMids).toHaveBeenCalledOnce();
  });

  it("propagates SDK error", async () => {
    mock.allMids.mockRejectedValue(new Error("allMids failed"));

    await expect(fetchAllMids(client)).rejects.toThrow("allMids failed");
  });
});

describe("fetchClearinghouseState", () => {
  let client: HyperliquidReadClient;
  let mock: MockInfo;

  beforeEach(() => {
    client = createMockReadClient();
    mock = asMockInfo(client);
  });

  it("passes user address to info.clearinghouseState", async () => {
    const fakeState = {
      marginSummary: { accountValue: "1000", totalMarginUsed: "100", totalNtlPos: "500" },
      assetPositions: [],
    };
    mock.clearinghouseState.mockResolvedValue(fakeState);

    const addr = "0xabcdef1234567890abcdef1234567890abcdef12";
    const result = await fetchClearinghouseState(client, addr);

    expect(mock.clearinghouseState).toHaveBeenCalledWith({ user: addr });
    expect(result.marginSummary.accountValue).toBe("1000");
    expect(result.assetPositions).toEqual([]);
  });

  it("returns asset positions with entry prices", async () => {
    const fakeState = {
      marginSummary: { accountValue: "5000", totalMarginUsed: "200", totalNtlPos: "3000" },
      assetPositions: [
        { position: { coin: "ETH", szi: "1.5", entryPx: "1800.0" } },
        { position: { coin: "BTC", szi: "-0.05", entryPx: null } },
      ],
    };
    mock.clearinghouseState.mockResolvedValue(fakeState);

    const result = await fetchClearinghouseState(
      client,
      "0x1111111111111111111111111111111111111111",
    );
    expect(result.assetPositions).toHaveLength(2);
    expect(result.assetPositions[0].position.coin).toBe("ETH");
    expect(result.assetPositions[1].position.entryPx).toBeNull();
  });

  it("propagates SDK error", async () => {
    mock.clearinghouseState.mockRejectedValue(new Error("clearinghouse failed"));

    await expect(
      fetchClearinghouseState(client, "0x0000000000000000000000000000000000000000"),
    ).rejects.toThrow("clearinghouse failed");
  });
});

describe("fetchSpotBalances", () => {
  let client: HyperliquidReadClient;
  let mock: MockInfo;

  beforeEach(() => {
    client = createMockReadClient();
    mock = asMockInfo(client);
  });

  it("passes user address and returns balances", async () => {
    const fakeState = {
      balances: [
        { coin: "USDC", hold: "0", total: "1000.0" },
        { coin: "ETH", hold: "0.5", total: "2.0" },
      ],
    };
    mock.spotClearinghouseState.mockResolvedValue(fakeState);

    const addr = "0xabcdef1234567890abcdef1234567890abcdef12";
    const result = await fetchSpotBalances(client, addr);

    expect(mock.spotClearinghouseState).toHaveBeenCalledWith({ user: addr });
    expect(result.balances).toHaveLength(2);
    expect(result.balances[0].coin).toBe("USDC");
  });

  it("returns empty balances array", async () => {
    mock.spotClearinghouseState.mockResolvedValue({ balances: [] });

    const result = await fetchSpotBalances(client, "0x0000000000000000000000000000000000000000");
    expect(result.balances).toEqual([]);
  });

  it("propagates SDK error", async () => {
    mock.spotClearinghouseState.mockRejectedValue(new Error("spot failed"));

    await expect(
      fetchSpotBalances(client, "0x0000000000000000000000000000000000000000"),
    ).rejects.toThrow("spot failed");
  });
});

describe("fetchOpenOrders", () => {
  let client: HyperliquidReadClient;
  let mock: MockInfo;

  beforeEach(() => {
    client = createMockReadClient();
    mock = asMockInfo(client);
  });

  it("passes user address and returns open orders", async () => {
    const fakeOrders = [
      { coin: "ETH", side: "B", sz: "1.0", oid: 100 },
      { coin: "BTC", side: "A", sz: "0.01", oid: 200 },
    ];
    mock.openOrders.mockResolvedValue(fakeOrders);

    const addr = "0xabcdef1234567890abcdef1234567890abcdef12";
    const result = await fetchOpenOrders(client, addr);

    expect(mock.openOrders).toHaveBeenCalledWith({ user: addr });
    expect(result).toHaveLength(2);
    expect(result[0].oid).toBe(100);
  });

  it("returns empty array when no orders", async () => {
    mock.openOrders.mockResolvedValue([]);

    const result = await fetchOpenOrders(client, "0x0000000000000000000000000000000000000000");
    expect(result).toEqual([]);
  });

  it("propagates SDK error", async () => {
    mock.openOrders.mockRejectedValue(new Error("openOrders failed"));

    await expect(
      fetchOpenOrders(client, "0x0000000000000000000000000000000000000000"),
    ).rejects.toThrow("openOrders failed");
  });
});

describe("fetchPerpMeta", () => {
  let client: HyperliquidReadClient;
  let mock: MockInfo;

  beforeEach(() => {
    client = createMockReadClient();
    mock = asMockInfo(client);
  });

  it("returns perpetual metadata universe", async () => {
    const fakeMeta = {
      universe: [
        { name: "ETH", szDecimals: 4 },
        { name: "BTC", szDecimals: 5 },
      ],
    };
    mock.meta.mockResolvedValue(fakeMeta);

    const result = await fetchPerpMeta(client);

    expect(mock.meta).toHaveBeenCalledOnce();
    expect(result.universe).toHaveLength(2);
    expect(result.universe[0]).toEqual({ name: "ETH", szDecimals: 4 });
  });

  it("handles empty universe", async () => {
    mock.meta.mockResolvedValue({ universe: [] });

    const result = await fetchPerpMeta(client);
    expect(result.universe).toEqual([]);
  });

  it("propagates SDK error", async () => {
    mock.meta.mockRejectedValue(new Error("meta failed"));

    await expect(fetchPerpMeta(client)).rejects.toThrow("meta failed");
  });
});

describe("createWriteClient SDK wallet contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a real mnemonicToAccount wallet without any cast", () => {
    const wallet = mnemonicToAccount(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );

    const client = createWriteClient({ isTestnet: true, wallet });

    expect(MockExchangeClient).toHaveBeenCalledWith({
      transport: mockHttpTransportInstance,
      wallet,
    });
    expect(client.exchange).toBe(mockExchangeInstance);
    expect(client.isTestnet).toBe(true);
  });
});
