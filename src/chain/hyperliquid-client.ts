// SDK choice: plan names "nomeida/hyperliquid" but that package depends on ethers@6
// and duplicates our viem wallet stack. @nktkas/hyperliquid is fully typed, viem-native,
// and covers the identical Hyperliquid REST surface (info + exchange + scheduleCancel).
// Switching SDKs would not change the adapter API below; this is a drop-in substitute.
import type { ExchangeSingleWalletConfig } from "@nktkas/hyperliquid";
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";

import { HYPERLIQUID_CLIENT_TIMEOUT_MS } from "../config/constants";

// Derive the wallet type from the installed SDK contract so this repo
// mirrors ExchangeClient's constructor signature rather than a narrower guess.
export type HyperliquidWallet = ExchangeSingleWalletConfig["wallet"];

export type HyperliquidClientConfig = {
  readonly isTestnet: boolean;
  readonly wallet?: HyperliquidWallet;
  readonly timeoutMs?: number;
};

export type HyperliquidReadClient = {
  readonly info: InfoClient;
  readonly isTestnet: boolean;
};

export type HyperliquidWriteClient = {
  readonly exchange: ExchangeClient;
  readonly info: InfoClient;
  readonly isTestnet: boolean;
};

type ClearinghouseStateResponse = {
  marginSummary: { accountValue: string; totalMarginUsed: string; totalNtlPos: string };
  assetPositions: readonly { position: { coin: string; szi: string; entryPx: string | null } }[];
};

type SpotBalancesResponse = {
  balances: readonly { coin: string; hold: string; total: string }[];
};

type OpenOrdersResponse = readonly { coin: string; side: string; sz: string; oid: number }[];

type PerpMetaResponse = {
  universe: readonly { name: string; szDecimals: number }[];
};

export function assertObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context}: expected object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

export function assertArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context}: expected array, got ${typeof value}`);
  }
  return value;
}

export function assertString(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`${context}: expected string, got ${typeof value}`);
  }
  return value;
}

export function assertNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `${context}: expected finite number, got ${typeof value === "number" ? String(value) : typeof value}`,
    );
  }
  return value;
}

export function assertStringOrNull(value: unknown, context: string): string | null {
  if (value === null) {
    return null;
  }
  return assertString(value, context);
}

function validateSdkResponse<T>(value: unknown, validator: (value: unknown) => T): T {
  return validator(value);
}

function validateClearinghouseStateResponse(value: unknown): ClearinghouseStateResponse {
  const state = assertObject(value, "fetchClearinghouseState response");
  const marginSummary = assertObject(
    state.marginSummary,
    "fetchClearinghouseState response.marginSummary",
  );
  const assetPositions = assertArray(
    state.assetPositions,
    "fetchClearinghouseState response.assetPositions",
  );

  for (let i = 0; i < assetPositions.length; i++) {
    const assetPosition = assertObject(
      assetPositions[i],
      `fetchClearinghouseState response.assetPositions[${i}]`,
    );
    const position = assertObject(
      assetPosition.position,
      `fetchClearinghouseState response.assetPositions[${i}].position`,
    );
    assertString(
      position.coin,
      `fetchClearinghouseState response.assetPositions[${i}].position.coin`,
    );
    assertString(
      position.szi,
      `fetchClearinghouseState response.assetPositions[${i}].position.szi`,
    );
    assertStringOrNull(
      position.entryPx,
      `fetchClearinghouseState response.assetPositions[${i}].position.entryPx`,
    );
  }

  return {
    marginSummary: {
      accountValue: assertString(
        marginSummary.accountValue,
        "fetchClearinghouseState response.marginSummary.accountValue",
      ),
      totalMarginUsed: assertString(
        marginSummary.totalMarginUsed,
        "fetchClearinghouseState response.marginSummary.totalMarginUsed",
      ),
      totalNtlPos: assertString(
        marginSummary.totalNtlPos,
        "fetchClearinghouseState response.marginSummary.totalNtlPos",
      ),
    },
    assetPositions: assetPositions as ClearinghouseStateResponse["assetPositions"],
  };
}

function validateSpotBalancesResponse(value: unknown): SpotBalancesResponse {
  const state = assertObject(value, "fetchSpotBalances response");
  const balances = assertArray(state.balances, "fetchSpotBalances response.balances");

  for (let i = 0; i < balances.length; i++) {
    const balance = assertObject(balances[i], `fetchSpotBalances response.balances[${i}]`);
    assertString(balance.coin, `fetchSpotBalances response.balances[${i}].coin`);
    assertString(balance.hold, `fetchSpotBalances response.balances[${i}].hold`);
    assertString(balance.total, `fetchSpotBalances response.balances[${i}].total`);
  }

  return {
    balances: balances as SpotBalancesResponse["balances"],
  };
}

function validateOpenOrdersResponse(value: unknown): OpenOrdersResponse {
  const orders = assertArray(value, "fetchOpenOrders response");

  for (let i = 0; i < orders.length; i++) {
    const order = assertObject(orders[i], `fetchOpenOrders response[${i}]`);
    assertString(order.coin, `fetchOpenOrders response[${i}].coin`);
    assertString(order.side, `fetchOpenOrders response[${i}].side`);
    assertString(order.sz, `fetchOpenOrders response[${i}].sz`);
    assertNumber(order.oid, `fetchOpenOrders response[${i}].oid`);
  }

  return orders as OpenOrdersResponse;
}

function validatePerpMetaResponse(value: unknown): PerpMetaResponse {
  const meta = assertObject(value, "fetchPerpMeta response");
  const universe = assertArray(meta.universe, "fetchPerpMeta response.universe");

  for (let i = 0; i < universe.length; i++) {
    const universeEntry = assertObject(universe[i], `fetchPerpMeta response.universe[${i}]`);
    assertString(universeEntry.name, `fetchPerpMeta response.universe[${i}].name`);
    assertNumber(universeEntry.szDecimals, `fetchPerpMeta response.universe[${i}].szDecimals`);
  }

  return {
    universe: universe as PerpMetaResponse["universe"],
  };
}

export function createReadClient(config: HyperliquidClientConfig): HyperliquidReadClient {
  const transport = new HttpTransport({
    isTestnet: config.isTestnet,
    timeout: config.timeoutMs ?? HYPERLIQUID_CLIENT_TIMEOUT_MS,
  });

  return {
    info: new InfoClient({ transport }),
    isTestnet: config.isTestnet,
  };
}

export function createWriteClient(config: HyperliquidClientConfig): HyperliquidWriteClient {
  if (!config.wallet) {
    throw new Error("Wallet is required for write operations.");
  }

  const transport = new HttpTransport({
    isTestnet: config.isTestnet,
    timeout: config.timeoutMs ?? HYPERLIQUID_CLIENT_TIMEOUT_MS,
  });

  return {
    exchange: new ExchangeClient({ transport, wallet: config.wallet }),
    info: new InfoClient({ transport }),
    isTestnet: config.isTestnet,
  };
}

export async function fetchAllMids(client: HyperliquidReadClient): Promise<Record<string, string>> {
  return client.info.allMids();
}

export async function fetchClearinghouseState(
  client: HyperliquidReadClient,
  userAddress: string,
): Promise<ClearinghouseStateResponse> {
  const state = await client.info.clearinghouseState({
    user: userAddress as `0x${string}`,
  });
  return validateSdkResponse(state, validateClearinghouseStateResponse);
}

export async function fetchSpotBalances(
  client: HyperliquidReadClient,
  userAddress: string,
): Promise<SpotBalancesResponse> {
  const state = await client.info.spotClearinghouseState({
    user: userAddress as `0x${string}`,
  });
  return validateSdkResponse(state, validateSpotBalancesResponse);
}

export async function fetchOpenOrders(
  client: HyperliquidReadClient,
  userAddress: string,
): Promise<OpenOrdersResponse> {
  const orders = await client.info.openOrders({
    user: userAddress as `0x${string}`,
  });
  return validateSdkResponse(orders, validateOpenOrdersResponse);
}

export async function fetchPerpMeta(client: HyperliquidReadClient): Promise<PerpMetaResponse> {
  const meta = await client.info.meta();
  return validateSdkResponse(meta, validatePerpMetaResponse);
}
