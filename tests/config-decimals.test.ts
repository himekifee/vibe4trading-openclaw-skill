import { describe, expect, it } from "vitest";

import {
  NON_NEGATIVE_DECIMAL_STRING_PATTERN,
  compareDecimalStrings,
  ensureNonNegativeDecimalString,
  normalizeDecimalString,
  subtractDecimalStrings,
  sumDecimalStrings,
} from "../src/config/decimals";
import { SchemaValidationError } from "../src/config/validation";

describe("normalizeDecimalString", () => {
  it("returns integer strings unchanged", () => {
    expect(normalizeDecimalString("0")).toBe("0");
    expect(normalizeDecimalString("1")).toBe("1");
    expect(normalizeDecimalString("42")).toBe("42");
  });

  it("strips trailing zeros from fractional part", () => {
    expect(normalizeDecimalString("1.00")).toBe("1");
    expect(normalizeDecimalString("1.10")).toBe("1.1");
    expect(normalizeDecimalString("1.010")).toBe("1.01");
    expect(normalizeDecimalString("0.50")).toBe("0.5");
  });

  it("preserves meaningful fractional digits", () => {
    expect(normalizeDecimalString("3.14")).toBe("3.14");
    expect(normalizeDecimalString("0.001")).toBe("0.001");
    expect(normalizeDecimalString("100.25")).toBe("100.25");
  });

  it("handles zero with fractional zeros", () => {
    expect(normalizeDecimalString("0.0")).toBe("0");
    expect(normalizeDecimalString("0.00")).toBe("0");
    expect(normalizeDecimalString("0.000")).toBe("0");
  });

  it("is idempotent — normalizing twice yields the same result", () => {
    const inputs = ["0", "1.10", "0.50", "100.250", "3.14", "0.001"];
    for (const input of inputs) {
      const once = normalizeDecimalString(input);
      const twice = normalizeDecimalString(once);
      expect(twice).toBe(once);
    }
  });

  it("throws SchemaValidationError for negative numbers", () => {
    expect(() => normalizeDecimalString("-1")).toThrow(SchemaValidationError);
    expect(() => normalizeDecimalString("-0.5")).toThrow(SchemaValidationError);
  });

  it("throws SchemaValidationError for empty string", () => {
    expect(() => normalizeDecimalString("")).toThrow(SchemaValidationError);
  });

  it("throws SchemaValidationError for non-numeric strings", () => {
    expect(() => normalizeDecimalString("abc")).toThrow(SchemaValidationError);
    expect(() => normalizeDecimalString("12abc")).toThrow(SchemaValidationError);
    expect(() => normalizeDecimalString("NaN")).toThrow(SchemaValidationError);
    expect(() => normalizeDecimalString("Infinity")).toThrow(SchemaValidationError);
  });

  it("throws SchemaValidationError for scientific notation", () => {
    expect(() => normalizeDecimalString("1e5")).toThrow(SchemaValidationError);
    expect(() => normalizeDecimalString("1.5e2")).toThrow(SchemaValidationError);
    expect(() => normalizeDecimalString("3E10")).toThrow(SchemaValidationError);
  });

  it("throws SchemaValidationError for leading zeros in integer part", () => {
    expect(() => normalizeDecimalString("01")).toThrow(SchemaValidationError);
    expect(() => normalizeDecimalString("007")).toThrow(SchemaValidationError);
  });

  it("throws for strings with spaces or special characters", () => {
    expect(() => normalizeDecimalString(" 1")).toThrow(SchemaValidationError);
    expect(() => normalizeDecimalString("1 ")).toThrow(SchemaValidationError);
    expect(() => normalizeDecimalString("+1")).toThrow(SchemaValidationError);
    expect(() => normalizeDecimalString("1,000")).toThrow(SchemaValidationError);
  });
});

describe("ensureNonNegativeDecimalString", () => {
  it("returns normalized value for valid input", () => {
    expect(ensureNonNegativeDecimalString("1.00", "price")).toBe("1");
    expect(ensureNonNegativeDecimalString("3.14", "amount")).toBe("3.14");
  });

  it("throws SchemaValidationError with context for invalid input", () => {
    expect(() => ensureNonNegativeDecimalString("-1", "price")).toThrow(SchemaValidationError);
    expect(() => ensureNonNegativeDecimalString("-1", "price")).toThrow(
      "price must be a non-negative decimal string.",
    );
  });
});

describe("sumDecimalStrings", () => {
  it("returns '0' for empty array", () => {
    expect(sumDecimalStrings([])).toBe("0");
  });

  it("returns normalized value for single-element array (round-trip)", () => {
    expect(sumDecimalStrings(["5.01"])).toBe("5.01");
    expect(sumDecimalStrings(["100"])).toBe("100");
    expect(sumDecimalStrings(["0.10"])).toBe("0.1");
  });

  it("adds two integers exactly", () => {
    expect(sumDecimalStrings(["10", "20"])).toBe("30");
  });

  it("adds 0.1 + 0.2 exactly as '0.3' (no floating-point drift)", () => {
    expect(sumDecimalStrings(["0.1", "0.2"])).toBe("0.3");
  });

  it("adds values with mixed decimal scales", () => {
    expect(sumDecimalStrings(["1.1", "2.22", "3.333"])).toBe("6.653");
  });

  it("handles large numbers without precision loss", () => {
    expect(sumDecimalStrings(["99999999999999999999", "1"])).toBe("100000000000000000000");
  });

  it("handles large decimals without precision loss", () => {
    expect(sumDecimalStrings(["0.999999999999999999", "0.000000000000000001"])).toBe("1");
  });

  it("sums multiple zeros", () => {
    expect(sumDecimalStrings(["0", "0", "0"])).toBe("0");
  });

  it("sums many small values", () => {
    const values = Array.from({ length: 10 }, () => "0.1");
    expect(sumDecimalStrings(values)).toBe("1");
  });
});

describe("compareDecimalStrings", () => {
  it("returns 0 for equal values", () => {
    expect(compareDecimalStrings("1", "1")).toBe(0);
    expect(compareDecimalStrings("0", "0")).toBe(0);
    expect(compareDecimalStrings("3.14", "3.14")).toBe(0);
  });

  it("returns 0 for values equal after normalization", () => {
    expect(compareDecimalStrings("1.0", "1")).toBe(0);
    expect(compareDecimalStrings("1.00", "1.0")).toBe(0);
    expect(compareDecimalStrings("0.10", "0.1")).toBe(0);
  });

  it("returns 1 when left > right", () => {
    expect(compareDecimalStrings("2", "1")).toBe(1);
    expect(compareDecimalStrings("1.1", "1.09")).toBe(1);
    expect(compareDecimalStrings("10", "9.99")).toBe(1);
  });

  it("returns -1 when left < right", () => {
    expect(compareDecimalStrings("1", "2")).toBe(-1);
    expect(compareDecimalStrings("1.09", "1.1")).toBe(-1);
    expect(compareDecimalStrings("0.001", "0.01")).toBe(-1);
  });

  it("compares values with different decimal scales", () => {
    expect(compareDecimalStrings("1.5", "1.50")).toBe(0);
    expect(compareDecimalStrings("1.500", "1.5001")).toBe(-1);
  });

  it("compares large numbers correctly", () => {
    expect(compareDecimalStrings("99999999999999999999", "99999999999999999998")).toBe(1);
    expect(compareDecimalStrings("99999999999999999998", "99999999999999999999")).toBe(-1);
  });

  it("throws for invalid inputs", () => {
    expect(() => compareDecimalStrings("-1", "1")).toThrow(SchemaValidationError);
    expect(() => compareDecimalStrings("1", "abc")).toThrow(SchemaValidationError);
  });
});

describe("NON_NEGATIVE_DECIMAL_STRING_PATTERN", () => {
  it("matches valid non-negative decimal strings", () => {
    expect(NON_NEGATIVE_DECIMAL_STRING_PATTERN.test("0")).toBe(true);
    expect(NON_NEGATIVE_DECIMAL_STRING_PATTERN.test("123")).toBe(true);
    expect(NON_NEGATIVE_DECIMAL_STRING_PATTERN.test("0.5")).toBe(true);
    expect(NON_NEGATIVE_DECIMAL_STRING_PATTERN.test("100.25")).toBe(true);
  });

  it("rejects invalid strings", () => {
    expect(NON_NEGATIVE_DECIMAL_STRING_PATTERN.test("")).toBe(false);
    expect(NON_NEGATIVE_DECIMAL_STRING_PATTERN.test("-1")).toBe(false);
    expect(NON_NEGATIVE_DECIMAL_STRING_PATTERN.test("01")).toBe(false);
    expect(NON_NEGATIVE_DECIMAL_STRING_PATTERN.test("1e5")).toBe(false);
    expect(NON_NEGATIVE_DECIMAL_STRING_PATTERN.test("abc")).toBe(false);
  });
});

describe("subtractDecimalStrings", () => {
  it("subtracts two integers", () => {
    expect(subtractDecimalStrings("10", "3")).toBe("7");
  });

  it("returns '0' for equal values", () => {
    expect(subtractDecimalStrings("5", "5")).toBe("0");
    expect(subtractDecimalStrings("0", "0")).toBe("0");
    expect(subtractDecimalStrings("3.14", "3.14")).toBe("0");
  });

  it("handles borrow / cross-scale subtraction", () => {
    expect(subtractDecimalStrings("100", "94.98")).toBe("5.02");
    expect(subtractDecimalStrings("10", "9.99")).toBe("0.01");
  });

  it("normalizes trailing zeros in the result", () => {
    expect(subtractDecimalStrings("1.50", "0.50")).toBe("1");
    expect(subtractDecimalStrings("2.10", "1.10")).toBe("1");
    expect(subtractDecimalStrings("5.00", "3.00")).toBe("2");
  });

  it("subtracts fractional values without floating-point drift", () => {
    expect(subtractDecimalStrings("0.3", "0.1")).toBe("0.2");
    expect(subtractDecimalStrings("1", "0.1")).toBe("0.9");
  });

  it("handles large numbers without precision loss", () => {
    expect(subtractDecimalStrings("100000000000000000000", "1")).toBe("99999999999999999999");
  });

  it("throws SchemaValidationError when result would be negative", () => {
    expect(() => subtractDecimalStrings("1", "2")).toThrow(SchemaValidationError);
    expect(() => subtractDecimalStrings("0", "0.001")).toThrow(SchemaValidationError);
    expect(() => subtractDecimalStrings("5.5", "5.6")).toThrow(SchemaValidationError);
  });

  it("throws SchemaValidationError for invalid inputs", () => {
    expect(() => subtractDecimalStrings("-1", "0")).toThrow(SchemaValidationError);
    expect(() => subtractDecimalStrings("1", "abc")).toThrow(SchemaValidationError);
  });
});
