import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";
import type { HyperliquidWriteClient } from "../src/chain/hyperliquid-client";
import {
  type CancelParams,
  type OrderParams,
  type TransferParams,
  cancelOrder,
  placeOrder,
  resetOrderLock,
  transferBetweenPerpAndSpot,
  withdrawToArbitrum,
} from "../src/chain/order-utils";

type MockExchange = {
  order: Mock;
  cancel: Mock;
  withdraw3: Mock;
  usdClassTransfer: Mock;
};

function createMockClient() {
  return {
    exchange: {
      order: vi.fn(),
      cancel: vi.fn(),
      withdraw3: vi.fn(),
      usdClassTransfer: vi.fn(),
    } as unknown as HyperliquidWriteClient["exchange"] & MockExchange,
    info: {} as HyperliquidWriteClient["info"],
    isTestnet: true,
  } satisfies HyperliquidWriteClient;
}

type MockClient = ReturnType<typeof createMockClient>;

function asMock(client: MockClient): MockExchange {
  return client.exchange as unknown as MockExchange;
}

/** Flush one macrotask turn so a previously-started async call progresses past its first await. */
function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const defaultOrderParams: OrderParams = {
  assetIndex: 3,
  isBuy: true,
  price: "1850.50",
  size: "0.1",
  reduceOnly: false,
  orderType: "gtc",
};

const defaultCancelParams: CancelParams = {
  assetIndex: 3,
  orderId: 123456,
};

const defaultTransferParams: TransferParams = {
  destination: "0xabcdef1234567890abcdef1234567890abcdef12",
  amountUsd: "100.0",
};

describe("placeOrder", () => {
  let client: MockClient;
  let mock: MockExchange;

  beforeEach(() => {
    resetOrderLock();
    client = createMockClient();
    mock = asMock(client);
  });

  it("happy path — maps params to SDK order shape (GTC buy)", async () => {
    mock.order.mockResolvedValue({
      status: "ok",
      response: { data: { statuses: [{ filled: { totalSz: "0.1" } }] } },
    });

    const result = await placeOrder(client, defaultOrderParams);

    expect(result.success).toBe(true);
    expect(result.statuses).toEqual([{ filled: { totalSz: "0.1" } }]);

    expect(mock.order).toHaveBeenCalledWith({
      orders: [
        {
          a: 3,
          b: true,
          p: "1850.50",
          s: "0.1",
          r: false,
          t: { limit: { tif: "Gtc" } },
        },
      ],
      grouping: "na",
    });
  });

  it("maps isBuy=false (sell) and orderType=ioc correctly", async () => {
    mock.order.mockResolvedValue({
      status: "ok",
      response: { data: { statuses: [{ resting: { oid: 99 } }] } },
    });

    const sellIoc: OrderParams = {
      ...defaultOrderParams,
      isBuy: false,
      orderType: "ioc",
    };
    const result = await placeOrder(client, sellIoc);

    expect(result.success).toBe(true);
    expect(mock.order).toHaveBeenCalledWith({
      orders: [
        expect.objectContaining({
          b: false,
          t: { limit: { tif: "Ioc" } },
        }),
      ],
      grouping: "na",
    });
  });

  it("includes clientOrderId as 'c' when provided", async () => {
    mock.order.mockResolvedValue({
      status: "ok",
      response: { data: { statuses: [] } },
    });

    await placeOrder(client, { ...defaultOrderParams, clientOrderId: "myid-1" });

    expect(mock.order).toHaveBeenCalledWith({
      orders: [expect.objectContaining({ c: "myid-1" })],
      grouping: "na",
    });
  });

  it("omits 'c' key when clientOrderId is not provided", async () => {
    mock.order.mockResolvedValue({
      status: "ok",
      response: { data: { statuses: [] } },
    });

    await placeOrder(client, defaultOrderParams);

    const call = mock.order.mock.calls[0][0];
    expect(call.orders[0]).not.toHaveProperty("c");
  });

  it("returns success=false when SDK reports non-ok status", async () => {
    mock.order.mockResolvedValue({
      status: "err",
      response: null,
    });

    const result = await placeOrder(client, defaultOrderParams);

    expect(result.success).toBe(false);
    expect(result.statuses).toEqual([]);
  });

  it("returns success=false when response is null", async () => {
    mock.order.mockResolvedValue({
      status: "ok",
      response: null,
    });

    const result = await placeOrder(client, defaultOrderParams);

    expect(result).toEqual({ success: false, statuses: [] });
  });

  it("returns success=false when response is undefined", async () => {
    mock.order.mockResolvedValue({
      status: "ok",
      response: undefined,
    });

    const result = await placeOrder(client, defaultOrderParams);

    expect(result).toEqual({ success: false, statuses: [] });
  });

  it("returns success=false when response exists but data is absent", async () => {
    mock.order.mockResolvedValue({
      status: "ok",
      response: {},
    });

    const result = await placeOrder(client, defaultOrderParams);

    expect(result).toEqual({ success: false, statuses: [] });
  });

  it("returns success=false when top-level ok contains embedded order error", async () => {
    mock.order.mockResolvedValue({
      status: "ok",
      response: { data: { statuses: [{ error: "Insufficient margin to place order." }] } },
    });

    const result = await placeOrder(client, defaultOrderParams);

    expect(result.success).toBe(false);
    expect(result.statuses).toEqual([{ error: "Insufficient margin to place order." }]);
  });

  it("returns success=false when any embedded status entry is an error", async () => {
    mock.order.mockResolvedValue({
      status: "ok",
      response: {
        data: {
          statuses: [
            { filled: { totalSz: "0.05" } },
            { error: "Order must have minimum value of $10." },
          ],
        },
      },
    });

    const result = await placeOrder(client, defaultOrderParams);

    expect(result.success).toBe(false);
    expect(result.statuses).toEqual([
      { filled: { totalSz: "0.05" } },
      { error: "Order must have minimum value of $10." },
    ]);
  });

  it("extracts statuses even with empty array", async () => {
    mock.order.mockResolvedValue({
      status: "ok",
      response: { data: { statuses: [] } },
    });

    const result = await placeOrder(client, defaultOrderParams);
    expect(result.statuses).toEqual([]);
  });

  it("defaults statuses to [] when response.data is missing", async () => {
    mock.order.mockResolvedValue({
      status: "ok",
      response: {},
    });

    const result = await placeOrder(client, defaultOrderParams);
    expect(result.statuses).toEqual([]);
  });

  it("propagates SDK error to caller", async () => {
    mock.order.mockRejectedValue(new Error("SDK order failed"));

    await expect(placeOrder(client, defaultOrderParams)).rejects.toThrow("SDK order failed");
  });
});

describe("cancelOrder", () => {
  let client: MockClient;
  let mock: MockExchange;

  beforeEach(() => {
    resetOrderLock();
    client = createMockClient();
    mock = asMock(client);
  });

  it("happy path — maps assetIndex and orderId to SDK cancel shape", async () => {
    mock.cancel.mockResolvedValue({ status: "ok" });

    const result = await cancelOrder(client, defaultCancelParams);

    expect(result.success).toBe(true);
    expect(mock.cancel).toHaveBeenCalledWith({
      cancels: [{ a: 3, o: 123456 }],
    });
  });

  it("returns success=false on non-ok status", async () => {
    mock.cancel.mockResolvedValue({ status: "err" });

    const result = await cancelOrder(client, defaultCancelParams);
    expect(result.success).toBe(false);
  });

  it("propagates SDK error to caller", async () => {
    mock.cancel.mockRejectedValue(new Error("cancel failed"));

    await expect(cancelOrder(client, defaultCancelParams)).rejects.toThrow("cancel failed");
  });
});

describe("withdrawToArbitrum", () => {
  let client: MockClient;
  let mock: MockExchange;

  beforeEach(() => {
    resetOrderLock();
    client = createMockClient();
    mock = asMock(client);
  });

  it("happy path — passes destination and amount to withdraw3", async () => {
    mock.withdraw3.mockResolvedValue({ status: "ok" });

    const result = await withdrawToArbitrum(client, defaultTransferParams);

    expect(result.success).toBe(true);
    expect(mock.withdraw3).toHaveBeenCalledWith({
      destination: defaultTransferParams.destination,
      amount: "100.0",
    });
  });

  it("returns success=false on non-ok status", async () => {
    mock.withdraw3.mockResolvedValue({ status: "err" });

    const result = await withdrawToArbitrum(client, defaultTransferParams);
    expect(result.success).toBe(false);
  });

  it("propagates SDK error to caller", async () => {
    mock.withdraw3.mockRejectedValue(new Error("withdraw failed"));

    await expect(withdrawToArbitrum(client, defaultTransferParams)).rejects.toThrow(
      "withdraw failed",
    );
  });
});

describe("transferBetweenPerpAndSpot", () => {
  let client: MockClient;
  let mock: MockExchange;

  beforeEach(() => {
    resetOrderLock();
    client = createMockClient();
    mock = asMock(client);
  });

  it("happy path — transfers to perp", async () => {
    mock.usdClassTransfer.mockResolvedValue({ status: "ok" });

    const result = await transferBetweenPerpAndSpot(client, "50.0", true);

    expect(result.success).toBe(true);
    expect(mock.usdClassTransfer).toHaveBeenCalledWith({
      amount: "50.0",
      toPerp: true,
    });
  });

  it("happy path — transfers to spot (toPerp=false)", async () => {
    mock.usdClassTransfer.mockResolvedValue({ status: "ok" });

    const result = await transferBetweenPerpAndSpot(client, "25.5", false);

    expect(result.success).toBe(true);
    expect(mock.usdClassTransfer).toHaveBeenCalledWith({
      amount: "25.5",
      toPerp: false,
    });
  });

  it("returns success=false on non-ok status", async () => {
    mock.usdClassTransfer.mockResolvedValue({ status: "err" });

    const result = await transferBetweenPerpAndSpot(client, "10.0", true);
    expect(result.success).toBe(false);
  });

  it("propagates SDK error to caller", async () => {
    mock.usdClassTransfer.mockRejectedValue(new Error("transfer failed"));

    await expect(transferBetweenPerpAndSpot(client, "10.0", true)).rejects.toThrow(
      "transfer failed",
    );
  });
});

describe("cross-function serialization via withOrderLock", () => {
  let client: MockClient;
  let mock: MockExchange;

  beforeEach(() => {
    resetOrderLock();
    client = createMockClient();
    mock = asMock(client);
  });

  it("concurrent placeOrder and cancelOrder execute in FIFO order", async () => {
    const executionOrder: string[] = [];

    let resolveOrder: (() => void) | undefined;
    const blockOrder = new Promise<void>((r) => {
      resolveOrder = r;
    });

    mock.order.mockImplementation(async () => {
      executionOrder.push("order-start");
      await blockOrder;
      executionOrder.push("order-end");
      return {
        status: "ok",
        response: { data: { statuses: [] } },
      };
    });

    mock.cancel.mockImplementation(async () => {
      executionOrder.push("cancel");
      return { status: "ok" };
    });

    const p1 = placeOrder(client, defaultOrderParams);
    await flushMacrotask();
    const p2 = cancelOrder(client, defaultCancelParams);

    resolveOrder?.();
    await Promise.all([p1, p2]);

    expect(executionOrder).toEqual(["order-start", "order-end", "cancel"]);
  });

  it("concurrent withdraw and transfer execute in FIFO order", async () => {
    const executionOrder: string[] = [];

    let resolveWithdraw: (() => void) | undefined;
    const blockWithdraw = new Promise<void>((r) => {
      resolveWithdraw = r;
    });

    mock.withdraw3.mockImplementation(async () => {
      executionOrder.push("withdraw-start");
      await blockWithdraw;
      executionOrder.push("withdraw-end");
      return { status: "ok" };
    });

    mock.usdClassTransfer.mockImplementation(async () => {
      executionOrder.push("transfer");
      return { status: "ok" };
    });

    const p1 = withdrawToArbitrum(client, defaultTransferParams);
    await flushMacrotask();
    const p2 = transferBetweenPerpAndSpot(client, "20.0", true);

    resolveWithdraw?.();
    await Promise.all([p1, p2]);

    expect(executionOrder).toEqual(["withdraw-start", "withdraw-end", "transfer"]);
  });
});
