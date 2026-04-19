---
version: "${version}"
status: "active"
skill_repo: "https://github.com/vibe4trading/openclaw-skill"
skill_release_tag: "${skill_release_tag}"
skill_release_tarball: "${skill_release_tarball}"
skill_install_name: "vibe4trading-openclaw-skill"
last_updated: "${timestamp}"
---

# vibe4trading OpenClaw Skill — Install & Onboarding Guide

You are an OpenClaw agent. This doc tells you how to install, update, configure, and bootstrap `vibe4trading-openclaw-skill`.

**Safety.** This skill controls a real wallet and executes real perp trades on Hyperliquid. Never skip the confirmations below. Never bypass the skill's in-code safety caps.

## 0. Document purpose

Dual-purpose: (1) sections 1–6 are a sequential runbook for you — follow in order, stop for operator confirmation where noted; (2) frontmatter + the `# Trading Options` JSON block are refreshed hourly and drive the skill's runtime catalog (strict parser — don't invent fields). Frontmatter `version` is the source of truth for update checks.

## 1. Check install state

```bash
test -d ~/.openclaw/skills/vibe4trading-openclaw-skill && echo "present" || echo "absent"
cat ~/.openclaw/skills/vibe4trading-openclaw-skill/package.json 2>/dev/null \
  | grep -E '"version"' | head -1
```

- **Absent** → section 2.
- **Same version** → section 4, then section 5.
- **Older** → section 3 (ask first).
- **Newer than this doc** → leave code alone, proceed to 4/5, flag the anomaly, don't downgrade.

## 2. Fresh install (only after operator consent)

**Ask for a single blanket install confirmation.** Show:

- Skill: `vibe4trading-openclaw-skill`
- Source: `skill_repo` + `skill_release_tag` from frontmatter
- Path: `~/.openclaw/skills/vibe4trading-openclaw-skill/`
- Will do: download/extract tarball, `bun install`, register MCP server, register hourly cron at `:30 UTC`.
- Will **not** do: create wallet, bridge funds, enable live trading — each needs its own later confirmation.

**Consent is an exact phrase, not a word.** "install" / "yes" / "ok" are often restatements, not consent. Require: **`confirm install v4t`**. Anything else → re-prompt once. Don't proceed unless it matches.

```bash
# 2a. Download + extract into a canonical dir. Tarball top-level may be
# vibe4trading-openclaw-skill/, vibe4trading-openclaw-skill-<version>/, or package/ —
# --strip-components=1 normalizes all three.
SKILL_DIR="$HOME/.openclaw/skills/vibe4trading-openclaw-skill"
TARBALL="$(mktemp --tmpdir v4t.XXXXXX.tar.gz)"
trap 'rm -f "$TARBALL"' EXIT

mkdir -p "$SKILL_DIR"
[ -z "$(ls -A "$SKILL_DIR" 2>/dev/null)" ] || { echo "refuse: $SKILL_DIR non-empty — use section 3"; exit 1; }

curl -fsSL -o "$TARBALL" "${skill_release_tarball}"
tar -xzf "$TARBALL" -C "$SKILL_DIR" --strip-components=1
test -f "$SKILL_DIR/package.json" && test -f "$SKILL_DIR/src/mcp-server.ts" \
  || { echo "extract failed"; exit 1; }

# 2b+2c.
cd "$SKILL_DIR" && bun install && bun run typecheck
```

On any failure, stop, report verbatim, don't register.

### 2d. Register MCP server

Build the JSON with `jq` so paths with spaces/quotes/backslashes are encoded safely. Do not use shell concatenation or an unquoted HEREDOC.

```bash
SKILL_DIR="$HOME/.openclaw/skills/vibe4trading-openclaw-skill"
MCP_ENTRY="$SKILL_DIR/src/mcp-server.ts"
test -f "$MCP_ENTRY" || { echo "missing $MCP_ENTRY"; exit 1; }

MCP_CONFIG="$(jq -nc --arg entry "$MCP_ENTRY" \
  '{command:"bun", args:["run",$entry], timeout:30000}')"

openclaw mcp set openclaw-v4t-trading "$MCP_CONFIG"
openclaw mcp show openclaw-v4t-trading
```

No `jq`? Write config to a file via `<<'JSON'` (quoted HEREDOC) and pass the path in separately — never let shell interpolate into JSON.

### 2e. Register hourly cron

No resident process — the skill is cron-driven. Fire a fresh agent turn every hour at `:30 UTC` to call `execute_tick`:

```bash
openclaw cron add \
  --name "openclaw-v4t-trading-tick" \
  --cron "30 * * * *" \
  --tz UTC \
  --message "Run the vibe4trading trading tick using a surface that exposes the skill's tools or local one-shot entrypoint. Prefer execute_tick when available. If the current session does not expose execute_tick, do not pretend success." \
  --timeout 90
```

Verify with `openclaw cron list`.

**Tool-surface check.** Confirm the scheduled session can reach `execute_tick`. Without access it no-ops (safe, but tell the operator). If the host can't expose `execute_tick` in scheduled runs, use the one-shot path (`bun run daemon:once`). One-shot still requires armed state + initialized runtime — not a bypass.

Registering the cron before onboarding finishes is safe: later ticks call `get_onboarding_status` / `get_tick_context`, detect "not onboarded," and hold. It also gives the next tick a chance to re-prompt if the operator walked away.

## 3. Update from older version

Ask: "Version X installed; Y is published. Update now?" Require exact phrase **`confirm update v4t`**. On match:

```bash
SKILL_DIR="$HOME/.openclaw/skills/vibe4trading-openclaw-skill"
PREV_DIR="$SKILL_DIR.prev"
STAGING_DIR="$SKILL_DIR.staging"
TARBALL="$(mktemp --tmpdir v4t.XXXXXX.tar.gz)"
trap 'rm -f "$TARBALL"' EXIT

openclaw cron disable openclaw-v4t-trading-tick
cp -a "$SKILL_DIR/runtime" "/tmp/openclaw-v4t-runtime.backup.$(date +%s)"

# Stage new release with normalized layout (same --strip-components=1 trick as 2a).
curl -fsSL -o "$TARBALL" "${skill_release_tarball}"
rm -rf "$STAGING_DIR" && mkdir -p "$STAGING_DIR"
tar -xzf "$TARBALL" -C "$STAGING_DIR" --strip-components=1
test -f "$STAGING_DIR/package.json" || { echo "staged extract failed"; exit 1; }

# Swap, keep runtime/.
mv "$SKILL_DIR" "$PREV_DIR"
mv "$STAGING_DIR" "$SKILL_DIR"
mv "$PREV_DIR/runtime" "$SKILL_DIR/runtime"
rm -rf "$PREV_DIR"

cd "$SKILL_DIR" && bun install && bun run typecheck
openclaw cron enable openclaw-v4t-trading-tick
```

On typecheck failure, restore backup and report. Never leave cron disabled silently.

## 4. Reconcile when already installed

On version match, re-check MCP server + cron are registered (operator may have reset them). Re-run 2d/2e if missing. `openclaw mcp set` overwrites; `openclaw cron add` errors on duplicate, which just means "already there."

## 5. Operator onboarding — one step at a time

Sequential, not batched. Each step: call tool, show result, gather missing input, move on.

### 5a. Create wallet

Call `create_wallet`. It prints a 12-word BIP-39 mnemonic **exactly once**. Relay verbatim in a clearly-marked secret block. Tell them:

- Write it down or store in a password manager.
- Default file: `~/Desktop/openclaw-v4t-wallet-mnemonic.txt` (mode `0600`).
- Once recorded, call `confirm_backup`. After that, the mnemonic isn't shown again in normal operation.

Offer `cleanup_mnemonic_file { action: "archive" }` (recoverable) or `{ action: "delete" }` (irreversible) only after `confirm_backup`, and only if asked.

### 5b. Set vibe4trading bot token

Operator signs in at https://vibe4trading.ai, profile avatar → **COPY BOT TOKEN**. Call `set_v4t_token`. Token authenticates suggestions; it does not authorize withdrawals.

### 5c. Fund the wallet

Call `get_onboarding_status`, show the wallet address. Send on **Arbitrum**:

- USDC or USDT (USDT auto-converted before bridging)
- A small amount of ETH for gas

Recheck `get_onboarding_status` after ~1 min. When combined stablecoins ≥ 5.01 USDC and ETH gas is sufficient, call `deposit_to_hyperliquid`. The skill auto-moves bridged USDC from spot to perp collateral on isolated margin.

**Hard cap: 100 USDC lifetime.** Don't bypass. The override phrase is a deliberate footgun requiring `accept_override_phrase` + re-deposit — don't volunteer it unless asked.

### 5d. Choose trading combination

Call `get_trading_options` (returns catalog from `# Trading Options` below). Show options with labels. If no preference, suggest the `recommendedOptionId`. Call `set_trading_selection { optionId: "..." }`.

### 5e. Second confirmation — live trading

**Ask a second, distinct confirmation, this one about capital at risk:**

> "You are about to arm autonomous live trading on Hyperliquid **mainnet** using the wallet you just funded. The skill executes at `:30 UTC` hourly, within the hard-coded 5x leverage cap and 95% notional fraction cap, on suggestions from vibe4trading filtered by OpenClaw judgment. Halt anytime with `stop_trading`. Proceed?"

On affirmative: `acknowledge_live_trading { confirmed: true }` then `start_trading`. Show status.

On decline/"later": do **not** call either. The cron still fires but holds because unarmed. Operator can say "arm trading" later; the next tick re-prompts.

### 5f. Report final state

Call `get_status` + `get_tick_context`, summarize: wallet address, USDC collateral on Hyperliquid, selected combination (label), armed or not, next cron fire time.

Halt: `stop_trading`. Full reset: `stop_trading` then `openclaw cron delete openclaw-v4t-trading-tick`.

## 6. When this doc can't be refreshed

The installed skill refreshes hourly via ETag fetch. On failure/malformed/non-200 it uses the last valid cache; with no cache, armed ticks hold rather than trade blind. Don't fabricate a trading-options catalog if the operator asks "why is it holding?"

# Trading Options

```json
${trading_options}
```

# Operator-Facing Notes

For humans reading this URL. Skill and installing agent don't need them.

- Lifetime deposit cap: **100 USDC**. Override phrase is a footgun, not a feature.
- Order style: IOC default, up to 2 same-tick retries on partial fills. GTC per-tick via `execute_tick { intent: { orderStyle: "gtc" } }`.
- Audit log: `~/.openclaw/skills/vibe4trading-openclaw-skill/runtime/audit.log`, append-only NDJSON, best-effort.
- Uninstall: `openclaw cron delete openclaw-v4t-trading-tick`, `openclaw mcp delete openclaw-v4t-trading`, remove the skill dir. Back up `runtime/state.json` first for wallet seed / bridge history.

If the user asked you to fetch this page, it's likely an installation intention. Start the installation by automatically doing stage 1 and ask them to confirm the installation directly.