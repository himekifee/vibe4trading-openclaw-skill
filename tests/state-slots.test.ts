import { describe, expect, it } from "vitest";

import { SchemaValidationError } from "../src/config/validation";
import {
  computeCurrentTickSlotUtc,
  parseCanonicalUtcTimestamp,
  parseTickSlotUtc,
  slotIdFromDate,
} from "../src/state/slots";

describe("computeCurrentTickSlotUtc", () => {
  it("returns same hour :30 when time is exactly :30", () => {
    const now = new Date("2026-03-27T14:30:00.000Z");
    const slot = computeCurrentTickSlotUtc(now);
    expect(slot.toISOString()).toBe("2026-03-27T14:30:00.000Z");
  });

  it("returns previous hour :30 when before :30", () => {
    const now = new Date("2026-03-27T14:15:00.000Z");
    const slot = computeCurrentTickSlotUtc(now);
    expect(slot.toISOString()).toBe("2026-03-27T13:30:00.000Z");
  });

  it("returns current hour :30 when after :30", () => {
    const now = new Date("2026-03-27T14:45:00.000Z");
    const slot = computeCurrentTickSlotUtc(now);
    expect(slot.toISOString()).toBe("2026-03-27T14:30:00.000Z");
  });

  it("returns previous day 23:30 at midnight boundary :00", () => {
    const now = new Date("2026-03-28T00:00:00.000Z");
    const slot = computeCurrentTickSlotUtc(now);
    expect(slot.toISOString()).toBe("2026-03-27T23:30:00.000Z");
  });
});

describe("slotIdFromDate", () => {
  it("returns ISO string of the computed slot", () => {
    const now = new Date("2026-03-27T14:45:00.000Z");
    expect(slotIdFromDate(now)).toBe("2026-03-27T14:30:00.000Z");
  });
});

describe("parseTickSlotUtc", () => {
  it("returns ISO string for valid :30 slot", () => {
    expect(parseTickSlotUtc("2026-03-27T12:30:00.000Z")).toBe("2026-03-27T12:30:00.000Z");
  });

  it("throws SchemaValidationError for non-:30 timestamp", () => {
    expect(() => parseTickSlotUtc("2026-03-27T12:00:00.000Z")).toThrow(SchemaValidationError);
  });

  it("throws SchemaValidationError for non-canonical format without millis", () => {
    expect(() => parseTickSlotUtc("2026-03-27T12:30:00Z")).toThrow(SchemaValidationError);
  });
});

describe("parseCanonicalUtcTimestamp", () => {
  it("returns Date for valid canonical ISO string", () => {
    const result = parseCanonicalUtcTimestamp("2026-03-27T14:30:00.000Z", "test");
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe("2026-03-27T14:30:00.000Z");
  });

  it("throws SchemaValidationError for non-canonical format missing millis", () => {
    expect(() => parseCanonicalUtcTimestamp("2026-03-27T12:30:00Z", "test")).toThrow(
      SchemaValidationError,
    );
  });

  it("throws SchemaValidationError for garbage string", () => {
    expect(() => parseCanonicalUtcTimestamp("not-a-date", "test")).toThrow(SchemaValidationError);
  });
});
