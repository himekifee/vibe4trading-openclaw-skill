import { mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { STATE_FILE_PATH } from "../config/paths";
import { deserializeRuntimeState, serializeRuntimeState } from "../state";
import type { RuntimeState } from "../state";
import { isNodeError, toErrorMessage } from "./errors";

const RUNTIME_STATE_FILE_LOCK_RETRY_MS = 10;
const RUNTIME_STATE_FILE_LOCK_TIMEOUT_MS = 5_000;

export type RuntimeStateUpdater = (state: RuntimeState) => RuntimeState;

export type StateReadErrorCode = "ENOENT" | "PARSE_ERROR";

export class StateReadError extends Error {
  readonly code: StateReadErrorCode;

  constructor(message: string, options?: { cause?: unknown; code?: StateReadErrorCode }) {
    super(message, options);
    this.name = "StateReadError";
    this.code = options?.code ?? "PARSE_ERROR";
  }
}

/**
 * Minimal wallet + market info recovered from a corrupt/unparseable state file.
 * Used for best-effort emergency cleanup when full deserialization fails.
 */
export type RawRecoveredState = {
  readonly walletAddress: string | null;
  readonly mnemonicFilePath: string | null;
  readonly marketId: string | null;
  readonly marketSymbol: string | null;
};

/**
 * Attempt to read the raw file text and extract wallet/market fields
 * without full schema validation.  Returns `null` if the file is missing
 * or completely unreadable; returns a best-effort `RawRecoveredState` for
 * corrupt/partial JSON.
 */
export async function readRawRuntimeStateFile(
  stateFilePath: string = STATE_FILE_PATH,
): Promise<RawRecoveredState | null> {
  let rawText: string;
  try {
    rawText = await readFile(stateFilePath, "utf8");
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(rawText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { walletAddress: null, mnemonicFilePath: null, marketId: null, marketSymbol: null };
    }
    const obj = parsed as Record<string, unknown>;

    const walletAddress = extractNestedString(obj, "wallet", "address");
    const mnemonicFilePath = extractNestedString(obj, "wallet", "mnemonicFilePath");
    const marketId = extractNestedString(obj, "market", "marketId");
    const marketSymbol = extractNestedString(obj, "market", "symbol");

    return { walletAddress, mnemonicFilePath, marketId, marketSymbol };
  } catch {
    return { walletAddress: null, mnemonicFilePath: null, marketId: null, marketSymbol: null };
  }
}

function extractNestedString(
  obj: Record<string, unknown>,
  key: string,
  subKey: string,
): string | null {
  const nested = obj[key];
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
    return null;
  }
  const value = (nested as Record<string, unknown>)[subKey];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export class StateWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StateWriteError";
  }
}

export async function readRuntimeStateFile(
  stateFilePath: string = STATE_FILE_PATH,
): Promise<RuntimeState> {
  try {
    const jsonText = await readFile(stateFilePath, "utf8");
    return deserializeRuntimeState(jsonText);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new StateReadError(`Runtime state file does not exist at ${stateFilePath}.`, {
        code: "ENOENT",
      });
    }

    throw new StateReadError(
      `Failed to read runtime state file at ${stateFilePath}: ${toErrorMessage(error)}`,
      { cause: error, code: "PARSE_ERROR" },
    );
  }
}

export class StateExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateExistsError";
  }
}

export async function initializeRuntimeStateFile(
  state: RuntimeState,
  stateFilePath: string = STATE_FILE_PATH,
): Promise<void> {
  const serializedState = serializeRuntimeState(state);
  await mkdir(dirname(stateFilePath), { recursive: true });

  let fileHandle: FileHandle | undefined;
  try {
    fileHandle = await open(stateFilePath, "wx", 0o600);
    await fileHandle.writeFile(serializedState, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new StateExistsError(
        `Runtime state file already exists at ${stateFilePath}. Refusing to overwrite.`,
      );
    }
    throw new StateWriteError(
      `Failed to initialize runtime state file at ${stateFilePath}: ${toErrorMessage(error)}`,
      { cause: error },
    );
  } finally {
    if (fileHandle !== undefined) {
      await fileHandle.close();
    }
  }
}

export async function persistRuntimeStateFile(
  state: RuntimeState,
  stateFilePath: string = STATE_FILE_PATH,
): Promise<void> {
  const tempFilePath = `${stateFilePath}.tmp-${process.pid}-${Date.now()}`;

  try {
    const serializedState = serializeRuntimeState(state);
    await mkdir(dirname(stateFilePath), { recursive: true });
    await writeFile(tempFilePath, serializedState, { encoding: "utf8", mode: 0o600 });
    await rename(tempFilePath, stateFilePath);
  } catch (error) {
    await cleanupTempFile(tempFilePath);
    throw new StateWriteError(
      `Failed to persist runtime state file at ${stateFilePath}: ${toErrorMessage(error)}`,
      { cause: error },
    );
  }
}

async function withRuntimeStateFileLock<T>(
  stateFilePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = `${stateFilePath}.lock`;
  const lockHandle = await acquireRuntimeStateFileLock(lockPath);

  try {
    return await fn();
  } finally {
    await releaseRuntimeStateFileLock(lockHandle, lockPath);
  }
}

export function updateRuntimeStateFile(updater: RuntimeStateUpdater): Promise<RuntimeState>;
export function updateRuntimeStateFile(
  stateFilePath: string,
  updater: RuntimeStateUpdater,
): Promise<RuntimeState>;
export async function updateRuntimeStateFile(
  stateFilePathOrUpdater: string | RuntimeStateUpdater = STATE_FILE_PATH,
  maybeUpdater?: RuntimeStateUpdater,
): Promise<RuntimeState> {
  const [stateFilePath, updater] =
    typeof stateFilePathOrUpdater === "function"
      ? [STATE_FILE_PATH, stateFilePathOrUpdater]
      : [stateFilePathOrUpdater, maybeUpdater];

  if (updater === undefined) {
    throw new StateWriteError("Runtime state updater must be provided.");
  }

  return withRuntimeStateFileLock(stateFilePath, async () => {
    const currentState = await readRuntimeStateFile(stateFilePath);
    const nextState = updater(currentState);
    if (isPromiseLike(nextState)) {
      throw new StateWriteError("Runtime state updater must be synchronous.");
    }
    if (nextState === currentState) {
      return currentState;
    }
    await persistRuntimeStateFile(nextState, stateFilePath);
    return nextState;
  });
}

async function cleanupTempFile(tempFilePath: string): Promise<void> {
  try {
    await rm(tempFilePath, { force: true });
  } catch (error) {
    console.warn(`cleanupTempFile: failed to remove ${tempFilePath} — ${toErrorMessage(error)}`);
  }
}

async function acquireRuntimeStateFileLock(lockPath: string): Promise<FileHandle> {
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(dirname(lockPath), { recursive: true });
      const lockHandle = await open(lockPath, "wx", 0o600);
      try {
        await lockHandle.writeFile(buildRuntimeStateLockPayload(), "utf8");
      } catch (error) {
        await cleanupLockFile(lockHandle, lockPath);
        throw new StateWriteError(
          `Failed to initialize runtime state file lock at ${lockPath}: ${toErrorMessage(error)}`,
          { cause: error },
        );
      }
      return lockHandle;
    } catch (error) {
      if (error instanceof StateWriteError) {
        throw error;
      }

      if (isNodeError(error) && error.code === "EEXIST") {
        const removed = await tryRemoveZombieLock(lockPath);
        if (removed) {
          continue;
        }

        if (Date.now() - startedAt >= RUNTIME_STATE_FILE_LOCK_TIMEOUT_MS) {
          throw new StateWriteError(
            `Timed out acquiring runtime state file lock at ${lockPath} after ${RUNTIME_STATE_FILE_LOCK_TIMEOUT_MS}ms.`,
          );
        }

        await delay(RUNTIME_STATE_FILE_LOCK_RETRY_MS);
        continue;
      }

      throw new StateWriteError(
        `Failed to acquire runtime state file lock at ${lockPath}: ${toErrorMessage(error)}`,
        { cause: error },
      );
    }
  }
}

async function tryRemoveZombieLock(lockPath: string): Promise<boolean> {
  try {
    const lockContent = await readFile(lockPath, "utf8");
    const parsed: unknown = JSON.parse(lockContent.trim());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    const pid = (parsed as Record<string, unknown>).pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      return false;
    }

    try {
      process.kill(pid, 0);
      return false;
    } catch {
      await unlink(lockPath).catch((unlinkError) => {
        console.warn(
          `tryRemoveZombieLock: failed to unlink zombie lock at ${lockPath} — ${toErrorMessage(unlinkError)}`,
        );
      });
      return true;
    }
  } catch (error) {
    console.warn(
      `tryRemoveZombieLock: unable to inspect lock at ${lockPath} — ${toErrorMessage(error)}`,
    );
    return false;
  }
}

async function releaseRuntimeStateFileLock(
  lockHandle: FileHandle,
  lockPath: string,
): Promise<void> {
  let releaseError: unknown = null;

  try {
    await lockHandle.close();
  } catch (error) {
    releaseError = error;
  }

  try {
    await unlink(lockPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      releaseError = releaseError ?? error;
    }
  }

  if (releaseError !== null) {
    throw new StateWriteError(
      `Failed to release runtime state file lock at ${lockPath}: ${toErrorMessage(releaseError)}`,
      { cause: releaseError },
    );
  }
}

async function cleanupLockFile(lockHandle: FileHandle, lockPath: string): Promise<void> {
  try {
    await lockHandle.close();
  } catch (error) {
    console.warn(`cleanupLockFile: failed to close handle — ${toErrorMessage(error)}`);
  }

  try {
    await unlink(lockPath);
  } catch (error) {
    console.warn(`cleanupLockFile: failed to unlink ${lockPath} — ${toErrorMessage(error)}`);
  }
}

function buildRuntimeStateLockPayload(): string {
  return `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`;
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    (typeof value === "object" || typeof value === "function") && value !== null && "then" in value
  );
}
