import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as tools from "../src/tools";

const MANIFEST_PATH = resolve(import.meta.dirname, "..", "mcp.json");
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as {
  tools: { name: string }[];
};
const EXPECTED_TOOL_NAMES: readonly string[] = manifest.tools.map((t) => t.name);

const EXPECTED_TYPE_EXPORTS = ["DaemonStatusSnapshot", "DaemonTickResult"] as const;

describe("tools barrel exports", () => {
  it("exports every expected tool function", () => {
    for (const name of EXPECTED_TOOL_NAMES) {
      expect(name in tools, `missing export: ${name}`).toBe(true);
      expect(typeof (tools as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("does not export unexpected runtime values", () => {
    const allExportKeys = Object.keys(tools);
    const runtimeExports = allExportKeys.filter(
      (k) => typeof (tools as Record<string, unknown>)[k] === "function",
    );

    for (const key of runtimeExports) {
      expect(
        (EXPECTED_TOOL_NAMES as readonly string[]).includes(key),
        `unexpected export: ${key}`,
      ).toBe(true);
    }
  });

  it("has exactly the expected number of tool functions", () => {
    const runtimeExports = Object.keys(tools).filter(
      (k) => typeof (tools as Record<string, unknown>)[k] === "function",
    );
    expect(runtimeExports).toHaveLength(EXPECTED_TOOL_NAMES.length);
  });
});

describe("tools registry consistency with mcp.json", () => {
  it("every mcp.json tool name maps to a barrel export", () => {
    const barrelExports = new Set(
      Object.keys(tools).filter((k) => typeof (tools as Record<string, unknown>)[k] === "function"),
    );

    for (const name of EXPECTED_TOOL_NAMES) {
      expect(barrelExports.has(name), `mcp.json has ${name} but barrel lacks it`).toBe(true);
    }
  });

  it("every barrel export maps to an mcp.json tool name", () => {
    const expectedSet = new Set<string>(EXPECTED_TOOL_NAMES);
    const runtimeExports = Object.keys(tools).filter(
      (k) => typeof (tools as Record<string, unknown>)[k] === "function",
    );

    for (const key of runtimeExports) {
      expect(expectedSet.has(key), `barrel exports ${key} but no mcp.json tool for it`).toBe(true);
    }
  });
});

describe("tool function shapes", () => {
  it("create_wallet accepts an options object", () => {
    expect(tools.create_wallet.length).toBeLessThanOrEqual(1);
  });

  it("confirm_backup keeps a zero-arg MCP-friendly runtime shape", () => {
    expect(typeof tools.confirm_backup).toBe("function");
    expect(tools.confirm_backup.length).toBe(0);
  });

  it("recover_mnemonic accepts an options object", () => {
    expect(tools.recover_mnemonic.length).toBeLessThanOrEqual(1);
  });

  it("set_v4t_token accepts an args object", () => {
    expect(tools.set_v4t_token.length).toBeLessThanOrEqual(1);
  });

  it("reset_override_phrase accepts no arguments", () => {
    expect(tools.reset_override_phrase.length).toBe(0);
  });

  it("get_trade_history accepts optional limit", () => {
    expect(tools.get_trade_history.length).toBeLessThanOrEqual(1);
  });

  it("start_trading accepts no arguments", () => {
    expect(tools.start_trading.length).toBe(0);
  });

  it("zero-arg tools have length 0", () => {
    const zeroArgTools = [
      "confirm_backup",
      "stop_trading",
      "execute_tick",
      "get_status",
      "get_onboarding_status",
      "reset_override_phrase",
    ] as const;
    for (const name of zeroArgTools) {
      const fn = (tools as Record<string, (...args: unknown[]) => unknown>)[name];
      expect(typeof fn).toBe("function");
      expect(fn.length, `${name} should accept zero arguments`).toBe(0);
    }
  });
});
