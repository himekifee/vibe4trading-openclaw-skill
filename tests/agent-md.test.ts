import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { extractAgentMdGuidance, parseAgentMdTradingOptionsCatalog } from "../src/config/agent-md";
import {
  AGENT_MD_FETCH_MAX_ATTEMPTS,
  AGENT_MD_FETCH_RETRY_DELAY_MS,
} from "../src/config/constants";
import { SchemaValidationError } from "../src/config/validation";
import { deserializeAgentMdCacheState } from "../src/state";
import { hashMarkdown, readAgentMdCache, refreshAgentMdCache } from "../src/v4t";

const VALID_TRADING_OPTIONS_JSON = `{
  "options": [
    {
      "id": "btc-balanced",
      "market": {
        "venue": "hyperliquid",
        "mode": "perp",
        "marketId": "perps:hyperliquid:BTC-PERP",
        "symbol": "BTC-PERP"
      },
      "modelKey": "openclaw-daemon",
      "strategyKey": "momentum-v2",
      "label": "BTC Momentum Balanced",
      "strategyProfile": "balanced"
    },
    {
      "id": "eth-conservative",
      "market": {
        "venue": "hyperliquid",
        "mode": "spot",
        "marketId": "spot:hyperliquid:ETH/USDC",
        "symbol": "ETH/USDC"
      },
      "modelKey": "openclaw-daemon",
      "strategyKey": "mean-reversion-v1",
      "label": "ETH Spot Conservative",
      "strategyProfile": "conservative"
    }
  ],
  "recommendedOptionId": "btc-balanced"
}`;

function createAgentMdMarkdown(
  optionsJson: string = VALID_TRADING_OPTIONS_JSON,
  overrides: {
    version?: string;
    lastUpdated?: string;
    apiContractVersion?: string;
    status?: string;
    extraFrontmatterLines?: string[];
    platformStatusText?: string;
  } = {},
): string {
  const version = overrides.version ?? "7";
  const lastUpdated = overrides.lastUpdated ?? "2026-03-27T11:00:00.000Z";
  const apiContractVersion = overrides.apiContractVersion ?? "2";
  const status = overrides.status ?? "degraded";
  const extraFrontmatterLines = overrides.extraFrontmatterLines ?? ["MAX_LEVERAGE: 999"];
  const platformStatusText = overrides.platformStatusText ?? "Maintenance window";

  return `---
version: ${version}
last_updated: ${lastUpdated}
api_contract_version: ${apiContractVersion}
status: ${status}
${extraFrontmatterLines.join("\n")}
---

# Onboarding
Ready.

# Funding
Fund the wallet.

# Safety Notices
Code-owned caps remain final.

# Trading Options



\`\`\`json
${optionsJson}
\`\`\`

# Platform Status
${platformStatusText}
`;
}

describe("agent-md", () => {
  it("fetches, hashes, and persists bounded agent.md cache metadata", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "agent-md-cache-"));
    const cacheFilePath = join(runtimeDir, "agent-md-cache.json");
    const markdown = createAgentMdMarkdown();

    const result = await refreshAgentMdCache({
      cacheFilePath,
      now: new Date("2026-03-27T11:01:00.000Z"),
      fetchImpl: async () =>
        new Response(markdown, {
          status: 200,
          headers: {
            etag: '"etag-123"',
            "content-type": "text/markdown",
          },
        }),
    });

    expect(result).toMatchObject({
      kind: "updated",
      httpStatus: 200,
      policy: {
        version: "7",
        lastUpdated: "2026-03-27T11:00:00.000Z",
        apiContractVersion: "2",
        status: "degraded",
      },
    });
    expect(result.kind === "updated" ? result.cache.hash : "").toBe(hashMarkdown(markdown));

    const storedText = await readFile(cacheFilePath, "utf8");
    const persisted = deserializeAgentMdCacheState(storedText);
    expect(persisted).toMatchObject({
      etag: '"etag-123"',
      fetchedAt: "2026-03-27T11:01:00.000Z",
      hash: hashMarkdown(markdown),
      status: "degraded",
      tradingOptions: {
        recommendedOptionId: "btc-balanced",
      },
    });
    expect(persisted.tradingOptions?.options).toHaveLength(2);
  });

  it("does not leave temp files after successful agent.md cache persistence", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "agent-md-atomic-"));
    const cacheFilePath = join(runtimeDir, "agent-md-cache.json");
    const markdown = createAgentMdMarkdown(
      `{
  "options": [
    {
      "id": "eth-balanced",
      "market": {
        "venue": "hyperliquid",
        "mode": "perp",
        "marketId": "perps:hyperliquid:ETH-PERP",
        "symbol": "ETH-PERP"
      },
      "modelKey": "openclaw-daemon",
      "strategyKey": "momentum-v1",
      "label": "ETH Balanced",
      "strategyProfile": "balanced"
    }
  ],
  "recommendedOptionId": "eth-balanced"
}`,
      {
        version: "1",
        apiContractVersion: "1",
        status: "active",
      },
    );

    await refreshAgentMdCache({
      cacheFilePath,
      now: new Date("2026-03-27T10:01:00.000Z"),
      fetchImpl: async () =>
        new Response(markdown, {
          status: 200,
          headers: { etag: '"etag-atomic"' },
        }),
    });

    const files = await readdir(runtimeDir);
    expect(files).toEqual(["agent-md-cache.json"]);
  });

  it("does not leave temp files after 304 revalidation persistence", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "agent-md-atomic-304-"));
    const cacheFilePath = join(runtimeDir, "agent-md-cache.json");
    const markdown = createAgentMdMarkdown(
      `{
  "options": [
    {
      "id": "eth-balanced",
      "market": {
        "venue": "hyperliquid",
        "mode": "perp",
        "marketId": "perps:hyperliquid:ETH-PERP",
        "symbol": "ETH-PERP"
      },
      "modelKey": "openclaw-daemon",
      "strategyKey": "momentum-v1",
      "label": "ETH Balanced",
      "strategyProfile": "balanced"
    }
  ],
  "recommendedOptionId": "eth-balanced"
}`,
      {
        version: "1",
        apiContractVersion: "1",
        status: "active",
      },
    );

    await refreshAgentMdCache({
      cacheFilePath,
      now: new Date("2026-03-27T10:01:00.000Z"),
      fetchImpl: async () =>
        new Response(markdown, {
          status: 200,
          headers: { etag: '"etag-304"' },
        }),
    });

    await refreshAgentMdCache({
      cacheFilePath,
      now: new Date("2026-03-27T10:05:00.000Z"),
      fetchImpl: async () =>
        new Response(null, {
          status: 304,
          headers: { etag: '"etag-304"' },
        }),
    });

    const files = await readdir(runtimeDir);
    expect(files).toEqual(["agent-md-cache.json"]);
  });

  it("revalidates with etag and refreshes fetchedAt on 304 responses", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "agent-md-304-"));
    const cacheFilePath = join(runtimeDir, "agent-md-cache.json");
    const markdown = createAgentMdMarkdown(
      `{
  "options": [
    {
      "id": "eth-balanced",
      "market": {
        "venue": "hyperliquid",
        "mode": "perp",
        "marketId": "perps:hyperliquid:ETH-PERP",
        "symbol": "ETH-PERP"
      },
      "modelKey": "openclaw-daemon",
      "strategyKey": "momentum-v1",
      "label": "ETH Balanced",
      "strategyProfile": "balanced"
    }
  ],
  "recommendedOptionId": "eth-balanced"
}`,
      {
        version: "1",
        apiContractVersion: "1",
        status: "active",
      },
    );

    await refreshAgentMdCache({
      cacheFilePath,
      now: new Date("2026-03-27T10:01:00.000Z"),
      fetchImpl: async () =>
        new Response(markdown, {
          status: 200,
          headers: { etag: '"etag-1"' },
        }),
    });

    let receivedIfNoneMatch: string | null = null;
    const secondResult = await refreshAgentMdCache({
      cacheFilePath,
      now: new Date("2026-03-27T10:05:00.000Z"),
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init?.headers);
        receivedIfNoneMatch = headers.get("If-None-Match");
        return new Response(null, {
          status: 304,
          headers: { etag: '"etag-1"' },
        });
      },
    });

    expect(receivedIfNoneMatch).toBe('"etag-1"');
    expect(secondResult).toMatchObject({
      kind: "not-modified",
      httpStatus: 304,
      policy: {
        version: "1",
        status: "active",
      },
    });

    const persistedCache = await readAgentMdCache({ cacheFilePath });
    expect(persistedCache?.fetchedAt).toBe("2026-03-27T10:05:00.000Z");
  });

  it("parses CRLF-terminated frontmatter identically to LF input", () => {
    const lf = createAgentMdMarkdown(
      `{
  "options": [
    {
      "id": "crlf-test",
      "market": {
        "venue": "hyperliquid",
        "mode": "perp",
        "marketId": "perps:hyperliquid:BTC-PERP",
        "symbol": "BTC-PERP"
      },
      "modelKey": "openclaw-daemon",
      "strategyKey": "momentum-v1",
      "label": "CRLF Test",
      "strategyProfile": "balanced"
    }
  ],
  "recommendedOptionId": "crlf-test"
}`,
      {
        version: "1",
        status: "active",
        extraFrontmatterLines: [],
        platformStatusText: "Body",
      },
    );
    const crlf = lf.replace(/\n/g, "\r\n");

    const lfResult = extractAgentMdGuidance(lf);
    const crlfResult = extractAgentMdGuidance(crlf);

    expect(crlfResult).toEqual(lfResult);
    expect(crlfResult.version).toBe("1");
    expect(crlfResult.status).toBe("active");
  });

  it("strips symmetric double quotes from documented scalar fields", () => {
    const markdown = createAgentMdMarkdown(undefined, {
      version: '"7"',
      lastUpdated: '"2026-03-27T11:00:00.000Z"',
      apiContractVersion: '"2"',
      status: '"active"',
    });
    const result = extractAgentMdGuidance(markdown);
    expect(result.version).toBe("7");
    expect(result.lastUpdated).toBe("2026-03-27T11:00:00.000Z");
    expect(result.apiContractVersion).toBe("2");
    expect(result.status).toBe("active");
  });

  it("strips symmetric single quotes from documented scalar fields", () => {
    const markdown = createAgentMdMarkdown(undefined, {
      version: "'3'",
    });
    const result = extractAgentMdGuidance(markdown);
    expect(result.version).toBe("3");
    expect(result.status).toBe("degraded");
  });

  it("does not strip asymmetric or non-matching quotes", () => {
    const markdown = createAgentMdMarkdown(undefined, {
      version: `\"7'`,
      status: "active",
    });
    const result = extractAgentMdGuidance(markdown);
    expect(result.version).toBe("\"7'");
    expect(result.status).toBe("active");
  });

  it("does not strip quotes from non-authority fields", () => {
    const markdown = createAgentMdMarkdown(undefined, {
      version: "1",
      status: "active",
      extraFrontmatterLines: ['MAX_LEVERAGE: "999"'],
    });
    const result = extractAgentMdGuidance(markdown);
    expect(result.ignoredKeys).toContain("MAX_LEVERAGE");
  });

  it("parses the locked Trading Options catalog from the required json block", () => {
    const result = extractAgentMdGuidance(createAgentMdMarkdown());

    expect(result.tradingOptions).toEqual({
      options: [
        {
          id: "btc-balanced",
          market: {
            venue: "hyperliquid",
            mode: "perp",
            marketId: "perps:hyperliquid:BTC-PERP",
            symbol: "BTC-PERP",
          },
          modelKey: "openclaw-daemon",
          strategyKey: "momentum-v2",
          label: "BTC Momentum Balanced",
          strategyProfile: "balanced",
        },
        {
          id: "eth-conservative",
          market: {
            venue: "hyperliquid",
            mode: "spot",
            marketId: "spot:hyperliquid:ETH/USDC",
            symbol: "ETH/USDC",
          },
          modelKey: "openclaw-daemon",
          strategyKey: "mean-reversion-v1",
          label: "ETH Spot Conservative",
          strategyProfile: "conservative",
        },
      ],
      recommendedOptionId: "btc-balanced",
    });
  });

  it("validates catalog strategyProfile against the locked enum", () => {
    expect(() =>
      parseAgentMdTradingOptionsCatalog({
        options: [
          {
            id: "opt-1",
            market: {
              venue: "hyperliquid",
              mode: "perp",
              marketId: "perps:hyperliquid:BTC-PERP",
              symbol: "BTC-PERP",
            },
            modelKey: "openclaw-daemon",
            strategyKey: "momentum-v1",
            label: "Option",
            strategyProfile: "yolo",
          },
        ],
        recommendedOptionId: "opt-1",
      }),
    ).toThrowError(/must be one of/i);
  });

  it("returns degraded when 200 OK body has no frontmatter and prior cache exists", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "agent-md-no-fm-"));
    const cacheFilePath = join(runtimeDir, "agent-md-cache.json");

    const validMarkdown = createAgentMdMarkdown(
      `{
  "options": [
    {
      "id": "eth-balanced",
      "market": {
        "venue": "hyperliquid",
        "mode": "perp",
        "marketId": "perps:hyperliquid:ETH-PERP",
        "symbol": "ETH-PERP"
      },
      "modelKey": "openclaw-daemon",
      "strategyKey": "momentum-v1",
      "label": "ETH Balanced",
      "strategyProfile": "balanced"
    }
  ],
  "recommendedOptionId": "eth-balanced"
}`,
      {
        version: "1",
        apiContractVersion: "1",
        status: "active",
      },
    );

    await refreshAgentMdCache({
      cacheFilePath,
      now: new Date("2026-03-27T10:01:00.000Z"),
      fetchImpl: async () =>
        new Response(validMarkdown, {
          status: 200,
          headers: { etag: '"etag-valid"' },
        }),
    });

    const priorCache = await readAgentMdCache({ cacheFilePath });
    expect(priorCache?.status).toBe("active");

    const spaBody = "<html><body>SPA landing page</body></html>";
    const result = await refreshAgentMdCache({
      cacheFilePath,
      now: new Date("2026-03-27T10:05:00.000Z"),
      fetchImpl: async () =>
        new Response(spaBody, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });

    expect(result.kind).toBe("degraded");
    if (result.kind !== "degraded") throw new Error("Expected degraded result");
    expect(result.reason).toBe("invalid-agent-md");
    expect(result.httpStatus).toBe(200);
    expect(result.message).toBe("agent.md response has no frontmatter.");
    expect(result.cache?.status).toBe("active");
    expect(result.cache?.tradingOptions?.recommendedOptionId).toBe("eth-balanced");

    const preservedCache = await readAgentMdCache({ cacheFilePath });
    expect(preservedCache?.status).toBe("active");
    expect(preservedCache?.tradingOptions?.recommendedOptionId).toBe("eth-balanced");
  });

  it("returns degraded with null cache when 200 OK body has no frontmatter and no prior cache", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "agent-md-no-fm-no-cache-"));
    const cacheFilePath = join(runtimeDir, "agent-md-cache.json");

    const spaBody = "<html><body>SPA landing page</body></html>";
    const result = await refreshAgentMdCache({
      cacheFilePath,
      now: new Date("2026-03-27T10:05:00.000Z"),
      fetchImpl: async () =>
        new Response(spaBody, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });

    expect(result.kind).toBe("degraded");
    if (result.kind !== "degraded") throw new Error("Expected degraded result");
    expect(result.reason).toBe("invalid-agent-md");
    expect(result.httpStatus).toBe(200);
    expect(result.cache).toBeNull();
  });

  it("parses quoted status correctly through full refresh cycle", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "agent-md-quoted-refresh-"));
    const cacheFilePath = join(runtimeDir, "agent-md-cache.json");
    const markdown = createAgentMdMarkdown(undefined, {
      version: '"7"',
      lastUpdated: '"2026-03-27T11:00:00.000Z"',
      apiContractVersion: '"2"',
      status: '"degraded"',
      platformStatusText: "Quoted values",
    });

    const result = await refreshAgentMdCache({
      cacheFilePath,
      now: new Date("2026-03-27T11:01:00.000Z"),
      fetchImpl: async () =>
        new Response(markdown, {
          status: 200,
          headers: { etag: '"etag-quoted"' },
        }),
    });

    expect(result).toMatchObject({
      kind: "updated",
      httpStatus: 200,
      policy: {
        version: "7",
        lastUpdated: "2026-03-27T11:00:00.000Z",
        apiContractVersion: "2",
        status: "degraded",
      },
    });
  });

  it("degrades and preserves the prior cache when Trading Options section is missing", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "agent-md-missing-options-"));
    const cacheFilePath = join(runtimeDir, "agent-md-cache.json");

    await refreshAgentMdCache({
      cacheFilePath,
      now: new Date("2026-03-27T10:01:00.000Z"),
      fetchImpl: async () =>
        new Response(createAgentMdMarkdown(), {
          status: 200,
          headers: { etag: '"etag-valid"' },
        }),
    });

    const malformedMarkdown = `---
version: 8
last_updated: 2026-03-27T10:05:00.000Z
api_contract_version: 2
status: active
---

# Platform Status
No catalog here.
`;

    const result = await refreshAgentMdCache({
      cacheFilePath,
      now: new Date("2026-03-27T10:06:00.000Z"),
      fetchImpl: async () =>
        new Response(malformedMarkdown, {
          status: 200,
          headers: { etag: '"etag-bad"' },
        }),
    });

    expect(result.kind).toBe("degraded");
    if (result.kind !== "degraded") throw new Error("Expected degraded result");
    expect(result.reason).toBe("invalid-agent-md");
    expect(result.message).toBe("agent.md is missing required # Trading Options section.");
    expect(result.cache?.tradingOptions?.recommendedOptionId).toBe("btc-balanced");

    const preservedCache = await readAgentMdCache({ cacheFilePath });
    expect(preservedCache?.tradingOptions?.recommendedOptionId).toBe("btc-balanced");
  });

  it("degrades and preserves the prior cache when Trading Options json is malformed", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "agent-md-bad-options-json-"));
    const cacheFilePath = join(runtimeDir, "agent-md-cache.json");

    await refreshAgentMdCache({
      cacheFilePath,
      now: new Date("2026-03-27T10:01:00.000Z"),
      fetchImpl: async () =>
        new Response(createAgentMdMarkdown(), {
          status: 200,
          headers: { etag: '"etag-valid"' },
        }),
    });

    const result = await refreshAgentMdCache({
      cacheFilePath,
      now: new Date("2026-03-27T10:06:00.000Z"),
      fetchImpl: async () =>
        new Response(
          createAgentMdMarkdown(`{
  "options": [
    {
      "id": "bad-risk",
      "market": {
        "venue": "hyperliquid",
        "mode": "perp",
        "marketId": "perps:hyperliquid:BTC-PERP",
        "symbol": "BTC-PERP"
      },
      "modelKey": "openclaw-daemon",
      "strategyKey": "momentum-v1",
      "label": "Bad Risk",
      "strategyProfile": "yolo"
    }
  ],
  "recommendedOptionId": "bad-risk"
}`),
          {
            status: 200,
            headers: { etag: '"etag-bad"' },
          },
        ),
    });

    expect(result.kind).toBe("degraded");
    if (result.kind !== "degraded") throw new Error("Expected degraded result");
    expect(result.reason).toBe("invalid-agent-md");
    expect(result.message).toMatch(/strategyProfile must be one of/i);
    expect(result.cache?.tradingOptions?.recommendedOptionId).toBe("btc-balanced");

    const preservedCache = await readAgentMdCache({ cacheFilePath });
    expect(preservedCache?.tradingOptions?.recommendedOptionId).toBe("btc-balanced");
  });

  it("degrades with null cache when Trading Options catalog is malformed and no prior cache exists", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "agent-md-bad-options-no-cache-"));
    const cacheFilePath = join(runtimeDir, "agent-md-cache.json");

    const result = await refreshAgentMdCache({
      cacheFilePath,
      now: new Date("2026-03-27T10:06:00.000Z"),
      fetchImpl: async () =>
        new Response(
          createAgentMdMarkdown(`{
  "options": [],
  "recommendedOptionId": "missing"
}`),
          {
            status: 200,
            headers: { etag: '"etag-bad"' },
          },
        ),
    });

    expect(result.kind).toBe("degraded");
    if (result.kind !== "degraded") throw new Error("Expected degraded result");
    expect(result.reason).toBe("invalid-agent-md");
    expect(result.cache).toBeNull();
  });

  it("rejects legacy riskProfile in Trading Options", () => {
    const parseLegacyCatalog = () =>
      parseAgentMdTradingOptionsCatalog({
        options: [
          {
            id: "btc-balanced",
            market: {
              venue: "hyperliquid",
              mode: "perp",
              marketId: "perps:hyperliquid:BTC-PERP",
              symbol: "BTC-PERP",
            },
            modelKey: "openclaw-daemon",
            strategyKey: "momentum-v2",
            label: "BTC Momentum Balanced",
            riskProfile: "balanced",
          },
        ],
        recommendedOptionId: "btc-balanced",
      });

    expect(parseLegacyCatalog).toThrow(SchemaValidationError);
    expect(parseLegacyCatalog).toThrow(/strategyProfile/);
  });

  it("retries network failures exactly 3 times with 2 delays between attempts", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "agent-md-retry-all-fail-"));
    const cacheFilePath = join(runtimeDir, "agent-md-cache.json");
    let fetchCallCount = 0;
    const delayCallArgs: number[] = [];

    const result = await refreshAgentMdCache({
      cacheFilePath,
      now: new Date("2026-03-27T12:00:00.000Z"),
      delay: async (ms) => {
        delayCallArgs.push(ms);
      },
      fetchImpl: async () => {
        fetchCallCount++;
        throw new Error("ECONNREFUSED");
      },
    });

    expect(fetchCallCount).toBe(AGENT_MD_FETCH_MAX_ATTEMPTS);
    expect(fetchCallCount).toBe(3);
    expect(delayCallArgs).toEqual([AGENT_MD_FETCH_RETRY_DELAY_MS, AGENT_MD_FETCH_RETRY_DELAY_MS]);
    expect(delayCallArgs).toEqual([2000, 2000]);
    expect(result.kind).toBe("degraded");
    if (result.kind !== "degraded") throw new Error("Expected degraded");
    expect(result.reason).toBe("network-error");
    expect(result.message).toBe("ECONNREFUSED");
    expect(result.cache).toBeNull();
  });

  it("succeeds on second attempt without further retries", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "agent-md-retry-success-2nd-"));
    const cacheFilePath = join(runtimeDir, "agent-md-cache.json");
    const markdown = createAgentMdMarkdown(undefined, { version: "1", status: "active" });
    let fetchCallCount = 0;
    const delayCallArgs: number[] = [];

    const result = await refreshAgentMdCache({
      cacheFilePath,
      now: new Date("2026-03-27T12:00:00.000Z"),
      delay: async (ms) => {
        delayCallArgs.push(ms);
      },
      fetchImpl: async () => {
        fetchCallCount++;
        if (fetchCallCount === 1) throw new Error("DNS failure");
        return new Response(markdown, {
          status: 200,
          headers: { etag: '"etag-retry"' },
        });
      },
    });

    expect(fetchCallCount).toBe(2);
    expect(delayCallArgs).toEqual([2000]);
    expect(result.kind).toBe("updated");
    expect(result).toMatchObject({
      kind: "updated",
      httpStatus: 200,
      policy: { version: "1", status: "active" },
    });

    const persisted = await readAgentMdCache({ cacheFilePath });
    expect(persisted?.version).toBe("1");
  });

  it("preserves prior cache in degraded result after all retry attempts fail", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "agent-md-retry-preserve-cache-"));
    const cacheFilePath = join(runtimeDir, "agent-md-cache.json");
    const markdown = createAgentMdMarkdown(undefined, { version: "5", status: "active" });

    await refreshAgentMdCache({
      cacheFilePath,
      now: new Date("2026-03-27T10:00:00.000Z"),
      fetchImpl: async () =>
        new Response(markdown, {
          status: 200,
          headers: { etag: '"etag-prior"' },
        }),
    });

    const result = await refreshAgentMdCache({
      cacheFilePath,
      now: new Date("2026-03-27T12:00:00.000Z"),
      delay: async () => {},
      fetchImpl: async () => {
        throw new Error("Connection timed out");
      },
    });

    expect(result.kind).toBe("degraded");
    if (result.kind !== "degraded") throw new Error("Expected degraded");
    expect(result.reason).toBe("network-error");
    expect(result.message).toBe("Connection timed out");
    expect(result.cache?.version).toBe("5");
    expect(result.cache?.status).toBe("active");
    expect(result.policy?.version).toBe("5");

    const preserved = await readAgentMdCache({ cacheFilePath });
    expect(preserved?.version).toBe("5");
  });

  it("does not retry on successful HTTP responses including non-200 status codes", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "agent-md-no-retry-http-"));
    const cacheFilePath = join(runtimeDir, "agent-md-cache.json");
    let fetchCallCount = 0;
    const delayCallArgs: number[] = [];

    const result = await refreshAgentMdCache({
      cacheFilePath,
      now: new Date("2026-03-27T12:00:00.000Z"),
      delay: async (ms) => {
        delayCallArgs.push(ms);
      },
      fetchImpl: async () => {
        fetchCallCount++;
        return new Response("Service Unavailable", { status: 503 });
      },
    });

    expect(fetchCallCount).toBe(1);
    expect(delayCallArgs).toEqual([]);
    expect(result.kind).toBe("degraded");
    if (result.kind !== "degraded") throw new Error("Expected degraded");
    expect(result.reason).toBe("unexpected-http-status");
    expect(result.httpStatus).toBe(503);
  });
});
