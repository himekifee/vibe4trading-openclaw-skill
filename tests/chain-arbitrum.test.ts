import { arbitrum } from "viem/chains";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSendTransaction, mockMnemonicToAccount } = vi.hoisted(() => ({
  mockSendTransaction: vi.fn<(...args: unknown[]) => Promise<string>>(),
  mockMnemonicToAccount: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createWalletClient: vi.fn(() => ({ sendTransaction: mockSendTransaction })),
  };
});

vi.mock("viem/accounts", () => ({
  mnemonicToAccount: mockMnemonicToAccount,
}));

import { TransactionReceiptNotFoundError, createWalletClient } from "viem";
import {
  ARBITRUM_USDC_ADDRESS,
  type ArbitrumClient,
  HYPERLIQUID_BRIDGE_ADDRESS,
  confirmBridgeTransfer,
  encodeBridgeTransferData,
  submitBridgeTransfer,
} from "../src/chain/arbitrum-client";

describe("Arbitrum client constants", () => {
  it("USDC address is valid Arbitrum USDC", () => {
    expect(ARBITRUM_USDC_ADDRESS).toBe("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
  });

  it("bridge address matches plan constant (lowercased for runtime safety)", () => {
    expect(HYPERLIQUID_BRIDGE_ADDRESS).toBe("0x2df1c51e09aecf9cacb7bc98cb1742757f163df7");
  });
});

describe("encodeBridgeTransferData", () => {
  it("encodes a USDC transfer to the bridge", () => {
    const result = encodeBridgeTransferData("10");
    expect(result.to).toBe(ARBITRUM_USDC_ADDRESS);
    expect(result.value).toBe(0n);
    expect(result.data).toMatch(/^0x/);
    expect(result.data.length).toBeGreaterThan(10);
  });

  it("encodes fractional USDC amounts", () => {
    const result = encodeBridgeTransferData("5.01");
    expect(result.to).toBe(ARBITRUM_USDC_ADDRESS);
    expect(result.data).toMatch(/^0x/);
  });
});

describe("submitBridgeTransfer", () => {
  const TEST_MNEMONIC = "test test test test test test test test test test test junk";
  const TEST_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
  const TEST_AMOUNT = "100";
  const FAKE_TX_HASH = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const FAKE_ACCOUNT = { address: "0xFAKEACCOUNT" } as const;
  const CUSTOM_RPC = "https://custom-arb-rpc.example.com";

  function makeMockClient(rpcUrl?: string): ArbitrumClient {
    return {
      publicClient: {} as ArbitrumClient["publicClient"],
      rpcUrl: rpcUrl ?? CUSTOM_RPC,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockMnemonicToAccount.mockReturnValue(FAKE_ACCOUNT);
    mockSendTransaction.mockResolvedValue(FAKE_TX_HASH);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("derives account from mnemonic via mnemonicToAccount", async () => {
    const client = makeMockClient();
    await submitBridgeTransfer(client, TEST_MNEMONIC, TEST_ADDRESS, TEST_AMOUNT);
    expect(mockMnemonicToAccount).toHaveBeenCalledOnce();
    expect(mockMnemonicToAccount).toHaveBeenCalledWith(TEST_MNEMONIC);
  });

  it("creates wallet client targeting Arbitrum chain with the public client RPC URL", async () => {
    const client = makeMockClient(CUSTOM_RPC);
    await submitBridgeTransfer(client, TEST_MNEMONIC, TEST_ADDRESS, TEST_AMOUNT);

    const mockCreateWallet = createWalletClient as unknown as MockInstance;
    expect(mockCreateWallet).toHaveBeenCalledOnce();

    const callArg = (mockCreateWallet.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(callArg.account).toBe(FAKE_ACCOUNT);
    expect(callArg.chain).toBe(arbitrum);
  });

  it("sends transaction with correct bridge contract address, encoded data, and zero value", async () => {
    const client = makeMockClient();
    await submitBridgeTransfer(client, TEST_MNEMONIC, TEST_ADDRESS, TEST_AMOUNT);

    expect(mockSendTransaction).toHaveBeenCalledOnce();

    const firstCall = mockSendTransaction.mock.calls[0] as unknown[];
    const txArg = firstCall[0] as {
      to: string;
      data: string;
      value: bigint;
    };

    expect(txArg.to).toBe(ARBITRUM_USDC_ADDRESS);
    expect(txArg.data).toMatch(/^0x/);
    expect(txArg.data.length).toBeGreaterThan(10);
    expect(txArg.value).toBe(0n);

    const expectedData = encodeBridgeTransferData(TEST_AMOUNT);
    expect(txArg.data).toBe(expectedData.data);
  });

  it("returns the transaction hash from sendTransaction on success", async () => {
    const client = makeMockClient();
    const result = await submitBridgeTransfer(client, TEST_MNEMONIC, TEST_ADDRESS, TEST_AMOUNT);
    expect(result).toEqual({ txHash: FAKE_TX_HASH });
  });

  it("propagates RPC errors from sendTransaction", async () => {
    const rpcError = new Error("RPC error: insufficient funds for gas");
    mockSendTransaction.mockRejectedValueOnce(rpcError);

    const client = makeMockClient();
    await expect(
      submitBridgeTransfer(client, TEST_MNEMONIC, TEST_ADDRESS, TEST_AMOUNT),
    ).rejects.toThrow("insufficient funds for gas");
  });

  it("uses default Arbitrum RPC when client was created without custom URL", async () => {
    const clientDefaultRpc: ArbitrumClient = {
      publicClient: {} as ArbitrumClient["publicClient"],
      rpcUrl: "https://arb1.arbitrum.io/rpc",
    };

    await submitBridgeTransfer(clientDefaultRpc, TEST_MNEMONIC, TEST_ADDRESS, TEST_AMOUNT);

    const mockCreateWallet = createWalletClient as unknown as MockInstance;
    expect(mockCreateWallet).toHaveBeenCalledOnce();
    expect(mockSendTransaction).toHaveBeenCalledOnce();
  });
});

describe("confirmBridgeTransfer", () => {
  const VALID_HASH = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const VALID_HASH_2 = "0xabc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1";

  it("returns pending when publicClient throws TransactionReceiptNotFoundError", async () => {
    const mockClient = {
      publicClient: {
        getTransactionReceipt: () => {
          throw new TransactionReceiptNotFoundError({ hash: VALID_HASH as `0x${string}` });
        },
      },
    } as never;
    const result = await confirmBridgeTransfer(mockClient, VALID_HASH);
    expect(result.status).toBe("pending");
  });

  it("returns unknown when publicClient throws a generic RPC error", async () => {
    const mockClient = {
      publicClient: {
        getTransactionReceipt: () => {
          throw new Error("RPC timeout: connection refused");
        },
      },
    } as never;
    const result = await confirmBridgeTransfer(mockClient, VALID_HASH);
    expect(result.status).toBe("unknown");
    if (result.status === "unknown") {
      expect(result.reason).toContain("RPC timeout");
    }
  });

  it("returns confirmed when receipt status is success", async () => {
    const mockClient = {
      publicClient: {
        getTransactionReceipt: () => Promise.resolve({ status: "success" }),
      },
    } as never;
    const result = await confirmBridgeTransfer(mockClient, VALID_HASH_2);
    expect(result.status).toBe("confirmed");
  });

  it("returns failed when receipt status is reverted", async () => {
    const mockClient = {
      publicClient: {
        getTransactionReceipt: () => Promise.resolve({ status: "reverted" }),
      },
    } as never;
    const result = await confirmBridgeTransfer(mockClient, VALID_HASH_2);
    expect(result.status).toBe("failed");
  });

  it("returns unknown with reason when a non-Error value is thrown", async () => {
    const mockClient = {
      publicClient: {
        getTransactionReceipt: () => {
          throw "socket hangup";
        },
      },
    } as never;
    const result = await confirmBridgeTransfer(mockClient, VALID_HASH);
    expect(result.status).toBe("unknown");
    if (result.status === "unknown") {
      expect(result.reason).toBe("Unknown RPC/transport error");
    }
  });
});
