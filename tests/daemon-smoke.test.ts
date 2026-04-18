import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");

describe("daemon smoke scenarios", () => {
  it("daemon-once scenario passes", () => {
    const result = execSync("bun run src/index.ts --scenario daemon-once", {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result).toContain("[smoke] daemon-once: PASS");

    const evidencePath = `${PROJECT_ROOT}/.sisyphus/evidence/task-9-daemon-reconcile.txt`;
    if (existsSync(evidencePath)) {
      const reconcileEvidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
        proof?: { startupReconciledBeforeTrading?: boolean };
        correctedExchangeActivity?: { hasOpenPosition: boolean; hasPendingOrder: boolean };
      };
      expect(reconcileEvidence.proof?.startupReconciledBeforeTrading).toBe(true);
      expect(reconcileEvidence.correctedExchangeActivity).toEqual({
        hasOpenPosition: true,
        hasPendingOrder: false,
      });
    }
  });

  it("daemon-duplicate-slot scenario passes", () => {
    const result = execSync("bun run src/index.ts --scenario daemon-duplicate-slot", {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result).toContain("[smoke] daemon-duplicate-slot: PASS");
  });

  it("emergency-stop scenario passes", () => {
    const result = execSync("bun run src/index.ts --scenario emergency-stop", {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result).toContain("[smoke] emergency-stop: PASS");
  });

  it("regression-lifecycle scenario passes and writes evidence", () => {
    const result = execSync("bun run src/index.ts --scenario regression-lifecycle", {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });

    expect(result).toContain("[smoke] regression-lifecycle: PASS");
    expect(result).toContain("1/12 wallet bootstrap PASS");
    expect(result).toContain("2/12 backup persistence PASS");
    expect(result).toContain("3/12 selection persistence PASS");
    expect(result).toContain("4/12 mainnet acknowledgment gate PASS");
    expect(result).toContain("5/12 USDT conversion automation PASS");
    expect(result).toContain("6/12 single pending deposit PASS");
    expect(result).toContain("7/12 automatic perp collateral prep PASS");
    expect(result).toContain("8/12 hold-visible status PASS");
    expect(result).toContain("9/12 agent-directed execution intent PASS");
    expect(result).toContain("10/12 isolated margin PASS");
    expect(result).toContain("11/12 bounded IOC retries PASS");
    expect(result).toContain("12/12 non-flattening stop_trading PASS");

    const evidencePath = `${PROJECT_ROOT}/.sisyphus/evidence/task-15-regression.txt`;
    expect(existsSync(evidencePath)).toBe(true);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
      task: number;
      walletBootstrap: { address: string; mnemonicWordCount: number };
      backupPersistence: { pendingStatus: string; confirmedStatus: string };
      selectionPersistence: { optionId: string; strategyProfile: string };
      mainnetAcknowledgmentGate: { armedAfterConsent: string };
      usdtConversionAutomation: { depositResult: string };
      singlePendingDeposit: { secondDeposit: string };
      perpCollateralPrep: { pendingStatus: string; failedStatus: string };
      holdVisibleStatus: { judgmentSummary: string };
      agentDirectedIntent: { holdIntentOutcome: string; targetIntentOutcome: string };
      isolatedMargin: { defaultOrderStyle: string };
      boundedIocRetries: { maxAttempts: number };
      nonFlatteningStopTrading: { positionsPreserved: boolean };
    };
    expect(evidence.task).toBe(15);
    expect(evidence.walletBootstrap.mnemonicWordCount).toBe(12);
    expect(evidence.backupPersistence.confirmedStatus).toBe("confirmed");
    expect(evidence.selectionPersistence.strategyProfile).toBe("aggressive");
    expect(evidence.mainnetAcknowledgmentGate.armedAfterConsent).toBe("running");
    expect(evidence.usdtConversionAutomation.depositResult).toBe("submitted");
    expect(evidence.singlePendingDeposit.secondDeposit).toBe("already_pending");
    expect(evidence.perpCollateralPrep.pendingStatus).toBe("collateral_prep_pending");
    expect(evidence.perpCollateralPrep.failedStatus).toBe("collateral_prep_failed");
    expect(evidence.holdVisibleStatus.judgmentSummary).toBe("Hold: no-suggestion");
    expect(evidence.agentDirectedIntent.holdIntentOutcome).toBe("executed");
    expect(evidence.agentDirectedIntent.targetIntentOutcome).toBe("executed");
    expect(evidence.isolatedMargin.defaultOrderStyle).toBe("ioc");
    expect(evidence.boundedIocRetries.maxAttempts).toBe(3);
    expect(evidence.nonFlatteningStopTrading.positionsPreserved).toBe(true);

    const errorEvidencePath = `${PROJECT_ROOT}/.sisyphus/evidence/task-15-regression-error.txt`;
    expect(existsSync(errorEvidencePath)).toBe(true);
    const errorEvidence = JSON.parse(readFileSync(errorEvidencePath, "utf8")) as {
      task: number;
      stopTradingRefusal: { positionsPreserved: boolean; refusedOutcome: string };
    };
    expect(errorEvidence.task).toBe(15);
    expect(errorEvidence.stopTradingRefusal.positionsPreserved).toBe(true);
    expect(errorEvidence.stopTradingRefusal.refusedOutcome).toBe("refused");
  });

  it("unknown --scenario exits non-zero with actionable help", () => {
    let threw = false;
    let stderr = "";
    try {
      execSync("bun run src/index.ts --scenario bogus-scenario", {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        timeout: 10_000,
      });
    } catch (error: unknown) {
      threw = true;
      const execError = error as { stderr?: string; status?: number };
      stderr = execError.stderr ?? "";
      expect(execError.status).not.toBe(0);
    }
    expect(threw).toBe(true);
    expect(stderr).toContain("Unknown scenario");
    expect(stderr).toContain("bogus-scenario");
    expect(stderr).toContain("wallet-create");
    expect(stderr).toContain("daemon-once");
  });
});
