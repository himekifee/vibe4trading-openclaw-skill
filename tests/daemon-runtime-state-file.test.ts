import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  StateExistsError,
  StateReadError,
  StateWriteError,
  initializeRuntimeStateFile,
  persistRuntimeStateFile,
  readRawRuntimeStateFile,
  readRuntimeStateFile,
  updateRuntimeStateFile,
} from "../src/daemon/runtime-state-file";
import { type RuntimeState, createRuntimeState, serializeRuntimeState } from "../src/state";

function makeTestState(
  overrides?: Partial<Parameters<typeof createRuntimeState>[0]>,
): RuntimeState {
  return createRuntimeState({
    wallet: {
      address: "0x1234567890abcdef1234567890ABCDEF12345678",
      privateKey: `0x${"ab".repeat(32)}`,
    },
    market: {
      venue: "hyperliquid",
      mode: "perp",
      marketId: "perps:hyperliquid:ETH",
      symbol: "ETH",
    },
    ...overrides,
  });
}

describe("daemon/runtime-state-file", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "state-file-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("read/write round-trip", () => {
    it("persists and reads back a minimal state", async () => {
      const filePath = join(tmpDir, "state.json");
      const state = makeTestState();

      await persistRuntimeStateFile(state, filePath);
      const loaded = await readRuntimeStateFile(filePath);

      expect(loaded).toEqual(state);
    });

    it("persists and reads back a state with bridge history and pending transfers", async () => {
      const filePath = join(tmpDir, "state.json");
      const state = makeTestState({
        bridgeHistory: [
          {
            transferId: "bridge-1",
            amountUsd: "10.5",
            confirmedAt: "2026-03-27T10:00:00.000Z",
          },
        ],
        pendingBridgeTransfers: [
          {
            idempotencyKey: "key-1",
            txHash: "0xabc123",
            amountUsdc: "5",
            submittedAt: "2026-03-27T11:00:00.000Z",
          },
        ],
        vibe4tradingToken: "tok-abc",
        lastExecutedSlot: "2026-03-27T11:30:00.000Z",
        lastSuggestionId: "sugg-1",
        daemonStatus: "running",
        overridePhraseAccepted: true,
        exchangeActivity: { hasOpenPosition: true, hasPendingOrder: false },
      });

      await persistRuntimeStateFile(state, filePath);
      const loaded = await readRuntimeStateFile(filePath);

      expect(loaded).toEqual(state);
    });

    it("overwrites a previous state file on subsequent persist", async () => {
      const filePath = join(tmpDir, "state.json");

      const stateA = makeTestState({ daemonStatus: "stopped" });
      await persistRuntimeStateFile(stateA, filePath);

      const stateB = makeTestState({ daemonStatus: "running" });
      await persistRuntimeStateFile(stateB, filePath);

      const loaded = await readRuntimeStateFile(filePath);
      expect(loaded.daemonStatus).toBe("running");
    });

    it("produces valid JSON on disk", async () => {
      const filePath = join(tmpDir, "state.json");
      const state = makeTestState();
      await persistRuntimeStateFile(state, filePath);

      const raw = readFileSync(filePath, "utf8");
      expect(() => JSON.parse(raw)).not.toThrow();
    });
  });

  describe("missing file", () => {
    it("throws StateReadError for nonexistent path", async () => {
      const filePath = join(tmpDir, "no-such-file.json");

      await expect(readRuntimeStateFile(filePath)).rejects.toThrow(StateReadError);
    });

    it("includes file path in the error message", async () => {
      const filePath = join(tmpDir, "no-such-file.json");

      await expect(readRuntimeStateFile(filePath)).rejects.toThrow(filePath);
    });

    it("includes 'does not exist' in the error message", async () => {
      const filePath = join(tmpDir, "no-such-file.json");

      await expect(readRuntimeStateFile(filePath)).rejects.toThrow("does not exist");
    });
  });

  describe("corrupt file", () => {
    it("throws StateReadError for invalid JSON", async () => {
      const filePath = join(tmpDir, "state.json");
      writeFileSync(filePath, "NOT_JSON{{{{", "utf8");

      await expect(readRuntimeStateFile(filePath)).rejects.toThrow(StateReadError);
    });

    it("throws StateReadError for valid JSON but invalid schema", async () => {
      const filePath = join(tmpDir, "state.json");
      writeFileSync(filePath, JSON.stringify({ foo: "bar" }), "utf8");

      await expect(readRuntimeStateFile(filePath)).rejects.toThrow(StateReadError);
    });

    it("throws StateReadError for empty file", async () => {
      const filePath = join(tmpDir, "state.json");
      writeFileSync(filePath, "", "utf8");

      await expect(readRuntimeStateFile(filePath)).rejects.toThrow(StateReadError);
    });

    it("throws StateReadError for partial/truncated JSON", async () => {
      const filePath = join(tmpDir, "state.json");
      const state = makeTestState();
      const serialized = JSON.stringify(state);
      writeFileSync(filePath, serialized.slice(0, serialized.length / 2), "utf8");

      await expect(readRuntimeStateFile(filePath)).rejects.toThrow(StateReadError);
    });
  });

  describe("atomic write behavior", () => {
    it("creates parent directories if they do not exist", async () => {
      const filePath = join(tmpDir, "nested", "deep", "state.json");
      const state = makeTestState();

      await persistRuntimeStateFile(state, filePath);
      const loaded = await readRuntimeStateFile(filePath);

      expect(loaded).toEqual(state);
    });

    it("does not leave temp files after successful write", async () => {
      const filePath = join(tmpDir, "state.json");
      const state = makeTestState();

      await persistRuntimeStateFile(state, filePath);

      const files = readdirSync(tmpDir);
      expect(files).toEqual(["state.json"]);
    });

    it("serializes concurrent runtime-state updates without losing writes", async () => {
      const filePath = join(tmpDir, "state.json");
      await persistRuntimeStateFile(makeTestState(), filePath);

      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          updateRuntimeStateFile(filePath, (state) => ({
            ...state,
            bridgeHistory: [
              ...state.bridgeHistory,
              {
                transferId: `bridge-${index + 1}`,
                amountUsd: "1",
                confirmedAt: `2026-03-27T12:${String(index).padStart(2, "0")}:00.000Z`,
              },
            ],
            cumulativeBridgeUsd: String(state.bridgeHistory.length + 1),
          })),
        ),
      );

      const loaded = await readRuntimeStateFile(filePath);

      expect(loaded.bridgeHistory).toHaveLength(10);
      expect(new Set(loaded.bridgeHistory.map((entry) => entry.transferId)).size).toBe(10);
      expect(loaded.cumulativeBridgeUsd).toBe("10");
      expect(readdirSync(tmpDir).sort()).toEqual(["state.json"]);
    });
  });

  describe("write failure", () => {
    it("throws StateWriteError when directory cannot be created", async () => {
      const filePath = "/dev/null/impossible/state.json";
      const state = makeTestState();

      await expect(persistRuntimeStateFile(state, filePath)).rejects.toThrow(StateWriteError);
    });

    it("StateWriteError includes the target path in message", async () => {
      const filePath = "/dev/null/impossible/state.json";
      const state = makeTestState();

      await expect(persistRuntimeStateFile(state, filePath)).rejects.toThrow(
        /\/dev\/null\/impossible\/state\.json/,
      );
    });
  });

  describe("error types", () => {
    it("StateReadError is an instance of Error", () => {
      const err = new StateReadError("test");
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("StateReadError");
      expect(err.message).toBe("test");
    });

    it("StateWriteError is an instance of Error", () => {
      const err = new StateWriteError("test");
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("StateWriteError");
      expect(err.message).toBe("test");
    });

    it("StateReadError and StateWriteError are distinguishable", () => {
      const readErr = new StateReadError("read fail");
      const writeErr = new StateWriteError("write fail");

      expect(readErr).not.toBeInstanceOf(StateWriteError);
      expect(writeErr).not.toBeInstanceOf(StateReadError);
      expect(readErr.name).not.toBe(writeErr.name);
    });

    it("errors can be caught by type", async () => {
      const filePath = join(tmpDir, "nonexistent.json");
      let caught: unknown;

      try {
        await readRuntimeStateFile(filePath);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(StateReadError);
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(StateWriteError);
    });

    it("StateReadError defaults code to PARSE_ERROR when not specified", () => {
      const err = new StateReadError("test");
      expect(err.code).toBe("PARSE_ERROR");
    });

    it("StateReadError accepts explicit code", () => {
      const err = new StateReadError("missing", { code: "ENOENT" });
      expect(err.code).toBe("ENOENT");
    });
  });

  describe("StateReadError.code discrimination", () => {
    it("missing file produces code ENOENT", async () => {
      const filePath = join(tmpDir, "no-such-file.json");

      try {
        await readRuntimeStateFile(filePath);
        expect.unreachable("should throw");
      } catch (error) {
        expect(error).toBeInstanceOf(StateReadError);
        expect((error as StateReadError).code).toBe("ENOENT");
      }
    });

    it("corrupt JSON produces code PARSE_ERROR", async () => {
      const filePath = join(tmpDir, "state.json");
      writeFileSync(filePath, "{{INVALID", "utf8");

      try {
        await readRuntimeStateFile(filePath);
        expect.unreachable("should throw");
      } catch (error) {
        expect(error).toBeInstanceOf(StateReadError);
        expect((error as StateReadError).code).toBe("PARSE_ERROR");
      }
    });

    it("valid JSON with invalid schema produces code PARSE_ERROR", async () => {
      const filePath = join(tmpDir, "state.json");
      writeFileSync(filePath, JSON.stringify({ not: "a-state" }), "utf8");

      try {
        await readRuntimeStateFile(filePath);
        expect.unreachable("should throw");
      } catch (error) {
        expect(error).toBeInstanceOf(StateReadError);
        expect((error as StateReadError).code).toBe("PARSE_ERROR");
      }
    });
  });

  describe("readRawRuntimeStateFile", () => {
    it("returns null for nonexistent file", async () => {
      const filePath = join(tmpDir, "no-such-file.json");
      const result = await readRawRuntimeStateFile(filePath);
      expect(result).toBeNull();
    });

    it("recovers wallet and market from valid state JSON", async () => {
      const filePath = join(tmpDir, "state.json");
      const state = makeTestState();
      await persistRuntimeStateFile(state, filePath);

      const result = await readRawRuntimeStateFile(filePath);
      if (result === null) throw new Error("expected non-null");
      expect(result.walletAddress).toBe("0x1234567890abcdef1234567890ABCDEF12345678");
      expect(result.privateKey).toBe(`0x${"ab".repeat(32)}`);
      expect(result.marketId).toBe("perps:hyperliquid:ETH");
      expect(result.marketSymbol).toBe("ETH");
    });

    it("recovers wallet info from corrupt state with valid wallet block", async () => {
      const filePath = join(tmpDir, "state.json");
      const partialJson = JSON.stringify({
        wallet: {
          address: "0xAABBCCDDEE1234567890aabbccddeeff12345678",
          privateKey: `0x${"ab".repeat(32)}`,
        },
        market: { marketId: "perps:hyperliquid:BTC", symbol: "BTC" },
        badField: "causes schema validation to fail",
      });
      writeFileSync(filePath, partialJson, "utf8");

      const result = await readRawRuntimeStateFile(filePath);
      if (result === null) throw new Error("expected non-null");
      expect(result.walletAddress).toBe("0xAABBCCDDEE1234567890aabbccddeeff12345678");
      expect(result.privateKey).toBe(`0x${"ab".repeat(32)}`);
      expect(result.marketId).toBe("perps:hyperliquid:BTC");
      expect(result.marketSymbol).toBe("BTC");
    });

    it("returns nulls for completely invalid JSON", async () => {
      const filePath = join(tmpDir, "state.json");
      writeFileSync(filePath, "{{NOT_JSON_AT_ALL", "utf8");

      const result = await readRawRuntimeStateFile(filePath);
      if (result === null) throw new Error("expected non-null");
      expect(result.walletAddress).toBeNull();
      expect(result.privateKey).toBeNull();
      expect(result.marketId).toBeNull();
      expect(result.marketSymbol).toBeNull();
    });

    it("returns nulls for empty file", async () => {
      const filePath = join(tmpDir, "state.json");
      writeFileSync(filePath, "", "utf8");

      const result = await readRawRuntimeStateFile(filePath);
      if (result === null) throw new Error("expected non-null");
      expect(result.walletAddress).toBeNull();
    });

    it("returns nulls when wallet block has wrong types", async () => {
      const filePath = join(tmpDir, "state.json");
      writeFileSync(filePath, JSON.stringify({ wallet: "not-an-object" }), "utf8");

      const result = await readRawRuntimeStateFile(filePath);
      if (result === null) throw new Error("expected non-null");
      expect(result.walletAddress).toBeNull();
      expect(result.privateKey).toBeNull();
    });
  });

  describe("initializeRuntimeStateFile", () => {
    it("creates state file atomically on fresh path", async () => {
      const filePath = join(tmpDir, "state.json");
      const state = makeTestState();

      await initializeRuntimeStateFile(state, filePath);

      const loaded = await readRuntimeStateFile(filePath);
      expect(loaded).toEqual(state);
    });

    it("throws StateExistsError if file already exists", async () => {
      const filePath = join(tmpDir, "state.json");
      const state = makeTestState();

      await initializeRuntimeStateFile(state, filePath);
      await expect(initializeRuntimeStateFile(state, filePath)).rejects.toThrow(StateExistsError);
    });

    it("StateExistsError includes file path", async () => {
      const filePath = join(tmpDir, "state.json");
      const state = makeTestState();

      await initializeRuntimeStateFile(state, filePath);
      await expect(initializeRuntimeStateFile(state, filePath)).rejects.toThrow(filePath);
    });

    it("StateExistsError is not a StateWriteError", () => {
      const err = new StateExistsError("test");
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(StateWriteError);
      expect(err.name).toBe("StateExistsError");
    });

    it("creates parent directories if needed", async () => {
      const filePath = join(tmpDir, "nested", "init", "state.json");
      const state = makeTestState();

      await initializeRuntimeStateFile(state, filePath);

      const loaded = await readRuntimeStateFile(filePath);
      expect(loaded).toEqual(state);
    });

    it("two concurrent initializations: exactly one succeeds", async () => {
      const filePath = join(tmpDir, "state.json");
      const state = makeTestState();

      const results = await Promise.allSettled([
        initializeRuntimeStateFile(state, filePath),
        initializeRuntimeStateFile(state, filePath),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StateExistsError);
    });
  });
});
