import { STATE_FILE_PATH } from "../config/paths";
import { SchemaValidationError } from "../config/validation";
import {
  StateReadError,
  readRuntimeStateFile,
  updateRuntimeStateFile,
} from "../daemon/runtime-state-file";
import { parseRuntimeState } from "../state";
import type { RuntimeState } from "../state";

const V4T_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]+$/;
const MAX_V4T_TOKEN_LENGTH = 2048;

export function parseVibe4TradingToken(value: string): string {
  const token = value.trim();
  if (token.length === 0) {
    throw new SchemaValidationError("vibe4trading token must not be empty.");
  }

  if (token.length > MAX_V4T_TOKEN_LENGTH) {
    throw new SchemaValidationError("vibe4trading token is too long.");
  }

  if (!V4T_TOKEN_PATTERN.test(token)) {
    throw new SchemaValidationError("vibe4trading token contains invalid characters.");
  }

  return token;
}

export function isValidVibe4TradingToken(value: string): boolean {
  try {
    parseVibe4TradingToken(value);
    return true;
  } catch (error) {
    console.warn(
      `isValidVibe4TradingToken: rejected — ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

function withPersistedVibe4TradingToken(state: RuntimeState, token: string | null): RuntimeState {
  return parseRuntimeState({
    ...state,
    vibe4tradingToken: token === null ? null : parseVibe4TradingToken(token),
  });
}

export async function readPersistedVibe4TradingToken(
  options: {
    readonly stateFilePath?: string;
  } = {},
): Promise<string | null> {
  try {
    const state = await readRuntimeStateFile(options.stateFilePath ?? STATE_FILE_PATH);
    return state.vibe4tradingToken;
  } catch (error) {
    if (isMissingStateReadError(error)) {
      return null;
    }

    throw error;
  }
}

export async function persistVibe4TradingToken(
  token: string | null,
  options: {
    readonly stateFilePath?: string;
  } = {},
): Promise<RuntimeState> {
  const stateFilePath = options.stateFilePath ?? STATE_FILE_PATH;
  try {
    return await updateRuntimeStateFile(stateFilePath, (currentState) =>
      withPersistedVibe4TradingToken(currentState, token),
    );
  } catch (error) {
    if (isMissingStateReadError(error)) {
      throw new SchemaValidationError(
        `Cannot persist vibe4trading token without an existing runtime state file at ${stateFilePath}.`,
      );
    }

    throw error;
  }
}

function isMissingStateReadError(error: unknown): error is StateReadError {
  return error instanceof StateReadError && error.message.includes("does not exist");
}
