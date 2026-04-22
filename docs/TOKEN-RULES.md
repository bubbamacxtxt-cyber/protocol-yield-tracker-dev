# Token Classification Rules

**Status:** Canonical. These rules apply project-wide.
**Last updated:** 2026-04-22
**Scope:** Every token found in a tracked wallet must be classified using these rules. No case-by-case patches. If a token doesn't fit, add it to the correct data list (`vaults.json`, `stables.json`, `token-registry.json`) — don't hard-code a fix in `export.js`.

---

## Why these rules exist

We used to patch special cases in `export.js` for each new whale. That broke every time we added a new wallet or a new token appeared.

These rules replace all special cases with a deterministic classifier. When a new whale is added with new tokens, the classifier handles them automatically.

---

## The Classifier (Layer 2: `src/token-discovery.js`)

Every token balance found by Alchemy for a wallet+chain passes through this pipeline in order. **First match wins.** No token can be classified twice.

### Rule 1: Vault Match

| Check | How |
|-------|-----|
| Token address exists in `data/vaults.json` with matching chain | O(1) lookup `chain:address` → vault entry |

**Match action:** Write as `protocol_id='vault'` with:
- `protocol_name` = vault's `protocol` field (e.g., "Upshift", "IPOR")
- `apy_base` = vault's `apy_30d` (or `apy_7d`, `apy_1d` in fallback order)
- `value_usd` = computed via ERC-4626 `convertToAssets()` on vault contract
- `source_type` = `vault`
- `source_name` = `token-discovery`

**Why address-based:** Vaults are chain-specific instruments. A vault on ETH is not the same vault on Base, even if they have the same name. Address is the only reliable identity.

### Rule 2: YBS Match (Yield-Bearing Stablecoin)

| Check | How |
|-------|-----|
| Token's canonical CoinGecko ticker matches an entry in `data/stables.json` | Look up `chain:address` in local token registry → get CG symbol → check `ybsIndex.bySymbol[symbol]` |

**Match action:** Write as `protocol_id='ybs'` with:
- `protocol_name` = YBS's `protocol` field (e.g., "ethena-usde", "maple", "strata-markets")
- `apy_base` = YBS's `apy_30d` (or `apy_7d`, `apy_1d` in fallback order)
- `value_usd` = `amount × DeFiLlama price`
- `source_type` = `ybs`
- `source_name` = `token-discovery`

**Why ticker-based (NOT address-based):**
YBS tokens have multiple bridged addresses across chains but share the same yield economics.
- `sUSDe` on ETH (`0x9d39...`) and `sUSDe` on Arbitrum (`0x211c...`) both earn the same ~3.6% from Ethena staking
- Matching by address would require listing every bridged contract on every chain — unsustainable
- The canonical CoinGecko ticker (`SUSDE`) is stable across bridges

**Fallback:** If a token isn't in the local CG registry (e.g., launched today), fall back to the on-chain metadata symbol from `alchemy_getTokenMetadata`.

**YBS list rules** (`data/stables.json`):
- ONE entry per yield-bearing asset. No per-chain duplicates.
- NO protocol-specific wrappers. Examples of what belongs elsewhere:
  - `fUSDC` / `fUSDT` → Fluid scanner
  - `aUSDC` / `aUSDT` / `aUSDe` → Aave scanner
  - `eUSDC` / `eUSDT` → Euler scanner
  - `steakUSDC` → Morpho scanner (Morpho MetaMorpho vault)
  - Pendle PT/YT tokens → Pendle scanner
- If a protocol has its own scanner, its wrapper tokens must NOT be in the YBS list.
- The `validate.js` script enforces this rule.

### Rule 3: Plain Token (Wallet-Held)

| Check | How |
|-------|-----|
| Token address exists in `data/token-registry.json` (the CG registry) | O(1) lookup `chain:address` → registry entry |

**Match action:** Write as `protocol_id='wallet-held'` with:
- `protocol_name` = `Wallet`
- `apy_base` = **null** (enforced — see Rule 6)
- `value_usd` = `amount × DeFiLlama price`
- `source_type` = `wallet`
- `source_name` = `wallet-scan`

**Examples that end up here:** plain USDC, USDT, PYUSD, GHO, CRVUSD, RLUSD, ETH, WETH, WBTC, etc.

### Rule 4: Unknown Token

If a token isn't in any of the above lists, **skip silently**. No row is written.

- Don't clutter the whale page with unknown tokens
- Don't invent prices or identities
- Weekly registry refresh picks up new tokens; re-scan catches them next run

### Rule 5: Minimum Value Threshold

A position (of any type) is only written if `value_usd >= $50,000`.

- Rationale: keep whale pages focused on material holdings
- Applies to vault, ybs, and wallet-held lanes equally

### Rule 6: APY Source Rules (CRITICAL)

A token's APY is determined SOLELY by its classification. There are NO exceptions, NO inferences, NO "best guess" APYs.

| Source Type | APY Comes From |
|-------------|----------------|
| `scanner` (Aave/Morpho/Euler/Pendle/Spark) | Protocol API / on-chain call |
| `vault` | `data/vaults.json` entry |
| `ybs` | `data/stables.json` entry |
| `wallet` / `wallet-held` | **null** |
| `manual` | Manual position file |

**Forbidden:**
- Giving a wallet-held row an APY "because the token usually earns yield"
- Copying APY from a similar-named token
- Using a DeBank-reported APY for a wallet-held token
- Any case-by-case relabel logic in `export.js`

**Enforcement:** `src/validate.js` has a rule that fails the pipeline if any wallet-held position carries an APY. The export itself explicitly nulls out APY for wallet-held rows as a belt-and-suspenders check.

---

## Source Priority (Layer 5: Merge)

When the same `wallet + chain + underlying_token` appears from multiple sources, the higher priority wins:

| Priority | Source | Example |
|----------|--------|---------|
| 100 | Protocol scanner | Aave aUSDC position |
| 90 | Vault (Layer 2) | Upshift earnAUSD |
| 80 | YBS (Layer 2) | sUSDe |
| 70 | Manual | Anzen bond |
| 50 | Wallet-held | Plain USDC |

**Example:** A wallet holds aUSDC (Aave wrapper for USDC deposit). The Aave scanner writes it as lending position (priority 100). Token discovery sees aUSDC as a registry token and would write it as wallet-held (priority 50). Merge keeps Aave, drops wallet-held.

---

## Data File Ownership

Each data file has a specific owner. Don't mix concerns.

| File | Owner | What goes in | What does NOT go in |
|------|-------|--------------|---------------------|
| `data/vaults.json` | Vault scanner (Upshift, IPOR APIs) | Chain-specific vaults with `{protocol, symbol, chain, address, apy_*, tvl_usd}` | YBS tokens, protocol wrappers |
| `data/stables.json` | YBS curator (manual + DeFiLlama pool data) | Yield-bearing stablecoins matched by ticker | Protocol-specific wrappers (fUSDC, aUSDC), non-stable assets |
| `data/token-registry.json` | Weekly script from CoinGecko `/coins/list` | All CG tokens with `{id, symbol, name, address, chain}` | Prices, APYs, yields |
| `data/manual-positions.json` | Manual operator | Off-chain positions (Anzen, Pareto, InfiniFi strategies) | On-chain positions (let scanners find them) |

---

## Adding New Entities

### New whale
1. Add wallet addresses to `data/whales.json`
2. Run DeBank recon (Layer 1) — will auto-populate wallet-chain values
3. Hourly scans (Layer 2 + 3) will auto-classify holdings
4. No code changes needed

### New vault
1. Add entry to `data/vaults.json` with `{protocol, symbol, chain, address, apy_30d, tvl_usd}`
2. Hourly scans will pick it up
3. No code changes needed

### New YBS token
1. Confirm it earns yield (staking / rebasing / appreciating vault share)
2. Confirm its CoinGecko ticker is stable across chains
3. Add entry to `data/stables.json` with `{name: "TICKER", protocol, apy_30d, aliases: ["TICKER"]}`
4. No code changes needed

### New protocol with its own scanner (e.g., Fluid)
1. Build `src/fluid-scanner.js` following `aave-scanner.js` pattern
2. Add to `free-scans-hourly.yml` workflow
3. Remove any Fluid wrapper tokens from `data/stables.json` (e.g., fUSDC)
4. The scanner's output takes priority over Layer 2 wallet-held for those tokens

---

## Testing Your Changes

Before committing a rules change:

```bash
# 1. Run the pipeline
node src/build-debank-recon.js  # Layer 1
node src/token-discovery.js     # Layer 2
node src/aave-scanner.js        # Layer 3a
node src/morpho-scanner.js      # Layer 3b
node src/euler-scanner.js       # Layer 3c
# ... (see .github/workflows/free-scans-hourly.yml for full list)
node src/export.js              # Merge + enrich
node src/validate.js            # MUST PASS — enforces Rule 6
```

If `validate.js` fails, the rules are being violated. Fix the root cause, not the symptom.

---

## Known Rule Violations To Fix

As of 2026-04-22, the following tokens end up in `wallet-held` but should arguably move elsewhere:

| Token | Currently | Should Be | Owner |
|-------|-----------|-----------|-------|
| `steakUSDC` | wallet-held | Morpho scanner position | Morpho scanner |
| `stkGHO` | wallet-held | Either Aave stkGHO or YBS | Aave stkGHO scan |
| `gtUSDCp` | wallet-held | Pendle PT position | Pendle scanner |

These will be resolved as each scanner is improved. Until then, they correctly show as wallet-held (better to show with no APY than show with a fake APY).
