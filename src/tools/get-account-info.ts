import {
  createArbitrumClient,
  createReadClient,
  fetchClearinghouseState,
  fetchOpenOrders,
  fetchSpotBalances,
  getEthBalance,
  getUsdcBalance,
  getUsdtBalance,
} from "../chain";
import type { HyperliquidReadClient } from "../chain";
import { HYPERLIQUID_CLIENT_TIMEOUT_MS } from "../config/constants";
import { StateReadError } from "../daemon/runtime-state-file";
import { readRuntimeStateFile } from "../daemon/runtime-state-file";
import { resolveNetworkTarget } from "../daemon/types";
import { buildAccountInfoBootstrapGuidance } from "./bootstrap-guidance";
import type { RuntimeState } from "../state";

/**
 * Structured account information returned by get_account_info.
 *
 * All monetary values are formatted decimal strings (e.g. "50.123456" for USDC,
 * "0.0042" for ETH). Null values indicate the corresponding RPC call failed
 * rather than returning a zero balance — callers should treat null as
 * "unavailable" and fall back to the non-null fields that succeeded.
 */
export type AccountInfoResult = {
  readonly walletAddress: string;
  readonly network: "mainnet" | "testnet";

  readonly arbitrum: {
    readonly usdc: string | null;
    readonly usdt: string | null;
    readonly eth: string | null;
    readonly ethWei: string | null;
  };

  readonly hyperliquid: {
    readonly accountValue: string | null;
    readonly totalMarginUsed: string | null;
    readonly totalNtlPos: string | null;
    readonly positions: readonly {
      readonly coin: string;
      readonly size: string;
      readonly entryPrice: string | null;
    }[];
    readonly spotBalances: readonly {
      readonly coin: string;
      readonly total: string;
      readonly hold: string;
    }[];
    readonly openOrders: readonly {
      readonly coin: string;
      readonly side: string;
      readonly size: string;
      readonly orderId: number;
    }[];
  };
};

export async function get_account_info(): Promise<AccountInfoResult> {
  let state: RuntimeState;
  try {
    state = await readRuntimeStateFile();
  } catch (error) {
    if (error instanceof StateReadError) {
      return buildAccountInfoBootstrapGuidance() as unknown as AccountInfoResult;
    }
    throw error;
  }

  const network = resolveNetworkTarget();
  const walletAddress = state.wallet.address;

  const arbitrumClient = createArbitrumClient();
  const hlReadClient = createReadClient({
    isTestnet: network === "testnet",
    timeoutMs: HYPERLIQUID_CLIENT_TIMEOUT_MS,
  });

  const [arbitrumResult, hlClearingResult, hlSpotResult, hlOrdersResult] = await Promise.all([
    fetchArbitrumBalances(arbitrumClient, walletAddress),
    fetchClearinghouse(hlReadClient, walletAddress),
    fetchSpot(hlReadClient, walletAddress),
    fetchOrders(hlReadClient, walletAddress),
  ]);

  return {
    walletAddress,
    network,
    arbitrum: arbitrumResult,
    hyperliquid: {
      accountValue: hlClearingResult.accountValue,
      totalMarginUsed: hlClearingResult.totalMarginUsed,
      totalNtlPos: hlClearingResult.totalNtlPos,
      positions: hlClearingResult.positions,
      spotBalances: hlSpotResult,
      openOrders: hlOrdersResult,
    },
  };
}

async function fetchArbitrumBalances(
  client: ReturnType<typeof createArbitrumClient>,
  address: string,
): Promise<AccountInfoResult["arbitrum"]> {
  try {
    const [usdc, usdt, eth] = await Promise.all([
      getUsdcBalance(client, address),
      getUsdtBalance(client, address),
      getEthBalance(client, address),
    ]);
    return {
      usdc: usdc.formatted,
      usdt: usdt.formatted,
      eth: eth.formatted,
      ethWei: String(eth.wei),
    };
  } catch (error) {
    console.warn(
      `get_account_info: Arbitrum balance fetch failed — ${error instanceof Error ? error.message : String(error)}`,
    );
    return { usdc: null, usdt: null, eth: null, ethWei: null };
  }
}

async function fetchClearinghouse(
  client: HyperliquidReadClient,
  address: string,
): Promise<{
  accountValue: string | null;
  totalMarginUsed: string | null;
  totalNtlPos: string | null;
  positions: AccountInfoResult["hyperliquid"]["positions"];
}> {
  try {
    const state = await fetchClearinghouseState(client, address);
    return {
      accountValue: state.marginSummary.accountValue,
      totalMarginUsed: state.marginSummary.totalMarginUsed,
      totalNtlPos: state.marginSummary.totalNtlPos,
      positions: state.assetPositions.map((entry) => ({
        coin: entry.position.coin,
        size: entry.position.szi,
        entryPrice: entry.position.entryPx,
      })),
    };
  } catch (error) {
    console.warn(
      `get_account_info: Hyperliquid clearinghouse fetch failed — ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      accountValue: null,
      totalMarginUsed: null,
      totalNtlPos: null,
      positions: [],
    };
  }
}

async function fetchSpot(
  client: HyperliquidReadClient,
  address: string,
): Promise<AccountInfoResult["hyperliquid"]["spotBalances"]> {
  try {
    const state = await fetchSpotBalances(client, address);
    return state.balances.map((b) => ({
      coin: b.coin,
      total: b.total,
      hold: b.hold,
    }));
  } catch (error) {
    console.warn(
      `get_account_info: Hyperliquid spot balances fetch failed — ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

async function fetchOrders(
  client: HyperliquidReadClient,
  address: string,
): Promise<AccountInfoResult["hyperliquid"]["openOrders"]> {
  try {
    const orders = await fetchOpenOrders(client, address);
    return orders.map((o) => ({
      coin: o.coin,
      side: o.side,
      size: o.sz,
      orderId: o.oid,
    }));
  } catch (error) {
    console.warn(
      `get_account_info: Hyperliquid open orders fetch failed — ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}
