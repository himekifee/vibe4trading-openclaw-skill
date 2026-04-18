import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { DAEMON_PID_FILE_PATH } from "../config/paths";
import { isNodeError, toErrorMessage } from "./errors";

export class DaemonPidLockError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DaemonPidLockError";
  }
}

export type ProcessLivenessChecker = (pid: number) => boolean;

export type PidFileStatus = {
  readonly pid: number | null;
  readonly isAlive: boolean;
};

export type PidLockHandle = {
  readonly replacedStalePid: boolean;
  readonly existingPid: number | null;
  release: () => Promise<void>;
};

type InspectedPidFile = {
  readonly pidText: string;
  readonly dev: number;
  readonly ino: number;
};

export async function inspectDaemonPidFile(
  options: {
    readonly pidFilePath?: string;
    readonly isProcessAlive: ProcessLivenessChecker;
  } = {
    isProcessAlive: () => false,
  },
): Promise<PidFileStatus> {
  const pidFilePath = options.pidFilePath ?? DAEMON_PID_FILE_PATH;

  try {
    const pidText = await readFile(pidFilePath, "utf8");
    const pid = parsePidText(pidText);
    if (pid === null) {
      return { pid: null, isAlive: false };
    }

    return {
      pid,
      isAlive: options.isProcessAlive(pid),
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { pid: null, isAlive: false };
    }

    throw error;
  }
}

export async function acquireDaemonPidLock(options: {
  readonly currentPid: number;
  readonly isProcessAlive: ProcessLivenessChecker;
  readonly pidFilePath?: string;
}): Promise<PidLockHandle> {
  const pidFilePath = options.pidFilePath ?? DAEMON_PID_FILE_PATH;
  await mkdir(dirname(pidFilePath), { recursive: true });

  return tryAcquirePidLock({
    currentPid: options.currentPid,
    isProcessAlive: options.isProcessAlive,
    pidFilePath,
    hasRetried: false,
  });
}

async function tryAcquirePidLock(options: {
  readonly currentPid: number;
  readonly isProcessAlive: ProcessLivenessChecker;
  readonly pidFilePath: string;
  readonly hasRetried: boolean;
}): Promise<PidLockHandle> {
  try {
    await writeFile(options.pidFilePath, `${options.currentPid}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    return {
      replacedStalePid: options.hasRetried,
      existingPid: null,
      release: async () => {
        await releasePidLock(options.pidFilePath, options.currentPid);
      },
    };
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw new DaemonPidLockError(
        `Failed to create daemon pid file at ${options.pidFilePath}: ${toErrorMessage(error)}`,
        { cause: error },
      );
    }

    const inspectedFile = await inspectPidFileInstance(options.pidFilePath);
    const status =
      inspectedFile === null
        ? { pid: null, isAlive: false }
        : buildPidFileStatus(inspectedFile.pidText, options.isProcessAlive);

    if (status.pid !== null && status.isAlive) {
      throw new DaemonPidLockError(`Another daemon is already running (PID ${status.pid}).`);
    }

    if (options.hasRetried) {
      throw new DaemonPidLockError(
        `Unable to replace stale daemon pid file at ${options.pidFilePath}.`,
      );
    }

    // TOCTOU mitigation: re-verify stale PID before unlink to narrow race window
    const recheck = await readFile(options.pidFilePath, "utf8").catch((err) => {
      if (isNodeError(err) && err.code === "ENOENT") return null;
      throw err;
    });
    if (recheck !== null) {
      const recheckPid = parsePidText(recheck);
      if (recheckPid !== null && recheckPid !== status.pid) {
        if (options.isProcessAlive(recheckPid)) {
          throw new DaemonPidLockError(`Another daemon is already running (PID ${recheckPid}).`);
        }
      }
    }

    try {
      if (inspectedFile !== null) {
        const revalidatedStat = await stat(options.pidFilePath).catch((err) => {
          if (isNodeError(err) && err.code === "ENOENT") return null;
          throw err;
        });
        if (
          revalidatedStat !== null &&
          revalidatedStat.dev === inspectedFile.dev &&
          revalidatedStat.ino === inspectedFile.ino
        ) {
          await unlink(options.pidFilePath);
        }
      }
    } catch (unlinkError) {
      if (!isNodeError(unlinkError) || unlinkError.code !== "ENOENT") {
        throw new DaemonPidLockError(
          `Failed to remove stale daemon pid file at ${options.pidFilePath}: ${toErrorMessage(unlinkError)}`,
          { cause: unlinkError },
        );
      }
    }

    await delay(10);

    const handle = await tryAcquirePidLock({
      ...options,
      hasRetried: true,
    });

    return {
      ...handle,
      existingPid: status.pid,
    };
  }
}

async function releasePidLock(pidFilePath: string, currentPid: number): Promise<void> {
  try {
    const pidText = await readFile(pidFilePath, "utf8");
    const pid = parsePidText(pidText);
    if (pid !== currentPid) {
      return;
    }

    await unlink(pidFilePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }

    throw error;
  }
}

export function parsePidText(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const pid = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }

  return pid;
}

const PID_FILE_INSPECT_MAX_ITERATIONS = 100;

async function inspectPidFileInstance(pidFilePath: string): Promise<InspectedPidFile | null> {
  for (let iteration = 0; iteration < PID_FILE_INSPECT_MAX_ITERATIONS; iteration++) {
    const beforeStat = await stat(pidFilePath).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }

      throw error;
    });
    if (beforeStat === null) {
      return null;
    }

    const pidText = await readFile(pidFilePath, "utf8").catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }

      throw error;
    });
    if (pidText === null) {
      return null;
    }

    const afterStat = await stat(pidFilePath).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }

      throw error;
    });
    if (afterStat === null) {
      return null;
    }

    if (beforeStat.dev === afterStat.dev && beforeStat.ino === afterStat.ino) {
      return {
        pidText,
        dev: beforeStat.dev,
        ino: beforeStat.ino,
      };
    }
  }

  throw new DaemonPidLockError(
    `inspectPidFileInstance: pid file ${pidFilePath} was replaced ${PID_FILE_INSPECT_MAX_ITERATIONS} times during inspection — aborting`,
  );
}

function buildPidFileStatus(
  pidText: string,
  isProcessAlive: ProcessLivenessChecker,
): PidFileStatus {
  const pid = parsePidText(pidText);
  if (pid === null) {
    return { pid: null, isAlive: false };
  }

  return {
    pid,
    isAlive: isProcessAlive(pid),
  };
}
