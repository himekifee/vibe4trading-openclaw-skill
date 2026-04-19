import { unlink } from "node:fs/promises";

import { STATE_FILE_PATH } from "../config/paths";
import { StateExistsError, initializeRuntimeStateFile } from "../daemon/runtime-state-file";
import { createRuntimeState } from "../state";
import type { RuntimeState } from "../state";
import { createWallet } from "../wallet";
import type { WalletCreationResult } from "../wallet";

type WalletAlreadyExistsGuidance = {
  readonly walletAlreadyExists: true;
  readonly reason: "runtime-state-exists";
  readonly message: string;
  readonly nextActions: readonly {
    readonly tool: string;
    readonly description: string;
  }[];
};

const WALLET_EXISTS_NEXT_ACTIONS: readonly {
  readonly tool: string;
  readonly description: string;
}[] = [
  {
    tool: "get_status",
    description: "Check the current wallet and trading status.",
  },
  {
    tool: "get_onboarding_status",
    description: "Check funding readiness for the existing wallet.",
  },
  {
    tool: "recover_mnemonic",
    description: "Re-read the mnemonic from the desktop file if backup status allows it.",
  },
];

/**
 * Default market configuration used when bootstrapping a fresh runtime state.
 * This is a safe placeholder — the operator must select a real trading option
 * via the agents.md catalog before trading can begin.
 */
const BOOTSTRAP_MARKET = {
  venue: "hyperliquid" as const,
  mode: "perp" as const,
  marketId: "perps:hyperliquid:ETH",
  symbol: "ETH",
};

export type CreateWalletResult =
  | {
      readonly wallet: WalletCreationResult;
      readonly runtimeState: RuntimeState;
    }
  | WalletAlreadyExistsGuidance;

/**
 * Create a new wallet and initialize persisted runtime state with safe
 * unarmed defaults.
 *
 * After this call:
 * - Mnemonic file exists on disk with 0600 permissions
 * - Runtime state file exists with:
 *   - `daemonStatus: "stopped"` (unarmed)
 *   - `walletBackup.status: "pending"`
 *   - `walletBackup.mnemonicDisplayedAt` set to `mnemonicDisplayedAt` if provided
 *   - `liveTradingConsent.acknowledged: false`
 *   - No trading selection, no bridge history
 *
 * The returned `wallet.mnemonic` is the ONLY in-memory copy. Callers must
 * display it once, then drop the reference.
 *
 * @param args.mnemonicDisplayedAt - ISO timestamp to record that the mnemonic
 *   was displayed in the same write as wallet creation, avoiding a two-write
 *   pattern.  Pass `new Date().toISOString()` from the call site.
 */
export async function create_wallet(args: {
  readonly path?: string;
  readonly stateFilePath?: string;
  readonly mnemonicDisplayedAt?: string;
}): Promise<CreateWalletResult> {
  const wallet = createWallet(args.path);

  const runtimeState = createRuntimeState({
    wallet: {
      address: wallet.address,
      mnemonicFilePath: wallet.mnemonicFilePath,
    },
    market: BOOTSTRAP_MARKET,
    daemonStatus: "stopped",
    walletBackup: {
      status: "pending",
      mnemonicDisplayedAt: args.mnemonicDisplayedAt ?? null,
      confirmedAt: null,
      cleanedUpAt: null,
    },
    liveTradingConsent: {
      acknowledged: false,
      acknowledgedAt: null,
    },
  });

  const stateFilePath = args.stateFilePath ?? STATE_FILE_PATH;

  try {
    await initializeRuntimeStateFile(runtimeState, stateFilePath);
  } catch (error) {
    if (error instanceof StateExistsError) {
      try {
        await unlink(wallet.mnemonicFilePath);
      } catch {
        // Best-effort: file may already be gone or inaccessible.
      }
      return {
        walletAlreadyExists: true,
        reason: "runtime-state-exists",
        message:
          "Runtime state file already exists. A wallet has already been created — refusing to overwrite to protect existing wallet and trading data. If you intend to start fresh, manually remove the state file first.",
        nextActions: WALLET_EXISTS_NEXT_ACTIONS,
      };
    }
    throw error;
  }

  return { wallet, runtimeState };
}
