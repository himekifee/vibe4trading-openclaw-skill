---
name: vibe4trading-openclaw-skill
description: >-
  Autonomous Hyperliquid trading skill that sources suggestions from vibe4trading,
  applies OpenClaw judgment with hard safety caps, and executes via host-managed
  cron at fixed :30 UTC intervals.
---

# vibe4trading OpenClaw Trading Skill

## What I Do

I manage a local Hyperliquid trading wallet that:
- Creates and securely stores a mnemonic-based wallet (BIP-39, 12 words)
- Accepts Arbitrum USDC or USDT funding, auto-converting USDT to USDC when needed
- Bridges USDC into Hyperliquid and automatically prepares perp collateral on isolated margin
- Fetches strategy suggestions from vibe4trading's API using the operator's persisted trading selection
- Applies OpenClaw judgment within hard-coded safety limits
- Executes trades on a fixed `hh:30 UTC` schedule, one tick per hour, driven by the OpenClaw Gateway scheduler
- Supports agent-directed order style (IOC or GTC) with bounded same-tick IOC retries on partial fills
- Maintains a best-effort audit trail of every decision, trade, retry, and policy reshaping (write failures are logged but do not halt execution)

There is no resident process. Each tick is a one-shot run scheduled by OpenClaw Gateway, then the process exits. No loop, no sleep, no long-lived process. The network defaults to mainnet; explicit live-trading acknowledgment is required before the first armed tick.

## When to Use Me

- When you want to set up autonomous trading on Hyperliquid via vibe4trading signals
- When you need a single-market, capped-risk trading automation
- After obtaining a vibe4trading bot token from your profile

## Prerequisites

Before using this skill, you need:

1. **Bun runtime** (v1.3+) installed on your system
2. **A vibe4trading account** with a bot token (see Token Retrieval below)
3. **Arbitrum USDC or USDT** in the wallet created by this skill, for bridging into Hyperliquid (USDT is auto-converted to USDC before bridging)
4. **Arbitrum ETH** in the same wallet, to cover gas fees for bridge transactions

## Setup

```bash
bun install
```

## Token Retrieval

To get your vibe4trading bot token:

1. Go to [vibe4trading.ai](https://vibe4trading.ai)
2. Click **SIGN IN**
3. Authenticate via **Google**, **X**, or **Telegram** (or connect a wallet via **JoyID**)
4. Once signed in, open the **profile avatar dropdown** in the top-right corner
5. Click **COPY BOT TOKEN**
6. Store the token securely. The skill reads it from your runtime state configuration.

The token authenticates API requests for strategy suggestions. It does not grant withdrawal or transfer permissions on the exchange.

## Wallet Creation and Mnemonic Handling

Running the wallet creation flow generates a 12-word BIP-39 mnemonic and derives an Ethereum-compatible address.

**Warnings:**

- The mnemonic file is written with `0600` permissions (owner-read/write only).
- Default location: `~/Desktop/openclaw-v4t-wallet-mnemonic.txt`
- **Back up your mnemonic immediately.** Loss means permanent loss of wallet access.
- **Never share your mnemonic.** Anyone with these words controls the wallet.
- The skill displays the mnemonic exactly once during the confirmation flow. After you confirm backup, it does not show it again through normal operation.

## Funding the Wallet

After wallet creation, you must fund it on the Arbitrum network:

1. **Send USDC or USDT (Arbitrum)** to the wallet address printed during creation
2. **Send a small amount of ETH (Arbitrum)** to the same address for gas
3. The skill's onboarding flow detects balances and auto-bridges USDC into Hyperliquid, converting any USDT shortfall to USDC first
4. After a successful bridge for a perp market, the skill automatically transfers the bridged amount from Hyperliquid spot to perp collateral on isolated margin

The auto-bridge respects the lifetime deposit cap (see Safety below). If the wallet has less than 5.01 USDC available to bridge, or the cap headroom is too small, bridging is skipped.

## Safety Limits

All safety limits are hard-coded in `src/config/constants.ts`. They cannot be overridden by `agent.md`, remote configuration, or any external signal.

The remote `agent.md` document may define the selectable trading combinations through a required `# Trading Options` section containing exactly one fenced `json` block shaped as `{ models: string[], strategies: string[], pairs: { symbol, marketId, venue, mode }[], recommended: { pair, strategy, model } | null }`. The agent may choose any combination of one item from each list. The `recommended` object points to the combo with the most recent successful tick and highest return (or `null` if no live data). That catalog may set validated `market`, `modelKey`, `strategyKey`, and `strategyProfile` values for operator/agent selection, but it still cannot override code-owned safety caps.

| Limit | Value | Description |
|---|---|---|
| Lifetime deposit cap | **100 USDC** | Maximum cumulative USDC bridged into Hyperliquid |
| Minimum bridge amount | 5.01 USDC | Below this, auto-bridge skips |
| Maximum leverage | 5x | Orders exceeding this are clamped |
| Max position fraction | 95% | Maximum notional as fraction of available balance |
| Tick cadence | :30 minute mark | One-shot execution once per hour at hh:30 UTC |
| Agent.md max age | 300 seconds | Stale agent.md triggers degraded-mode hold |
| Suggestion max age | 900 seconds | Expired suggestions are rejected |
| Dead-man switch | 90 seconds | Exchange auto-cancels orders if skill goes silent |

### The 100 USDC Lifetime Cap

The skill enforces a **100 USDC lifetime deposit cap** on all bridged funds. This is tracked cumulatively across every confirmed bridge transfer in `runtime/state.json`.

When you reach the cap, the system blocks further deposits and logs `cap_exceeded_no_override`.

An explicit override phrase exists in the code, but accepting it requires deliberate operator action. The override does not raise or remove the cap. It only permits additional bridging while the real cumulative total remains tracked above 100, and that acceptance persists until you explicitly call `reset_override_phrase`. Reset clears the persisted acceptance bit only; it does not erase `bridgeHistory` or `cumulativeBridgeUsd`. This is a footgun, not a feature. Treat it accordingly.

### Kill-Switch / Emergency Stop

Calling `stop_trading` (via the tool surface or MCP) triggers an emergency halt:

1. All open orders on Hyperliquid are cancelled
2. The dead-man switch is cleared
3. Trading status is set to `halted` in `runtime/state.json`
4. Further ticks are refused until you explicitly call `start_trading`

Open positions are **not** closed or flattened. The halt persists across process restarts. A halted state stays halted.

When runtime state is **missing** (no `runtime/state.json`), `stop_trading` returns bootstrap guidance instead of halting — there is nothing to halt.

When runtime state is **corrupt or unreadable** (file exists but cannot be parsed), `stop_trading` attempts best-effort emergency cleanup: it extracts wallet info from the raw file and, if a wallet address and mnemonic path are recoverable, cancels open orders and clears the dead-man switch. The result includes `corruptState: true`, recovered info (if any), and emergency cleanup outcome. Manual inspection or removal of the state file is required before resuming.

## Execution Model

This skill uses a **one-shot, cron-driven execution model**. There is no resident process, no loop, and no inter-tick sleep.

### How It Works

1. **`start_trading`** arms the skill: reconciles local state against Hyperliquid exchange data and sets status to `running`. It does not start a loop or spawn a background process. On mainnet, requires prior `acknowledge_live_trading` consent.
2. **The OpenClaw Gateway scheduler** fires an isolated agent turn every hour at `:30 UTC`.
3. **`execute_tick`** is the deterministic one-shot execution seam. Each invocation reconciles state, fetches a suggestion, evaluates policy, executes, and exits. Duplicate-slot and halt guards prevent re-execution within the same slot. Accepts optional explicit agent-authored intents and agent-directed order style (IOC or GTC).
4. **`stop_trading`** halts execution: cancels orders, clears the dead-man switch, and refuses further ticks until re-armed. Does not close or flatten open positions. Returns bootstrap guidance when state is missing; attempts best-effort emergency cleanup when state is corrupt.

### Cron Schedule Setup

The cron schedule is **host-managed** through OpenClaw Gateway tooling or operator instructions. The skill itself does not register or provision its schedule; that responsibility belongs to the host. SKILL.md frontmatter supports only `name`, `description`, `license`, `compatibility`, and `metadata`. Unknown fields (like `cron`, `schedule`, or `trigger`) are silently ignored.

A safe scheduler contract is:

```yaml
name: openclaw-v4t-trading-tick
schedule:
  kind: "cron"
  expr: "30 * * * *"
  tz: "UTC"
  staggerMs: 0
payload:
  kind: "agentTurn"
  message: >-
    Run the vibe4trading trading tick using a surface that actually exposes the
    skill's tools or local one-shot entrypoint. Prefer calling execute_tick when
    it is available. If the current session does not expose execute_tick, do not
    pretend success.
  lightContext: true
  timeoutSeconds: 90
delivery:
  mode: "none"
```

Important notes:
- The exact host wiring matters. A plain isolated agent session is only correct if that session actually has access to the skill tool surface.
- If the host cannot expose `execute_tick` inside the scheduled run, use a local one-shot execution path instead of instructing a generic agent to call a missing tool.
- `runtime/state.json` must exist before scheduled execution can progress beyond bootstrap holds or state-file errors.
- `payload.timeoutSeconds: 90` should match the exchange dead-man window.
- `delivery.mode: "none"` suppresses routine tick noise.
- `schedule.staggerMs: 0` keeps execution pinned to exact `:30 UTC`.

### One-Shot Compatibility Path

The `daemon:once` script (`bun run daemon:once` / `--daemon-once`) runs a single tick and exits. Use it for manual testing, ad-hoc execution, or hosts that cannot expose the MCP tool surface inside cron-triggered sessions. It still requires initialized runtime state, and on a fresh install will fail until bootstrap has created `runtime/state.json`. It is not automatically safe just because the cron fired.

### Reconciliation

Before every tick, the skill reconciles local state against live Hyperliquid exchange data. If local state says "no open positions" but the exchange has one, local state is corrected. The exchange is always the source of truth.

## Tool Surface

The skill exposes eighteen tools through `src/tools/`:

### Wallet & Setup

| Tool | Description |
|---|---|
| `create_wallet` | Create a BIP-39 wallet, display the mnemonic exactly once. Call `confirm_backup` after recording it. |
| `confirm_backup` | Confirm mnemonic backup. After confirmation, `create_wallet` will not display the mnemonic again. |
| `recover_mnemonic` | Deliberate local recovery: re-read the mnemonic from the desktop file (requires 0600 permissions). Refused when backup status is `"archived"` or `"deleted"`. |
| `set_v4t_token` | Persist or clear the vibe4trading bot token in runtime state for suggestion API authentication. |
| `cleanup_mnemonic_file` | Securely archive or permanently delete the mnemonic file after backup confirmation. Accepts `{ action: "archive" \| "delete" }`. Rejected until `walletBackup.status` is `"confirmed"`. Returns bootstrap guidance when runtime state is missing. See **Mnemonic Cleanup** below. |

### Operator Lifecycle

| Tool | Description |
|---|---|
| `acknowledge_live_trading` | Record explicit mainnet live-trading consent. Required before `start_trading` on mainnet. Accepts `{ confirmed: true }`. |
| `get_trading_options` | Return the available trading option catalog from the cached `agent.md`. Read-only, no state mutation. Option entries expose `strategyProfile`. |
| `set_trading_selection` | Persist the operator's chosen trading combination by `optionId` from the `agent.md` catalog. |
| `accept_override_phrase` | Record operator consent for the bridge-cap override phrase. Accepts `{ confirmed: true }`. |

### Onboarding & Funding

| Tool | Description |
|---|---|
| `get_onboarding_status` | Check wallet funding: combined USDC + USDT stablecoin balance, ETH gas, bridge cap headroom, readiness to deposit. May reconcile and persist pending bridge transfer state when confirmations or failures resolve on-chain. Returns bootstrap guidance until `create_wallet` initializes runtime state. USDT is auto-converted before bridging. |
| `deposit_to_hyperliquid` | Initiate a USDC bridge deposit from Arbitrum into Hyperliquid. Auto-converts USDT when native USDC is insufficient. Checks preflight and cap limits before submitting. Returns bootstrap guidance when runtime state is missing. |
| `reset_override_phrase` | Clear persisted override acceptance without touching cumulative bridge history. Future over-cap decisions require fresh consent again. Returns bootstrap guidance when runtime state is missing. |

### Trading Lifecycle

| Tool | Description |
|---|---|
| `start_trading` | Arm trading for cron-managed execution. Runs startup reconciliation, sets status to `running`. On mainnet, requires prior `acknowledge_live_trading` consent. Does not start a loop. Returns bootstrap guidance when runtime state is missing. |
| `stop_trading` | Emergency halt: cancel orders, clear dead-man, set status to `halted`. Does not flatten positions. Ticks refused until re-armed via `start_trading`. Returns bootstrap guidance when runtime state is missing. Returns a `corruptState` result with best-effort emergency cleanup when runtime state exists but is unreadable. |
| `get_tick_context` | Preview current tick state: selection validation, onboarding readiness, hold context, suggestion wiring, and allowed order styles. Read-only. Returns bootstrap guidance until runtime state exists. |
| `execute_tick` | Run a single one-shot tick cycle. Reconciles, fetches, evaluates, executes, exits. Respects duplicate-slot and halt guards. Accepts optional `{ slotId, intent }`. Returns bootstrap guidance when runtime state is missing. |
| `get_status` | Return current trading status: daemonStatus, lastExecutedSlot, lastSuggestionId, exchangeActivity, haltReason, currentSlot, network, walletBackup, tradingSelection, liveTradingConsent, and fundingReadiness. Returns bootstrap guidance until runtime state exists. |
| `get_trade_history` | Read the NDJSON audit log, return last N entries. Entries include retry and reshaping metadata when applicable. |

Wallet/onboarding/token tools wrap domain modules in `src/wallet/`, `src/onboarding/`, and `src/v4t/token.ts`. Trading lifecycle tools are thin pass-through wrappers around `src/daemon/engine.ts`.

### Mnemonic Cleanup

After confirming your backup via `confirm_backup`, you may choose to clean up the local mnemonic file using `cleanup_mnemonic_file`:

- **`archive`**: Renames the mnemonic file with a timestamped `.archived-*` suffix in the same directory. The file is no longer at its original path but remains on disk for manual recovery if needed.
- **`delete`**: Permanently removes the mnemonic file from disk. This is irreversible. If you have not backed up your mnemonic elsewhere, you will permanently lose wallet access.

The cleanup tool is blocked until `walletBackup.status` reaches `"confirmed"`. After cleanup, `walletBackup.status` transitions to `"archived"` or `"deleted"` with a `cleanedUpAt` timestamp, and this state is visible through `get_status`.

**Recovery consequences:**
- After **archive**, the mnemonic can still be recovered from the `.archived-*` file on disk.
- After **delete**, the mnemonic is gone from the local filesystem. Recovery is only possible if you backed it up externally.
- `recover_mnemonic` reads from the original mnemonic path and will fail after either cleanup action.

## MCP Registration

The `mcp.json` manifest is the single source of truth for the tool surface: the server (`src/mcp-server.ts`) loads tool definitions from `mcp.json` at startup for `tools/list` responses and input schema validation. The server implements the MCP protocol handshake (`initialize`, `tools/list`, `tools/call`) over Content-Length framed stdio (with newline-delimited JSON fallback). To register it in OpenCode, add to your `opencode.json` using an **absolute path** to `src/mcp-server.ts` (replace `/absolute/path/to/...` with the actual install path — typically `$HOME/.openclaw/skills/vibe4trading-openclaw-skill`):

```json
{
  "mcp": {
    "openclaw-trading": {
      "type": "local",
      "command": ["bun", "run", "/absolute/path/to/vibe4trading-openclaw-skill/src/mcp-server.ts"],
      "timeout": 30000
    }
  }
}
```

Do not put a literal `~` or relative path into `command` / `args`: MCP hosts (OpenCode, OpenClaw Gateway) launch the command directly rather than through a shell, so `~` is not expanded and a relative path resolves against the host's CWD, not the skill directory. Resolve the home directory and produce an absolute path at registration time. After registering an MCP server mid-session, the current session's tool list will not refresh — start a new session (or wait for the next cron-fired session) to see the tools.

The server exposes all eighteen tools listed above. The wallet creation flow persists backup lifecycle state in `runtime/state.json`, enabling restart-safe one-time mnemonic display and confirmation semantics across separate MCP server processes. Tool call results are returned in the MCP `content` array format. No external MCP SDK dependency is required.

## Audit Trail

Every execution decision is appended as NDJSON to `runtime/audit.log`. Each entry records the slot ID, suggestion ID, market, judgment summary, actions taken (place-order, cancel-order, close-position), retry metadata (order style, attempt count, partial fill status), reshaping metadata (baseline vs. final target and policy sources), and timestamp. This log is append-only under normal operation; however, audit writes are best-effort — if a write fails (e.g. disk full, permissions), the failure is logged to stderr and execution continues without retrying the write.

## Project Structure

```
src/
  tools/          Tool entrypoints (thin wrappers)
  daemon/         Engine, overlap lock, reconciliation, state file I/O
  chain/          Hyperliquid + Arbitrum client wrappers
  config/         Constants, paths, validation
  execution/      Trade execution engine
  onboarding/     Funding detection and auto-deposit
  policy/         OpenClaw policy evaluation
  state/          Runtime state types and slot computation
  v4t/            vibe4trading API client, agent.md cache, suggestion adapter
  wallet/         Wallet creation, mnemonic confirmation
  mcp-server.ts   MCP stdio server entrypoint
  index.ts        CLI entrypoint (smoke scenarios, one-shot tick)
runtime/          Generated at runtime: state.json, audit.log, daemon.pid, agent-md-cache.json
docs/             Platform expectations and contract documentation
```

## Development

```bash
bun run typecheck    # Type-check without emitting
bun run test         # Run Vitest test suite (uses Vitest runner)
bun run smoke -- --help            # Show smoke CLI usage
bun run smoke -- --scenario wallet-create   # Wallet creation smoke test (default: runtime/smoke-wallet-create/openclaw-v4t-wallet-mnemonic.txt)
bun run smoke -- --scenario daemon-once     # Single tick smoke test
bun run smoke -- --scenario cap-halt        # Deposit cap enforcement smoke test
bun run lint         # Lint with Biome
bun run format       # Auto-format with Biome
```

> **Note:** Always use `bun run test` (which invokes Vitest) rather than bare `bun test` (which uses Bun's built-in test runner and will not find the Vitest test suites).

## Current Status

Core modules are implemented and tested: wallet, chain infrastructure, onboarding, policy evaluation, execution engine, tick orchestration, and tool wrappers. The platform suggestion endpoint is not yet available in production (see `docs/platform-expectations.md` for the expected contract and current gaps).

Until the upstream suggestion endpoint and `agent.md` document go live, the skill operates in a **hold-only posture**: armed ticks detect no actionable suggestion or no valid cached catalog and hold (take no trading action) rather than trading blind. This is deliberate — the skill will begin active trading automatically once the upstream surfaces become available, with no code changes required.
