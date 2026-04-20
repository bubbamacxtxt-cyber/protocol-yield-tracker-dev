# Improvement Priorities

_Created: 2026-04-20 | Updated: 2026-04-20_

## 🔴 P0 — Critical / Broken

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| 1 | **Scanner v3 not in workflow** | ✅ DONE | Added `morpho-scanner.js` (was v3) to workflow |
| 2 | **Aave scanner v2 unused** | ✅ DONE | Renamed v2 → `aave-scanner.js`, now in workflow |
| 3 | **Euler scanner timeout** | ✅ DONE | Added 30s timeout + 3 retries with backoff |

## 🟡 P1 — Important / Data Quality

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| 4 | **Morpho REST API for borrow positions** | ✅ DONE | `morpho-scanner.js` uses REST API, finds borrow positions |
| 5 | **sUSDe native yield missing** | ✅ DONE | YBS enrichment in export.js adds Ethena staking APY |
| 6 | **No DeBank balance fallback** | 🟡 PARTIAL | Added retry with 30s timeout; full Alchemy fallback not implemented |
| 7 | **Morpho collateral labels wrong** | ✅ DONE | `fix-morpho-tokens.js` runs in workflow |

## 🟢 P2 — Nice to Have / Robustness

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| 8 | **Consolidate scanners** | ✅ DONE | Old versions moved to `src/deprecated/`, renamed to canonical names |
| 9 | **Add retry with backoff** | ✅ DONE | `fetch-helper.js` created, used by Merkl + enrich-markets |
| 10 | **Validation improvements** | ✅ DONE | Tiered thresholds: 3%/5%/8%/15% based on position size |
| 11 | **History tracking** | ✅ EXISTS | `data/total-history.json` already tracks daily totals |
| 12 | **Vault auto-discovery** | ❌ TODO | `vault-discoverer.js` exists but not integrated |

## 🔵 P3 — Architecture / Future

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| 13 | **Layer 2 v2 architecture** | ❌ TODO | Alchemy-based discovery (see `docs/scanner-architecture-v2.md`) |
| 14 | **Real-time alerts** | ❌ TODO | Telegram alerts on large position changes |
| 15 | **Multi-tenant support** | ❌ TODO | Add/remove whales without code changes |

---

## Audit Findings (2026-04-20)

### Bugs Fixed During Audit
1. **`asset_usd` not recalculated after merge** — Positions from Aave scanner + DeBank merged but `asset_usd` kept DeBank value (partial). Now recalculated from merged supply tokens.
2. **`apy_cost` not recalculated after merge** — Borrow tokens from different sources didn't have weighted APY recalculated. Added post-merge recalc.
3. **Audit script missing ×100** — Formula calculated decimal (-0.42) but didn't multiply by 100 for percentage (-42%).

### Math Verified
- Leverage formula: `net_apy = (supply×supplyApy - borrow×borrowApy) / equity × 100`
- Negative net APY is correct when borrow cost > supply yield (amplified by leverage)
- Yuzu: 11x leverage, 9.86% supply, 15.03% borrow → -42% net ✓

---

## Current Tech Debt (Updated)

- `yield-tracker.db` committed to git — should be in `.gitignore` (data.json is the export)
- `audit.js` in root — should move to `debug/`
- InfiniFi + Superform drift — need manual review (17%, 15% off from DeBank)
