import { DEAD_MANS_SWITCH_SECONDS } from "../config/constants";
import type { HyperliquidWriteClient } from "./hyperliquid-client";

const MIN_SCHEDULE_DELAY_MS = 5_000;

export type DeadManScheduleResult =
  | { readonly scheduled: true; readonly cancelTimeMs: number }
  | { readonly scheduled: false; readonly reason: string };

export function computeCancelTime(nowMs: number, delaySec?: number): number {
  const delay = delaySec ?? DEAD_MANS_SWITCH_SECONDS;
  const cancelTimeMs = nowMs + delay * 1_000;
  return cancelTimeMs;
}

export function validateCancelTime(cancelTimeMs: number, nowMs: number): string | null {
  const deltaMs = cancelTimeMs - nowMs;
  if (deltaMs < MIN_SCHEDULE_DELAY_MS) {
    return `Cancel time must be at least ${MIN_SCHEDULE_DELAY_MS}ms in the future, got ${deltaMs}ms.`;
  }
  return null;
}

export async function scheduleDeadManCancel(
  client: HyperliquidWriteClient,
  nowMs?: number,
  delaySec?: number,
): Promise<DeadManScheduleResult> {
  const now = nowMs ?? Date.now();
  const cancelTimeMs = computeCancelTime(now, delaySec);

  const validationError = validateCancelTime(cancelTimeMs, now);
  if (validationError) {
    return { scheduled: false, reason: validationError };
  }

  await client.exchange.scheduleCancel({ time: cancelTimeMs });
  return { scheduled: true, cancelTimeMs };
}

export async function clearDeadManCancel(client: HyperliquidWriteClient): Promise<void> {
  // Omitting `time` clears all scheduled cancels per the Hyperliquid SDK contract.
  await client.exchange.scheduleCancel({});
}
