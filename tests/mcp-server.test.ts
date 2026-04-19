import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createRuntimeState, serializeRuntimeState } from "../src/state";
import { serializeAgentMdCacheState } from "../src/state";

const SERVER_ENTRY = resolve(import.meta.dirname, "../src/mcp-server.ts");
const RUNTIME_DIR = resolve(import.meta.dirname, "../runtime");
const STATE_FILE = resolve(RUNTIME_DIR, "state.json");
const AGENT_MD_CACHE_FILE = resolve(RUNTIME_DIR, "agent-md-cache.json");

type JsonRpcResponse = {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
};

type ToolDef = {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<
      string,
      {
        type: string | string[];
        properties?: Record<string, { type: string | string[] }>;
      }
    >;
    required?: string[];
    additionalProperties?: boolean;
  };
};
type ToolCallResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function encodeFrame(body: string): Buffer {
  const bodyBuf = Buffer.from(body, "utf8");
  const header = `Content-Length: ${bodyBuf.byteLength}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, "utf8"), bodyBuf]);
}

function parseFirstFrame(buf: Buffer): JsonRpcResponse | null {
  const headerEnd = buf.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;

  const headerSection = buf.subarray(0, headerEnd).toString("utf8");
  const match = /^Content-Length:\s*(\d+)/im.exec(headerSection);
  if (!match) return null;

  const contentLength = Number(match[1]);
  const bodyStart = headerEnd + 4;
  if (buf.byteLength < bodyStart + contentLength) return null;

  const body = buf.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
  return JSON.parse(body) as JsonRpcResponse;
}

function sendFrameAndCollect(raw: string, timeoutMs = 10_000): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", ["run", SERVER_ENTRY], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = Buffer.alloc(0);
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error("Timed out waiting for MCP response"));
      }
    }, timeoutMs);

    proc.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      buf = Buffer.concat([buf, chunk]);

      const parsed = parseFirstFrame(buf);
      if (parsed) {
        settled = true;
        clearTimeout(timer);
        proc.kill();
        resolve(parsed);
      }
    });

    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    proc.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        const parsed = parseFirstFrame(buf);
        if (parsed) {
          resolve(parsed);
        } else {
          reject(new Error("Process exited without a complete response"));
        }
      }
    });

    const frame = encodeFrame(raw);
    proc.stdin.write(frame);
    proc.stdin.end();
  });
}

function rpc(
  method: string,
  id: string | number | null,
  params?: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  return sendFrameAndCollect(body);
}

describe("MCP server JSON-RPC dispatch", () => {
  it("initialize returns protocol version and server info", async () => {
    const res = await rpc("initialize", 1);
    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(1);
    expect(res.error).toBeUndefined();

    const result = res.result as {
      protocolVersion: string;
      capabilities: { tools: object };
      serverInfo: { name: string; version: string };
    };
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result.serverInfo.name).toBe("openclaw-trading");
    expect(result.serverInfo.version).toBe("0.1.0");
  });

  it("unknown method returns -32601 Method not found", async () => {
    const res = await rpc("bogus/method", 2);
    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(2);
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32601);
    expect(res.error?.message).toContain("bogus/method");
  });

  it("invalid JSON returns -32700 Parse error", async () => {
    const res = await sendFrameAndCollect("{not valid json!!!");
    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBeNull();
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32700);
    expect(res.error?.message).toContain("Parse error");
  });

  it("valid JSON with invalid request envelope returns -32600 Invalid Request", async () => {
    const res = await sendFrameAndCollect("null");
    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBeNull();
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32600);
    expect(res.error?.message).toContain("Invalid Request");
  });

  it("rejects malformed JSON-RPC envelopes with -32600", async () => {
    const invalidEnvelopes = [
      "42",
      "[]",
      '{"jsonrpc":"1.0","method":"initialize","id":1}',
      '{"method":"initialize","id":1}',
      '{"jsonrpc":"2.0"}',
    ];

    for (const raw of invalidEnvelopes) {
      const res = await sendFrameAndCollect(raw);
      expect(res.jsonrpc).toBe("2.0");
      expect(res.id).toBeNull();
      expect(res.error).toBeDefined();
      expect(res.error?.code).toBe(-32600);
      expect(res.error?.message).toContain("Invalid Request");
    }
  });
});

describe("MCP tools/list", () => {
  it("returns all registered tool definitions", async () => {
    const res = await rpc("tools/list", 10);
    expect(res.error).toBeUndefined();

    const result = res.result as { tools: ToolDef[] };
    expect(Array.isArray(result.tools)).toBe(true);

    const expectedTools = [
      "create_wallet",
      "confirm_backup",
      "recover_mnemonic",
      "recover_from_mnemonic",
      "get_onboarding_status",
      "deposit_to_hyperliquid",
      "reset_override_phrase",
      "set_v4t_token",
      "start_trading",
      "stop_trading",
      "get_tick_context",
      "execute_tick",
      "get_status",
      "get_account_info",
      "get_trade_history",
      "acknowledge_live_trading",
      "get_trading_options",
      "set_trading_selection",
      "accept_override_phrase",
      "cleanup_mnemonic_file",
    ];

    const toolNames = result.tools.map((t) => t.name);
    expect(toolNames).toEqual(expect.arrayContaining(expectedTools));
    expect(toolNames).toHaveLength(expectedTools.length);
  });

  it("every tool has name, description, and inputSchema with type object", async () => {
    const res = await rpc("tools/list", 11);
    const result = res.result as { tools: ToolDef[] };

    for (const tool of result.tools) {
      expect(tool.name).toBeTruthy();
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }

    const setToken = result.tools.find((tool) => tool.name === "set_v4t_token");
    expect(setToken?.inputSchema.required).toEqual(["token"]);
    expect(setToken?.inputSchema.properties?.token?.type).toEqual(["string", "null"]);

    const tradeHistory = result.tools.find((tool) => tool.name === "get_trade_history");
    expect(tradeHistory?.inputSchema.properties?.limit?.type).toBe("number");

    const tickContext = result.tools.find((tool) => tool.name === "get_tick_context");
    expect(tickContext?.inputSchema.properties?.slotId?.type).toBe("string");
    expect(tickContext?.inputSchema.properties?.intent?.type).toBe("object");
    expect(tickContext?.inputSchema.properties?.intent?.properties?.action?.type).toBe("string");
    expect(tickContext?.inputSchema.properties?.intent?.properties?.rationale?.type).toBe("string");

    const executeTick = result.tools.find((tool) => tool.name === "execute_tick");
    expect(executeTick?.inputSchema.properties?.slotId?.type).toBe("string");
    expect(executeTick?.inputSchema.properties?.intent?.type).toBe("object");
    expect(executeTick?.inputSchema.properties?.intent?.properties?.action?.type).toBe("string");
    expect(executeTick?.inputSchema.properties?.intent?.properties?.rationale?.type).toBe("string");

    const acknowledgeLiveTrading = result.tools.find(
      (tool) => tool.name === "acknowledge_live_trading",
    );
    expect(acknowledgeLiveTrading?.inputSchema.required).toEqual(["confirmed"]);
    expect(acknowledgeLiveTrading?.inputSchema.properties?.confirmed?.type).toBe("boolean");

    const setTradingSelection = result.tools.find((tool) => tool.name === "set_trading_selection");
    expect(setTradingSelection?.inputSchema.required).toEqual(["pair", "strategy", "model"]);
    expect(setTradingSelection?.inputSchema.properties?.pair?.type).toBe("string");
    expect(setTradingSelection?.inputSchema.properties?.strategy?.type).toBe("string");
    expect(setTradingSelection?.inputSchema.properties?.model?.type).toBe("string");

    const acceptOverridePhrase = result.tools.find(
      (tool) => tool.name === "accept_override_phrase",
    );
    expect(acceptOverridePhrase?.inputSchema.required).toEqual(["confirmed"]);
    expect(acceptOverridePhrase?.inputSchema.properties?.confirmed?.type).toBe("boolean");

    const cleanupMnemonicFile = result.tools.find((tool) => tool.name === "cleanup_mnemonic_file");
    expect(cleanupMnemonicFile?.inputSchema.required).toEqual(["action"]);
    expect(cleanupMnemonicFile?.inputSchema.properties?.action?.type).toBe("string");
  });
});

describe("MCP no-daemon contract alignment", () => {
  it("start_trading schema has no runLoop property", async () => {
    const res = await rpc("tools/list", 30);
    const result = res.result as { tools: ToolDef[] };
    const startTool = result.tools.find((t) => t.name === "start_trading");
    expect(startTool).toBeDefined();
    const schema = (startTool as ToolDef).inputSchema as {
      type: string;
      properties?: Record<string, unknown>;
    };
    expect(schema.properties).toBeDefined();
    expect(schema.properties).not.toHaveProperty("runLoop");
  });

  it("tool descriptions do not reference resident daemon loop or PID", async () => {
    const res = await rpc("tools/list", 31);
    const result = res.result as { tools: ToolDef[] };
    const staleTerms = [/\brunLoop\b/i, /\brunning\s*loop\b/i, /\bresident\b/i, /\bpid\b/i];
    for (const tool of result.tools) {
      for (const re of staleTerms) {
        expect(
          re.test(tool.description),
          `tool "${tool.name}" description matches stale term ${re}: "${tool.description}"`,
        ).toBe(false);
      }
    }
  });

  it("get_status description does not reference runningLoop or pid", async () => {
    const res = await rpc("tools/list", 32);
    const result = res.result as { tools: ToolDef[] };
    const statusTool = result.tools.find((t) => t.name === "get_status") as ToolDef;
    expect(statusTool).toBeDefined();
    expect(statusTool.description).not.toMatch(/runningLoop/);
    expect(statusTool.description).not.toMatch(/\bpid\b/i);
  });

  it("start_trading description mentions cron-managed or one-shot execution", async () => {
    const res = await rpc("tools/list", 33);
    const result = res.result as { tools: ToolDef[] };
    const startTool = result.tools.find((t) => t.name === "start_trading") as ToolDef;
    expect(startTool).toBeDefined();
    expect(startTool.description).toMatch(/cron|one-shot|scheduled/i);
  });

  it("execute_tick description reflects one-shot behavior", async () => {
    const res = await rpc("tools/list", 34);
    const result = res.result as { tools: ToolDef[] };
    const tickTool = result.tools.find((t) => t.name === "execute_tick") as ToolDef;
    expect(tickTool).toBeDefined();
    expect(tickTool.description).not.toMatch(/daemon tick/i);
  });

  it("stop_trading description reflects lifecycle-accurate wording", async () => {
    const res = await rpc("tools/list", 35);
    const result = res.result as { tools: ToolDef[] };
    const stopTool = result.tools.find((t) => t.name === "stop_trading") as ToolDef;
    expect(stopTool).toBeDefined();
    expect(stopTool.description).toMatch(/start_trading|re-arm/i);
  });
});

describe("MCP tools/call routing", () => {
  it("missing tool name returns -32602", async () => {
    const res = await rpc("tools/call", 20, { arguments: {} });
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toContain("Missing required param: name");
  });

  it("unknown tool name returns -32602", async () => {
    const res = await rpc("tools/call", 21, { name: "nonexistent_tool", arguments: {} });
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toContain("Unknown tool: nonexistent_tool");
  });

  it("get_status returns bootstrap guidance when runtime state is missing", async () => {
    const res = await rpc("tools/call", 22, { name: "get_status", arguments: {} });
    expect(res.error).toBeUndefined();

    const result = res.result as ToolCallResult;
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    const payload = JSON.parse(result.content[0].text) as {
      bootstrapRequired: boolean;
      reason: string;
      nextActions: Array<{ tool: string }>;
    };
    expect(payload.bootstrapRequired).toBe(true);
    expect(payload.reason).toBe("runtime-state-missing");
    expect(payload.nextActions.map((action) => action.tool)).toContain("create_wallet");
  });

  it("get_tick_context returns bootstrap guidance when runtime state is missing", async () => {
    const res = await rpc("tools/call", 22.01, { name: "get_tick_context", arguments: {} });
    expect(res.error).toBeUndefined();

    const result = res.result as ToolCallResult;
    const payload = JSON.parse(result.content[0].text) as {
      bootstrapRequired: boolean;
      reason: string;
      execution: { defaultOrderStyle: string; selectedOrderStyle: string };
    };

    expect(payload.bootstrapRequired).toBe(true);
    expect(payload.reason).toBe("runtime-state-missing");
    expect(payload.execution.defaultOrderStyle).toBe("ioc");
    expect(payload.execution.selectedOrderStyle).toBe("ioc");
  });

  it("get_onboarding_status returns bootstrap guidance when runtime state is missing", async () => {
    const res = await rpc("tools/call", 22.02, { name: "get_onboarding_status", arguments: {} });
    expect(res.error).toBeUndefined();

    const result = res.result as ToolCallResult;
    const payload = JSON.parse(result.content[0].text) as {
      bootstrapRequired: boolean;
      reason: string;
      nextActions: Array<{ tool: string }>;
    };

    expect(payload.bootstrapRequired).toBe(true);
    expect(payload.reason).toBe("runtime-state-missing");
    expect(payload.nextActions.map((action) => action.tool)).toContain("create_wallet");
  });

  it("execute_tick returns bootstrap guidance when runtime state is missing", async () => {
    const res = await rpc("tools/call", 22.03, { name: "execute_tick", arguments: {} });
    expect(res.error).toBeUndefined();

    const result = res.result as ToolCallResult;
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as {
      bootstrapRequired: boolean;
      reason: string;
      execution: { defaultOrderStyle: string; selectedOrderStyle: string };
    };

    expect(payload.bootstrapRequired).toBe(true);
    expect(payload.reason).toBe("runtime-state-missing");
    expect(payload.execution.defaultOrderStyle).toBe("ioc");
    expect(payload.execution.selectedOrderStyle).toBe("ioc");
  });

  it("start_trading returns bootstrap guidance when runtime state is missing", async () => {
    const res = await rpc("tools/call", 22.04, { name: "start_trading", arguments: {} });
    expect(res.error).toBeUndefined();

    const result = res.result as ToolCallResult;
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as {
      bootstrapRequired: boolean;
      reason: string;
      nextActions: Array<{ tool: string }>;
    };

    expect(payload.bootstrapRequired).toBe(true);
    expect(payload.reason).toBe("runtime-state-missing");
    expect(payload.nextActions.map((action) => action.tool)).toContain("create_wallet");
  });

  it("stop_trading returns bootstrap guidance when runtime state is missing", async () => {
    const res = await rpc("tools/call", 22.06, { name: "stop_trading", arguments: {} });
    expect(res.error).toBeUndefined();

    const result = res.result as ToolCallResult;
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as {
      bootstrapRequired: boolean;
      reason: string;
      nextActions: Array<{ tool: string }>;
    };

    expect(payload.bootstrapRequired).toBe(true);
    expect(payload.reason).toBe("runtime-state-missing");
    expect(payload.nextActions.map((action) => action.tool)).toContain("create_wallet");
  });

  it("deposit_to_hyperliquid returns bootstrap guidance when runtime state is missing", async () => {
    const res = await rpc("tools/call", 22.07, {
      name: "deposit_to_hyperliquid",
      arguments: {},
    });
    expect(res.error).toBeUndefined();

    const result = res.result as ToolCallResult;
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as {
      bootstrapRequired: boolean;
      reason: string;
      nextActions: Array<{ tool: string }>;
    };

    expect(payload.bootstrapRequired).toBe(true);
    expect(payload.reason).toBe("runtime-state-missing");
    expect(payload.nextActions.map((action) => action.tool)).toContain("create_wallet");
  });

  it("reset_override_phrase returns bootstrap guidance when runtime state is missing", async () => {
    const res = await rpc("tools/call", 22.08, {
      name: "reset_override_phrase",
      arguments: {},
    });
    expect(res.error).toBeUndefined();

    const result = res.result as ToolCallResult;
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as {
      bootstrapRequired: boolean;
      reason: string;
      nextActions: Array<{ tool: string }>;
    };

    expect(payload.bootstrapRequired).toBe(true);
    expect(payload.reason).toBe("runtime-state-missing");
    expect(payload.nextActions.map((action) => action.tool)).toContain("create_wallet");
  });

  it("cleanup_mnemonic_file returns bootstrap guidance when runtime state is missing", async () => {
    const res = await rpc("tools/call", 22.09, {
      name: "cleanup_mnemonic_file",
      arguments: { action: "archive" },
    });
    expect(res.error).toBeUndefined();

    const result = res.result as ToolCallResult;
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as {
      bootstrapRequired: boolean;
      reason: string;
      nextActions: Array<{ tool: string }>;
    };

    expect(payload.bootstrapRequired).toBe(true);
    expect(payload.reason).toBe("runtime-state-missing");
    expect(payload.nextActions.map((action) => action.tool)).toContain("create_wallet");
  });

  it("execute_tick rejects invalid order styles before invocation", async () => {
    const res = await rpc("tools/call", 22.05, {
      name: "execute_tick",
      arguments: {
        intent: {
          action: "target-position",
          orderStyle: "day",
          rationale: "invalid order style",
        },
      },
    });

    expect(res.error).toBeUndefined();
    const result = res.result as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/orderStyle must be one of: ioc, gtc/i);
  });

  it("execute_tick rejects malformed explicit intents before invocation", async () => {
    const res = await rpc("tools/call", 22.06, {
      name: "execute_tick",
      arguments: {
        intent: {
          action: "hold",
          side: "short",
          rationale: "holding",
        },
      },
    });

    expect(res.error).toBeUndefined();
    const result = res.result as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(
      /intent.side is only supported when intent.action is "target-position"/i,
    );
  });

  it("rejects non-object arguments for a known tool before invocation", async () => {
    const res = await rpc("tools/call", 22.1, { name: "get_status", arguments: [] });
    expect(res.error).toEqual({
      code: -32602,
      message: "Invalid params: arguments must be an object",
    });
    expect(res.result).toBeUndefined();
  });

  it("rejects missing required tool arguments before invocation", async () => {
    const res = await rpc("tools/call", 22.2, { name: "set_v4t_token", arguments: {} });
    expect(res.error).toEqual({
      code: -32602,
      message: "Invalid params: missing required argument: token",
    });
    expect(res.result).toBeUndefined();
  });

  it("rejects wrong-typed union arguments before invocation", async () => {
    const res = await rpc("tools/call", 22.3, {
      name: "set_v4t_token",
      arguments: { token: 42 },
    });
    expect(res.error).toEqual({
      code: -32602,
      message: 'Invalid params: argument "token" must be of type string | null',
    });
    expect(res.result).toBeUndefined();
  });

  it("rejects wrong-typed declared properties before invocation", async () => {
    const res = await rpc("tools/call", 22.4, {
      name: "get_trade_history",
      arguments: { limit: "ten" },
    });
    expect(res.error).toEqual({
      code: -32602,
      message: 'Invalid params: argument "limit" must be of type number',
    });
    expect(res.result).toBeUndefined();
  });

  it("handler error returns isError true with error message in content", async () => {
    const res = await rpc("tools/call", 23, { name: "confirm_backup", arguments: {} });
    expect(res.error).toBeUndefined();

    const result = res.result as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it("reset_override_phrase clears persisted acceptance without altering cumulative history", async () => {
    const state = createRuntimeState({
      wallet: {
        address: "0x1234567890abcdef1234567890ABCDEF12345678",
        privateKey: `0x${"ab".repeat(32)}`,
      },
      market: {
        venue: "hyperliquid",
        mode: "perp",
        marketId: "perps:hyperliquid:BTC-PERP",
        symbol: "BTC-PERP",
      },
      overridePhraseAccepted: true,
      bridgeHistory: [
        {
          transferId: "bridge-1",
          amountUsd: "150",
          confirmedAt: "2026-03-27T10:00:00.000Z",
        },
      ],
    });

    await mkdir(RUNTIME_DIR, { recursive: true });
    await writeFile(STATE_FILE, serializeRuntimeState(state), "utf8");

    try {
      const res = await rpc("tools/call", 24, { name: "reset_override_phrase", arguments: {} });
      expect(res.error).toBeUndefined();

      const result = res.result as ToolCallResult;
      const payload = JSON.parse(result.content[0].text) as {
        reset: boolean;
        overridePhraseAccepted: boolean;
        cumulativeBridgeUsd: string;
        bridgeHistoryCount: number;
      };

      expect(payload).toMatchObject({
        reset: true,
        overridePhraseAccepted: false,
        cumulativeBridgeUsd: "150",
        bridgeHistoryCount: 1,
      });

      const persisted = JSON.parse(await readFile(STATE_FILE, "utf8")) as {
        overridePhraseAccepted: boolean;
        cumulativeBridgeUsd: string;
        bridgeHistory: unknown[];
      };
      expect(persisted.overridePhraseAccepted).toBe(false);
      expect(persisted.cumulativeBridgeUsd).toBe("150");
      expect(persisted.bridgeHistory).toHaveLength(1);
    } finally {
      await rm(STATE_FILE, { force: true });
    }
  });
});

describe("MCP operator-control tools", () => {
  const TEST_MARKET = {
    venue: "hyperliquid",
    mode: "perp",
    marketId: "perps:hyperliquid:BTC-PERP",
    symbol: "BTC-PERP",
  } as const;

  const TEST_AGENT_MD_CACHE = {
    url: "https://example.com/agents.md",
    version: "1.0.0",
    lastUpdated: "2026-03-27T10:00:00.000Z",
    apiContractVersion: "1",
    status: "active",
    etag: null,
    hash: "abc123",
    fetchedAt: "2026-03-27T10:00:00.000Z",
    tradingOptions: {
      models: ["openclaw-daemon"],
      strategies: ["aggressive", "balanced", "conservative"],
      pairs: [
        TEST_MARKET,
        {
          venue: "hyperliquid",
          mode: "perp",
          marketId: "perps:hyperliquid:ETH-PERP",
          symbol: "ETH-PERP",
        },
      ],
      recommended: {
        pair: "BTC-PERP",
        strategy: "balanced",
        model: "openclaw-daemon",
      },
    },
  };

  function createTestState(overrides: Record<string, unknown> = {}) {
    return createRuntimeState({
      wallet: {
        address: "0x1234567890abcdef1234567890ABCDEF12345678",
        privateKey: `0x${"ab".repeat(32)}`,
      },
      market: TEST_MARKET,
      ...overrides,
    });
  }

  async function setupState(overrides: Record<string, unknown> = {}) {
    await mkdir(RUNTIME_DIR, { recursive: true });
    await writeFile(STATE_FILE, serializeRuntimeState(createTestState(overrides)), "utf8");
  }

  async function setupAgentMdCache() {
    await mkdir(RUNTIME_DIR, { recursive: true });
    await writeFile(
      AGENT_MD_CACHE_FILE,
      serializeAgentMdCacheState(TEST_AGENT_MD_CACHE as never),
      "utf8",
    );
  }

  async function cleanup() {
    await rm(STATE_FILE, { force: true });
    await rm(AGENT_MD_CACHE_FILE, { force: true });
  }

  it("acknowledge_live_trading requires confirmed: true and persists acknowledgment", async () => {
    await setupState();

    try {
      const res = await rpc("tools/call", 40, {
        name: "acknowledge_live_trading",
        arguments: { confirmed: true },
      });
      expect(res.error).toBeUndefined();

      const result = res.result as ToolCallResult;
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content[0].text) as {
        acknowledged: boolean;
        acknowledgedAt: string;
        walletAddress: string;
      };
      expect(payload.acknowledged).toBe(true);
      expect(payload.acknowledgedAt).toBeTruthy();

      const persisted = JSON.parse(await readFile(STATE_FILE, "utf8")) as {
        liveTradingConsent: { acknowledged: boolean; acknowledgedAt: string | null };
      };
      expect(persisted.liveTradingConsent.acknowledged).toBe(true);
      expect(persisted.liveTradingConsent.acknowledgedAt).toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it("acknowledge_live_trading rejects missing confirmed argument", async () => {
    const res = await rpc("tools/call", 41, {
      name: "acknowledge_live_trading",
      arguments: {},
    });
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toContain("missing required argument: confirmed");
  });

  it("set_trading_selection persists selection and survives restart", async () => {
    await setupState();
    await setupAgentMdCache();

    try {
      const res = await rpc("tools/call", 42, {
        name: "set_trading_selection",
        arguments: { pair: "BTC-PERP", strategy: "balanced", model: "openclaw-daemon" },
      });
      expect(res.error).toBeUndefined();

      const result = res.result as ToolCallResult;
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content[0].text) as {
        selected: boolean;
        tradingSelection: { optionId: string };
      };
      expect(payload.selected).toBe(true);
      expect(payload.tradingSelection.optionId).toBe("BTC-PERP|balanced|openclaw-daemon");

      const persisted = JSON.parse(await readFile(STATE_FILE, "utf8")) as {
        tradingSelection: { optionId: string; market: { symbol: string } } | null;
      };
      expect(persisted.tradingSelection).not.toBeNull();
      expect(persisted.tradingSelection?.optionId).toBe("BTC-PERP|balanced|openclaw-daemon");
      expect(persisted.tradingSelection?.market.symbol).toBe("BTC-PERP");
    } finally {
      await cleanup();
    }
  });

  it("set_trading_selection rejects invalid pair", async () => {
    await setupState();
    await setupAgentMdCache();

    try {
      const res = await rpc("tools/call", 43, {
        name: "set_trading_selection",
        arguments: { pair: "NONEXISTENT", strategy: "balanced", model: "openclaw-daemon" },
      });
      expect(res.error).toBeUndefined();

      const result = res.result as ToolCallResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid pair");
      expect(result.content[0].text).toContain("NONEXISTENT");
    } finally {
      await cleanup();
    }
  });

  it("accept_override_phrase persists override acceptance", async () => {
    await setupState();

    try {
      const res = await rpc("tools/call", 44, {
        name: "accept_override_phrase",
        arguments: { confirmed: true },
      });
      expect(res.error).toBeUndefined();

      const result = res.result as ToolCallResult;
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content[0].text) as {
        accepted: boolean;
        overridePhraseAccepted: boolean;
      };
      expect(payload.accepted).toBe(true);
      expect(payload.overridePhraseAccepted).toBe(true);

      const persisted = JSON.parse(await readFile(STATE_FILE, "utf8")) as {
        overridePhraseAccepted: boolean;
      };
      expect(persisted.overridePhraseAccepted).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("accept_override_phrase rejects missing confirmed argument", async () => {
    const res = await rpc("tools/call", 45, {
      name: "accept_override_phrase",
      arguments: {},
    });
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toContain("missing required argument: confirmed");
  });

  it("cleanup_mnemonic_file rejects when backup not confirmed", async () => {
    await setupState();

    try {
      const res = await rpc("tools/call", 46, {
        name: "cleanup_mnemonic_file",
        arguments: { action: "archive" },
      });
      expect(res.error).toBeUndefined();

      const result = res.result as ToolCallResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('must be "confirmed"');
    } finally {
      await cleanup();
    }
  });

  it("cleanup_mnemonic_file rejects missing action argument", async () => {
    const res = await rpc("tools/call", 47, {
      name: "cleanup_mnemonic_file",
      arguments: {},
    });
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toContain("missing required argument: action");
  });

  it("get_trading_options returns catalog from agent-md cache", async () => {
    await setupAgentMdCache();

    try {
      const res = await rpc("tools/call", 48, {
        name: "get_trading_options",
        arguments: {},
      });
      expect(res.error).toBeUndefined();

      const result = res.result as ToolCallResult;
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content[0].text) as {
        available: boolean;
        models: string[];
        strategies: string[];
        pairs: Array<{ symbol: string; marketId: string; venue: string; mode: string }>;
        recommended: { pair: string; strategy: string; model: string } | null;
      };
      expect(payload.available).toBe(true);
      expect(payload.models).toEqual(["openclaw-daemon"]);
      expect(payload.strategies).toEqual(["aggressive", "balanced", "conservative"]);
      expect(payload.pairs).toHaveLength(2);
      expect(payload.pairs[0].symbol).toBe("BTC-PERP");
      expect(payload.recommended).toEqual({
        pair: "BTC-PERP",
        strategy: "balanced",
        model: "openclaw-daemon",
      });
    } finally {
      await cleanup();
    }
  });

  it("get_trading_options returns unavailable when no cache exists", async () => {
    await rm(AGENT_MD_CACHE_FILE, { force: true });

    const res = await rpc("tools/call", 49, {
      name: "get_trading_options",
      arguments: {},
    });
    expect(res.error).toBeUndefined();

    const result = res.result as ToolCallResult;
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text) as {
      available: boolean;
      reason: string;
      message: string;
    };
    expect(payload.available).toBe(false);
    expect(payload.reason).toBe("agent-md-cache-missing");
    expect(payload.message).toMatch(/get_tick_context or execute_tick/i);
  });
});
