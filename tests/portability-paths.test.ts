import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HARDCODED_ROOT = "/home/grider/Projects/vibe4trading_openclaw_skill";

const TARGET_FILES = [
  resolve(import.meta.dirname, "../src/index.ts"),
  resolve(import.meta.dirname, "../tests/daemon-smoke.test.ts"),
  resolve(import.meta.dirname, "../tests/smoke-wallet-create.test.ts"),
];

describe("portability: no hardcoded repo-root paths", () => {
  for (const filePath of TARGET_FILES) {
    it(`${filePath.split("/").slice(-2).join("/")} must not contain hardcoded repo root`, () => {
      const content = readFileSync(filePath, "utf8");
      expect(content).not.toContain(HARDCODED_ROOT);
    });
  }
});
