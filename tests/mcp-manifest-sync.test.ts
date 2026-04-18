import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../src/mcp-server";
import type { ToolDefinition } from "../src/mcp-server";
import * as tools from "../src/tools";

const MANIFEST_PATH = resolve(import.meta.dirname, "..", "mcp.json");
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
const manifestTools: { name: string; description: string; inputSchema: object }[] = manifest.tools;

describe("mcp.json is the source of truth for TOOL_DEFINITIONS", () => {
  it("TOOL_DEFINITIONS is loaded from mcp.json (structural identity)", () => {
    expect(JSON.parse(JSON.stringify(TOOL_DEFINITIONS))).toEqual(manifestTools);
  });

  it("manifest tool count matches TOOL_DEFINITIONS", () => {
    expect(manifestTools).toHaveLength(TOOL_DEFINITIONS.length);
  });

  it("manifest tool names match TOOL_DEFINITIONS in order", () => {
    const runtimeNames = TOOL_DEFINITIONS.map((t) => t.name);
    const manifestNames = manifestTools.map((t) => t.name);
    expect(manifestNames).toEqual(runtimeNames);
  });

  it("every tool definition has a corresponding barrel export", () => {
    const barrelExports = new Set(
      Object.keys(tools).filter((k) => typeof (tools as Record<string, unknown>)[k] === "function"),
    );

    for (const tool of TOOL_DEFINITIONS) {
      expect(barrelExports.has(tool.name), `missing barrel export for tool: ${tool.name}`).toBe(
        true,
      );
    }
  });
});

describe("mcp.json schema integrity", () => {
  for (const tool of manifestTools) {
    describe(`tool: ${tool.name}`, () => {
      it("has a non-empty description", () => {
        expect(typeof tool.description).toBe("string");
        expect(tool.description.length).toBeGreaterThan(0);
      });

      it("inputSchema has type object", () => {
        expect((tool.inputSchema as { type: string }).type).toBe("object");
      });

      it("inputSchema has additionalProperties false", () => {
        expect((tool.inputSchema as { additionalProperties: boolean }).additionalProperties).toBe(
          false,
        );
      });
    });
  }
});
