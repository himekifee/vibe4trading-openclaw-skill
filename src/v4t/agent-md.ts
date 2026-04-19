import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentMdStatus } from "../config/agent-md";
import { extractAgentMdGuidance, hasFrontmatter } from "../config/agent-md";
import {
  AGENT_MD_FETCH_MAX_ATTEMPTS,
  AGENT_MD_FETCH_RETRY_DELAY_MS,
  DEFAULT_AGENT_MD_URL,
} from "../config/constants";
import { AGENT_MD_CACHE_FILE_PATH } from "../config/paths";
import { SchemaValidationError } from "../config/validation";
import { isNodeError } from "../daemon/errors";
import {
  createAgentMdCacheState,
  deserializeAgentMdCacheState,
  parseAgentMdCacheState,
  serializeAgentMdCacheState,
} from "../state";
import type { AgentMdCacheState } from "../state";

export class AgentMdCacheWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentMdCacheWriteError";
  }
}

export type AgentMdPolicyView = {
  readonly version: string | null;
  readonly lastUpdated: string | null;
  readonly apiContractVersion: string | null;
  readonly status: AgentMdStatus;
};

type AgentMdDegradedReason =
  | "network-error"
  | "invalid-agent-md"
  | "unexpected-http-status"
  | "missing-cache";

export type AgentMdRefreshResult =
  | {
      readonly kind: "updated" | "not-modified";
      readonly httpStatus: 200 | 304;
      readonly cache: AgentMdCacheState;
      readonly policy: AgentMdPolicyView;
    }
  | {
      readonly kind: "degraded";
      readonly reason: AgentMdDegradedReason;
      readonly httpStatus: number | null;
      readonly message: string;
      readonly cache: AgentMdCacheState | null;
      readonly policy: AgentMdPolicyView | null;
    };

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type DelayFn = (ms: number) => Promise<void>;

export async function readAgentMdCache(
  options: {
    readonly cacheFilePath?: string;
  } = {},
): Promise<AgentMdCacheState | null> {
  const cacheFilePath = options.cacheFilePath ?? AGENT_MD_CACHE_FILE_PATH;

  try {
    const jsonText = await readFile(cacheFilePath, "utf8");
    return deserializeAgentMdCacheState(jsonText);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function persistAgentMdCache(
  cache: AgentMdCacheState,
  options: {
    readonly cacheFilePath?: string;
  } = {},
): Promise<void> {
  const cacheFilePath = options.cacheFilePath ?? AGENT_MD_CACHE_FILE_PATH;
  const serialized = serializeAgentMdCacheState(cache);
  const tempFilePath = `${cacheFilePath}.tmp-${process.pid}-${Date.now()}`;

  try {
    await mkdir(dirname(cacheFilePath), { recursive: true });
    await writeFile(tempFilePath, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(tempFilePath, cacheFilePath);
  } catch (error) {
    await cleanupTempFile(tempFilePath);
    throw new AgentMdCacheWriteError(
      `Failed to persist agents.md cache to ${cacheFilePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export async function refreshAgentMdCache(
  options: {
    readonly url?: string;
    readonly now?: Date;
    readonly fetchImpl?: FetchLike;
    readonly cacheFilePath?: string;
    readonly delay?: DelayFn;
    readonly maxAttempts?: number;
    readonly retryDelayMs?: number;
  } = {},
): Promise<AgentMdRefreshResult> {
  const url = options.url ?? DEFAULT_AGENT_MD_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const cacheFilePath = options.cacheFilePath ?? AGENT_MD_CACHE_FILE_PATH;
  const fetchedAt = (options.now ?? new Date()).toISOString();
  const cachedState = await readAgentMdCache({ cacheFilePath });
  const delay = options.delay ?? defaultDelay;
  const maxAttempts = options.maxAttempts ?? AGENT_MD_FETCH_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? AGENT_MD_FETCH_RETRY_DELAY_MS;

  const headers = new Headers({ Accept: "text/markdown, text/plain;q=0.9, */*;q=0.1" });
  if (cachedState?.etag != null) {
    headers.set("If-None-Match", cachedState.etag);
  }

  let response: Response;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      response = await fetchImpl(url, { method: "GET", headers });
      return processAgentMdResponse(response, cachedState, url, fetchedAt, cacheFilePath);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await delay(retryDelayMs);
      }
    }
  }

  return degradedResult(
    "network-error",
    null,
    lastError instanceof Error ? lastError.message : "agents.md fetch failed.",
    cachedState,
  );
}

function toAgentMdPolicyView(
  value: Pick<AgentMdCacheState, "version" | "lastUpdated" | "apiContractVersion" | "status">,
): AgentMdPolicyView {
  return Object.freeze({
    version: value.version,
    lastUpdated: value.lastUpdated,
    apiContractVersion: value.apiContractVersion,
    status: value.status,
  });
}

export function hashMarkdown(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

function degradedResult(
  reason: AgentMdDegradedReason,
  httpStatus: number | null,
  message: string,
  cache: AgentMdCacheState | null,
): AgentMdRefreshResult {
  return {
    kind: "degraded",
    reason,
    httpStatus,
    message,
    cache,
    policy: cache === null ? null : toAgentMdPolicyView(cache),
  };
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processAgentMdResponse(
  response: Response,
  cachedState: AgentMdCacheState | null,
  url: string,
  fetchedAt: string,
  cacheFilePath: string,
): Promise<AgentMdRefreshResult> {
  if (response.status === 304) {
    if (cachedState === null) {
      return degradedResult(
        "missing-cache",
        response.status,
        "Received 304 for agents.md without a local cache entry.",
        null,
      );
    }

    const nextCache = parseAgentMdCacheState({
      ...cachedState,
      etag: response.headers.get("etag")?.trim() ?? cachedState.etag,
      fetchedAt,
    });
    await persistAgentMdCache(nextCache, { cacheFilePath });
    return {
      kind: "not-modified",
      httpStatus: 304,
      cache: nextCache,
      policy: toAgentMdPolicyView(nextCache),
    };
  }

  if (response.status !== 200) {
    return degradedResult(
      "unexpected-http-status",
      response.status,
      `Unexpected agents.md HTTP status: ${response.status}.`,
      cachedState,
    );
  }

  const markdown = await response.text();
  if (!hasFrontmatter(markdown)) {
    return degradedResult(
      "invalid-agent-md",
      response.status,
      "agents.md response has no frontmatter.",
      cachedState,
    );
  }

  try {
    extractAgentMdGuidance(markdown);
  } catch (error) {
    return degradedResult(
      "invalid-agent-md",
      response.status,
      error instanceof Error ? error.message : "agents.md failed validation.",
      cachedState,
    );
  }

  const nextCache = createAgentMdCacheState({
    markdown,
    url,
    etag: response.headers.get("etag")?.trim() ?? null,
    fetchedAt,
    hash: hashMarkdown(markdown),
  });
  await persistAgentMdCache(nextCache, { cacheFilePath });
  return {
    kind: "updated",
    httpStatus: 200,
    cache: nextCache,
    policy: toAgentMdPolicyView(nextCache),
  };
}

async function cleanupTempFile(tempFilePath: string): Promise<void> {
  try {
    await rm(tempFilePath, { force: true });
  } catch (error) {
    console.warn(
      `cleanupTempFile: failed to remove ${tempFilePath} — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
