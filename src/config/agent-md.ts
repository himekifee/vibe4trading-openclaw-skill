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
  readRequiredString,
} from "./validation";

const AGENT_MD_STATUSES = ["active", "degraded", "maintenance", "unknown"] as const;
const AGENT_MD_STRATEGY_PROFILES = ["aggressive", "balanced", "conservative"] as const;

export type AgentMdStatus = (typeof AGENT_MD_STATUSES)[number];
export type AgentMdStrategyProfile = (typeof AGENT_MD_STRATEGY_PROFILES)[number];

export type AgentMdTradingOption = {
  readonly id: string;
  readonly market: SingleMarketConfig;
  readonly modelKey: string;
  readonly strategyKey: string;
  readonly label: string;
  readonly strategyProfile: AgentMdStrategyProfile;
};

export type AgentMdTradingOptionsCatalog = {
  readonly options: AgentMdTradingOption[];
  readonly recommendedOptionId: string;
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
      throw new SchemaValidationError("agent.md frontmatter contains an invalid line.");
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
    throw new SchemaValidationError("agent.md status is invalid.");
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
  assertExactKeys(input, ["options", "recommendedOptionId"], context);

  const options = readArray(input, "options", context, (item, index) =>
    parseAgentMdTradingOption(item, index),
  );
  if (options.length === 0) {
    throw new SchemaValidationError(
      "AgentMdTradingOptions.options must contain at least one option.",
    );
  }

  const optionIds = new Set<string>();
  for (const option of options) {
    if (optionIds.has(option.id)) {
      throw new SchemaValidationError(
        `AgentMdTradingOptions.options contains duplicate id: ${option.id}.`,
      );
    }
    optionIds.add(option.id);
  }

  const recommendedOptionId = readRequiredString(input, "recommendedOptionId", context, {
    minLength: 1,
  });
  if (!optionIds.has(recommendedOptionId)) {
    throw new SchemaValidationError(
      "AgentMdTradingOptions.recommendedOptionId must reference one of the configured options.",
    );
  }

  return {
    options,
    recommendedOptionId,
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

function parseAgentMdTradingOption(value: unknown, index: number): AgentMdTradingOption {
  const context = `AgentMdTradingOptions.options[${index}]`;
  const input = expectPlainObject(value, context);
  assertExactKeys(
    input,
    ["id", "market", "modelKey", "strategyKey", "label", "strategyProfile"],
    context,
  );

  return {
    id: readRequiredString(input, "id", context, { minLength: 1 }),
    market: parseSingleMarketConfig(input.market),
    modelKey: readRequiredString(input, "modelKey", context, { minLength: 1 }),
    strategyKey: readRequiredString(input, "strategyKey", context, { minLength: 1 }),
    label: readRequiredString(input, "label", context, { minLength: 1 }),
    strategyProfile: readEnumString(input, "strategyProfile", context, AGENT_MD_STRATEGY_PROFILES),
  };
}

function extractTradingOptionsCatalog(markdown: string): AgentMdTradingOptionsCatalog {
  const section = extractTradingOptionsSection(markdown);
  const jsonBlock = extractTradingOptionsJsonBlock(section);
  return parseJsonText(
    jsonBlock,
    parseAgentMdTradingOptionsCatalog,
    "agent.md # Trading Options block",
  );
}

function extractTradingOptionsSection(markdown: string): string {
  const headingMatch = /^# Trading Options[ \t]*$/m.exec(markdown);
  if (headingMatch === null) {
    throw new SchemaValidationError("agent.md is missing required # Trading Options section.");
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
      "agent.md # Trading Options section must contain exactly one fenced json block.",
    );
  }

  const infoString = fences[0]?.[1]?.trim();
  if (infoString !== "json") {
    throw new SchemaValidationError(
      "agent.md # Trading Options section must contain exactly one fenced json block.",
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
    throw new SchemaValidationError("agent.md frontmatter is not properly terminated.");
  }

  return {
    frontmatter: markdown.slice(4, closingIndex),
  };
}

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n");
}
