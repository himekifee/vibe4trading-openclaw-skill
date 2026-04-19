import {
  http,
  TransactionReceiptNotFoundError,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  formatUnits,
  isAddress,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

import { ARBITRUM_USDC_ADDRESS as ARBITRUM_USDC_CONFIG_ADDRESS } from "../config/constants";

export const ARBITRUM_USDC_ADDRESS = ARBITRUM_USDC_CONFIG_ADDRESS;
// Plan value: 0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7
// EIP-55 checksummed: 0x2dF1c51e09AECf9Cacb7bc98Cb1742757F163dF7
// Runtime-safe: lowercased to avoid viem checksum validation failures when
// @noble/hashes keccak256 state is corrupted by prior in-process usage (Bun bug).
// Lowercase hex is always accepted by viem's isAddress() regardless of keccak state.
export const HYPERLIQUID_BRIDGE_ADDRESS = "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7" as const;

const ERC20_BALANCE_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const ERC20_TRANSFER_ABI = [
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export type ArbitrumClientConfig = {
  readonly rpcUrl?: string;
};

export type ArbitrumClient = {
  readonly publicClient: ReturnType<typeof createPublicClient>;
  readonly rpcUrl: string;
};

export function createArbitrumClient(config?: ArbitrumClientConfig): ArbitrumClient {
  const rpcUrl = config?.rpcUrl ?? "https://arb1.arbitrum.io/rpc";
  return {
    publicClient: createPublicClient({
      chain: arbitrum,
      transport: http(rpcUrl),
    }),
    rpcUrl,
  };
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

export async function getEthBalance(
  client: ArbitrumClient,
  address: string,
): Promise<{ wei: bigint; formatted: string }> {
  const balance = await client.publicClient.getBalance({
    address: assertAddress(address, "getEthBalance"),
  });
  return { wei: balance, formatted: formatEther(balance) };
}

export async function getUsdcBalance(
  client: ArbitrumClient,
  address: string,
): Promise<{ raw: bigint; formatted: string }> {
  const balance = await client.publicClient.readContract({
    address: ARBITRUM_USDC_ADDRESS,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [assertAddress(address, "getUsdcBalance")],
  });
  return { raw: balance, formatted: formatUnits(balance, 6) };
}

export function encodeBridgeTransferData(amountUsdc: string): {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
} {
  const amountRaw = parseUnits(amountUsdc, 6);
  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [HYPERLIQUID_BRIDGE_ADDRESS, amountRaw],
  });

  return {
    to: ARBITRUM_USDC_ADDRESS,
    data,
    value: 0n,
  };
}

export async function estimateBridgeGas(
  client: ArbitrumClient,
  fromAddress: string,
  amountUsdc: string,
): Promise<{ gasEstimate: bigint; gasPriceWei: bigint; totalCostWei: bigint }> {
  const txData = encodeBridgeTransferData(amountUsdc);
  const [gasEstimate, gasPrice] = await Promise.all([
    client.publicClient.estimateGas({
      account: assertAddress(fromAddress, "estimateBridgeGas"),
      to: txData.to,
      data: txData.data,
      value: txData.value,
    }),
    client.publicClient.getGasPrice(),
  ]);

  return {
    gasEstimate,
    gasPriceWei: gasPrice,
    totalCostWei: gasEstimate * gasPrice,
  };
}

export async function submitBridgeTransfer(
  client: ArbitrumClient,
  privateKey: string,
  _address: string,
  amountUsdc: string,
): Promise<{ txHash: string }> {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: arbitrum,
    transport: http(client.rpcUrl),
  });

  const txData = encodeBridgeTransferData(amountUsdc);
  const txHash = await walletClient.sendTransaction({
    to: txData.to,
    data: txData.data,
    value: txData.value,
  });

  return { txHash };
}

/**
 * Discriminated result for bridge transfer confirmation.
 *
 * - `confirmed`: receipt found with `status === "success"`.
 * - `pending`: receipt not yet available (transaction may still be in mempool or not mined).
 * - `failed`: receipt found with `status === "reverted"`.
 * - `unknown`: RPC/transport fault — the query itself failed; retryable.
 */
export type BridgeConfirmationStatus =
  | { readonly status: "confirmed" }
  | { readonly status: "pending" }
  | { readonly status: "failed" }
  | { readonly status: "unknown"; readonly reason: string };

export async function confirmBridgeTransfer(
  client: ArbitrumClient,
  txHash: string,
): Promise<BridgeConfirmationStatus> {
  try {
    const receipt = await client.publicClient.getTransactionReceipt({
      hash: assertHash(txHash, "confirmBridgeTransfer"),
    });
    return receipt.status === "success" ? { status: "confirmed" } : { status: "failed" };
  } catch (error: unknown) {
    if (error instanceof TransactionReceiptNotFoundError) {
      return { status: "pending" };
    }
    const reason = error instanceof Error ? error.message : "Unknown RPC/transport error";
    return { status: "unknown", reason };
  }
}
