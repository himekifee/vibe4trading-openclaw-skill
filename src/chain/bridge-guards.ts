import {
  MAX_CUMULATIVE_BRIDGE_USD,
  MIN_BRIDGE_USDC,
  MIN_ETH_GAS_BUFFER_MULTIPLIER,
} from "../config/constants";
import { compareDecimalStrings, sumDecimalStrings } from "../config/decimals";

export type BridgePreflightInput = {
  readonly amountUsdc: string;
  readonly cumulativeBridgeUsd: string;
  readonly overridePhraseAccepted: boolean;
  readonly walletUsdcBalance: string;
  readonly walletEthWei: bigint;
  readonly estimatedGasWei: bigint;
};

export type BridgePreflightResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export function checkBridgePreflight(input: BridgePreflightInput): BridgePreflightResult {
  if (compareDecimalStrings(input.amountUsdc, String(MIN_BRIDGE_USDC)) < 0) {
    return {
      ok: false,
      reason: `Bridge amount ${input.amountUsdc} USDC is below minimum ${MIN_BRIDGE_USDC} USDC.`,
    };
  }

  const projectedCumulative = sumDecimalStrings([input.cumulativeBridgeUsd, input.amountUsdc]);
  if (
    !input.overridePhraseAccepted &&
    compareDecimalStrings(projectedCumulative, String(MAX_CUMULATIVE_BRIDGE_USD)) > 0
  ) {
    return {
      ok: false,
      reason: `Projected cumulative bridge ${projectedCumulative} USDC exceeds cap ${MAX_CUMULATIVE_BRIDGE_USD} USDC.`,
    };
  }

  if (compareDecimalStrings(input.walletUsdcBalance, input.amountUsdc) < 0) {
    return {
      ok: false,
      reason: `Wallet USDC balance ${input.walletUsdcBalance} is insufficient for ${input.amountUsdc} USDC bridge.`,
    };
  }

  const requiredGasWei = input.estimatedGasWei * MIN_ETH_GAS_BUFFER_MULTIPLIER;
  if (input.walletEthWei < requiredGasWei) {
    return {
      ok: false,
      reason: `Wallet ETH balance insufficient for gas. Need ${requiredGasWei} wei (2x estimate), have ${input.walletEthWei} wei.`,
    };
  }

  return { ok: true };
}
