# vibe4trading OpenClaw Skill

OpenClaw skill for autonomous Hyperliquid trading using vibe4trading strategy suggestions, executed via host-managed cron at fixed `:30 UTC` intervals. Defaults to mainnet and requires explicit live-trading acknowledgment before the first armed tick.

## Purpose

This skill creates a local wallet, accepts Arbitrum USDC or USDT funding (auto-converting USDT to USDC when needed), bridges into Hyperliquid, automatically prepares perp collateral on isolated margin, fetches trading suggestions from vibe4trading, applies OpenClaw judgment within hard-coded safety caps, and executes trades as one-shot ticks driven by the OpenClaw Gateway scheduler. There is no resident process or loop.

The operator selects a trading combination (market, model, strategy, strategy profile) from a catalog published in the remote `agents.md`. That selection is persisted in runtime state and drives every subsequent suggestion request. There are no hardcoded `balanced` or `openclaw-daemon` defaults in the request path. Internally and across the public tool surface this field is named `strategyProfile`; the external suggestion HTTP query key remains `risk_profile`.

The 100 USDC cumulative bridge cap gates automated trading: once the cap is reached, the policy holds until the override phrase is accepted. After acceptance, the cap check is bypassed and trading resumes without a dollar ceiling. Override acceptance persists until `reset_override_phrase` is called; it does not erase cumulative bridge accounting or history.

## Execution Model

- **`start_trading`** arms the skill (reconciles state, sets status to `running`). Does not start a loop. On mainnet, requires prior `acknowledge_live_trading` consent.
- **OpenClaw Gateway cron** fires an isolated agent turn every hour at `:30 UTC`.
- **`execute_tick`** is the one-shot execution seam: reconcile, fetch, evaluate, execute, exit. Accepts optional explicit agent-authored intents (hold or target-position with rationale) and agent-directed order style (IOC or GTC). IOC orders may retry up to 2 additional times within the same tick on partial fills; GTC gets a single attempt.
- **`stop_trading`** cancels open orders and halts further ticks until re-armed. Does not close or flatten open positions.

On a fresh checkout with no runtime state yet, the read-only surfaces `get_status` and `get_tick_context` return structured bootstrap guidance instead of throwing. `get_onboarding_status` also returns bootstrap guidance on a fresh checkout, and when runtime state exists, it may reconcile and persist pending bridge transfer state (confirmed/failed transactions update cumulative totals and bridge history). Mutating flows remain strict: tools like `start_trading`, `deposit_to_hyperliquid`, and token-setting still require initialized runtime state.

Cron setup is host-managed through OpenClaw Gateway tooling, not repository code. See `SKILL.md` for the full cron recipe.

Until the upstream vibe4trading suggestion endpoint and `agents.md` document go live, the skill operates in a **hold-only posture** — armed ticks hold (take no trading action) rather than trading blind. Active trading begins automatically once upstream surfaces are available.

## Setup

```bash
bun install
```

## Development

```bash
bun run typecheck    # Type-check without emitting
bun run test         # Run Vitest test suite (uses Vitest runner)
bun run smoke -- --help  # Show smoke CLI usage
bun run lint         # Lint with Biome
bun run format       # Auto-format with Biome
bun run daemon:once  # One-shot compatibility tick (requires armed state)
```

> **Note:** Always use `bun run test` (which invokes Vitest) rather than bare `bun test` (which uses Bun's built-in test runner and will not find the Vitest test suites).

## Project Structure

```
src/           # TypeScript source
tests/         # Vitest test suites
runtime/       # Runtime state, cache, audit (generated)
docs/          # Documentation and platform expectations
.sisyphus/     # Plan, evidence, notepads
```
