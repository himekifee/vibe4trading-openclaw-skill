import { SchemaValidationError } from "./validation";

export const NON_NEGATIVE_DECIMAL_STRING_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function normalizeDecimalString(value: string): string {
  if (!NON_NEGATIVE_DECIMAL_STRING_PATTERN.test(value)) {
    throw new SchemaValidationError(`Invalid decimal string: ${value}.`);
  }

  const [integerPart, fractionalPart = ""] = value.split(".");
  const normalizedIntegerPart = integerPart || "0";
  const normalizedFractionalPart = fractionalPart.replace(/0+$/, "");

  return normalizedFractionalPart.length > 0
    ? `${normalizedIntegerPart}.${normalizedFractionalPart}`
    : normalizedIntegerPart;
}

export function ensureNonNegativeDecimalString(value: string, context: string): string {
  try {
    return normalizeDecimalString(value);
  } catch {
    throw new SchemaValidationError(`${context} must be a non-negative decimal string.`);
  }
}

function getScale(value: string): number {
  const parts = value.split(".");
  return parts[1]?.length ?? 0;
}

function scaleDecimal(value: string, targetScale: number): bigint {
  const normalized = normalizeDecimalString(value);
  const [integerPart, fractionalPart = ""] = normalized.split(".");
  const paddedFraction = fractionalPart.padEnd(targetScale, "0");
  return BigInt(`${integerPart}${paddedFraction}`);
}

function formatScaledInteger(value: bigint, scale: number): string {
  if (scale === 0) {
    return value.toString();
  }

  const sign = value < 0n ? "-" : "";
  const absoluteValue = value < 0n ? value * -1n : value;
  const raw = absoluteValue.toString().padStart(scale + 1, "0");
  const integerPart = raw.slice(0, -scale) || "0";
  const fractionalPart = raw.slice(-scale).replace(/0+$/, "");

  return fractionalPart.length > 0
    ? `${sign}${integerPart}.${fractionalPart}`
    : `${sign}${integerPart}`;
}

export function sumDecimalStrings(values: readonly string[]): string {
  if (values.length === 0) {
    return "0";
  }

  const normalizedValues = values.map((value) => normalizeDecimalString(value));
  const targetScale = normalizedValues.reduce(
    (maxScale, value) => Math.max(maxScale, getScale(value)),
    0,
  );

  const total = normalizedValues.reduce((sum, value) => sum + scaleDecimal(value, targetScale), 0n);

  return formatScaledInteger(total, targetScale);
}

export function compareDecimalStrings(left: string, right: string): number {
  const normalizedLeft = normalizeDecimalString(left);
  const normalizedRight = normalizeDecimalString(right);
  const targetScale = Math.max(getScale(normalizedLeft), getScale(normalizedRight));
  const scaledLeft = scaleDecimal(normalizedLeft, targetScale);
  const scaledRight = scaleDecimal(normalizedRight, targetScale);

  if (scaledLeft === scaledRight) {
    return 0;
  }

  return scaledLeft > scaledRight ? 1 : -1;
}

export function subtractDecimalStrings(left: string, right: string): string {
  const normalizedLeft = normalizeDecimalString(left);
  const normalizedRight = normalizeDecimalString(right);
  const targetScale = Math.max(getScale(normalizedLeft), getScale(normalizedRight));
  const scaledLeft = scaleDecimal(normalizedLeft, targetScale);
  const scaledRight = scaleDecimal(normalizedRight, targetScale);
  const result = scaledLeft - scaledRight;

  if (result < 0n) {
    throw new SchemaValidationError(
      `Subtraction would produce a negative result: ${normalizedLeft} - ${normalizedRight}.`,
    );
  }

  return formatScaledInteger(result, targetScale);
}
