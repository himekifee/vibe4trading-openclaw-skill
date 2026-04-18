import { describe, expect, it, vi } from "vitest";

import type { ArbitrumClient } from "../src/chain/arbitrum-client";
import {
  buildUsdtToUsdcExactInputSingleParams,
  buildUsdtToUsdcQuoteParams,
  computeUsdtToUsdcAmountOutMinimum,
  convertUsdtToUsdc,
  preflightUsdtToUsdcConversion,
  quoteUsdtToUsdcExactInput,
} from "../src/chain/usdt-usdc-conversion";
import {
  ARBITRUM_UNISWAP_QUOTER_V2_ADDRESS,
  ARBITRUM_UNISWAP_SWAP_ROUTER_02_ADDRESS,
  ARBITRUM_USDC_ADDRESS,
  ARBITRUM_USDT_ADDRESS,
  ARBITRUM_USDT_USDC_POOL_FEE,
} from "../src/config/constants";

describe("USDT→USDC conversion constants", () => {
  it("locks canonical Arbitrum router, quoter, token, and fee constants", () => {
    expect(ARBITRUM_UNISWAP_SWAP_ROUTER_02_ADDRESS).toBe(
      "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    );
    expect(ARBITRUM_UNISWAP_QUOTER_V2_ADDRESS).toBe("0x61fFE014bA17989E743c5F6cB21bF9697530B21e");
    expect(ARBITRUM_USDT_ADDRESS).toBe("0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9");
    expect(ARBITRUM_USDC_ADDRESS).toBe("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
    expect(ARBITRUM_USDT_USDC_POOL_FEE).toBe(100);
  });
});

describe("USDT→USDC quote helpers", () => {
  it("builds canonical quote params and slippage minimum", () => {
    const quoteParams = buildUsdtToUsdcQuoteParams(12_345_678n);
    expect(quoteParams).toEqual({
      tokenIn: ARBITRUM_USDT_ADDRESS,
      tokenOut: ARBITRUM_USDC_ADDRESS,
      amountIn: 12_345_678n,
      fee: 100,
      sqrtPriceLimitX96: 0n,
    });

    expect(computeUsdtToUsdcAmountOutMinimum(10_000_000n)).toBe(9_990_000n);
    expect(computeUsdtToUsdcAmountOutMinimum(12_345_678n)).toBe(12_333_332n);
  });

  it("builds exactInputSingle params without inventing a deadline", () => {
    expect(
      buildUsdtToUsdcExactInputSingleParams({
        recipient: "0x1234567890abcdef1234567890abcdef12345678",
        amountInRaw: 10_000_000n,
        quotedAmountOutRaw: 9_999_900n,
      }),
    ).toEqual({
      tokenIn: ARBITRUM_USDT_ADDRESS,
      tokenOut: ARBITRUM_USDC_ADDRESS,
      fee: 100,
      recipient: "0x1234567890abcdef1234567890abcdef12345678",
      amountIn: 10_000_000n,
      amountOutMinimum: 9_989_900n,
      sqrtPriceLimitX96: 0n,
    });
  });

  it("quotes exact input through QuoterV2 deterministically", async () => {
    const readContract = vi.fn().mockResolvedValue([9_999_900n, 0n, 0, 210_000n] as const);
    const client = {
      publicClient: {
        readContract,
      },
    } as unknown as ArbitrumClient;

    const result = await quoteUsdtToUsdcExactInput(client, 10_000_000n);

    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: ARBITRUM_UNISWAP_QUOTER_V2_ADDRESS,
        functionName: "quoteExactInputSingle",
        args: [
          {
            tokenIn: ARBITRUM_USDT_ADDRESS,
            tokenOut: ARBITRUM_USDC_ADDRESS,
            amountIn: 10_000_000n,
            fee: 100,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }),
    );
    expect(result.quotedAmountOutRaw).toBe(9_999_900n);
    expect(result.amountOutMinimumRaw).toBe(9_989_900n);
  });
});

describe("USDT→USDC preflight and execution", () => {
  it("fails preflight when slippage minimum cannot satisfy required USDC shortfall", async () => {
    const result = await preflightUsdtToUsdcConversion(
      {
        getUsdtBalance: vi.fn().mockResolvedValue(15_000_000n),
        quoteExactInputSingle: vi.fn().mockResolvedValue(14_990_000n),
      },
      {
        walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
        amountInRaw: 15_000_000n,
        minimumRequiredAmountOutRaw: 15_000_000n,
      },
    );

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.failure.code).toBe("quoted_output_below_required");
      expect(result.failure.message).toContain("Slippage-protected USDC minimum");
    }
  });

  it("performs approve(0), approve(amount), then exactInputSingle swap", async () => {
    const order: string[] = [];
    const sendUsdtApprove = vi.fn().mockImplementation(async (_spender: string, amount: bigint) => {
      order.push(`approve:${amount}`);
      return amount === 0n ? "0xapprove-reset" : "0xapprove-amount";
    });
    const waitForTransactionReceipt = vi.fn().mockImplementation(async (txHash: string) => {
      order.push(`receipt:${txHash}`);
      return { status: "success" as const };
    });
    const sendExactInputSingle = vi.fn().mockImplementation(async () => {
      order.push("swap");
      return "0xswap";
    });

    const result = await convertUsdtToUsdc(
      {
        getUsdtBalance: vi.fn().mockResolvedValue(10_000_000n),
        quoteExactInputSingle: vi.fn().mockResolvedValue(9_999_900n),
        sendUsdtApprove,
        sendExactInputSingle,
        waitForTransactionReceipt,
      },
      {
        walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
        recipientAddress: "0x1234567890abcdef1234567890abcdef12345678",
        amountInRaw: 10_000_000n,
        minimumRequiredAmountOutRaw: 9_989_900n,
      },
    );

    expect(result.kind).toBe("converted");
    expect(sendUsdtApprove).toHaveBeenNthCalledWith(1, ARBITRUM_UNISWAP_SWAP_ROUTER_02_ADDRESS, 0n);
    expect(sendUsdtApprove).toHaveBeenNthCalledWith(
      2,
      ARBITRUM_UNISWAP_SWAP_ROUTER_02_ADDRESS,
      10_000_000n,
    );
    expect(sendExactInputSingle).toHaveBeenCalledWith({
      tokenIn: ARBITRUM_USDT_ADDRESS,
      tokenOut: ARBITRUM_USDC_ADDRESS,
      fee: 100,
      recipient: "0x1234567890abcdef1234567890abcdef12345678",
      amountIn: 10_000_000n,
      amountOutMinimum: 9_989_900n,
      sqrtPriceLimitX96: 0n,
    });
    expect(order).toEqual([
      "approve:0",
      "receipt:0xapprove-reset",
      "approve:10000000",
      "receipt:0xapprove-amount",
      "swap",
      "receipt:0xswap",
    ]);
  });

  it("returns operator-visible approval-reset failure details", async () => {
    const result = await convertUsdtToUsdc(
      {
        getUsdtBalance: vi.fn().mockResolvedValue(10_000_000n),
        quoteExactInputSingle: vi.fn().mockResolvedValue(10_000_000n),
        sendUsdtApprove: vi.fn().mockRejectedValue(new Error("replacement fee too low")),
        sendExactInputSingle: vi.fn(),
        waitForTransactionReceipt: vi.fn(),
      },
      {
        walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
        recipientAddress: "0x1234567890abcdef1234567890abcdef12345678",
        amountInRaw: 10_000_000n,
        minimumRequiredAmountOutRaw: 9_990_000n,
      },
    );

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.failure.code).toBe("approval_reset_failed");
      expect(result.failure.message).toContain("replacement fee too low");
    }
  });
});
