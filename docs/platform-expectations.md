# Platform Expectations

This document describes the expected contract between the OpenClaw skill and the vibe4trading platform, along with the current platform reality and known gaps. Field names, types, and error semantics below match the plan's declared future contract literally.

## Operational Model

The skill operates on a **one-shot, cron-driven execution model**. There is no resident process, no loop, and no inter-tick sleep. The network defaults to mainnet; explicit live-trading acknowledgment is required before the first armed tick.

- **`start_trading`** arms the skill: reconciles local state against Hyperliquid exchange data and sets status to `running`. It does not start a loop or spawn a background process. On mainnet, requires prior `acknowledge_live_trading` consent.
- **The OpenClaw Gateway scheduler** fires an isolated agent turn every hour at `:30 UTC` using the `30 * * * *` cron expression.
- **`execute_tick`** is the deterministic one-shot execution seam. Each invocation reconciles state, fetches a suggestion, evaluates policy, executes, and exits. Accepts optional explicit agent-authored intents and agent-directed order style (IOC or GTC). IOC orders may retry up to 2 additional times within the same tick on partial fills.
- **`stop_trading`** halts execution: cancels orders, clears the dead-man switch, and refuses further ticks until re-armed. Does not close or flatten open positions.

Cron registration is host-managed through OpenClaw Gateway tooling or operator instructions. The skill itself does not register or provision its schedule. SKILL.md frontmatter does not support `cron`, `schedule`, or `trigger` fields.

## Suggestion Endpoint

### Expected Contract

```
GET https://vibe4trading.ai/api/agent/suggestions/latest
Authorization: Bearer <api_token>
```

Query parameters:
- `market_id` -- exact configured market, e.g. `perps:hyperliquid:BTC-PERP` or `spot:hyperliquid:ETH/USDC`
- `risk_profile` -- `aggressive | balanced | conservative` (wire key remains `risk_profile` even though the skill's internal/public field name is `strategyProfile`)
- `model_key` -- requested vibe4trading model identifier
- `strategy_key` -- strategy identifier from the selected trading option, e.g. `momentum-v2`

**200 response fields:**

| Field | Type | Notes |
|---|---|---|
| `suggestion_id` | `string` | Unique identifier |
| `generated_at` | `string` (ISO 8601) | When the suggestion was generated |
| `expires_at` | `string` (ISO 8601) | When the suggestion expires |
| `market_id` | `string` | Echo of requested market |
| `mode` | `"spot" \| "futures"` | Trading mode |
| `side` | `"long" \| "short" \| "flat"` | Suggested direction |
| `target_fraction` | `number` | 0.0--1.0 margin/equity fraction before local reinterpretation |
| `leverage` | `number` | Suggested leverage — **integer-only** (the parser rejects non-integer values). Clamped locally to MAX_LEVERAGE. A value of `0` on a non-flat perp target causes a policy hold when `maxLeverage` is set to `0`; otherwise the deterministic 1x floor applies. |
| `confidence` | `number` | Model confidence score |
| `rationale` | `string` | Human-readable explanation |
| `key_signals` | `string[]` | Signal identifiers driving the suggestion |
| `stop_loss_pct` | `number \| null` | Optional stop-loss percentage |
| `take_profit_pct` | `number \| null` | Optional take-profit percentage |
| `source_run_id` | `string \| null` | Optional originating run ID |
| `source_strategy_name` | `string \| null` | Optional strategy name |

**Error responses:**

| Status | Meaning |
|---|---|
| `204` | No fresh suggestion currently available; skill holds and logs degraded status |
| `401/403` | Token invalid or unauthorized |
| `422` | Unsupported market/model combination |

### Platform Status

**Not available in production.** The suggestion endpoint (`GET https://vibe4trading.ai/api/agent/suggestions/latest`) is not currently exposed by vibe4trading. The skill handles this by holding (taking no action) when no suggestion is available. A mock suggestion provider is included for local development and smoke tests.

## agents.md Contract

### Expected Contract

**URL:** `https://vibe4trading.ai/agents.md`

**Purpose:** Structured platform guidance plus the authoritative catalog of selectable trading combinations. Free-form prose may change messaging and warnings, while code-owned safety caps remain final.

**Required frontmatter:**

```yaml
version: "<version string>"
last_updated: "<ISO 8601>"
api_contract_version: "<version string>"
status: "active | degraded | maintenance"
```

**Required body contract:**

- `# Trading Options`
- The section must contain **exactly one** fenced `json` block with this shape:

```json
{
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
    }
  ],
  "recommendedOptionId": "btc-balanced"
}
```

Validation rules:
- `options` must contain at least one entry
- `recommendedOptionId` must match one configured option `id`
- each option must contain exactly `id`, `market`, `modelKey`, `strategyKey`, `label`, `strategyProfile`
- `market` is validated with the same `SingleMarketConfig` contract used in code
- `strategyProfile` must be exactly `aggressive | balanced | conservative`

Legacy `riskProfile` is no longer accepted. Persisted runtime state and cached `agents.md` content must use `strategyProfile`. The HTTP suggestion wire key remains `risk_profile` for backward compatibility with the platform API.

The skill caches this document locally at `runtime/agent-md-cache.json` with ETag-based revalidation. The cache entry stores `url`, `version`, `lastUpdated`, `apiContractVersion`, `status`, `etag`, `hash` (SHA-256 of response body), `fetchedAt`, and the parsed `tradingOptions` catalog.

### Authority Boundaries

The `agents.md` document can influence:
- `version`, `last_updated`, `api_contract_version`, `status`
- the selectable trading option catalog in `# Trading Options` (`id`, `market`, `modelKey`, `strategyKey`, `label`, `strategyProfile`, `recommendedOptionId`)

The operator's chosen trading combination (via `set_trading_selection`) is persisted in runtime state and drives every suggestion request. There are no hardcoded `balanced` or `openclaw-daemon` defaults in the request path; if no selection is persisted, the tick holds until the operator chooses one.

On a bootstrap-fresh repo with no runtime state yet, `get_status`, `get_tick_context`, and `get_onboarding_status` return structured bootstrap guidance instead of failing. `get_onboarding_status` may also reconcile pending bridge transfers on read: if a previously pending bridge transaction has confirmed or failed on-chain, the tool persists the updated transfer state (cumulative totals, bridge history, and pending list) before returning. Mutating flows still require initialized runtime state.

The `agents.md` document **cannot** override:
- Hard safety caps (`MAX_CUMULATIVE_BRIDGE_USD`, `MAX_LEVERAGE`, etc.)
- Wallet or mnemonic paths
- Tick cadence or dead-man switch timing
 - Any execution beyond the validated option catalog
These boundaries are enforced in `src/config/constants.ts` via `AGENT_MD_AUTHORITY_FIELDS` and `CODE_OWNED_CAP_KEYS`.

### Platform Status

**Not available as expected.** The URL `https://vibe4trading.ai/agents.md` currently resolves to a SPA landing page rather than a dedicated Markdown document with YAML frontmatter and the required `# Trading Options` fenced JSON contract. The skill handles this as a degraded state: if the fetch fails or the structured contract is missing/malformed, the cached version (if any) is preserved. If no cache exists, the tick holds.

## Authentication

### Token Format

Bot tokens are issued through the vibe4trading web UI (profile avatar dropdown, **COPY BOT TOKEN**). The token is passed as:

```
Authorization: Bearer <token>
```

Tokens are expected to be long-lived. The skill does not implement token refresh. If a token expires or is revoked, API calls return `401/403` and the skill enters a hold state until a valid token is configured.

### Token Storage

The token is stored in `runtime/state.json` as the `vibe4tradingToken` field. It is not encrypted at rest. Operators should ensure filesystem permissions protect the runtime directory.

## Current Platform Reality

- vibe4trading already supports Telegram, X (Twitter), and Google login and token issuance.
- vibe4trading does **not** currently expose the suggestion endpoint described above.
- vibe4trading does **not** currently implement Hyperliquid execution.
- This skill is built against a contract-first adapter and a mock provider, while this document records the future platform shape.
- Future platform hardening expected later: token scoping for agent access, dedicated rate limiting for suggestion endpoints, and optional skill registration/audit metadata. Audit logging on the skill side is best-effort: write failures are logged to stderr but do not halt execution (see `src/execution/engine.ts`).

## Integration Gaps Summary

| Component | Expected | Current Status |
|---|---|---|
| `GET /api/agent/suggestions/latest` | REST endpoint with `Authorization: Bearer` | Not deployed |
| `agents.md` hosted document | YAML-frontmatter Markdown with required sections | SPA landing, no Markdown content |
| Bot token issuance | Profile dropdown "COPY BOT TOKEN" | Available |
| Hyperliquid exchange API | Read/write via `@nktkas/hyperliquid` SDK | Available (mainnet + testnet) |
| Arbitrum bridge | USDC bridge to Hyperliquid (USDC + USDT funding accepted, auto-conversion) | Available |
| Perp collateral prep | Automatic spot-to-perp transfer after bridge confirmation (isolated margin) | Available |
| OpenClaw Gateway cron | Host-managed `30 * * * *` UTC schedule | Operator-configured, not skill-installed |

## Versioning

The skill tracks the platform contract `version` from `agents.md` frontmatter. Version changes are logged but do not trigger automatic behavior changes. The skill's own safety limits are version-independent and hard-coded.

Future contract evolution should increment `api_contract_version` in `agents.md` when the suggestion response shape changes, giving the skill a signal to adapt its parser.
