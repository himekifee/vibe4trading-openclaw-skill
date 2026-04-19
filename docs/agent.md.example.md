---
version: "${version}"
status: "active"
skill_repo: "https://github.com/vibe4trading/openclaw-skill"
skill_release_tag: "${skill_release_tag}"
skill_release_tarball: "${skill_release_tarball}"
skill_install_name: "vibe4trading-openclaw-skill"
---

# vibe4trading OpenClaw Skill — Agent Install & Onboarding Guide

You are an OpenClaw agent that has been asked to fetch this document. This document instructs you how to **install, update, configure, and bootstrap** the `vibe4trading-openclaw-skill` for the human operator you are working with.

**Safety posture.** This skill controls a real on-chain wallet and executes real perp trades on Hyperliquid. Installation writes code to disk and registers a recurring background job; enabling live trading puts real USDC at risk. Never skip the explicit confirmations below. Never bypass the skill's in-code safety caps.

## 0. What this document is

This document is **dual-purpose**:

1. For you, the agent: the prose below (sections 1–6) is a step-by-step install and onboarding runbook. Follow it in order. Stop and ask the operator whenever a confirmation step says to.
2. For the already-installed skill: the machine-parsed parts (frontmatter + `# Trading Options` JSON block) are refreshed periodically (typically hourly) and drive the skill's runtime selection catalog. Do not invent fields; the skill's parser is strict.

The latest published version of the skill is in the frontmatter field `version` above. Treat that as the source of truth for "is there an update?" checks.

## 1. Check install state

Before doing anything else, determine which of these three states the operator's machine is in. Run these non-destructive checks:

```bash
# Does the skill directory exist?
test -d ~/.openclaw/skills/vibe4trading-openclaw-skill && echo "present" || echo "absent"

# If present, what version is installed?
cat ~/.openclaw/skills/vibe4trading-openclaw-skill/package.json 2>/dev/null \
  | grep -E '"version"' \
  | head -1
```

Classify the result as one of:

- **Not installed** — directory absent → go to section 2 (fresh install).
- **Installed, same version** as the `version` field in this document's frontmatter → skip to section 4 (reconcile config) and then section 5 (operator onboarding).
- **Installed, older version** than frontmatter `version` → go to section 3 (update). Do not auto-update without asking.
- **Installed, newer version** than this document → do nothing to the code. Proceed to section 4 / section 5. Mention the anomaly to the operator but do not downgrade.

## 2. Fresh install (only after operator consent)

**Stop here and ask the operator for a single blanket install confirmation.** Show them:

- Skill name: `vibe4trading-openclaw-skill`
- Source: the `skill_repo` and `skill_release_tag` from frontmatter
- Install location: `~/.openclaw/skills/vibe4trading-openclaw-skill/`
- What you will do: download the release tarball, extract it, run `bun install` inside the extracted directory, register a local MCP server, and register a recurring OpenClaw cron job firing every hour at `:30 UTC`.
- What this does **not** do: it does not create a wallet, does not bridge funds, does not enable live trading. Those require separate, explicit confirmations later.

Only after the operator says yes, proceed:

```bash
# 2a. Download and extract the release tarball.
# Resolve ${skill_release_tarball} from this document's frontmatter.
mkdir -p ~/.openclaw/skills
cd ~/.openclaw/skills
curl -fsSL -o vibe4trading-openclaw-skill.tar.gz "${skill_release_tarball}"
tar -xzf vibe4trading-openclaw-skill.tar.gz
# The tarball is expected to extract to ./vibe4trading-openclaw-skill/
rm vibe4trading-openclaw-skill.tar.gz

# 2b. Install JS dependencies.
cd ~/.openclaw/skills/vibe4trading-openclaw-skill
bun install

# 2c. Sanity-check: typecheck should pass against the pristine release.
bun run typecheck
```

If any of these fail, stop, report the error verbatim to the operator, and do not proceed to registration.

### 2d. Register the skill's MCP server

```bash
# Resolve the absolute path first; do not put a literal "~" inside the MCP args.
SKILL_DIR="$HOME/.openclaw/skills/vibe4trading-openclaw-skill"
MCP_ENTRY="$SKILL_DIR/src/mcp-server.ts"

# Sanity-check the path exists before registering.
test -f "$MCP_ENTRY" || { echo "mcp-server.ts not found at $MCP_ENTRY"; exit 1; }

openclaw mcp set openclaw-v4t-trading "$(cat <<JSON
{
  "command": "bun",
  "args": ["run", "$MCP_ENTRY"],
  "timeout": 30000
}
JSON
)"
openclaw mcp show openclaw-v4t-trading
```

### 2e. Register the hourly cron tick

The skill is cron-driven; there is no resident process. Register a single cron entry that fires a fresh isolated agent turn every hour at `:30 UTC` and has it call `execute_tick`:

```bash
openclaw cron add \
  --name "openclaw-v4t-trading-tick" \
  --cron "30 * * * *" \
  --tz UTC \
  --message "Run the vibe4trading trading tick using a surface that actually exposes the skill's tools or local one-shot entrypoint. Prefer calling execute_tick when it is available. If the current session does not expose execute_tick, do not pretend success." \
  --timeout 90
```

Verify with `openclaw cron list` that the job appears and the next-fire time is the upcoming `:30 UTC`.

**Tool-surface check.** After registration, confirm that the scheduled session actually has access to the `execute_tick` MCP tool. A cron session that cannot reach the skill's MCP server will either fail silently or produce no trading action — which is safe, but the operator should know. Two common reasons `execute_tick` is missing from a session:

1. The MCP entry was registered with an unexpanded `~` in `args` — see 2d above; fix by re-registering with an absolute path.
2. The current session was started *before* `openclaw mcp set` ran, so its tool snapshot predates registration — open a new session or wait for the next cron-fired session.

If the host cannot expose `execute_tick` inside the scheduled run (for example the cron runner still doesn't see the MCP surface after both of the above are ruled out), fall back to the local one-shot path (`bun run daemon:once`) inside the skill directory instead of instructing a generic agent to call a missing tool. The one-shot path is not automatically safe just because the cron fired — it still requires armed state and initialized runtime.

**Why we register the cron before onboarding completes:** the operator may be undecided about wallet creation or funding during this conversation. Once the cron is registered, each subsequent `:30 UTC` tick runs the skill's own tools (`get_onboarding_status`, `get_tick_context`), which will detect "not yet onboarded" and hold cleanly. The cron is harmless until live trading is explicitly armed, and it gives the next tick a chance to prompt the operator again if they walked away mid-flow.

## 3. Update from an older version

Ask the operator: "Version X is installed; version Y is published. Update now?" If yes:

```bash
# Stop the cron from firing mid-update, without deleting it.
openclaw cron disable openclaw-v4t-trading-tick

# Preserve runtime state (wallet, cumulative bridge total, audit log).
cp -a ~/.openclaw/skills/vibe4trading-openclaw-skill/runtime /tmp/openclaw-v4t-runtime.backup.$(date +%s)

# Replace source, keep runtime/.
cd ~/.openclaw/skills
curl -fsSL -o vibe4trading-openclaw-skill.tar.gz "${skill_release_tarball}"
mv vibe4trading-openclaw-skill vibe4trading-openclaw-skill.prev
tar -xzf vibe4trading-openclaw-skill.tar.gz
mv vibe4trading-openclaw-skill.prev/runtime vibe4trading-openclaw-skill/runtime
rm -rf vibe4trading-openclaw-skill.prev vibe4trading-openclaw-skill.tar.gz

cd vibe4trading-openclaw-skill
bun install
bun run typecheck

openclaw cron enable openclaw-v4t-trading-tick
```

If typecheck fails, restore the backup (`mv vibe4trading-openclaw-skill vibe4trading-openclaw-skill.broken && tar -xzf … && mv runtime-backup/* runtime/`) and report to the operator. Never leave the cron disabled silently — either it's enabled on the new version or the operator has been told it's disabled and why.

## 4. Reconcile config when already installed

Even when the version matches, verify the MCP server and cron job are still registered (the operator may have reset them). Re-run the commands from sections 2d and 2e if either is missing. These commands are idempotent in practice — `openclaw mcp set` overwrites and `openclaw cron add` will error on duplicate name, which you can interpret as "already there, good."

## 5. Operator onboarding (guided, auto-progressing)

After install, walk the operator through setup **one step at a time, in prompt form**. Do not batch; do not assume. At each step, call the relevant MCP tool, show the result, ask the operator to supply anything missing, and move on.

### 5a. Create wallet

Call `create_wallet`. The tool will print a 12-word BIP-39 mnemonic **exactly once**. Relay it to the operator verbatim inside a clearly-marked secret block. Tell them:

- Write it down on paper or store it in a password manager.
- Default file location: `~/Desktop/openclaw-v4t-wallet-mnemonic.txt` (mode `0600`).
- Once they confirm they have recorded it, call `confirm_backup`. After confirmation, the mnemonic will not be shown again through normal operation.

Offer `cleanup_mnemonic_file { action: "archive" }` (recoverable from disk) or `cleanup_mnemonic_file { action: "delete" }` (irreversible) only after `confirm_backup` succeeds, and only if the operator asks.

### 5b. Set the vibe4trading bot token

Ask the operator to sign in at https://vibe4trading.ai and use the profile avatar → **COPY BOT TOKEN**. Then call `set_v4t_token` with the token string. The token authenticates suggestion requests; it does not authorize withdrawals.

### 5c. Fund the wallet

Call `get_onboarding_status` and show the operator the wallet address. Tell them to send, on the **Arbitrum** network:

- USDC or USDT (either works; USDT is auto-converted before bridging)
- A small amount of ETH for gas

Call `get_onboarding_status` again after a minute to confirm balances appear. When the combined stablecoin balance is ≥ 5.01 USDC and ETH gas is sufficient, call `deposit_to_hyperliquid` to bridge. The skill will auto-transfer bridged USDC from spot to perp collateral on isolated margin.

**Hard cap:** the skill enforces a 100 USDC **lifetime** deposit cap. Do not attempt to bypass it; the override phrase exists but is a deliberate footgun and requires `accept_override_phrase` followed by re-deposit. Do not volunteer this override unless the operator explicitly asks.

### 5d. Choose a trading combination

Call `get_trading_options`. It returns the catalog defined in section `# Trading Options` below: `models`, `strategies`, `pairs`, and a `recommended` `{pair, strategy, model}` triplet. Present the axes to the operator and let them pick one of each. If they have no preference, suggest the `recommended` triplet. Call `set_trading_selection { pair, strategy, model }` with their pick.

### 5e. Second, explicit live-trading confirmation

**Stop and ask the operator a second confirmation, different from the install confirmation.** This one is specifically about putting capital at risk:

> "You are about to arm autonomous live trading on Hyperliquid **mainnet** using the wallet you just funded. The skill will execute at `:30 UTC` every hour, within the hard-coded 5x leverage cap and 95% notional fraction cap, based on suggestions from vibe4trading filtered by OpenClaw judgment. Halt anytime with `stop_trading`. Proceed?"

Only if they affirm, call `acknowledge_live_trading { confirmed: true }` and then `start_trading`. Show them the returned status.

If they decline or say "later": do **not** call `acknowledge_live_trading` or `start_trading`. The cron is already registered (from section 2e) and will fire at `:30 UTC`, but the skill will hold because it is not armed. The operator can come back in a future session and say "arm trading" — the next tick will re-prompt.

### 5f. Report final state

Call `get_status` and `get_tick_context` and summarize for the operator:

- Wallet address
- Current USDC collateral on Hyperliquid
- Selected trading combination (label)
- Armed (running) or not
- Next cron fire time

Tell them the halt command is `stop_trading` and the full-reset escape is to call `stop_trading` then delete the cron with `openclaw cron delete openclaw-v4t-trading-tick`.

## 6. Behaviour when this document cannot be refreshed

The installed skill refreshes this document hourly via ETag-revalidated fetch. If the network is down, or this document is malformed, or upstream returns a non-200, the skill falls back to the most recent valid cache. If no cache has ever been stored, armed ticks hold rather than trade blind. You, the installing agent, do not need to handle this — the skill handles it internally — but do not fabricate a trading-options catalog on behalf of the skill if the operator asks "why is it holding?"

# Trading Options

```json
{
  "models": ["openclaw-daemon", "gpt-5.4", "gemini-3.1-pro-preview"],
  "strategies": ["aggressive", "balanced", "conservative"],
  "pairs": [
    {
      "venue": "hyperliquid",
      "mode": "perp",
      "marketId": "perps:hyperliquid:BTC-PERP",
      "symbol": "BTC-PERP"
    },
    {
      "venue": "hyperliquid",
      "mode": "perp",
      "marketId": "perps:hyperliquid:ETH-PERP",
      "symbol": "ETH-PERP"
    },
    {
      "venue": "hyperliquid",
      "mode": "perp",
      "marketId": "perps:hyperliquid:SOL-PERP",
      "symbol": "SOL-PERP"
    }
  ],
  "recommended": {
    "pair": "BTC-PERP",
    "strategy": "balanced",
    "model": "openclaw-daemon"
  }
}
```

# Operator-Facing Notes

These notes exist for humans reading this URL in a browser. The skill and the installing agent do not need them.

- The lifetime deposit cap is **100 USDC**. The override phrase in the code is a footgun, not a feature.
- Order style defaults to IOC with up to 2 same-tick retries on partial fills. GTC is available per-tick via `execute_tick { intent: { orderStyle: "gtc" } }`.
- The audit log lives at `runtime/audit.log` inside the skill directory (`~/.openclaw/skills/vibe4trading-openclaw-skill/runtime/audit.log`). It is append-only NDJSON; audit writes are best-effort.
- To uninstall: `openclaw cron delete openclaw-v4t-trading-tick`, `openclaw mcp delete openclaw-v4t-trading`, then remove `~/.openclaw/skills/vibe4trading-openclaw-skill/`. Back up `runtime/state.json` first if you want the wallet mnemonic seed or the bridge history.
