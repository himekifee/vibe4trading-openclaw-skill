import { AGENT_MD_AUTHORITY_FIELDS, CODE_OWNED_CAP_KEYS, HARD_SAFETY_CAPS } from "./constants";
import type { SingleMarketConfig } from "./market";
import { parseSingleMarketConfig } from "./market";
import {
  SchemaValidationError,
  assertExactKeys,
  expectPlainObject,
  parseJsonText,
  readArray,
  readEnumString,
  readNullableNestedObject,
  readRequiredString,
} from "./validation";

const AGENT_MD_STATUSES = ["active", "degraded", "maintenance", "unknown"] as const;
const AGENT_MD_STRATEGY_PROFILES = ["aggressive", "balanced", "conservative"] as const;

export type AgentMdStatus = (typeof AGENT_MD_STATUSES)[number];
export type AgentMdStrategyProfile = (typeof AGENT_MD_STRATEGY_PROFILES)[number];

export type AgentMdRecommendedSelection = {
  readonly pair: string;
  readonly strategy: AgentMdStrategyProfile;
  readonly model: string;
};

export type AgentMdTradingOptionsCatalog = {
  readonly models: readonly string[];
  readonly strategies: readonly AgentMdStrategyProfile[];
  readonly pairs: readonly SingleMarketConfig[];
  readonly recommended: AgentMdRecommendedSelection | null;
};

export type AgentMdGuidance = {
  readonly version: string | null;
  readonly lastUpdated: string | null;
  readonly apiContractVersion: string | null;
  readonly status: AgentMdStatus;
  readonly ignoredKeys: string[];
  readonly tradingOptions: AgentMdTradingOptionsCatalog | null;
};

const SCALAR_FIELDS: readonly string[] = AGENT_MD_AUTHORITY_FIELDS;

export function extractAgentMdGuidance(markdown: string): AgentMdGuidance {
  const normalized = normalizeMarkdown(markdown);
  const parsedDocument = splitFrontmatter(normalized);
  if (parsedDocument === null) {
    return {
      version: null,
      lastUpdated: null,
      apiContractVersion: null,
      status: "unknown",
      ignoredKeys: [],
      tradingOptions: null,
    };
  }

  const parsed = new Map<string, string>();
  for (const line of parsedDocument.frontmatter.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) {
      throw new SchemaValidationError("agents.md frontmatter contains an invalid line.");
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (SCALAR_FIELDS.includes(key)) {
      value = stripSymmetricQuotes(value);
    }

    parsed.set(key, value);
  }

  const ignoredKeys = [...parsed.keys()].filter(
    (key) => !AGENT_MD_AUTHORITY_FIELDS.includes(key as never),
  );
  const status = parsed.get("status") ?? "unknown";
  if (!AGENT_MD_STATUSES.includes(status as AgentMdStatus)) {
    throw new SchemaValidationError("agents.md status is invalid.");
  }

  return {
    version: parsed.get("version") ?? null,
    lastUpdated: parsed.get("last_updated") ?? null,
    apiContractVersion: parsed.get("api_contract_version") ?? null,
    status: status as AgentMdStatus,
    ignoredKeys,
    tradingOptions: extractTradingOptionsCatalog(normalized),
  };
}

export function parseAgentMdTradingOptionsCatalog(value: unknown): AgentMdTradingOptionsCatalog {
  const context = "AgentMdTradingOptions";
  const input = expectPlainObject(value, context);
  assertExactKeys(input, ["models", "strategies", "pairs", "recommended"], context);

  const models = readArray(input, "models", context, (item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new SchemaValidationError(`${context}.models[${index}] must be a non-empty string.`);
    }
    return item;
  });
  if (models.length === 0) {
    throw new SchemaValidationError(`${context}.models must contain at least one model.`);
  }
  if (new Set(models).size !== models.length) {
    throw new SchemaValidationError(`${context}.models must not contain duplicates.`);
  }

  const strategies = readArray(input, "strategies", context, (item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new SchemaValidationError(
        `${context}.strategies[${index}] must be a non-empty string.`,
      );
    }
    if (!AGENT_MD_STRATEGY_PROFILES.includes(item as AgentMdStrategyProfile)) {
      throw new SchemaValidationError(
        `${context}.strategies[${index}] must be one of: ${AGENT_MD_STRATEGY_PROFILES.join(", ")}.`,
      );
    }
    return item as AgentMdStrategyProfile;
  });
  if (strategies.length === 0) {
    throw new SchemaValidationError(`${context}.strategies must contain at least one strategy.`);
  }
  if (new Set(strategies).size !== strategies.length) {
    throw new SchemaValidationError(`${context}.strategies must not contain duplicates.`);
  }

  const pairs = readArray(input, "pairs", context, (item) => parseSingleMarketConfig(item));
  if (pairs.length === 0) {
    throw new SchemaValidationError(`${context}.pairs must contain at least one pair.`);
  }
  const pairSymbols = new Set<string>();
  for (const pair of pairs) {
    if (pairSymbols.has(pair.symbol)) {
      throw new SchemaValidationError(
        `${context}.pairs contains duplicate symbol: ${pair.symbol}.`,
      );
    }
    pairSymbols.add(pair.symbol);
  }

  const recommended = parseRecommendedSelection(
    readNullableNestedObject(input, "recommended", context),
    { models, strategies, pairs },
  );

  return {
    models,
    strategies,
    pairs,
    recommended,
  };
}

export function getHardSafetyCaps(): typeof HARD_SAFETY_CAPS {
  return HARD_SAFETY_CAPS;
}

export function getAgentMdIgnoredCapKeys(markdown: string): string[] {
  const ignoredKeys = extractAgentMdGuidance(markdown).ignoredKeys;
  return ignoredKeys.filter((key) => CODE_OWNED_CAP_KEYS.includes(key as never));
}

export function hasFrontmatter(markdown: string): boolean {
  return splitFrontmatter(normalizeMarkdown(markdown)) !== null;
}

export function buildOptionId(input: {
  readonly pair: string;
  readonly strategy: string;
  readonly model: string;
}): string {
  return `${input.pair}|${input.strategy}|${input.model}`;
}

function stripSymmetricQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseRecommendedSelection(
  value: ReturnType<typeof readNullableNestedObject>,
  catalog: {
    readonly models: readonly string[];
    readonly strategies: readonly AgentMdStrategyProfile[];
    readonly pairs: readonly SingleMarketConfig[];
  },
): AgentMdRecommendedSelection | null {
  if (value === null) {
    return null;
  }

  const context = "AgentMdTradingOptions.recommended";
  assertExactKeys(value, ["pair", "strategy", "model"], context);

  const pair = readRequiredString(value, "pair", context, { minLength: 1 });
  if (!catalog.pairs.some((entry) => entry.symbol === pair)) {
    throw new SchemaValidationError(
      `${context}.pair must reference one of the configured pair symbols.`,
    );
  }

  const strategy = readEnumString(value, "strategy", context, AGENT_MD_STRATEGY_PROFILES);
  if (!catalog.strategies.includes(strategy)) {
    throw new SchemaValidationError(
      `${context}.strategy must reference one of the configured strategies.`,
    );
  }

  const model = readRequiredString(value, "model", context, { minLength: 1 });
  if (!catalog.models.includes(model)) {
    throw new SchemaValidationError(
      `${context}.model must reference one of the configured models.`,
    );
  }

  return { pair, strategy, model };
}

function extractTradingOptionsCatalog(markdown: string): AgentMdTradingOptionsCatalog {
  const section = extractTradingOptionsSection(markdown);
  const jsonBlock = extractTradingOptionsJsonBlock(section);
  return parseJsonText(
    jsonBlock,
    parseAgentMdTradingOptionsCatalog,
    "agents.md # Trading Options block",
  );
}

function extractTradingOptionsSection(markdown: string): string {
  const headingMatch = /^# Trading Options[ \t]*$/m.exec(markdown);
  if (headingMatch === null) {
    throw new SchemaValidationError("agents.md is missing required # Trading Options section.");
  }

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const remaining = markdown.slice(sectionStart);
  const nextHeadingOffset = remaining.search(/\n# /);
  return nextHeadingOffset === -1 ? remaining : remaining.slice(0, nextHeadingOffset);
}

function extractTradingOptionsJsonBlock(section: string): string {
  const fencePattern = /```([^\n`]*)\n([\s\S]*?)\n```/g;
  const fences = [...section.matchAll(fencePattern)];

  if (fences.length !== 1) {
    throw new SchemaValidationError(
      "agents.md # Trading Options section must contain exactly one fenced json block.",
    );
  }

  const infoString = fences[0]?.[1]?.trim();
  if (infoString !== "json") {
    throw new SchemaValidationError(
      "agents.md # Trading Options section must contain exactly one fenced json block.",
    );
  }

  return fences[0]?.[2] ?? "";
}

function splitFrontmatter(markdown: string): { frontmatter: string } | null {
  if (!markdown.startsWith("---\n")) {
    return null;
  }

  const closingIndex = markdown.indexOf("\n---", 4);
  if (closingIndex === -1) {
    throw new SchemaValidationError("agents.md frontmatter is not properly terminated.");
  }

  return {
    frontmatter: markdown.slice(4, closingIndex),
  };
}

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n");
}
