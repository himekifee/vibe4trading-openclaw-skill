import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_AGENT_MD_URL = "https://vibe4trading.ai/agents.md" as const;
export const DEFAULT_V4T_API_ORIGIN = "https://vibe4trading.ai" as const;
export const ARBITRUM_UNISWAP_SWAP_ROUTER_02_ADDRESS =
  "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as const;
export const ARBITRUM_UNISWAP_QUOTER_V2_ADDRESS =
  "0x61fFE014bA17989E743c5F6cB21bF9697530B21e" as const;
export const ARBITRUM_USDT_ADDRESS = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" as const;
export const ARBITRUM_USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
export const ARBITRUM_USDT_USDC_POOL_FEE = 100 as const;
export const BASIS_POINTS_DENOMINATOR = 10_000n;
export const ARBITRUM_USDT_USDC_AMOUNT_OUT_MINIMUM_BPS = 9_990n;

export const MAX_CUMULATIVE_BRIDGE_USD = 100 as const;
export const MIN_BRIDGE_USDC = 5.01 as const;
export const MAX_LEVERAGE = 5 as const;
export const MAX_POSITION_NOTIONAL_FRACTION = 0.95 as const;
export const TICK_MINUTE = 30 as const;
export const MAX_AGENT_MD_AGE_SECONDS = 300 as const;
export const MAX_SUGGESTION_AGE_SECONDS = 900 as const;
export const DEAD_MANS_SWITCH_SECONDS = 90 as const;
export const ALLOWED_ORDER_STYLES = ["ioc", "gtc"] as const;
export const DEFAULT_ORDER_STYLE = "ioc" as const;
export const MAX_IOC_SAME_TICK_RETRIES = 2 as const;
export const MIN_ORDER_NOTIONAL_USD = 10 as const;
export const AGENT_MD_FETCH_MAX_ATTEMPTS = 3 as const;
export const AGENT_MD_FETCH_RETRY_DELAY_MS = 2_000 as const;
export const HYPERLIQUID_CLIENT_TIMEOUT_MS = 15_000 as const;

export const MIN_ETH_GAS_BUFFER_MULTIPLIER = 2n;

export type HardSafetyCaps = {
  readonly MAX_CUMULATIVE_BRIDGE_USD: typeof MAX_CUMULATIVE_BRIDGE_USD;
  readonly MIN_BRIDGE_USDC: typeof MIN_BRIDGE_USDC;
  readonly MAX_LEVERAGE: typeof MAX_LEVERAGE;
  readonly MAX_POSITION_NOTIONAL_FRACTION: typeof MAX_POSITION_NOTIONAL_FRACTION;
  readonly TICK_MINUTE: typeof TICK_MINUTE;
  readonly MAX_AGENT_MD_AGE_SECONDS: typeof MAX_AGENT_MD_AGE_SECONDS;
  readonly MAX_SUGGESTION_AGE_SECONDS: typeof MAX_SUGGESTION_AGE_SECONDS;
  readonly DEAD_MANS_SWITCH_SECONDS: typeof DEAD_MANS_SWITCH_SECONDS;
};

export const HARD_SAFETY_CAPS = Object.freeze({
  MAX_CUMULATIVE_BRIDGE_USD,
  MIN_BRIDGE_USDC,
  MAX_LEVERAGE,
  MAX_POSITION_NOTIONAL_FRACTION,
  TICK_MINUTE,
  MAX_AGENT_MD_AGE_SECONDS,
  MAX_SUGGESTION_AGE_SECONDS,
  DEAD_MANS_SWITCH_SECONDS,
}) satisfies HardSafetyCaps;

export const CODE_OWNED_CAP_KEYS = Object.freeze(
  Object.keys(HARD_SAFETY_CAPS) as (keyof HardSafetyCaps)[],
);

export const AGENT_MD_AUTHORITY_FIELDS = Object.freeze([
  "version",
  "last_updated",
  "api_contract_version",
  "status",
] as const);
