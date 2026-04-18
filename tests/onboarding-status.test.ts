import { describe, expect, it } from "vitest";

import { classifyOnboardingStatus } from "../src/onboarding/status";
import type { OnboardingStatusInput } from "../src/onboarding/status";

function makeInput(overrides: Partial<OnboardingStatusInput> = {}): OnboardingStatusInput {
  return {
    walletUsdcBalance: "50",
    walletUsdtBalance: "0",
    walletEthWei: 1_000_000_000_000_000n,
    estimatedGasWei: 100_000_000_000_000n,
    cumulativeBridgeUsd: "0",
    overridePhraseAccepted: false,
    hasPendingTransfer: false,
    ...overrides,
  };
}

describe("classifyOnboardingStatus", () => {
  it("returns unfunded when wallet has zero USDC", () => {
    const result = classifyOnboardingStatus(makeInput({ walletUsdcBalance: "0" }));
    expect(result.status).toBe("unfunded");
    expect(result.bridgeableAmount).toBeNull();
  });

  it("returns ready when wallet can fund via USDT conversion path", () => {
    const result = classifyOnboardingStatus(
      makeInput({ walletUsdcBalance: "0", walletUsdtBalance: "12" }),
    );
    expect(result.status).toBe("ready");
    expect(result.bridgeableAmount).toBe("12");
    expect(result.message).toContain("convertible USDT");
  });

  it("returns missing_eth_gas when ETH is insufficient for gas", () => {
    const result = classifyOnboardingStatus(
      makeInput({
        walletEthWei: 10n,
        estimatedGasWei: 100_000_000_000_000n,
      }),
    );
    expect(result.status).toBe("missing_eth_gas");
    expect(result.bridgeableAmount).toBeNull();
  });

  it("returns below_minimum_bridge when USDC < 5.01", () => {
    const result = classifyOnboardingStatus(makeInput({ walletUsdcBalance: "3.5" }));
    expect(result.status).toBe("below_minimum_bridge");
    expect(result.bridgeableAmount).toBeNull();
  });

  it("returns below_minimum_bridge when combined USDC and USDT remain below minimum", () => {
    const result = classifyOnboardingStatus(
      makeInput({ walletUsdcBalance: "2", walletUsdtBalance: "3" }),
    );
    expect(result.status).toBe("below_minimum_bridge");
    expect(result.bridgeableAmount).toBeNull();
  });

  it("returns collateral_prep_pending when collateralPrepStatus is pending", () => {
    const result = classifyOnboardingStatus(makeInput({ collateralPrepStatus: "pending" }));
    expect(result.status).toBe("collateral_prep_pending");
    expect(result.bridgeableAmount).toBeNull();
    expect(result.message).toContain("spot-to-perp transfer");
  });

  it("returns collateral_prep_failed when collateralPrepStatus is failed", () => {
    const result = classifyOnboardingStatus(makeInput({ collateralPrepStatus: "failed" }));
    expect(result.status).toBe("collateral_prep_failed");
    expect(result.bridgeableAmount).toBeNull();
    expect(result.message).toContain("collateral preparation");
    expect(result.message).toContain("failed");
  });

  it("collateral_prep_pending takes priority over balance checks", () => {
    const result = classifyOnboardingStatus(
      makeInput({ walletUsdcBalance: "0", collateralPrepStatus: "pending" }),
    );
    expect(result.status).toBe("collateral_prep_pending");
  });

  it("pending_confirmation takes priority over collateral_prep_pending", () => {
    const result = classifyOnboardingStatus(
      makeInput({ hasPendingTransfer: true, collateralPrepStatus: "pending" }),
    );
    expect(result.status).toBe("pending_confirmation");
  });

  it("returns ready when collateralPrepStatus is null", () => {
    const result = classifyOnboardingStatus(makeInput({ collateralPrepStatus: null }));
    expect(result.status).toBe("ready");
  });

  it("returns ready when collateralPrepStatus is undefined", () => {
    const result = classifyOnboardingStatus(makeInput());
    expect(result.status).toBe("ready");
  });

  it("returns pending_confirmation when transfer is pending", () => {
    const result = classifyOnboardingStatus(makeInput({ hasPendingTransfer: true }));
    expect(result.status).toBe("pending_confirmation");
    expect(result.bridgeableAmount).toBeNull();
  });

  it("returns cap_exceeded_no_override when cumulative near cap", () => {
    const result = classifyOnboardingStatus(
      makeInput({ cumulativeBridgeUsd: "99", overridePhraseAccepted: false }),
    );
    expect(result.status).toBe("cap_exceeded_no_override");
    expect(result.bridgeableAmount).toBeNull();
  });

  it("returns cap_exceeded_no_override when cumulative equals cap", () => {
    const result = classifyOnboardingStatus(
      makeInput({ cumulativeBridgeUsd: "100", overridePhraseAccepted: false }),
    );
    expect(result.status).toBe("cap_exceeded_no_override");
    expect(result.bridgeableAmount).toBeNull();
  });

  it("returns ready with cap-limited amount when headroom < balance", () => {
    const result = classifyOnboardingStatus(
      makeInput({
        walletUsdcBalance: "50",
        cumulativeBridgeUsd: "80",
        overridePhraseAccepted: false,
      }),
    );
    expect(result.status).toBe("ready");
    expect(result.bridgeableAmount).toBe("20");
  });

  it("returns ready with full balance when headroom > balance", () => {
    const result = classifyOnboardingStatus(
      makeInput({
        walletUsdcBalance: "10",
        cumulativeBridgeUsd: "0",
        overridePhraseAccepted: false,
      }),
    );
    expect(result.status).toBe("ready");
    expect(result.bridgeableAmount).toBe("10");
  });

  it("returns ready with no cap restriction when override accepted", () => {
    const result = classifyOnboardingStatus(
      makeInput({
        walletUsdcBalance: "200",
        walletUsdtBalance: "50",
        cumulativeBridgeUsd: "150",
        overridePhraseAccepted: true,
      }),
    );
    expect(result.status).toBe("ready");
    expect(result.bridgeableAmount).toBe("250");
    expect(result.message).toContain("Override phrase accepted");
    expect(result.message).toContain("150 USDC");
    expect(result.message).toContain("remaining headroom: 0 USDC");
    expect(result.message).toContain("reset_override_phrase");
  });

  it("prioritizes pending_confirmation over other issues", () => {
    const result = classifyOnboardingStatus(
      makeInput({
        walletUsdcBalance: "0",
        walletEthWei: 0n,
        hasPendingTransfer: true,
      }),
    );
    expect(result.status).toBe("pending_confirmation");
  });

  it("handles fractional USDC amounts correctly", () => {
    const result = classifyOnboardingStatus(
      makeInput({
        walletUsdcBalance: "5.02",
        cumulativeBridgeUsd: "94.98",
        overridePhraseAccepted: false,
      }),
    );
    expect(result.status).toBe("ready");
    expect(result.bridgeableAmount).toBe("5.02");
  });

  it("returns below_minimum_bridge when exactly at minimum minus epsilon", () => {
    const result = classifyOnboardingStatus(makeInput({ walletUsdcBalance: "5" }));
    expect(result.status).toBe("below_minimum_bridge");
  });

  it("returns ready when exactly at minimum", () => {
    const result = classifyOnboardingStatus(makeInput({ walletUsdcBalance: "5.01" }));
    expect(result.status).toBe("ready");
    expect(result.bridgeableAmount).toBe("5.01");
  });

  it("returns ready when ETH exactly meets 2x gas buffer", () => {
    const result = classifyOnboardingStatus(
      makeInput({
        walletEthWei: 200_000_000_000_000n,
        estimatedGasWei: 100_000_000_000_000n,
      }),
    );
    expect(result.status).toBe("ready");
    expect(result.bridgeableAmount).not.toBeNull();
  });

  it("returns missing_eth_gas when ETH is 1 wei below 2x gas buffer", () => {
    const result = classifyOnboardingStatus(
      makeInput({
        walletEthWei: 199_999_999_999_999n,
        estimatedGasWei: 100_000_000_000_000n,
      }),
    );
    expect(result.status).toBe("missing_eth_gas");
    expect(result.bridgeableAmount).toBeNull();
  });

  it("returns cap_exceeded when cumulative is just barely below cap with fractional remainder", () => {
    const result = classifyOnboardingStatus(
      makeInput({
        walletUsdcBalance: "50",
        cumulativeBridgeUsd: "99.99",
        overridePhraseAccepted: false,
      }),
    );
    expect(result.status).toBe("cap_exceeded_no_override");
    expect(result.bridgeableAmount).toBeNull();
  });

  it("returns ready with cap-limited bridgeable when headroom equals minimum bridge amount", () => {
    const result = classifyOnboardingStatus(
      makeInput({
        walletUsdcBalance: "50",
        cumulativeBridgeUsd: "94.99",
        overridePhraseAccepted: false,
      }),
    );
    expect(result.status).toBe("ready");
    expect(result.bridgeableAmount).toBe("5.01");
  });

  it("returns zero headroom via override when cumulative exceeds cap", () => {
    const result = classifyOnboardingStatus(
      makeInput({
        walletUsdcBalance: "10",
        cumulativeBridgeUsd: "120",
        overridePhraseAccepted: true,
      }),
    );
    expect(result.status).toBe("ready");
    expect(result.bridgeableAmount).toBe("10");
    expect(result.message).toContain("remaining headroom: 0 USDC");
  });

  it("gas message includes shortfall and actionable instruction", () => {
    const result = classifyOnboardingStatus(
      makeInput({
        walletEthWei: 50_000_000_000_000n,
        estimatedGasWei: 100_000_000_000_000n,
      }),
    );
    expect(result.status).toBe("missing_eth_gas");
    expect(result.message).toContain("shortfall:");
    expect(result.message).toContain("Send ETH to the wallet on Arbitrum");
  });

  it("below minimum message includes actionable funding instruction", () => {
    const result = classifyOnboardingStatus(
      makeInput({ walletUsdcBalance: "2", walletUsdtBalance: "1" }),
    );
    expect(result.status).toBe("below_minimum_bridge");
    expect(result.message).toContain("Fund the wallet");
    expect(result.message).toContain("5.01");
  });
});
