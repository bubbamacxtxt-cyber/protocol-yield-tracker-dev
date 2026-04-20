# Improvement Priorities

_Created: 2026-04-20_

## 🔴 P0 — Critical / Broken

| # | Issue | Impact | Effort |
|---|-------|--------|--------|
| 1 | **Scanner v3 not in workflow** — `morpho-scanner-v3.js` exists but workflow uses v2 | Missing Morpho positions, wrong APYs | 5 min (update workflow) |
| 2 | **Aave scanner v2 unused** — `aave-scanner-v2.js` has Merit API integration | Missing Merit bonus APYs | 5 min (update workflow) |
| 3 | **Euler scanner timeout** — some chains time out, no retry | Missing Euler positions on slow chains | 30 min (add retry logic) |

## 🟡 P1 — Important / Data Quality

| # | Issue | Impact | Effort |
|---|-------|--------|--------|
| 4 | **Morpho REST API for borrow positions** — current GraphQL `userByAddress` returns empty for most wallets | Missing borrow positions | 1 hr (switch to REST) |
| 5 | **sUSDe native yield missing** — Aave reports 0%, need to add Ethena staking APY from YBS list | Positions show 0% supply APY | Already fixed in export.js ✓ |
| 6 | **No DeBank balance fallback** — if DeBank fails, entire scan fails | Full pipeline failure | 2 hr (add fallback to Alchemy) |
| 7 | **Morpho collateral labels wrong** — `fix-morpho-tokens.js` runs after enrichment | Confusing token names in UI | Already fixed ✓ |

## 🟢 P2 — Nice to Have / Robustness

| # | Issue | Impact | Effort |
|---|-------|--------|--------|
| 8 | **Consolidate scanners** — multiple versions of Aave/Morpho scanners | Maintenance confusion | 4 hr (pick best, delete others) |
| 9 | **Add retry with backoff** — Merkl, DeFiLlama, Aave APIs fail silently | Sporadic missing data | 2 hr |
| 10 | **Validation improvements** — current 5% threshold is too loose for small positions | Bad data passes validation | 1 hr |
| 11 | **History tracking** — `position_history` table exists but not populated | No PnL tracking | 3 hr |
| 12 | **Vault auto-discovery** — `vault-discoverer.js` exists but not integrated | New vaults missed until manual add | 4 hr |

## 🔵 P3 — Architecture / Future

| # | Issue | Impact | Effort |
|---|-------|--------|--------|
| 13 | **Layer 2 v2 architecture** — scanner-architecture-v2.md proposes Alchemy-based discovery | Replace DeBank dependency | 8 hr |
| 14 | **Real-time alerts** — Telegram alerts on large position changes | Early warning system | 4 hr |
| 15 | **Multi-tenant support** — add/remove whales without code changes | Operational flexibility | 6 hr |

---

## Recommended Next Steps (this week)

1. **Today:** Update workflow to use scanner v3 + Aave v2 (P0 #1, #2) — 10 min
2. **Today:** Add Euler retry logic (P0 #3) — 30 min
3. **This week:** Switch Morpho to REST API for borrow positions (P1 #4) — 1 hr
4. **This week:** Consolidate duplicate scanners (P2 #8) — 4 hr

---

## Current Tech Debt

- 4 Morpho scanners (v1, v2, v3, rest-api) — only v3 should remain
- 2 Aave scanners (v1, v2) — v2 should be default
- `check-*.js` debug scripts in root — should move to `debug/` or delete
- `yield-tracker.db` committed to git — should be in `.gitignore` (data.json is the export)
