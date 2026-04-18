import {
  MAX_CUMULATIVE_BRIDGE_USD,
  MIN_BRIDGE_USDC,
  MIN_ETH_GAS_BUFFER_MULTIPLIER,
} from "../config/constants";
import {
  compareDecimalStrings,
  subtractDecimalStrings,
  sumDecimalStrings,
} from "../config/decimals";

const ONBOARDING_STATUSES = [
  "unfunded",
  "missing_eth_gas",
  "below_minimum_bridge",
  "cap_exceeded_no_override",
  "pending_confirmation",
  "collateral_prep_pending",
  "collateral_prep_failed",
  "ready",
] as const;

export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export type OnboardingStatusInput = {
  readonly walletUsdcBalance: string;
  readonly walletUsdtBalance?: string;
  readonly walletEthWei: bigint;
  readonly estimatedGasWei: bigint;
  readonly cumulativeBridgeUsd: string;
  readonly overridePhraseAccepted: boolean;
  readonly hasPendingTransfer: boolean;
  readonly collateralPrepStatus?: "pending" | "failed" | null;
};

export type OnboardingStatusResult = {
  readonly status: OnboardingStatus;
  readonly message: string;
  readonly bridgeableAmount: string | null;
};

export function classifyOnboardingStatus(input: OnboardingStatusInput): OnboardingStatusResult {
  const walletUsdtBalance = input.walletUsdtBalance ?? "0";

  if (input.hasPendingTransfer) {
    return {
      status: "pending_confirmation",
      message:
        "A bridge transfer is pending confirmation. Wait for validators to confirm the deposit before submitting another.",
      bridgeableAmount: null,
    };
  }

  if (input.collateralPrepStatus === "pending") {
    return {
      status: "collateral_prep_pending",
      message:
        "Bridge transfer confirmed. Collateral is being prepared for perp trading — waiting for spot-to-perp transfer to complete.",
      bridgeableAmount: null,
    };
  }

  if (input.collateralPrepStatus === "failed") {
    return {
      status: "collateral_prep_failed",
      message:
        "Bridge transfer confirmed but collateral preparation for perp trading failed. The bridged funds are on Hyperliquid spot but have not been moved to the perp margin context. Manual intervention or retry may be needed.",
      bridgeableAmount: null,
    };
  }

  const availableStableBalance = sumDecimalStrings([input.walletUsdcBalance, walletUsdtBalance]);

  if (compareDecimalStrings(availableStableBalance, "0") <= 0) {
    return {
      status: "unfunded",
      message:
        "Wallet has no USDC or USDT on Arbitrum. Fund the wallet with stablecoins to begin onboarding.",
      bridgeableAmount: null,
    };
  }

  const requiredGasWei = input.estimatedGasWei * MIN_ETH_GAS_BUFFER_MULTIPLIER;
  if (input.walletEthWei < requiredGasWei) {
    const shortfallWei = requiredGasWei - input.walletEthWei;
    return {
      status: "missing_eth_gas",
      message: `Wallet ETH balance insufficient for gas. Need ${requiredGasWei} wei (2× estimate), have ${input.walletEthWei} wei (shortfall: ${shortfallWei} wei). Send ETH to the wallet on Arbitrum to cover gas.`,
      bridgeableAmount: null,
    };
  }

  if (compareDecimalStrings(availableStableBalance, String(MIN_BRIDGE_USDC)) < 0) {
    return {
      status: "below_minimum_bridge",
      message: `Combined Arbitrum stablecoin balance (${availableStableBalance} across USDC + USDT) is below the minimum bridge amount of ${MIN_BRIDGE_USDC} USDC. Fund the wallet with at least ${MIN_BRIDGE_USDC} USDC or USDT on Arbitrum to proceed.`,
      bridgeableAmount: null,
    };
  }

  const capHeadroom = computeCapHeadroom(input.cumulativeBridgeUsd);
  if (input.overridePhraseAccepted) {
    return {
      status: "ready",
      message: `Wallet is funded and ready to bridge. Override phrase accepted and remains active until reset_override_phrase is called. Cumulative bridged total is ${input.cumulativeBridgeUsd} USDC against the ${MAX_CUMULATIVE_BRIDGE_USD} USDC cap (remaining headroom: ${capHeadroom} USDC). Available wallet stablecoin balance: ${availableStableBalance} across USDC + USDT (USDT shortfall can be converted before bridging).`,
      bridgeableAmount: availableStableBalance,
    };
  }

  if (compareDecimalStrings(capHeadroom, String(MIN_BRIDGE_USDC)) < 0) {
    return {
      status: "cap_exceeded_no_override",
      message: `Cumulative bridged total (${input.cumulativeBridgeUsd} USDC) is near the ${MAX_CUMULATIVE_BRIDGE_USD} USDC cap. Remaining headroom (${capHeadroom} USDC) is below the minimum bridge amount. Accept the override phrase to continue.`,
      bridgeableAmount: null,
    };
  }

  const bridgeableAmount =
    compareDecimalStrings(availableStableBalance, capHeadroom) <= 0
      ? availableStableBalance
      : capHeadroom;

  if (compareDecimalStrings(bridgeableAmount, String(MIN_BRIDGE_USDC)) < 0) {
    return {
      status: "below_minimum_bridge",
      message: `Bridgeable amount ${bridgeableAmount} USDC (cap-limited) is below minimum ${MIN_BRIDGE_USDC} USDC.`,
      bridgeableAmount: null,
    };
  }

  return {
    status: "ready",
    message: `Wallet is funded and ready to bridge up to ${bridgeableAmount} USDC using available USDC plus convertible USDT if needed (cap headroom: ${capHeadroom} USDC).`,
    bridgeableAmount,
  };
}

function computeCapHeadroom(cumulativeBridgeUsd: string): string {
  const capStr = String(MAX_CUMULATIVE_BRIDGE_USD);
  if (compareDecimalStrings(cumulativeBridgeUsd, capStr) >= 0) {
    return "0";
  }

  return subtractDecimalStrings(capStr, cumulativeBridgeUsd);
}
