import { describe, expect, it } from "vitest";
import { checkBridgePreflight } from "../src/chain/bridge-guards";
import type { BridgePreflightInput } from "../src/chain/bridge-guards";

function makeInput(overrides: Partial<BridgePreflightInput> = {}): BridgePreflightInput {
  return {
    amountUsdc: "10",
    cumulativeBridgeUsd: "0",
    overridePhraseAccepted: false,
    walletUsdcBalance: "100",
    walletEthWei: 1_000_000_000_000_000n,
    estimatedGasWei: 100_000_000_000_000n,
    ...overrides,
  };
}

describe("checkBridgePreflight", () => {
  it("passes valid bridge transfer", () => {
    const result = checkBridgePreflight(makeInput());
    expect(result.ok).toBe(true);
  });

  it("rejects amount below MIN_BRIDGE_USDC (5.01)", () => {
    const result = checkBridgePreflight(makeInput({ amountUsdc: "5" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("below minimum");
      expect(result.reason).toContain("5.01");
    }
  });

  it("passes amount exactly at MIN_BRIDGE_USDC", () => {
    const result = checkBridgePreflight(makeInput({ amountUsdc: "5.01" }));
    expect(result.ok).toBe(true);
  });

  it("rejects when cumulative exceeds MAX_CUMULATIVE_BRIDGE_USD (100)", () => {
    const result = checkBridgePreflight(makeInput({ amountUsdc: "10", cumulativeBridgeUsd: "95" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("exceeds cap");
    }
  });

  it("passes when cumulative is exactly at cap", () => {
    const result = checkBridgePreflight(makeInput({ amountUsdc: "10", cumulativeBridgeUsd: "90" }));
    expect(result.ok).toBe(true);
  });

  it("allows override-active deposits while preserving the real cumulative input", () => {
    const result = checkBridgePreflight(
      makeInput({ amountUsdc: "10", cumulativeBridgeUsd: "500", overridePhraseAccepted: true }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects when wallet USDC balance is insufficient", () => {
    const result = checkBridgePreflight(makeInput({ amountUsdc: "10", walletUsdcBalance: "5.01" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("insufficient");
    }
  });

  it("rejects when wallet ETH is insufficient for gas (2x buffer)", () => {
    const result = checkBridgePreflight(
      makeInput({
        walletEthWei: 100_000_000_000_000n,
        estimatedGasWei: 100_000_000_000_000n,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("insufficient for gas");
    }
  });

  it("passes when ETH exactly covers 2x gas estimate", () => {
    const result = checkBridgePreflight(
      makeInput({
        walletEthWei: 200_000_000_000_000n,
        estimatedGasWei: 100_000_000_000_000n,
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects when ETH is 1 wei below 2x gas buffer", () => {
    const result = checkBridgePreflight(
      makeInput({
        walletEthWei: 199_999_999_999_999n,
        estimatedGasWei: 100_000_000_000_000n,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("insufficient for gas");
    }
  });

  it("checks minimum amount first (ordered rejections)", () => {
    const result = checkBridgePreflight(
      makeInput({
        amountUsdc: "1",
        walletUsdcBalance: "0.5",
        walletEthWei: 0n,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("below minimum");
    }
  });
});
