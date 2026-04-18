import { chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { MNEMONIC_FILE_MODE } from "../config/paths";
import { isNodeError } from "../daemon/errors";
import { StateReadError } from "../daemon/runtime-state-file";
import { readRuntimeStateFile, updateRuntimeStateFile } from "../daemon/runtime-state-file";
import { parseRuntimeState } from "../state";
import type { RuntimeState, WalletBackupStatus } from "../state";
import { buildOnboardingBootstrapGuidance } from "./bootstrap-guidance";

export async function cleanup_mnemonic_file(args: {
  readonly action: "archive" | "delete";
  readonly stateFilePath?: string;
}) {
  const { action, stateFilePath } = args;

  if (action !== "archive" && action !== "delete") {
    throw new Error('cleanup_mnemonic_file action must be "archive" or "delete".');
  }

  let state: RuntimeState;
  try {
    state = stateFilePath
      ? await readRuntimeStateFile(stateFilePath)
      : await readRuntimeStateFile();
  } catch (error) {
    if (error instanceof StateReadError) {
      return buildOnboardingBootstrapGuidance();
    }

    throw error;
  }

  const mnemonicFilePath = state.wallet.mnemonicFilePath;

  // Early guard: reject immediately if backup isn't confirmed.
  // The updater lambdas below re-check inside the atomic read-modify-write
  // to cover TOCTOU races, but this early check avoids irreversible file
  // operations (rename / delete) when the status is obviously wrong.
  if (state.walletBackup.status !== "confirmed") {
    throw new Error(
      `Cannot cleanup mnemonic file: wallet backup status is "${state.walletBackup.status}", must be "confirmed". Confirm backup first via confirm_backup.`,
    );
  }

  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(mnemonicFilePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        `Mnemonic file not found at ${mnemonicFilePath}. It may have already been cleaned up.`,
      );
    }
    throw error;
  }

  const mode = fileStat.mode & 0o777;
  if (mode !== MNEMONIC_FILE_MODE) {
    throw new Error(
      `Mnemonic file at ${mnemonicFilePath} has mode ${mode.toString(8)}, expected 600. Refusing to proceed — file permissions are unsafe.`,
    );
  }

  const now = new Date().toISOString();
  const targetStatus: WalletBackupStatus = action === "archive" ? "archived" : "deleted";

  if (action === "archive") {
    const archiveDir = dirname(mnemonicFilePath);
    const archiveName = `${mnemonicFilePath}.archived-${Date.now()}`;

    const updater = (current: RuntimeState) => {
      if (current.walletBackup.status !== "confirmed") {
        throw new Error(
          `Cannot cleanup mnemonic file: wallet backup status is "${current.walletBackup.status}", must be "confirmed". Confirm backup first via confirm_backup.`,
        );
      }
      return parseRuntimeState({
        ...current,
        walletBackup: {
          ...current.walletBackup,
          status: targetStatus,
          cleanedUpAt: now,
        },
      });
    };

    const updatedState = stateFilePath
      ? await updateRuntimeStateFile(stateFilePath, updater)
      : await updateRuntimeStateFile(updater);

    await mkdir(archiveDir, { recursive: true });
    await rename(mnemonicFilePath, archiveName);
    await chmod(archiveName, MNEMONIC_FILE_MODE);

    return {
      action,
      completed: true,
      walletBackupStatus: updatedState.walletBackup.status,
      message: `Mnemonic file archived. Original path: ${mnemonicFilePath}`,
      archivedPath: archiveName,
    };
  }

  // For delete: persist state first, THEN remove the file.
  // Ordering rationale: if the process crashes after the state write but before
  // the rm, the file still exists on disk but state says "deleted" — the operator
  // can re-run cleanup or manually remove the file. This is recoverable.
  // The previous order (rm then write) was not: a crash left the file
  // unrecoverably gone while state still said "confirmed", with no recovery path.
  const updater = (current: RuntimeState) => {
    if (current.walletBackup.status !== "confirmed") {
      throw new Error(
        `Cannot cleanup mnemonic file: wallet backup status is "${current.walletBackup.status}", must be "confirmed". Confirm backup first via confirm_backup.`,
      );
    }
    return parseRuntimeState({
      ...current,
      walletBackup: {
        ...current.walletBackup,
        status: targetStatus,
        cleanedUpAt: now,
      },
    });
  };

  const updatedState = stateFilePath
    ? await updateRuntimeStateFile(stateFilePath, updater)
    : await updateRuntimeStateFile(updater);

  await rm(mnemonicFilePath, { force: true });

  return {
    action,
    completed: true,
    walletBackupStatus: updatedState.walletBackup.status,
    message: `Mnemonic file permanently deleted from ${mnemonicFilePath}.`,
  };
}
