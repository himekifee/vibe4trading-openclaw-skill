import { isAddress } from "viem";
import type { HyperliquidWriteClient } from "./hyperliquid-client";

let _orderLock = false;
const _lockQueue: (() => void)[] = [];

export async function withOrderLock<T>(fn: () => Promise<T>): Promise<T> {
  if (_orderLock) {
    await new Promise<void>((resolve) => _lockQueue.push(resolve));
  }
  _orderLock = true;
  try {
    return await fn();
  } finally {
    const next = _lockQueue.shift();
    if (next) {
      next();
    } else {
      _orderLock = false;
    }
  }
}

export function isOrderLockHeld(): boolean {
  return _orderLock;
}

export function getOrderLockQueueLength(): number {
  return _lockQueue.length;
}

export type OrderParams = {
  readonly assetIndex: number;
  readonly isBuy: boolean;
  readonly price: string;
  readonly size: string;
  readonly reduceOnly: boolean;
  readonly orderType: "gtc" | "ioc";
  readonly clientOrderId?: string;
};

export type OrderResult = {
  readonly success: boolean;
  readonly statuses: readonly unknown[];
};

function isEmbeddedOrderErrorStatus(status: unknown): status is { readonly error: string } {
  return (
    typeof status === "object" &&
    status !== null &&
    "error" in status &&
    typeof status.error === "string"
  );
}

export async function placeOrder(
  client: HyperliquidWriteClient,
  params: OrderParams,
): Promise<OrderResult> {
  return withOrderLock(async () => {
    const tif = params.orderType === "gtc" ? "Gtc" : "Ioc";
    const result = await client.exchange.order({
      orders: [
        {
          a: params.assetIndex,
          b: params.isBuy,
          p: params.price,
          s: params.size,
          r: params.reduceOnly,
          t: { limit: { tif } },
          ...(params.clientOrderId ? { c: params.clientOrderId } : {}),
        },
      ],
      grouping: "na",
    });

    const data = result.response?.data;

    if (!data) {
      return { success: false, statuses: [] };
    }

    const statuses = data.statuses ?? [];

    return {
      success: result.status === "ok" && !statuses.some(isEmbeddedOrderErrorStatus),
      statuses,
    };
  });
}

export type CancelParams = {
  readonly assetIndex: number;
  readonly orderId: number;
};

export async function cancelOrder(
  client: HyperliquidWriteClient,
  params: CancelParams,
): Promise<{ success: boolean }> {
  return withOrderLock(async () => {
    const result = await client.exchange.cancel({
      cancels: [{ a: params.assetIndex, o: params.orderId }],
    });
    return { success: result.status === "ok" };
  });
}

export type TransferParams = {
  readonly destination: string;
  readonly amountUsd: string;
};

export async function withdrawToArbitrum(
  client: HyperliquidWriteClient,
  params: TransferParams,
): Promise<{ success: boolean }> {
  return withOrderLock(async () => {
    const result = await client.exchange.withdraw3({
      destination: assertAddress(params.destination, "withdrawToArbitrum"),
      amount: params.amountUsd,
    });
    return { success: result.status === "ok" };
  });
}

export async function transferBetweenPerpAndSpot(
  client: HyperliquidWriteClient,
  amountUsd: string,
  toPerp: boolean,
): Promise<{ success: boolean }> {
  return withOrderLock(async () => {
    const result = await client.exchange.usdClassTransfer({
      amount: amountUsd,
      toPerp,
    });
    return { success: result.status === "ok" };
  });
}

export function resetOrderLock(): void {
  _orderLock = false;
  _lockQueue.length = 0;
}

function assertAddress(value: string, context: string): `0x${string}` {
  if (!isAddress(value, { strict: false })) {
    throw new Error(`${context}: invalid Ethereum address: ${value}`);
  }
  return value as `0x${string}`;
}
