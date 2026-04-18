/**
 * Market-configuration guards.
 *
 * **Freshness contract**: every function in this module assumes that callers
 * supply a `RuntimeState` whose `exchangeActivity` fields (`hasOpenPosition`,
 * `hasPendingOrder`) have been freshly reconciled against the exchange
 * **before** the call.  The guards themselves do **not** perform runtime
 * freshness checks — they trust the caller to have reconciled already.
 */

import { parseSingleMarketConfig } from "../config/market";
import { SchemaValidationError } from "../config/validation";
import { parseRuntimeState } from "./runtime-state";
import type { RuntimeState } from "./runtime-state";

/**
 * Throws if the given state indicates open exposure on the exchange.
 *
 * Callers **must** provide a `RuntimeState` with freshly reconciled
 * `exchangeActivity` — this guard does not re-fetch exchange state.
 */
export function assertMarketConfigChangeAllowed(state: RuntimeState): void {
  if (state.exchangeActivity.hasOpenPosition || state.exchangeActivity.hasPendingOrder) {
    throw new SchemaValidationError(
      "Market configuration cannot change while an open position or pending order exists.",
    );
  }
}

/**
 * Replaces the market configuration in `state` after verifying no open exposure.
 *
 * Callers **must** provide a `RuntimeState` with freshly reconciled
 * `exchangeActivity` — this function delegates the exposure check to
 * {@link assertMarketConfigChangeAllowed} and does not re-fetch exchange state.
 */
export function replaceMarketConfig(state: RuntimeState, nextMarketConfig: unknown): RuntimeState {
  assertMarketConfigChangeAllowed(state);

  return parseRuntimeState({
    ...state,
    market: parseSingleMarketConfig(nextMarketConfig),
  });
}
