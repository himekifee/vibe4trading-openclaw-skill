import { extractAgentMdGuidance, parseAgentMdTradingOptionsCatalog } from "../config/agent-md";
import type { AgentMdStatus, AgentMdTradingOptionsCatalog } from "../config/agent-md";
import { DEFAULT_AGENT_MD_URL } from "../config/constants";
import {
  SchemaValidationError,
  assertExactKeys,
  expectPlainObject,
  parseJsonText,
  readNullableNestedObject,
  readNullableString,
  readRequiredString,
} from "../config/validation";
import { parseCanonicalUtcTimestamp } from "./slots";

export type AgentMdCacheState = {
  readonly url: string;
  readonly version: string | null;
  readonly lastUpdated: string | null;
  readonly apiContractVersion: string | null;
  readonly status: AgentMdStatus;
  readonly etag: string | null;
  readonly hash: string;
  readonly fetchedAt: string;
  readonly tradingOptions: AgentMdTradingOptionsCatalog | null;
};

export function createAgentMdCacheState(input: {
  readonly markdown: string;
  readonly fetchedAt: string;
  readonly hash: string;
  readonly url?: string;
  readonly etag?: string | null;
}): AgentMdCacheState {
  const guidance = extractAgentMdGuidance(input.markdown);
  return parseAgentMdCacheState({
    url: input.url ?? DEFAULT_AGENT_MD_URL,
    version: guidance.version,
    lastUpdated: guidance.lastUpdated,
    apiContractVersion: guidance.apiContractVersion,
    status: guidance.status,
    etag: input.etag ?? null,
    hash: input.hash,
    fetchedAt: input.fetchedAt,
    tradingOptions: guidance.tradingOptions,
  });
}

export function parseAgentMdCacheState(value: unknown): AgentMdCacheState {
  const context = "AgentMdCacheState";
  const input = expectPlainObject(value, context);
  const withTradingOptions = "tradingOptions" in input ? input : { ...input, tradingOptions: null };
  assertExactKeys(
    withTradingOptions,
    [
      "url",
      "version",
      "lastUpdated",
      "apiContractVersion",
      "status",
      "etag",
      "hash",
      "fetchedAt",
      "tradingOptions",
    ],
    context,
  );

  const status = readRequiredString(withTradingOptions, "status", context);
  if (
    status !== "active" &&
    status !== "degraded" &&
    status !== "maintenance" &&
    status !== "unknown"
  ) {
    throw new SchemaValidationError("AgentMdCacheState.status is invalid.");
  }

  const lastUpdated = readNullableString(withTradingOptions, "lastUpdated", context, {
    minLength: 1,
  });
  if (lastUpdated !== null) {
    parseCanonicalUtcTimestamp(lastUpdated, `${context}.lastUpdated`);
  }

  const tradingOptions = parseNullableAgentMdTradingOptionsCatalog(
    readNullableNestedObject(withTradingOptions, "tradingOptions", context),
  );

  return {
    url: readRequiredString(withTradingOptions, "url", context, { minLength: 1 }),
    version: readNullableString(withTradingOptions, "version", context, { minLength: 1 }),
    lastUpdated,
    apiContractVersion: readNullableString(withTradingOptions, "apiContractVersion", context, {
      minLength: 1,
    }),
    status,
    etag: readNullableString(withTradingOptions, "etag", context, { minLength: 1 }),
    hash: readRequiredString(withTradingOptions, "hash", context, { minLength: 1 }),
    fetchedAt: parseCanonicalUtcTimestamp(
      readRequiredString(withTradingOptions, "fetchedAt", context),
      `${context}.fetchedAt`,
    ).toISOString(),
    tradingOptions,
  };
}

export function serializeAgentMdCacheState(value: AgentMdCacheState): string {
  return `${JSON.stringify(parseAgentMdCacheState(value), null, 2)}\n`;
}

export function deserializeAgentMdCacheState(jsonText: string): AgentMdCacheState {
  return parseJsonText(jsonText, parseAgentMdCacheState, "agents.md cache file");
}

function parseNullableAgentMdTradingOptionsCatalog(
  value: unknown,
): AgentMdTradingOptionsCatalog | null {
  if (value === null) {
    return null;
  }

  return parseAgentMdTradingOptionsCatalog(value);
}
