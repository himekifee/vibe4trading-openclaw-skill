/**
 * Tool wrappers for the OpenClaw operator surface.
 *
 * Trading lifecycle tools: thin pass-through to `src/daemon/engine.ts` facade.
 * Wallet/onboarding/token tools: thin wrappers around domain modules.
 */

export { get_trade_history } from "../daemon/engine";

export { execute_tick } from "./execute-tick";
export { start_trading } from "./start-trading";
export { stop_trading } from "./stop-trading";

export type {
  DaemonStatusSnapshot,
  DaemonTickContextSnapshot,
  DaemonTickResult,
  NetworkTarget,
} from "../daemon/engine";

export { create_wallet } from "./create-wallet";
export type { CreateWalletResult } from "./create-wallet";
export { confirm_backup } from "./confirm-backup";
export { get_status } from "./get-status";
export { get_tick_context } from "./get-tick-context";
export { get_account_info } from "./get-account-info";
export type { AccountInfoResult } from "./get-account-info";
export { recover_mnemonic } from "./recover-mnemonic";
export { get_onboarding_status } from "./get-onboarding-status";
export { deposit_to_hyperliquid } from "./deposit-to-hyperliquid";
export { reset_override_phrase } from "./reset-override-phrase";
export { set_v4t_token } from "./set-v4t-token";
export { acknowledge_live_trading } from "./acknowledge-live-trading";
export { get_trading_options } from "./get-trading-options";
export { set_trading_selection } from "./set-trading-selection";
export { accept_override_phrase } from "./accept-override-phrase";
export { cleanup_mnemonic_file } from "./cleanup-mnemonic-file";
