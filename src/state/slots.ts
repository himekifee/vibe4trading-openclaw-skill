import { TICK_MINUTE } from "../config/constants";
import { SchemaValidationError } from "../config/validation";

export function computeCurrentTickSlotUtc(now: Date = new Date()): Date {
  const slot = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      TICK_MINUTE,
      0,
      0,
    ),
  );

  if (now.getUTCMinutes() < TICK_MINUTE) {
    slot.setUTCHours(slot.getUTCHours() - 1);
  }

  return slot;
}

function formatTickSlotUtc(slot: Date): string {
  assertDateIsTickSlot(slot, "slot");
  return slot.toISOString();
}

export function slotIdFromDate(now: Date = new Date()): string {
  return formatTickSlotUtc(computeCurrentTickSlotUtc(now));
}

export function parseTickSlotUtc(slot: string): string {
  const parsed = parseCanonicalUtcTimestamp(slot, "tick slot");
  assertDateIsTickSlot(parsed, "tick slot");
  return parsed.toISOString();
}

/**
 * Parse a **canonical** UTC ISO-8601 timestamp — the exact format produced by
 * `Date.prototype.toISOString()`.
 *
 * The canonical form is `YYYY-MM-DDTHH:mm:ss.sssZ` (always 24 characters,
 * always three-digit milliseconds, always trailing `Z`).  Strings that are
 * valid ISO-8601 but use a different representation — such as omitting
 * milliseconds (`"2026-03-27T12:30:00Z"`) or using a `±HH:MM` offset — are
 * **rejected** so that every persisted timestamp round-trips identically
 * through `JSON.stringify` / `JSON.parse` without silent normalisation.
 *
 * @param value   The string to validate and parse.
 * @param context A human-readable label included in the error message on
 *                failure (e.g. `"tick slot"`, `"confirmedAt"`).
 * @returns       A `Date` whose `.toISOString()` equals `value`.
 * @throws {SchemaValidationError} If `value` is not in canonical form.
 */
export function parseCanonicalUtcTimestamp(value: string, context: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new SchemaValidationError(`${context} must be a canonical UTC ISO timestamp.`);
  }

  return parsed;
}

function assertDateIsTickSlot(value: Date, context: string): void {
  if (
    value.getUTCMinutes() !== TICK_MINUTE ||
    value.getUTCSeconds() !== 0 ||
    value.getUTCMilliseconds() !== 0
  ) {
    throw new SchemaValidationError(`${context} must align to hh:${TICK_MINUTE} UTC.`);
  }
}
