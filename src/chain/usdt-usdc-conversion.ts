import {
  http,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  isAddress,
  parseUnits,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

import {
  ARBITRUM_UNISWAP_QUOTER_V2_ADDRESS,
  ARBITRUM_UNISWAP_SWAP_ROUTER_02_ADDRESS,
  ARBITRUM_USDC_ADDRESS,
  ARBITRUM_USDT_ADDRESS,
  ARBITRUM_USDT_USDC_AMOUNT_OUT_MINIMUM_BPS,
  ARBITRUM_USDT_USDC_POOL_FEE,
  BASIS_POINTS_DENOMINATOR,
} from "../config/constants";
import type { ArbitrumClient } from "./arbitrum-client";

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertAddress(value: string, context: string): `0x${string}` {
  if (!isAddress(value, { strict: false })) {
    throw new Error(`${context}: invalid Ethereum address: ${value}`);
  }
  return value as `0x${string}`;
}

function assertHash(value: string, context: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${context}: invalid transaction hash: ${value}`);
  }
  return value as `0x${string}`;
}

const STABLECOIN_DECIMALS = 6;

const ERC20_BALANCE_OF_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const ERC20_APPROVE_ABI = [
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const UNISWAP_QUOTER_V2_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        name: "params",
        type: "tuple",
      },
    ],
    name: "quoteExactInputSingle",
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const UNISWAP_SWAP_ROUTER_02_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        name: "params",
        type: "tuple",
      },
    ],
    name: "exactInputSingle",
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
] as const;

export type UsdtToUsdcQuoteParams = {
  readonly tokenIn: typeof ARBITRUM_USDT_ADDRESS;
  readonly tokenOut: typeof ARBITRUM_USDC_ADDRESS;
  readonly amountIn: bigint;
  readonly fee: typeof ARBITRUM_USDT_USDC_POOL_FEE;
  readonly sqrtPriceLimitX96: 0n;
};

export type UsdtToUsdcExactInputSingleParams = {
  readonly tokenIn: typeof ARBITRUM_USDT_ADDRESS;
  readonly tokenOut: typeof ARBITRUM_USDC_ADDRESS;
  readonly fee: typeof ARBITRUM_USDT_USDC_POOL_FEE;
  readonly recipient: `0x${string}`;
  readonly amountIn: bigint;
  readonly amountOutMinimum: bigint;
  readonly sqrtPriceLimitX96: 0n;
};

export type UsdtToUsdcQuote = {
  readonly amountInRaw: bigint;
  readonly quotedAmountOutRaw: bigint;
  readonly amountOutMinimumRaw: bigint;
  readonly params: UsdtToUsdcQuoteParams;
};

const USDT_TO_USDC_CONVERSION_FAILURE_CODES = [
  "balance_check_failed",
  "insufficient_usdt_balance",
  "quote_failed",
  "quoted_output_below_required",
  "approval_reset_failed",
  "approval_reset_reverted",
  "approval_amount_failed",
  "approval_amount_reverted",
  "swap_submission_failed",
  "swap_reverted",
] as const;

export type UsdtToUsdcConversionFailureCode =
  (typeof USDT_TO_USDC_CONVERSION_FAILURE_CODES)[number];

export type UsdtToUsdcConversionFailure = {
  readonly code: UsdtToUsdcConversionFailureCode;
  readonly message: string;
};

export type UsdtToUsdcPreflightResult =
  | {
      readonly kind: "ok";
      readonly walletUsdtBalanceRaw: bigint;
      readonly quote: UsdtToUsdcQuote;
    }
  | {
      readonly kind: "failed";
      readonly failure: UsdtToUsdcConversionFailure;
    };

export type UsdtToUsdcConversionResult =
  | {
      readonly kind: "converted";
      readonly amountInUsdt: string;
      readonly quotedAmountOutUsdc: string;
      readonly amountOutMinimumUsdc: string;
      readonly approvalResetTxHash: string;
      readonly approvalAmountTxHash: string;
      readonly swapTxHash: string;
    }
  | {
      readonly kind: "failed";
      readonly failure: UsdtToUsdcConversionFailure;
    };

export type UsdtToUsdcConversionRequest = {
  readonly walletAddress: string;
  readonly recipientAddress?: string;
  readonly amountUsdt: string;
  readonly minimumRequiredAmountOutUsdc?: string;
};

export type UsdtToUsdcConversionDeps = {
  readonly getUsdtBalance: (address: string) => Promise<bigint>;
  readonly quoteExactInputSingle: (amountInRaw: bigint) => Promise<bigint>;
  readonly sendUsdtApprove: (spender: `0x${string}`, amount: bigint) => Promise<string>;
  readonly sendExactInputSingle: (params: UsdtToUsdcExactInputSingleParams) => Promise<string>;
  readonly waitForTransactionReceipt: (
    txHash: string,
  ) => Promise<{ readonly status: "success" | "reverted" }>;
};

export type ArbitrumUsdtToUsdcConversionExecutorConfig = {
  readonly client: ArbitrumClient;
  readonly readMnemonic: () => Promise<string>;
};

export async function getUsdtBalance(
  client: ArbitrumClient,
  address: string,
): Promise<{ raw: bigint; formatted: string }> {
  const balance = await client.publicClient.readContract({
    address: ARBITRUM_USDT_ADDRESS,
    abi: ERC20_BALANCE_OF_ABI,
    functionName: "balanceOf",
    args: [assertAddress(address, "getUsdtBalance")],
  });

  return { raw: balance, formatted: formatStablecoinAmount(balance) };
}

export function parseStablecoinAmount(value: string): bigint {
  return parseUnits(value, STABLECOIN_DECIMALS);
}

export function formatStablecoinAmount(value: bigint): string {
  return formatUnits(value, STABLECOIN_DECIMALS);
}

export function buildUsdtToUsdcQuoteParams(amountInRaw: bigint): UsdtToUsdcQuoteParams {
  return {
    tokenIn: ARBITRUM_USDT_ADDRESS,
    tokenOut: ARBITRUM_USDC_ADDRESS,
    amountIn: amountInRaw,
    fee: ARBITRUM_USDT_USDC_POOL_FEE,
    sqrtPriceLimitX96: 0n,
  };
}

export function computeUsdtToUsdcAmountOutMinimum(quotedAmountOutRaw: bigint): bigint {
  return (
    (quotedAmountOutRaw * ARBITRUM_USDT_USDC_AMOUNT_OUT_MINIMUM_BPS) / BASIS_POINTS_DENOMINATOR
  );
}

export function buildUsdtToUsdcExactInputSingleParams(input: {
  readonly recipient: string;
  readonly amountInRaw: bigint;
  readonly quotedAmountOutRaw: bigint;
}): UsdtToUsdcExactInputSingleParams {
  return {
    tokenIn: ARBITRUM_USDT_ADDRESS,
    tokenOut: ARBITRUM_USDC_ADDRESS,
    fee: ARBITRUM_USDT_USDC_POOL_FEE,
    recipient: assertAddress(input.recipient, "buildUsdtToUsdcExactInputSingleParams"),
    amountIn: input.amountInRaw,
    amountOutMinimum: computeUsdtToUsdcAmountOutMinimum(input.quotedAmountOutRaw),
    sqrtPriceLimitX96: 0n,
  };
}

export async function quoteUsdtToUsdcExactInput(
  client: ArbitrumClient,
  amountInRaw: bigint,
): Promise<UsdtToUsdcQuote> {
  const params = buildUsdtToUsdcQuoteParams(amountInRaw);
  const quoteResult = (await client.publicClient.readContract({
    address: ARBITRUM_UNISWAP_QUOTER_V2_ADDRESS,
    abi: UNISWAP_QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    args: [params],
  })) as readonly [bigint, bigint, number, bigint];
  const quotedAmountOutRaw = quoteResult[0];

  return {
    amountInRaw,
    quotedAmountOutRaw,
    amountOutMinimumRaw: computeUsdtToUsdcAmountOutMinimum(quotedAmountOutRaw),
    params,
  };
}

export async function preflightUsdtToUsdcConversion(
  deps: Pick<UsdtToUsdcConversionDeps, "getUsdtBalance" | "quoteExactInputSingle">,
  input: {
    readonly walletAddress: string;
    readonly amountInRaw: bigint;
    readonly minimumRequiredAmountOutRaw?: bigint;
  },
): Promise<UsdtToUsdcPreflightResult> {
  let walletUsdtBalanceRaw: bigint;
  try {
    walletUsdtBalanceRaw = await deps.getUsdtBalance(input.walletAddress);
  } catch (error: unknown) {
    return {
      kind: "failed",
      failure: createConversionFailure(
        "balance_check_failed",
        `Unable to read Arbitrum USDT balance before conversion (${toErrorMessage(error)}).`,
      ),
    };
  }

  if (walletUsdtBalanceRaw < input.amountInRaw) {
    return {
      kind: "failed",
      failure: createConversionFailure(
        "insufficient_usdt_balance",
        `Wallet USDT balance ${formatStablecoinAmount(walletUsdtBalanceRaw)} is insufficient for required conversion input ${formatStablecoinAmount(input.amountInRaw)}.`,
      ),
    };
  }

  let quotedAmountOutRaw: bigint;
  try {
    quotedAmountOutRaw = await deps.quoteExactInputSingle(input.amountInRaw);
  } catch (error: unknown) {
    return {
      kind: "failed",
      failure: createConversionFailure(
        "quote_failed",
        `Unable to quote Arbitrum USDT→USDC conversion via Uniswap V3 QuoterV2 (${toErrorMessage(error)}).`,
      ),
    };
  }

  const amountOutMinimumRaw = computeUsdtToUsdcAmountOutMinimum(quotedAmountOutRaw);

  if (
    input.minimumRequiredAmountOutRaw !== undefined &&
    amountOutMinimumRaw < input.minimumRequiredAmountOutRaw
  ) {
    return {
      kind: "failed",
      failure: createConversionFailure(
        "quoted_output_below_required",
        `Slippage-protected USDC minimum ${formatStablecoinAmount(amountOutMinimumRaw)} is below required shortfall ${formatStablecoinAmount(input.minimumRequiredAmountOutRaw)}.`,
      ),
    };
  }

  return {
    kind: "ok",
    walletUsdtBalanceRaw,
    quote: {
      amountInRaw: input.amountInRaw,
      quotedAmountOutRaw,
      amountOutMinimumRaw,
      params: buildUsdtToUsdcQuoteParams(input.amountInRaw),
    },
  };
}

export async function convertUsdtToUsdc(
  deps: UsdtToUsdcConversionDeps,
  input: {
    readonly walletAddress: string;
    readonly recipientAddress: string;
    readonly amountInRaw: bigint;
    readonly minimumRequiredAmountOutRaw?: bigint;
  },
): Promise<UsdtToUsdcConversionResult> {
  const preflight = await preflightUsdtToUsdcConversion(deps, {
    walletAddress: input.walletAddress,
    amountInRaw: input.amountInRaw,
    minimumRequiredAmountOutRaw: input.minimumRequiredAmountOutRaw,
  });
  if (preflight.kind === "failed") {
    return preflight;
  }

  const approvalReset = await submitAndConfirmTransaction({
    submit: () => deps.sendUsdtApprove(ARBITRUM_UNISWAP_SWAP_ROUTER_02_ADDRESS, 0n),
    waitForTransactionReceipt: deps.waitForTransactionReceipt,
    failureCode: "approval_reset_failed",
    revertedCode: "approval_reset_reverted",
    failureMessage: (detail) =>
      `USDT approval reset for SwapRouter02 failed before swap submission (${detail}).`,
    revertedMessage:
      "USDT approval reset for SwapRouter02 reverted on-chain before swap submission.",
  });
  if (approvalReset.kind === "failed") {
    return approvalReset;
  }

  const approvalAmount = await submitAndConfirmTransaction({
    submit: () =>
      deps.sendUsdtApprove(ARBITRUM_UNISWAP_SWAP_ROUTER_02_ADDRESS, preflight.quote.amountInRaw),
    waitForTransactionReceipt: deps.waitForTransactionReceipt,
    failureCode: "approval_amount_failed",
    revertedCode: "approval_amount_reverted",
    failureMessage: (detail) =>
      `USDT approval for the required swap amount failed before swap submission (${detail}).`,
    revertedMessage: "USDT approval for the required swap amount reverted on-chain.",
  });
  if (approvalAmount.kind === "failed") {
    return approvalAmount;
  }

  const swapParams = buildUsdtToUsdcExactInputSingleParams({
    recipient: input.recipientAddress,
    amountInRaw: preflight.quote.amountInRaw,
    quotedAmountOutRaw: preflight.quote.quotedAmountOutRaw,
  });

  const swap = await submitAndConfirmTransaction({
    submit: () => deps.sendExactInputSingle(swapParams),
    waitForTransactionReceipt: deps.waitForTransactionReceipt,
    failureCode: "swap_submission_failed",
    revertedCode: "swap_reverted",
    failureMessage: (detail) =>
      `USDT→USDC exactInputSingle swap submission failed on Arbitrum (${detail}).`,
    revertedMessage: "USDT→USDC exactInputSingle swap reverted on-chain on Arbitrum.",
  });
  if (swap.kind === "failed") {
    try {
      await deps.sendUsdtApprove(ARBITRUM_UNISWAP_SWAP_ROUTER_02_ADDRESS, 0n);
    } catch (revokeError: unknown) {
      console.warn(
        `Best-effort USDT approval revoke failed after swap failure: ${revokeError instanceof Error ? revokeError.message : String(revokeError)}`,
      );
    }
    return swap;
  }

  return {
    kind: "converted",
    amountInUsdt: formatStablecoinAmount(preflight.quote.amountInRaw),
    quotedAmountOutUsdc: formatStablecoinAmount(preflight.quote.quotedAmountOutRaw),
    amountOutMinimumUsdc: formatStablecoinAmount(preflight.quote.amountOutMinimumRaw),
    approvalResetTxHash: approvalReset.txHash,
    approvalAmountTxHash: approvalAmount.txHash,
    swapTxHash: swap.txHash,
  };
}

export function createArbitrumUsdtToUsdcConversionExecutor(
  config: ArbitrumUsdtToUsdcConversionExecutorConfig,
): (input: UsdtToUsdcConversionRequest) => Promise<UsdtToUsdcConversionResult> {
  return async (input) => {
    let walletContextPromise: Promise<{
      readonly walletClient: ReturnType<typeof createWalletClient>;
      readonly account: ReturnType<typeof mnemonicToAccount>;
    }> | null = null;

    const getWalletContext = async () => {
      if (walletContextPromise === null) {
        walletContextPromise = (async () => {
          const mnemonic = (await config.readMnemonic()).trim();
          const account = mnemonicToAccount(mnemonic);
          return {
            account,
            walletClient: createWalletClient({
              account,
              chain: arbitrum,
              transport: http(config.client.rpcUrl),
            }),
          };
        })();
      }

      return walletContextPromise;
    };

    return convertUsdtToUsdc(
      {
        getUsdtBalance: async (address) => (await getUsdtBalance(config.client, address)).raw,
        quoteExactInputSingle: async (amountInRaw) =>
          (await quoteUsdtToUsdcExactInput(config.client, amountInRaw)).quotedAmountOutRaw,
        sendUsdtApprove: async (spender, amount) => {
          const { walletClient, account } = await getWalletContext();
          return walletClient.sendTransaction({
            account,
            chain: arbitrum,
            to: ARBITRUM_USDT_ADDRESS,
            data: encodeFunctionData({
              abi: ERC20_APPROVE_ABI,
              functionName: "approve",
              args: [spender, amount],
            }),
            value: 0n,
          });
        },
        sendExactInputSingle: async (params) => {
          const { walletClient, account } = await getWalletContext();
          return walletClient.sendTransaction({
            account,
            chain: arbitrum,
            to: ARBITRUM_UNISWAP_SWAP_ROUTER_02_ADDRESS,
            data: encodeFunctionData({
              abi: UNISWAP_SWAP_ROUTER_02_ABI,
              functionName: "exactInputSingle",
              args: [params],
            }),
            value: 0n,
          });
        },
        waitForTransactionReceipt: async (txHash) => {
          const receipt = await config.client.publicClient.waitForTransactionReceipt({
            hash: assertHash(txHash, "waitForTransactionReceipt"),
          });
          return { status: receipt.status };
        },
      },
      {
        walletAddress: input.walletAddress,
        recipientAddress: input.recipientAddress ?? input.walletAddress,
        amountInRaw: parseStablecoinAmount(input.amountUsdt),
        minimumRequiredAmountOutRaw:
          input.minimumRequiredAmountOutUsdc === undefined
            ? undefined
            : parseStablecoinAmount(input.minimumRequiredAmountOutUsdc),
      },
    );
  };
}

function createConversionFailure(
  code: UsdtToUsdcConversionFailureCode,
  message: string,
): UsdtToUsdcConversionFailure {
  return { code, message };
}

async function submitAndConfirmTransaction(input: {
  readonly submit: () => Promise<string>;
  readonly waitForTransactionReceipt: (
    txHash: string,
  ) => Promise<{ readonly status: "success" | "reverted" }>;
  readonly failureCode: UsdtToUsdcConversionFailureCode;
  readonly revertedCode: UsdtToUsdcConversionFailureCode;
  readonly failureMessage: (detail: string) => string;
  readonly revertedMessage: string;
}): Promise<
  | { readonly kind: "confirmed"; readonly txHash: string }
  | { readonly kind: "failed"; readonly failure: UsdtToUsdcConversionFailure }
> {
  let txHash: string;
  try {
    txHash = await input.submit();
  } catch (error: unknown) {
    return {
      kind: "failed",
      failure: createConversionFailure(
        input.failureCode,
        input.failureMessage(toErrorMessage(error)),
      ),
    };
  }

  try {
    const receipt = await input.waitForTransactionReceipt(txHash);
    if (receipt.status !== "success") {
      return {
        kind: "failed",
        failure: createConversionFailure(input.revertedCode, input.revertedMessage),
      };
    }
  } catch (error: unknown) {
    return {
      kind: "failed",
      failure: createConversionFailure(
        input.failureCode,
        input.failureMessage(toErrorMessage(error)),
      ),
    };
  }

  return { kind: "confirmed", txHash };
}
