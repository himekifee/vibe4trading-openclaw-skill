import { describe, expect, it, vi } from "vitest";
import {
  clearDeadManCancel,
  computeCancelTime,
  scheduleDeadManCancel,
  validateCancelTime,
} from "../src/chain/dead-man-switch";
import type { HyperliquidWriteClient } from "../src/chain/hyperliquid-client";
import { DEAD_MANS_SWITCH_SECONDS } from "../src/config/constants";

describe("computeCancelTime", () => {
  it("uses DEAD_MANS_SWITCH_SECONDS by default", () => {
    const now = 1_700_000_000_000;
    const result = computeCancelTime(now);
    expect(result).toBe(now + DEAD_MANS_SWITCH_SECONDS * 1_000);
  });

  it("accepts custom delay", () => {
    const now = 1_700_000_000_000;
    const result = computeCancelTime(now, 30);
    expect(result).toBe(now + 30_000);
  });
});

describe("validateCancelTime", () => {
  it("returns null for valid future time", () => {
    const now = 1_700_000_000_000;
    const cancelTime = now + 10_000;
    expect(validateCancelTime(cancelTime, now)).toBeNull();
  });

  it("returns error when cancel time is less than 5s in the future", () => {
    const now = 1_700_000_000_000;
    const cancelTime = now + 3_000;
    const error = validateCancelTime(cancelTime, now);
    expect(error).toContain("at least 5000ms");
  });

  it("returns null for exactly 5s in the future", () => {
    const now = 1_700_000_000_000;
    const cancelTime = now + 5_000;
    expect(validateCancelTime(cancelTime, now)).toBeNull();
  });

  it("returns error for time in the past", () => {
    const now = 1_700_000_000_000;
    const cancelTime = now - 1_000;
    const error = validateCancelTime(cancelTime, now);
    expect(error).not.toBeNull();
  });
});

function createMockClient() {
  const scheduleCancel = vi.fn().mockResolvedValue({ status: "ok" });
  const client = {
    exchange: { scheduleCancel },
    info: {},
    isTestnet: false,
  } as unknown as HyperliquidWriteClient;
  return { client, scheduleCancel };
}

describe("scheduleDeadManCancel", () => {
  it("calls scheduleCancel with computed cancel time", async () => {
    const { client, scheduleCancel } = createMockClient();
    const now = 1_700_000_000_000;
    const result = await scheduleDeadManCancel(client, now);
    expect(result).toEqual({
      scheduled: true,
      cancelTimeMs: now + DEAD_MANS_SWITCH_SECONDS * 1_000,
    });
    expect(scheduleCancel).toHaveBeenCalledWith({
      time: now + DEAD_MANS_SWITCH_SECONDS * 1_000,
    });
  });

  it("returns validation error without calling exchange", async () => {
    const { client, scheduleCancel } = createMockClient();
    const now = 1_700_000_000_000;
    const result = await scheduleDeadManCancel(client, now, 1);
    expect(result).toEqual({
      scheduled: false,
      reason: expect.stringContaining("at least 5000ms"),
    });
    expect(scheduleCancel).not.toHaveBeenCalled();
  });

  it("allows heartbeat refreshes without clearing first", async () => {
    const { client, scheduleCancel } = createMockClient();
    const now = 1_700_000_000_000;

    const first = await scheduleDeadManCancel(client, now, 90);
    const second = await scheduleDeadManCancel(client, now + 60_000, 90);

    expect(first).toEqual({
      scheduled: true,
      cancelTimeMs: now + 90_000,
    });
    expect(second).toEqual({
      scheduled: true,
      cancelTimeMs: now + 150_000,
    });
    expect(scheduleCancel).toHaveBeenNthCalledWith(1, { time: now + 90_000 });
    expect(scheduleCancel).toHaveBeenNthCalledWith(2, { time: now + 150_000 });
  });
});

describe("clearDeadManCancel", () => {
  it("calls scheduleCancel with empty object to clear", async () => {
    const { client, scheduleCancel } = createMockClient();
    await clearDeadManCancel(client);
    expect(scheduleCancel).toHaveBeenCalledTimes(1);
    expect(scheduleCancel).toHaveBeenCalledWith({});
  });

  it("returns void (no result object)", async () => {
    const { client } = createMockClient();
    const result = await clearDeadManCancel(client);
    expect(result).toBeUndefined();
  });
});
