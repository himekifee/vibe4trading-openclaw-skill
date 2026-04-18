import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("scaffold integrity", () => {
  const root = resolve(import.meta.dirname, "..");

  it("has package.json with required scripts", async () => {
    const pkgPath = resolve(root, "package.json");
    expect(existsSync(pkgPath)).toBe(true);

    const pkg = await import(pkgPath);
    const scripts = pkg.default?.scripts ?? pkg.scripts;
    expect(scripts).toBeDefined();

    const requiredScripts = ["typecheck", "test", "smoke", "lint", "format", "daemon:once"];
    for (const name of requiredScripts) {
      expect(scripts[name], `missing script: ${name}`).toBeDefined();
    }
  });

  it("has tsconfig.json with strict mode", async () => {
    const tscPath = resolve(root, "tsconfig.json");
    expect(existsSync(tscPath)).toBe(true);

    const tsconfig = JSON.parse(readFileSync(tscPath, "utf-8"));
    expect(tsconfig.compilerOptions?.strict).toBe(true);
  });

  it("has required directories", () => {
    const dirs = ["src", "tests", "runtime", "docs", ".sisyphus/evidence"];
    for (const dir of dirs) {
      expect(existsSync(resolve(root, dir)), `missing directory: ${dir}`).toBe(true);
    }
  });

  it("has required root files", () => {
    const files = ["SKILL.md", "mcp.json", "README.md", ".gitignore"];
    for (const file of files) {
      expect(existsSync(resolve(root, file)), `missing file: ${file}`).toBe(true);
    }
  });

  it("src/index.ts exists and is non-empty", async () => {
    const entrypoint = resolve(root, "src/index.ts");
    expect(existsSync(entrypoint)).toBe(true);

    const content = readFileSync(entrypoint, "utf-8");
    expect(content.length).toBeGreaterThan(100);
    expect(content).toContain("--help");
  });
});
