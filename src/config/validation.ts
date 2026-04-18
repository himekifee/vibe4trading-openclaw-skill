export class SchemaValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SchemaValidationError";
  }
}

export type JsonObject = Record<string, unknown>;

export function expectPlainObject(value: unknown, context: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SchemaValidationError(`${context} must be a plain object.`);
  }

  return value as JsonObject;
}

export function assertExactKeys(
  value: JsonObject,
  allowedKeys: readonly string[],
  context: string,
): void {
  const extraKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (extraKeys.length > 0) {
    console.warn(
      `${context} contains unrecognised field(s): ${extraKeys.join(", ")}. They will be ignored.`,
    );
  }

  const missingKeys = allowedKeys.filter((key) => !(key in value));
  if (missingKeys.length > 0) {
    throw new SchemaValidationError(
      `${context} is missing required field(s): ${missingKeys.join(", ")}.`,
    );
  }
}

type StringOptions = {
  readonly minLength?: number;
  readonly pattern?: RegExp;
  readonly absolutePath?: boolean;
};

export function readRequiredString(
  value: JsonObject,
  key: string,
  context: string,
  options: StringOptions = {},
): string {
  const rawValue = value[key];
  if (typeof rawValue !== "string") {
    throw new SchemaValidationError(`${context}.${key} must be a string.`);
  }

  const normalized = rawValue.trim();
  if (normalized.length < (options.minLength ?? 1)) {
    throw new SchemaValidationError(`${context}.${key} must not be empty.`);
  }

  if (options.absolutePath && !normalized.startsWith("/")) {
    throw new SchemaValidationError(`${context}.${key} must be an absolute filesystem path.`);
  }

  if (options.pattern && !options.pattern.test(normalized)) {
    throw new SchemaValidationError(`${context}.${key} has an invalid format.`);
  }

  return normalized;
}

export function readNullableString(
  value: JsonObject,
  key: string,
  context: string,
  options: StringOptions = {},
): string | null {
  const rawValue = value[key];
  if (rawValue === null) {
    return null;
  }

  if (typeof rawValue !== "string") {
    throw new SchemaValidationError(`${context}.${key} must be a string or null.`);
  }

  return readRequiredString({ [key]: rawValue }, key, context, options);
}

export function readBoolean(value: JsonObject, key: string, context: string): boolean {
  const rawValue = value[key];
  if (typeof rawValue !== "boolean") {
    throw new SchemaValidationError(`${context}.${key} must be a boolean.`);
  }

  return rawValue;
}

export function readEnumString<T extends string>(
  value: JsonObject,
  key: string,
  context: string,
  allowedValues: readonly T[],
): T {
  const rawValue = readRequiredString(value, key, context);
  if (!allowedValues.includes(rawValue as T)) {
    throw new SchemaValidationError(
      `${context}.${key} must be one of: ${allowedValues.join(", ")}.`,
    );
  }

  return rawValue as T;
}

export function readArray<T>(
  value: JsonObject,
  key: string,
  context: string,
  parser: (item: unknown, index: number) => T,
): T[] {
  const rawValue = value[key];
  if (!Array.isArray(rawValue)) {
    throw new SchemaValidationError(`${context}.${key} must be an array.`);
  }

  return rawValue.map((item, index) => parser(item, index));
}

export function readNestedObject(value: JsonObject, key: string, context: string): JsonObject {
  return expectPlainObject(value[key], `${context}.${key}`);
}

export function readNullableNestedObject(
  value: JsonObject,
  key: string,
  context: string,
): JsonObject | null {
  const rawValue = value[key];
  if (rawValue === null) {
    return null;
  }

  return expectPlainObject(rawValue, `${context}.${key}`);
}

export function parseJsonText<T>(
  jsonText: string,
  parser: (value: unknown) => T,
  context: string,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch (error) {
    throw new SchemaValidationError(
      `${context} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }

  return parser(parsed);
}
