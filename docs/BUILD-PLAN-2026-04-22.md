# Build Plan — Protocol Yield Tracker v3

**Date:** 2026-04-22
**Status:** Draft — awaiting approval
**Cost model:** DeBank 700 credits/day, everything else free

---

## Executive Summary

Replace the current hybrid DeBank+scanner pipeline with a clean scanner-first architecture. DeBank is used only for daily recon (wallet-chain discovery) and gap reporting. All position data comes from protocol-native APIs and direct Alchemy reads.

**Key principle:** Every position on the whale data page must be traceable to a specific on-chain contract or protocol API response. No black-box DeBank positions in the main output.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ LAYER 1: DEBANK RECON (Daily, 7 AM UTC)                          │
│                                                                   │
│ API:    /v1/user/all_complex_protocol_list                       │
│ Cost:   70 wallets × 10 credits = 700 credits/day               │
│ Output: wallet_chain_values.json                                  │
│         {wallet, chain, total_usd, protocols[]}                  │
│ Filter: Keep only wallet+chain pairs > $50K                     │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ LAYER 2: ALCHEMY TOKEN DISCOVERY (Hourly, :15)                   │
│                                                                   │
│ Input:  Active wallet+chain pairs from Layer 1                   │
│ API:    alchemy_getTokenBalances per wallet+chain                │
│ Match priority (first match wins):                               │
│   1. VAULT LIST → Create vault position with APY                │
│   2. YBS LIST → Create yield-bearing position with APY          │
│   3. TOKEN REGISTRY → Create wallet-held position                │
│ Filter: Only positions with value > $50K                        │
│ Output: Write to DB with source = 'alchemy+{type}'              │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ LAYER 3: PROTOCOL API SCANNERS (Hourly, :15)                     │
│                                                                   │
│ Gated by Layer 1: Only scan chains with wallet+chain > $50K     │
│ where DeBank shows relevant protocol hints.                      │
│                                                                   │
│ Aave scanner   → lending positions (supply + borrow)            │
│ Morpho scanner → vault positions + borrow positions             │
│ Euler scanner  → vault positions                                 │
│ Pendle scanner → PT/YT positions                                 │
│ Spark scanner  → savings + lending                               │
│ Output: Write to DB with source = 'scanner'                     │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ LAYER 4: MANUAL/OFF-CHAIN POSITIONS (On demand)                  │
│                                                                   │
│ Anzen bonds, Pareto funds, InfiniFi strategies                   │
│ Written directly to DB with source = 'manual'                   │
│ These bypass all discovery layers                                │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ LAYER 5: MERGE & DEDUPLICATE                                     │
│                                                                   │
│ Load all positions from DB (Layer 2 + 3 + 4)                    │
│ Group by: wallet + chain + underlying_token_address             │
│ Priority (highest wins):                                         │
│   1. Protocol scanner (Aave/Morpho/Euler/Pendle/Spark)         │
│   2. Vault detection (from Layer 2)                             │
│   3. YBS detection (from Layer 2)                               │
│   4. Manual/off-chain                                           │
│   5. Wallet-held (lowest priority)                              │
│ If same underlying appears in scanner + wallet-held → scanner   │
│ Output: Deduped position list                                    │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ LAYER 6: ENRICH & EXPORT                                         │
│                                                                   │
│ Enrich:                                                          │
│   - Add APY from vault list, YBS list, protocol APIs            │
│   - Compute net APY per position                                │
│   - Add protocol category from registry                         │
│ Export:                                                          │
│   - data.json (frontend whale pages)                            │
│   - missing-report.json (DeBank vs ours gap analysis)           │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ LAYER 7: FRONTEND                                                │
│                                                                   │
│ Whale page shows:                                                │
│   - All positions with source badge                             │
│   - Coverage % (our total / DeBank total per whale)             │
│   - "View Missing" link → DeBank detail comparison              │
│ Source badges:                                                   │
│   🟢 Scanner = protocol API (highest confidence)                │
│   🟡 Vault = matched from vault list                            │
│   🔵 YBS = yield-bearing stable                                 │
│   ⚪ Wallet = plain token holding                               │
│   ⚫ Manual = off-chain position                                │
└──────────────────────────────────────────────────────────────────┘
```

---

## Data Sources

### Source of Truth Registry

| Data | File | Count | Updated |
|------|------|-------|---------|
| Whale wallets | `data/whales.json` | 70 wallets, 10 whales | Manual |
| Token registry | `data/token-registry.json` | 23,737 contract addresses, 302 chains | Weekly (CoinGecko) |
| Vault list | `data/vaults.json` | 86 vaults, 10 chains | Daily (Upshift + IPOR APIs) |
| YBS list | `data/stables.json` | 34 yield-bearing stables | Daily (DeFiLlama) |
| Protocol registry | `data/protocol-registry.json` | Canonical names + aliases | Manual |
| Manual positions | `data/manual-positions.json` | Off-chain + API-derived | Manual |

### API Costs

| Layer | API | Calls | Cost |
|-------|-----|-------|------|
| 1 | DeBank all_complex_protocol_list | 70/day | 700 credits/day |
| 2 | Alchemy getTokenBalances | ~640/hour | Free (within CU) |
| 2 | Alchemy getTokenMetadata | ~640/hour | Free (within CU) |
| 3 | Aave GraphQL | ~50/hour | Free |
| 3 | Morpho REST | ~50/hour | Free |
| 3 | Euler API | ~20/hour | Free |
| 3 | Pendle API | ~20/hour | Free |
| 6 | DeFiLlama yields | ~10/day | Free |

**Total DeBank cost: 700 credits/day (~21K/month)**

---

## Current State vs Target

### What Works Today

| Component | Status | Notes |
|-----------|--------|-------|
| `build-debank-recon.js` | ✅ | Outputs wallet-chain summary + positions |
| `recon-helpers.js` | ✅ | `loadActiveWalletChains(50000)` filters correctly |
| Token registry | ✅ | 23,737 tokens, O(1) lookup by `chain:address` |
| Vault list | ✅ | 86 vaults with contract addresses + APY |
| YBS list | ✅ | 34 stables with contract addresses + APY |
| `reconcile-gaps.js` | ✅ | Produces gap report (DeBank vs modeled) |
| Manual positions | ✅ | `fetch-anzen.js`, `fetch-pareto.js`, `fetch-infinifi.js` |

### What's Broken

| Component | Problem | Impact |
|-----------|---------|--------|
| `aave-scanner.js` | $10M sidechain thresholds (lines 37-40) | Blocks Ink ($3.5M) and Plasma ($15.8M) positions |
| `morpho-scanner.js` | Earn positions not found for Avant | Missing $3.6M supply, only borrow found |
| `euler-scanner.js` | Hardcoded `value_usd: 0` | All 18 Euler positions show $0 |
| `export.js` | Overloaded (1,156 lines) | Merge + dedup + suppress + format + APY recompute all in one file |
| `export.js` | Missing `value_usd` field | Frontend can't display position value |

### What's Missing

| Component | Needed For | Complexity |
|-----------|-----------|------------|
| Vault matching in token discovery | Layer 2 | Medium |
| YBS matching in token discovery | Layer 2 | Low |
| ERC-4626 vault value calculation | Layer 2 | Medium |
| Clean merge layer | Layer 5 | Medium |
| Source badges on frontend | Layer 7 | Low |
| Coverage % per whale | Layer 7 | Low |
| "View Missing" link | Layer 7 | Low |

---

## Build Phases

### Phase 0: Foundation Cleanup (30 minutes) — P0

**Goal:** Remove broken pieces that poison the pipeline.

1. **Remove $10M thresholds** in `aave-scanner.js`
   - Delete lines 37-40 (mnt/ink/plasma/base < $10M blocks)
   - Keep `loadActiveWalletChains()` gating

2. **Add `value_usd = net_usd`** in `export.js`
   - One-line fix: `p.value_usd = p.net_usd` before writing
   - Frontend needs this field

3. **Disable `update.yml`**
   - This is the legacy DeBank-heavy path
   - Rename to `.github/workflows/update.yml.disabled`
   - `free-scans-hourly.yml` + `recon-daily.yml` replace it

**Risk:** Low. Isolated fixes.

---

### Phase 1: Token Discovery v3 (3 hours) — P0

**Goal:** Layer 2 works with vault + YBS + wallet-held detection.

**File:** Rewrite `src/token-discovery.js`

**New flow:**
```javascript
// Load indexes
const vaultIndex = buildVaultIndex();      // chain:address → vault
const ybsIndex = buildYbsIndex();          // chain:address → ybs
const registry = loadRegistry();           // chain:address → token

// For each active wallet+chain pair
for (const {wallet, chain} of activePairs) {
  const balances = await alchemy_getTokenBalances(wallet, chain);
  
  for (const token of balances) {
    const metadata = await alchemy_getTokenMetadata(token.address);
    const amount = token.balance / 10 ** metadata.decimals;
    
    // Priority 1: Vault match
    const vault = vaultIndex[`${chain}:${token.address}`];
    if (vault) {
      const value_usd = await calculateVaultValue(vault, amount, wallet);
      if (value_usd > 50000) {
        writePosition({
          wallet, chain,
          protocol_id: 'vault',
          protocol_name: vault.protocol,
          symbol: vault.symbol,
          address: token.address,
          amount, value_usd,
          apy: vault.apy_30d,
          source_type: 'alchemy+vault'
        });
      }
      continue;
    }
    
    // Priority 2: YBS match
    const ybs = ybsIndex[`${chain}:${token.address}`];
    if (ybs) {
      const price = await getTokenPrice(chain, token.address);
      const value_usd = amount * price;
      if (value_usd > 50000) {
        writePosition({
          wallet, chain,
          protocol_id: 'ybs',
          protocol_name: ybs.protocol,
          symbol: ybs.name,
          address: token.address,
          amount, value_usd,
          apy: ybs.apy_30d,
          source_type: 'alchemy+ybs'
        });
      }
      continue;
    }
    
    // Priority 3: Plain token (from registry)
    const registryToken = registry.by_address[`${chain}:${token.address}`];
    if (registryToken) {
      const price = await getTokenPrice(chain, token.address);
      const value_usd = amount * price;
      if (value_usd > 50000) {
        writePosition({
          wallet, chain,
          protocol_id: 'wallet-held',
          protocol_name: 'Wallet',
          symbol: registryToken.symbol,
          address: token.address,
          amount, value_usd,
          apy: null,
          source_type: 'alchemy+registry'
        });
      }
    }
  }
}
```

**Vault value calculation:**
1. Try ERC-4626 `convertToAssets(shares)` via RPC
2. Fallback: `shares × TVL / totalSupply` from vault data
3. Fallback: Use vault's underlying token price × estimated underlying amount
4. Last resort: Write with `value_usd: null` + flag for review

**Price sources (in order):**
1. DeFiLlama `/coins/{chain}:{address}`
2. CoinGecko `/simple/token_price/{chain_id}`
3. Alchemy price API (if available)

**Risk:** Medium. Vault value calculation is the tricky part.

---

### Phase 2: Fix Protocol Scanners (4 hours) — P0

#### 2A: Aave Scanner (1 hour)

**File:** `src/aave-scanner.js`

**Changes:**
- Remove lines 37-40 (mnt/ink/plasma/base < $10M blocks)
- Keep `loadActiveWalletChains()` gating — this is the correct filter
- Test with Avant wallets on Ink and Plasma

**Test:**
```bash
node src/aave-scanner.js --wallet 0x920eefbcf1 --chain ink
node src/aave-scanner.js --wallet 0xc468315a2d --chain plasma
```

#### 2B: Morpho Scanner (2 hours)

**File:** `src/morpho-scanner.js`

**Problem:** Avant wallet `0x7bee8d37fba61a6251a08b957d502c56e2a50fab` has:
- Borrow positions found: $26.8M debt
- Earn positions missing: $3.6M supply should exist

**Debug steps:**
1. Test Morpho REST API directly:
   ```bash
   curl "https://api.morpho.org/v1/positions/earn?userAddress=0x7bee8d...&chainIds=1"
   ```
2. If empty, try internal API:
   ```bash
   curl -H "x-apollo-operation-name: GetUserPositions" \
        "https://app.morpho.org/api/graphql" \
        -d '{"query": "..."}'
   ```
3. Check if earn positions are under a different endpoint
4. Add fallback to borrow endpoint collateral parsing (already partially there)

**Risk:** Medium. API behavior may have changed.

#### 2C: Euler Scanner (1 hour)

**File:** `src/euler-scanner.js`

**Problem:** Line 106 hardcodes `value_usd: 0`

**Fix:**
```javascript
// For each vault position:
const shares = await vault.balanceOf(wallet);
const underlying = await vault.convertToAssets(shares);
const price = await getTokenPrice(chain, underlyingTokenAddress);
const value_usd = (underlying / 10 ** decimals) * price;
```

**Risk:** Low. Standard ERC-4626 pattern.

---

### Phase 3: Merge Layer (3 hours) — P1

**Goal:** Clean deduplication separate from export.

**New file:** `src/merge-positions.js`

```javascript
const db = require('better-sqlite3')('./yield-tracker.db');

// Load all positions
const positions = db.prepare('SELECT * FROM positions').all();

// Group by wallet + chain + underlying_token
const groups = new Map();
for (const p of positions) {
  const underlying = getUnderlyingAddress(p);
  const key = `${p.wallet}|${p.chain}|${underlying}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(p);
}

// Apply priority
const merged = [];
for (const [key, group] of groups) {
  const sorted = group.sort((a, b) => sourcePriority(b) - sourcePriority(a));
  const winner = sorted[0];
  
  // If winner is scanner, merge any wallet-held data as notes
  if (winner.source_type === 'scanner' && group.length > 1) {
    winner.also_found_as = group.slice(1).map(p => p.source_type);
  }
  
  merged.push(winner);
}

function sourcePriority(p) {
  const type = p.source_type || p.protocol_id || '';
  if (['aave', 'morpho', 'euler', 'pendle', 'spark'].includes(type)) return 100;
  if (type === 'vault') return 90;
  if (type === 'ybs') return 80;
  if (type === 'manual' || p.wallet === 'off-chain') return 70;
  if (type === 'wallet-held' || type === 'wallet') return 50;
  return 0;
}
```

**Output:** Write merged positions to new table `positions_merged` or temp file.

**Risk:** Low. Pure data transformation.

---

### Phase 4: Simplified Export (2 hours) — P1

**Goal:** Extract only format/display logic from `export.js`.

**Split into:**

#### `src/merge-positions.js` (Phase 3, already)
- Dedup logic
- Priority rules

#### `src/enrich-apy.js` (new)
- Load merged positions
- For each position:
  - If vault: APY from `data/vaults.json`
  - If YBS: APY from `data/stables.json`
  - If Aave: APY from Aave API or cache
  - If Morpho: APY from Morpho API or cache
  - If wallet-held: APY = null
- Compute weighted net APY per position
- Output: enriched positions

#### `src/export-json.js` (new, replaces `export.js`)
- Load enriched positions
- Format for frontend:
  ```javascript
  {
    wallet, chain, protocol_name, protocol_id,
    strategy, position_type,
    supply: [...], borrow: [...],
    asset_usd, debt_usd, net_usd, value_usd,
    apy_base, bonus_total, apy_cost, apy_net,
    health_rate,
    source_type, confidence, exposure_class
  }
  ```
- Write `data.json`

**Risk:** Medium. Need to preserve all frontend fields.

---

### Phase 5: Missing Report (2 hours) — P2

**Goal:** Clear visibility into gaps.

**Enhanced `reconcile-gaps.js`:**

```json
{
  "generated_at": "2026-04-22T...",
  "summary": {
    "total_debank_usd": 483000000,
    "total_modeled_usd": 456000000,
    "coverage_pct": 94.4,
    "wallets_with_gaps": 12
  },
  "whales": {
    "Avant": {
      "debank_usd": 245000000,
      "modeled_usd": 230000000,
      "coverage_pct": 93.9,
      "wallets": [
        {
          "wallet": "0x7bee8d...",
          "chain": "eth",
          "debank_usd": 3600000,
          "modeled_usd": 0,
          "delta_usd": 3600000,
          "missing_protocols": [
            { "name": "Morpho", "debank_usd": 3600000 }
          ],
          "status": "needs_investigation"
        }
      ]
    }
  }
}
```

**Status codes:**
- `ok` — coverage > 95%
- `minor_gap` — coverage 90-95%
- `needs_investigation` — coverage < 90% or > $1M delta

**Risk:** Low. Pure reporting.

---

### Phase 6: Frontend Integration (2 hours) — P2

**Files:** `whale-common.js`, `index.html`

**Changes:**

1. **Source badges in table:**
   ```javascript
   const SOURCE_BADGES = {
     'scanner': { icon: '🟢', label: 'Scanner' },
     'vault': { icon: '🟡', label: 'Vault' },
     'ybs': { icon: '🔵', label: 'YBS' },
     'wallet-held': { icon: '⚪', label: 'Wallet' },
     'manual': { icon: '⚫', label: 'Manual' }
   };
   ```

2. **Coverage card per whale:**
   ```javascript
   {
     label: 'Coverage',
     field: '_computed',
     fn: (positions) => {
       const whale = positions[0]?.whale;
       const report = loadGapReport();
       const coverage = report.whales[whale]?.coverage_pct;
       return coverage ? coverage + '%' : 'N/A';
     },
     color: (v) => v > 95 ? 'green' : v > 90 ? 'yellow' : 'red'
   }
   ```

3. **"View Missing" button:**
   - Opens modal with DeBank vs ours comparison
   - Shows protocols we missed
   - Shows USD delta per chain

**Risk:** Low. UI only.

---

## Execution Order

| Order | Phase | Time | Priority | Depends On |
|-------|-------|------|----------|------------|
| 1 | Phase 0: Foundation cleanup | 30m | P0 | — |
| 2 | Phase 1: Token discovery v3 | 3h | P0 | Phase 0 |
| 3 | Phase 2A: Aave fix | 1h | P0 | Phase 0 |
| 4 | Phase 2B: Morpho fix | 2h | P0 | — |
| 5 | Phase 2C: Euler fix | 1h | P1 | — |
| 6 | Phase 3: Merge layer | 3h | P1 | Phases 1, 2 |
| 7 | Phase 4: Simplified export | 2h | P1 | Phase 3 |
| 8 | Phase 5: Missing report | 2h | P2 | Phase 4 |
| 9 | Phase 6: Frontend | 2h | P2 | Phase 5 |

**Total: ~16 hours focused work**

---

## Foreseen Problems & Solutions

### 1. Vault Value Calculation
**Issue:** Vault tokens like `earnAUSD` aren't priced on DeFiLlama.

**Solutions (in order):**
1. ERC-4626 `convertToAssets(shares)` via RPC
2. `shares × TVL / totalSupply` from vault data
3. Protocol API `/value` endpoint
4. Fallback: `value_usd: null` + flag for review

### 2. Duplicate Tokens Across Sources
**Issue:** Same USDC in Aave scanner + Alchemy balance.

**Solution:** Dedup by underlying address. Scanner wins over wallet-held.

### 3. Missing Report Noise
**Issue:** DeBank shows $5K in obscure protocols.

**Solution:** Filter dust < $1K, ignore Merkl, only flag > $5K deltas.

### 4. HyperLiquid Token Discovery
**Issue:** New chain, Alchemy support partial.

**Solution:** Best-effort. Skip if RPC fails. Test before enabling.

### 5. Rate Limits
**Issue:** 640 calls/scan × 24/day.

**Solution:** 460K calls/month well within 300M CU limit.

### 6. New Tokens Not in Registry
**Issue:** Token launched today, not in CoinGecko yet.

**Solution:** Fallback to `alchemy_getTokenMetadata`. Weekly registry refresh.

### 7. Scanner Returns Negative Net
**Issue:** Morpho borrow-only fragments show negative net.

**Solution:** Merge layer handles this — borrow-only gets merged into supply row.

---

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| DeBank in main output? | **No** | Only for recon + missing report |
| Vault value on failure? | **Null + flag** | Don't hide positions, mark for review |
| Wallet-held vs scanner? | **Scanner wins** | Scanner has exact market context |
| Missing report delivery? | **JSON + dashboard** | No Telegram alerts yet |
| ERC-4626 vaults? | **Primary method** | Standard, reliable |
| Price source priority? | **DeFiLlama → CoinGecko → Alchemy** | Free, comprehensive |
| Coverage threshold? | **95% = ok, 90-95% = minor, <90% = investigate** | Based on $1M delta rule |

---

## Success Criteria

1. **Coverage:** > 95% of DeBank total per whale
2. **Accuracy:** No negative net positions without explicit borrow
3. **Traceability:** Every position traceable to source (scanner/vault/ybs/wallet/manual)
4. **Cost:** < 1,000 DeBank credits/day
5. **Speed:** Hourly pipeline completes in < 10 minutes
6. **Gap visibility:** Missing report auto-generated, linked from frontend

---

## Current Data Snapshot

- **Wallets:** 70 across 10 whales
- **Active pairs:** 58 wallet-chain pairs > $50K
- **Chain totals:** ETH $371M, Plasma $35M, Monad $23M, Mantle $17M, Base $10M, Arb $8M
- **DB positions:** 142
- **DB tokens:** 134
- **Protocols in DB:** Morpho 42, Aave V3 26, Euler 18, Pendle 16, Ethena 5

---

## Files to Create/Modify

### New Files
- `src/merge-positions.js`
- `src/enrich-apy.js`
- `src/export-json.js`

### Modified Files
- `src/token-discovery.js` (rewrite)
- `src/aave-scanner.js` (remove thresholds)
- `src/morpho-scanner.js` (fix earn positions)
- `src/euler-scanner.js` (fix value calculation)
- `src/export.js` (deprecate, replace)
- `src/reconcile-gaps.js` (enhance)
- `whale-common.js` (add badges + coverage)
- `index.html` (add "View Missing" link)

### Disabled
- `.github/workflows/update.yml` → `update.yml.disabled`

---

*Plan written 2026-04-22. Awaiting approval to begin Phase 0.*
