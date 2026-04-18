import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DaemonPidLockError,
  acquireDaemonPidLock,
  inspectDaemonPidFile,
  parsePidText,
} from "../src/daemon/pid-lock";
import type { ProcessLivenessChecker } from "../src/daemon/pid-lock";

let tmpDir: string;
let pidFilePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pid-lock-test-"));
  pidFilePath = join(tmpDir, "daemon.pid");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function alwaysDead(): ProcessLivenessChecker {
  return () => false;
}

function alwaysAlive(): ProcessLivenessChecker {
  return () => true;
}

function aliveForPids(...pids: number[]): ProcessLivenessChecker {
  return (pid: number) => pids.includes(pid);
}

describe("parsePidText", () => {
  it("parses a valid positive integer", () => {
    expect(parsePidText("1234\n")).toBe(1234);
  });

  it("parses a value with surrounding whitespace", () => {
    expect(parsePidText("  42  \n")).toBe(42);
  });

  it("returns null for empty string", () => {
    expect(parsePidText("")).toBeNull();
  });

  it("returns null for whitespace-only", () => {
    expect(parsePidText("   \n")).toBeNull();
  });

  it("returns null for zero", () => {
    expect(parsePidText("0")).toBeNull();
  });

  it("returns null for negative numbers", () => {
    expect(parsePidText("-1")).toBeNull();
    expect(parsePidText("-99999")).toBeNull();
  });

  it("returns null for floats", () => {
    expect(parsePidText("3.14")).toBeNull();
    expect(parsePidText("0.5")).toBeNull();
  });

  it("returns null for NaN text", () => {
    expect(parsePidText("NaN")).toBeNull();
    expect(parsePidText("abc")).toBeNull();
  });

  it("returns null for Infinity", () => {
    expect(parsePidText("Infinity")).toBeNull();
    expect(parsePidText("-Infinity")).toBeNull();
  });

  it("returns null for numbers exceeding safe integer range", () => {
    expect(parsePidText("9007199254740993")).toBeNull();
  });
});

describe("inspectDaemonPidFile", () => {
  it("returns pid:null isAlive:false when file does not exist", async () => {
    const result = await inspectDaemonPidFile({
      pidFilePath,
      isProcessAlive: alwaysAlive(),
    });
    expect(result).toEqual({ pid: null, isAlive: false });
  });

  it("returns pid:null isAlive:false for corrupt content", async () => {
    writeFileSync(pidFilePath, "not-a-number\n");
    const result = await inspectDaemonPidFile({
      pidFilePath,
      isProcessAlive: alwaysAlive(),
    });
    expect(result).toEqual({ pid: null, isAlive: false });
  });

  it("returns alive status for a live PID", async () => {
    writeFileSync(pidFilePath, "42\n");
    const result = await inspectDaemonPidFile({
      pidFilePath,
      isProcessAlive: alwaysAlive(),
    });
    expect(result).toEqual({ pid: 42, isAlive: true });
  });

  it("returns dead status for a dead PID", async () => {
    writeFileSync(pidFilePath, "99999\n");
    const result = await inspectDaemonPidFile({
      pidFilePath,
      isProcessAlive: alwaysDead(),
    });
    expect(result).toEqual({ pid: 99999, isAlive: false });
  });

  it("delegates liveness check to the provided checker", async () => {
    writeFileSync(pidFilePath, "100\n");
    const checker = vi.fn().mockReturnValue(true);
    await inspectDaemonPidFile({ pidFilePath, isProcessAlive: checker });
    expect(checker).toHaveBeenCalledWith(100);
  });
});

describe("acquireDaemonPidLock", () => {
  it("acquires lock when no PID file exists", async () => {
    const handle = await acquireDaemonPidLock({
      currentPid: 1000,
      isProcessAlive: alwaysDead(),
      pidFilePath,
    });

    expect(handle.replacedStalePid).toBe(false);
    expect(handle.existingPid).toBeNull();

    const content = readFileSync(pidFilePath, "utf8");
    expect(content.trim()).toBe("1000");

    await handle.release();
  });

  it("replaces stale PID file from a dead process", async () => {
    writeFileSync(pidFilePath, "99999\n");

    const handle = await acquireDaemonPidLock({
      currentPid: 2000,
      isProcessAlive: alwaysDead(),
      pidFilePath,
    });

    expect(handle.replacedStalePid).toBe(true);
    expect(handle.existingPid).toBe(99999);

    const content = readFileSync(pidFilePath, "utf8");
    expect(content.trim()).toBe("2000");

    await handle.release();
  });

  it("throws when a live PID file exists", async () => {
    writeFileSync(pidFilePath, "5555\n");

    await expect(
      acquireDaemonPidLock({
        currentPid: 3000,
        isProcessAlive: aliveForPids(5555),
        pidFilePath,
      }),
    ).rejects.toThrow(DaemonPidLockError);

    await expect(
      acquireDaemonPidLock({
        currentPid: 3000,
        isProcessAlive: aliveForPids(5555),
        pidFilePath,
      }),
    ).rejects.toThrow(/already running.*5555/);
  });

  it("throws when stale PID file contains corrupt data but still blocks on retry", async () => {
    writeFileSync(pidFilePath, "garbage-content\n");

    const handle = await acquireDaemonPidLock({
      currentPid: 4000,
      isProcessAlive: alwaysDead(),
      pidFilePath,
    });

    expect(handle.replacedStalePid).toBe(true);
    expect(handle.existingPid).toBeNull();

    const content = readFileSync(pidFilePath, "utf8");
    expect(content.trim()).toBe("4000");

    await handle.release();
  });

  it("rejects when PID file is replaced by live process between inspect and unlink", async () => {
    writeFileSync(pidFilePath, "7777\n");

    let livenessCallCount = 0;
    const checker: ProcessLivenessChecker = (pid) => {
      livenessCallCount++;
      if (livenessCallCount === 1 && pid === 7777) {
        const replacementPath = join(tmpDir, "replacement.pid");
        writeFileSync(replacementPath, "8888\n");
        renameSync(replacementPath, pidFilePath);
        return false;
      }
      if (pid === 8888) return true;
      return false;
    };

    await expect(
      acquireDaemonPidLock({
        currentPid: 9000,
        isProcessAlive: checker,
        pidFilePath,
      }),
    ).rejects.toThrow(DaemonPidLockError);

    await expect(
      acquireDaemonPidLock({
        currentPid: 9000,
        isProcessAlive: checker,
        pidFilePath,
      }),
    ).rejects.toThrow(/already running.*8888/);
  });
});

describe("release semantics", () => {
  it("release removes PID file when PID matches", async () => {
    const handle = await acquireDaemonPidLock({
      currentPid: 6000,
      isProcessAlive: alwaysDead(),
      pidFilePath,
    });

    const contentBefore = readFileSync(pidFilePath, "utf8");
    expect(contentBefore.trim()).toBe("6000");

    await handle.release();

    expect(() => readFileSync(pidFilePath)).toThrow();
  });

  it("release does NOT remove PID file when PID does not match", async () => {
    const handle = await acquireDaemonPidLock({
      currentPid: 7000,
      isProcessAlive: alwaysDead(),
      pidFilePath,
    });

    writeFileSync(pidFilePath, "9999\n");

    await handle.release();

    const content = readFileSync(pidFilePath, "utf8");
    expect(content.trim()).toBe("9999");
  });

  it("release is idempotent when file already removed", async () => {
    const handle = await acquireDaemonPidLock({
      currentPid: 8000,
      isProcessAlive: alwaysDead(),
      pidFilePath,
    });

    await handle.release();
    await expect(handle.release()).resolves.toBeUndefined();
  });
});

describe("edge cases", () => {
  it("creates parent directories if they do not exist", async () => {
    const nested = join(tmpDir, "deep", "nested", "daemon.pid");

    const handle = await acquireDaemonPidLock({
      currentPid: 10000,
      isProcessAlive: alwaysDead(),
      pidFilePath: nested,
    });

    const content = readFileSync(nested, "utf8");
    expect(content.trim()).toBe("10000");

    await handle.release();
  });

  it("PID file has mode 0o600", async () => {
    const { statSync } = await import("node:fs");

    const handle = await acquireDaemonPidLock({
      currentPid: 11000,
      isProcessAlive: alwaysDead(),
      pidFilePath,
    });

    const stat = statSync(pidFilePath);
    expect(stat.mode & 0o777).toBe(0o600);

    await handle.release();
  });
});
