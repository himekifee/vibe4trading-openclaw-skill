import { ALLOWED_ORDER_STYLES, DEFAULT_ORDER_STYLE } from "../config/constants";
import type { ExecuteTickInput } from "../daemon/engine";
import { resolveNetworkTarget, validateExecuteTickInput } from "../daemon/engine";
import { slotIdFromDate } from "../state";

type BootstrapNextAction = {
  readonly tool: string;
  readonly description: string;
};

const BOOTSTRAP_NEXT_ACTIONS: readonly BootstrapNextAction[] = [
  {
    tool: "create_wallet",
    description: "Create the local wallet and initialize runtime state.",
  },
  {
    tool: "confirm_backup",
    description: "Confirm the mnemonic backup after the wallet has been displayed once.",
  },
  {
    tool: "get_onboarding_status",
    description: "Re-check funding readiness after bootstrap is complete.",
  },
] as const;

type BootstrapGuidance = {
  readonly bootstrapRequired: true;
  readonly reason: "runtime-state-missing";
  readonly message: string;
  readonly nextActions: readonly BootstrapNextAction[];
};

export function buildStatusBootstrapGuidance(): BootstrapGuidance & {
  readonly currentSlot: string;
  readonly network: "mainnet" | "testnet";
} {
  return {
    bootstrapRequired: true,
    reason: "runtime-state-missing",
    message:
      "Runtime state has not been initialized yet. Call create_wallet first to bootstrap the skill before requesting trading status.",
    currentSlot: slotIdFromDate(new Date()),
    network: resolveNetworkTarget(),
    nextActions: BOOTSTRAP_NEXT_ACTIONS,
  };
}

export function buildTickContextBootstrapGuidance(
  input: ExecuteTickInput = {},
): BootstrapGuidance & {
  readonly currentSlot: string;
  readonly network: "mainnet" | "testnet";
  readonly execution: {
    readonly allowedOrderStyles: readonly ("ioc" | "gtc")[];
    readonly defaultOrderStyle: "ioc" | "gtc";
    readonly selectedOrderStyle: "ioc" | "gtc";
  };
} {
  const validated = validateExecuteTickInput(input);

  return {
    bootstrapRequired: true,
    reason: "runtime-state-missing",
    message:
      "Runtime state has not been initialized yet. Call create_wallet first so tick previews can validate selection, onboarding, and execution context.",
    currentSlot: validated.slotId,
    network: resolveNetworkTarget(),
    execution: {
      allowedOrderStyles: ALLOWED_ORDER_STYLES,
      defaultOrderStyle: DEFAULT_ORDER_STYLE,
      selectedOrderStyle: validated.orderStyle,
    },
    nextActions: BOOTSTRAP_NEXT_ACTIONS,
  };
}

export function buildOnboardingBootstrapGuidance(): BootstrapGuidance {
  return {
    bootstrapRequired: true,
    reason: "runtime-state-missing",
    message:
      "Runtime state has not been initialized yet. Call create_wallet first to create the wallet before checking onboarding or funding readiness.",
    nextActions: BOOTSTRAP_NEXT_ACTIONS,
  };
}
