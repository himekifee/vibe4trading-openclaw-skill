import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./config/constants";
import { SchemaValidationError } from "./config/validation";
import { validateExecuteTickInput } from "./daemon/engine";
import type { ExecuteTickInput } from "./daemon/engine";
import { readRuntimeStateFile } from "./daemon/runtime-state-file";
import type { AllowedOrderStyle } from "./daemon/types";
import {
  accept_override_phrase,
  acknowledge_live_trading,
  cleanup_mnemonic_file,
  confirm_backup,
  create_wallet,
  deposit_to_hyperliquid,
  execute_tick,
  get_onboarding_status,
  get_status,
  get_tick_context,
  get_trade_history,
  get_trading_options,
  recover_mnemonic,
  reset_override_phrase,
  set_trading_selection,
  set_v4t_token,
  start_trading,
  stop_trading,
} from "./tools";

type JsonRpcRequest = {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

type JsonRpcNotification = {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification;

type JsonSchemaType = "array" | "boolean" | "null" | "number" | "object" | "string";

type JsonSchemaLiteralValue = boolean | number | string | null;

type ToolArgumentValidationError = {
  readonly message: string;
  readonly surface: "tool" | "transport";
};

type ToolSchemaBase = {
  readonly type: JsonSchemaType | readonly JsonSchemaType[];
  readonly description?: string;
  readonly properties?: Record<string, ToolPropertySchema>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly enum?: readonly JsonSchemaLiteralValue[];
  readonly const?: JsonSchemaLiteralValue;
  readonly minLength?: number;
};

type ToolPropertySchema = ToolSchemaBase;

type ToolInputSchema = ToolSchemaBase & {
  readonly type: "object";
};

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
};

type JsonRpcResponse = {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
};

const SERVER_INFO = {
  name: "openclaw-trading",
  version: "0.1.0",
};

const PROTOCOL_VERSION = "2024-11-05";

// mcp.json is the single source of truth for tools/list definitions.
const MCP_MANIFEST_PATH = resolve(REPO_ROOT, "mcp.json");
const mcpManifest = JSON.parse(readFileSync(MCP_MANIFEST_PATH, "utf-8")) as {
  tools: ToolDefinition[];
};
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = mcpManifest.tools;

type ToolInvoker = (args: Record<string, unknown>) => Promise<unknown>;

const TOOL_INVOKERS: Record<string, ToolInvoker> = {
  create_wallet: async (args) => {
    // Pass mnemonicDisplayedAt into create_wallet so that the timestamp is
    // recorded in the single initial write, avoiding a two-write pattern where
    // a crash between the unlocked persist and the locked update could leave
    // the state without a display timestamp.
    const now = new Date().toISOString();
    const result = await create_wallet({
      path: args.path as string | undefined,
      mnemonicDisplayedAt: now,
    });

    if ("walletAlreadyExists" in result) {
      return result;
    }

    return {
      address: result.wallet.address,
      mnemonicFilePath: result.wallet.mnemonicFilePath,
      mnemonic: result.wallet.mnemonic,
      displayedAt: now,
      backupStatus: result.runtimeState.walletBackup.status,
      warning:
        "Back up this mnemonic NOW. It will not be shown again. Call confirm_backup when done.",
    };
  },
  confirm_backup: async () => {
    return confirm_backup();
  },
  recover_mnemonic: async (args) => {
    // Guard: refuse recovery if the operator has already archived or deleted
    // the mnemonic file through the cleanup lifecycle. Reading the state file
    // on every call also acts as a natural rate-limiter (file I/O + lock
    // contention).
    const state = await readRuntimeStateFile();
    const backupStatus = state.walletBackup.status;
    if (backupStatus === "archived" || backupStatus === "deleted") {
      throw new Error(
        `Cannot recover mnemonic: wallet backup status is "${backupStatus}". The mnemonic file has been cleaned up and recovery is no longer permitted.`,
      );
    }

    const mnemonic = recover_mnemonic({ path: args.path as string | undefined });
    return {
      mnemonic,
      warning: "This is a deliberate local recovery from the desktop file. Store securely.",
    };
  },
  get_onboarding_status: async () => get_onboarding_status(),
  deposit_to_hyperliquid: async (args) =>
    deposit_to_hyperliquid({ amountUsdc: args.amountUsdc as string | undefined }),
  reset_override_phrase: async () => reset_override_phrase(),
  set_v4t_token: async (args) => set_v4t_token({ token: args.token as string | null }),
  start_trading: async () => start_trading(),
  stop_trading: async () => stop_trading(),
  get_tick_context: async (args) => get_tick_context(normalizeExecuteTickArgs(args)),
  execute_tick: async (args) => execute_tick(normalizeExecuteTickArgs(args)),
  get_status: async () => get_status(),
  get_trade_history: async (args) => get_trade_history(args.limit as number | undefined),
  acknowledge_live_trading: async (args) =>
    acknowledge_live_trading({ confirmed: args.confirmed as true }),
  get_trading_options: async () => get_trading_options(),
  set_trading_selection: async (args) =>
    set_trading_selection({
      pair: args.pair as string,
      strategy: args.strategy as string,
      model: args.model as string,
    }),
  accept_override_phrase: async (args) =>
    accept_override_phrase({ confirmed: args.confirmed as true }),
  cleanup_mnemonic_file: async (args) => {
    const action = args.action;
    if (action !== "archive" && action !== "delete") {
      throw new Error(`Invalid cleanup_mnemonic_file action: ${String(action)}`);
    }
    return cleanup_mnemonic_file({ action });
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcRequestEnvelope(value: unknown): value is JsonRpcRequest {
  if (!isPlainObject(value)) {
    return false;
  }

  if (value.jsonrpc !== "2.0" || typeof value.method !== "string") {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(value, "id")) {
    return false;
  }

  if (value.id !== null && typeof value.id !== "number" && typeof value.id !== "string") {
    return false;
  }

  return value.params === undefined || isPlainObject(value.params);
}

function isJsonRpcNotificationEnvelope(value: unknown): value is JsonRpcNotification {
  if (!isPlainObject(value)) {
    return false;
  }

  if (value.jsonrpc !== "2.0" || typeof value.method !== "string") {
    return false;
  }

  if (
    Object.prototype.hasOwnProperty.call(value, "id") ||
    !value.method.startsWith("notifications/")
  ) {
    return false;
  }

  return value.params === undefined || isPlainObject(value.params);
}

function hasRequestId(message: JsonRpcMessage): message is JsonRpcRequest {
  return Object.prototype.hasOwnProperty.call(message, "id");
}

function matchesJsonSchemaType(
  type: JsonSchemaType | readonly JsonSchemaType[],
  value: unknown,
): boolean {
  if (Array.isArray(type)) {
    return type.some((candidate) => matchesJsonSchemaType(candidate, value));
  }

  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "number":
      return typeof value === "number";
    case "object":
      return isPlainObject(value);
    case "string":
      return typeof value === "string";
    default:
      return false;
  }
}

function formatSchemaType(type: JsonSchemaType | readonly JsonSchemaType[]): string {
  return Array.isArray(type) ? type.join(" | ") : String(type);
}

function formatSchemaLiteralValue(value: JsonSchemaLiteralValue): string {
  return typeof value === "string" ? value : String(value);
}

function formatSchemaPath(path: readonly string[]): string {
  return path.join(".");
}

function createSchemaValueError(
  kind: "const" | "enum" | "minLength",
  path: readonly string[],
  schema: ToolPropertySchema,
): ToolArgumentValidationError {
  const argumentName = formatSchemaPath(path);

  if (kind === "enum") {
    const enumValues = schema.enum ?? [];
    return {
      message: `${argumentName} must be one of: ${enumValues.map(formatSchemaLiteralValue).join(", ")}.`,
      surface: "tool",
    };
  }

  if (kind === "const") {
    const constValue = formatSchemaLiteralValue(schema.const ?? null);
    if (argumentName === "acknowledge_live_trading.confirmed") {
      return {
        message: "acknowledge_live_trading requires { confirmed: true }.",
        surface: "tool",
      };
    }

    if (argumentName === "accept_override_phrase.confirmed") {
      return {
        message: "accept_override_phrase requires { confirmed: true }.",
        surface: "tool",
      };
    }

    return {
      message: `${argumentName} must equal ${constValue}.`,
      surface: "tool",
    };
  }

  return {
    message: `${argumentName} must be a non-empty string.`,
    surface: "tool",
  };
}

function normalizeExecuteTickArgs(args: Record<string, unknown>): ExecuteTickInput {
  const rawIntent = args.intent;
  let intent: ExecuteTickInput["intent"];

  if (rawIntent !== undefined) {
    if (!isPlainObject(rawIntent)) {
      throw new SchemaValidationError("execute_tick.intent must be an object.");
    }
    const ri = rawIntent as Record<string, unknown>;

    if (typeof ri.action !== "string") {
      throw new SchemaValidationError("execute_tick.intent.action must be a string.");
    }
    if (ri.side !== undefined && typeof ri.side !== "string") {
      throw new SchemaValidationError("execute_tick.intent.side must be a string.");
    }
    if (ri.targetFraction !== undefined && typeof ri.targetFraction !== "string") {
      throw new SchemaValidationError("execute_tick.intent.targetFraction must be a string.");
    }
    if (ri.leverage !== undefined && typeof ri.leverage !== "number") {
      throw new SchemaValidationError("execute_tick.intent.leverage must be a number.");
    }
    if (ri.orderStyle !== undefined && typeof ri.orderStyle !== "string") {
      throw new SchemaValidationError("execute_tick.intent.orderStyle must be a string.");
    }
    if (ri.rationale !== undefined && typeof ri.rationale !== "string") {
      throw new SchemaValidationError("execute_tick.intent.rationale must be a string.");
    }

    intent = {
      action: ri.action as "hold" | "target-position",
      side: ri.side as "long" | "short" | "flat" | undefined,
      targetFraction: ri.targetFraction as string | undefined,
      leverage: ri.leverage as number | undefined,
      orderStyle: ri.orderStyle as AllowedOrderStyle | undefined,
      rationale: ri.rationale as string | undefined,
    };
  }

  const normalized: ExecuteTickInput = {
    slotId: typeof args.slotId === "string" ? args.slotId : undefined,
    intent,
  };
  validateExecuteTickInput(normalized);
  return normalized;
}

function validateSchemaValue(
  schema: ToolInputSchema | ToolPropertySchema,
  value: unknown,
  path: readonly string[],
): ToolArgumentValidationError | null {
  const argumentName = path.join(".");
  const isRoot = path.length === 0;

  if (!matchesJsonSchemaType(schema.type, value)) {
    if (isRoot) {
      return { message: "Invalid params: arguments must be an object", surface: "transport" };
    }

    return {
      message: `Invalid params: argument "${argumentName}" must be of type ${formatSchemaType(schema.type)}`,
      surface: "transport",
    };
  }

  if (
    Object.prototype.hasOwnProperty.call(schema, "const") &&
    value !== schema.const &&
    path.length > 0
  ) {
    return createSchemaValueError("const", path, schema);
  }

  if (
    schema.enum !== undefined &&
    !schema.enum.includes(value as JsonSchemaLiteralValue) &&
    path.length > 0
  ) {
    return createSchemaValueError("enum", path, schema);
  }

  if (
    schema.minLength !== undefined &&
    typeof value === "string" &&
    value.trim().length < schema.minLength
  ) {
    return path.length > 0 ? createSchemaValueError("minLength", path, schema) : null;
  }

  if (!isPlainObject(value)) {
    return null;
  }

  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return {
        message: `Invalid params: missing required argument: ${[...path, key].join(".")}`,
        surface: "transport",
      };
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        return {
          message: `Invalid params: unexpected argument: ${[...path, key].join(".")}`,
          surface: "transport",
        };
      }
    }
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const property = properties[key];
    if (!property) {
      continue;
    }

    const error = validateSchemaValue(property, nestedValue, [...path, key]);
    if (error !== null) {
      return error;
    }
  }

  return null;
}

function validateToolArguments(
  schema: ToolInputSchema,
  args: unknown,
): ToolArgumentValidationError | null {
  if (schema.type !== "object") {
    return { message: "Invalid params: arguments must be an object", surface: "transport" };
  }

  return validateSchemaValue(schema, args, []);
}

function handleInitialize(request: JsonRpcRequest): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: request.id,
    result: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    },
  };
}

function handleToolsList(request: JsonRpcRequest): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: request.id,
    result: { tools: TOOL_DEFINITIONS },
  };
}

async function handleToolsCall(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const params = request.params ?? {};
  const toolName = typeof params.name === "string" ? params.name : undefined;
  if (!toolName) {
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32602, message: "Missing required param: name" },
    };
  }

  const invoker = TOOL_INVOKERS[toolName];
  if (!invoker) {
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32602, message: `Unknown tool: ${toolName}` },
    };
  }

  const schema = TOOL_DEFINITIONS.find((tool) => tool.name === toolName)?.inputSchema;
  const rawArgs = params.arguments ?? {};
  const validationError = schema ? validateToolArguments(schema, rawArgs) : null;
  if (validationError !== null) {
    if (validationError.surface === "tool") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: `[SchemaValidationError] ${validationError.message}` }],
          isError: true,
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32602, message: validationError.message },
    };
  }

  try {
    const args = rawArgs as Record<string, unknown>;
    const result = await invoker(args);
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      },
    };
  } catch (err) {
    const errorName = err instanceof Error ? err.constructor.name : "UnknownError";
    const message = err instanceof Error ? err.message : String(err);
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text: `[${errorName}] ${message}` }],
        isError: true,
      },
    };
  }
}

async function handleRequest(request: JsonRpcMessage): Promise<JsonRpcResponse | null> {
  if (!hasRequestId(request)) {
    return null;
  }

  switch (request.method) {
    case "initialize":
      return handleInitialize(request);
    case "notifications/initialized":
      return null;
    case "tools/list":
      return handleToolsList(request);
    case "tools/call":
      return handleToolsCall(request);
    default:
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `Method not found: ${request.method}` },
      };
  }
}

function sendResponse(json: JsonRpcResponse): void {
  const body = JSON.stringify(json);
  const bytes = new TextEncoder().encode(body);
  process.stdout.write(`Content-Length: ${bytes.byteLength}\r\n\r\n`);
  process.stdout.write(bytes);
}

async function dispatch(raw: string): Promise<void> {
  try {
    const request = JSON.parse(raw);
    if (!isJsonRpcRequestEnvelope(request) && !isJsonRpcNotificationEnvelope(request)) {
      sendResponse({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      });
      return;
    }

    const response = await handleRequest(request);
    if (response !== null) {
      sendResponse(response);
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      sendResponse({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    } else {
      console.error(
        `dispatch: unhandled error — ${err instanceof Error ? err.message : String(err)}`,
      );
      sendResponse({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "Internal error" },
      });
    }
  }
}

/**
 * Supports Content-Length framed (MCP/LSP stdio: `Content-Length: <n>\r\n\r\n<json>`)
 * and newline-delimited JSON fallback for manual testing.
 */
async function main(): Promise<void> {
  let buf = Buffer.alloc(0);

  for await (const chunk of Bun.stdin.stream()) {
    buf = Buffer.concat([buf, Buffer.from(chunk)]);

    while (true) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        const headerSection = buf.subarray(0, headerEnd).toString("utf8");
        const match = /^Content-Length:\s*(\d+)/im.exec(headerSection);
        if (match) {
          const contentLength = Number(match[1]);
          const bodyStart = headerEnd + 4;
          if (buf.byteLength >= bodyStart + contentLength) {
            const body = buf.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
            buf = buf.subarray(bodyStart + contentLength);
            await dispatch(body);
            continue;
          }
          break;
        }
      }

      const newlineIdx = buf.indexOf(0x0a);
      if (newlineIdx === -1) {
        break;
      }
      const line = buf.subarray(0, newlineIdx).toString("utf8").trim();
      buf = buf.subarray(newlineIdx + 1);
      if (line.length > 0) {
        await dispatch(line);
      }
    }
  }

  const remaining = buf.toString("utf8").trim();
  if (remaining.length > 0) {
    await dispatch(remaining);
  }
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error("Unhandled error in MCP server:", error);
    process.exitCode = 1;
  });
}
