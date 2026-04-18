import { execSync } from "node:child_process";
import { rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const smokeDir = join(repoRoot, "runtime", "smoke-wallet-create");
const mnemonicPath = join(smokeDir, "openclaw-v4t-wallet-mnemonic.txt");

describe("smoke wallet-create", () => {
  beforeEach(() => {
    rmSync(smokeDir, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(smokeDir, { recursive: true, force: true });
  });

  it("wallet-create scenario passes without hidden env vars and file has mode 600", () => {
    const result = execSync("bun run src/index.ts --scenario wallet-create", {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 30_000,
    });

    expect(result).toContain("[smoke] wallet-create: PASS");
    expect(result).toContain(`[smoke] wallet-create: file=${mnemonicPath} mode=600`);
    expect(result).toMatch(/\[smoke\] wallet-create: address=0x[a-fA-F0-9]{40}/);
    expect(result).toContain("mode=600");

    const stat = statSync(mnemonicPath);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
