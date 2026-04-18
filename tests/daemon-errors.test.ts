import { describe, expect, it } from "vitest";

import { isNodeError, toErrorMessage } from "../src/daemon/errors";

describe("toErrorMessage", () => {
  it("extracts message from Error instances", () => {
    expect(toErrorMessage(new Error("msg"))).toBe("msg");
  });

  it("returns string values as-is", () => {
    expect(toErrorMessage("string")).toBe("string");
  });

  it("stringifies numbers", () => {
    expect(toErrorMessage(42)).toBe("42");
  });

  it("stringifies null", () => {
    expect(toErrorMessage(null)).toBe("null");
  });

  it("stringifies undefined", () => {
    expect(toErrorMessage(undefined)).toBe("undefined");
  });
});

describe("isNodeError", () => {
  it("returns false for plain Error without code property", () => {
    expect(isNodeError(new Error("x"))).toBe(false);
  });

  it("returns true for Error with code property", () => {
    expect(isNodeError(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(true);
  });

  it("returns false for string values", () => {
    expect(isNodeError("string")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isNodeError(null)).toBe(false);
  });
});
