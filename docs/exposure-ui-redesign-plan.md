# Exposure UI Redesign — Plan v2

**Status:** Draft for review
**Created:** 2026-04-27
**Replaces:** Current exposure section UI on whale pages (Vercel-copy)

---

## What's wrong right now

1. **Pro-rata legs can exceed the position's USD value.** For leveraged positions (supply > net), the decomposition legs sum to the gross deposit, not the net. Reservoir-monitor's donuts equal the whale's holdings; ours don't. This needs to be fixed at the adapter level.
2. **Donuts don't total the whale's holdings.** Symptom of (1).
3. **"by token" card is missing.** The section renders but the third donut is empty in some views.
4. **No section name on donut hover.** Hard to tell which legend you're looking at once you scan away.
5. **Per-position cards don't say what each number means.** No labels, no column headers, no units — user has to guess that the second column is USD and the third is pct.
6. **No context.** Missing TVL, total borrowable, remaining borrowable — the things that actually matter for risk.
7. **Non-borrowable collateral mixed in with borrowable supply.** sUSDe shows up as "market exposure" on Aave Plasma but it's collateral-only there. Those positions aren't counterparty risk to the whale's USDT0 deposit. Needs to be filtered.
8. **"What are we doing here?"** Strategy column value (lend / loop / stake / lp) is on the table but not on the card. User has to cross-reference.
9. **Card width / row wrapping.** Current grid puts 4 on one row, 2 on the next — uneven sizing because of content length. We're not using `auto-fit` with enough flexibility.

---

## Target design

### Per-position card — new layout

Each card is **wider** (roughly 2× current), split into two columns internally:

```
┌──────────────────────────────────────────────────────────────┐
│ AAVE V3 · plasma                    [lend] [high]            │
│ Avant on Aave V3 Plasma                                      │
│                                                              │
│ Whale exposure         Pool TVL              Total borrowed  │
│ $52.65M (60.7%)        $287.4M               $184.3M (64%)   │
│                                                              │
│ ┌─ COLLATERAL ASSETS ─────┐ ┌─ BORROWABLE LIQUIDITY ────────┐│
│ │ Asset  │ Pool $  │  %   │ │ Asset │ Pool $ │ Avail │  %  ││
│ │ USDe   │ $60M    │ 20.9%│ │ USDT0 │ $120M  │ $45M  │41.8%││
│ │ sUSDe  │ $52M    │ 18.1%│ │ USDC  │  $8M   │  $2M  │ 2.8%││
│ │ PT-sUSDE│$48M    │ 16.7%│ │ GHO   │  $1M   │ $0.3M │ 0.3%││
│ │ USDT0  │ $41M    │ 14.3%│ │ ...                           ││
│ │ weETH  │ $4M     │  1.4%│ │                                ││
│ │ ...(scrollable)         │ │                                ││
│ └─────────────────────────┘ └───────────────────────────────┘│
│                                                              │
│ Protocol: Aave V3 · Market: Aave V3 Plasma · Chain: plasma  │
│ aave · subgraph · as of 2026-04-27 22:30 UTC                 │
└──────────────────────────────────────────────────────────────┘
```

**Key differences from current:**
- Two internal columns (collateral / borrowable) both scrollable and the same height
- Column headers inside each list, so every number has a label
- Header row of "Whale exposure", "Pool TVL", "Total borrowed" with clear units
- Strategy badge (lend / loop / lp / stake) next to confidence badge
- Footer has full context: Protocol / Market / Chain / adapter / source / timestamp

**Sizing:** Grid is `repeat(auto-fit, minmax(520px, 1fr))`. On wide screens: 2 per row. On narrow: 1 per row. Never 4-then-2.

### Donut section — changes

- Same three donuts (by protocol / by token / by market) BUT each donut's total = whale's real exposure (≤ whale total). Math fix below.
- Add a **title tooltip** on hover of the donut itself (not just the card title) — native `<title>` or custom tooltip showing "By protocol — $X across N protocols".
- Fix the missing "by token" — it's not missing, just needs a guard when `rollup.by_token` is empty. Show a placeholder: "No token-level exposure for this whale (off-chain only)."

### What we show per leg

Right now a leg row shows `Symbol / USD / %`. The new card has two such lists:

**Collateral assets list** (left):
- Assets accepted as collateral by the pool (includes non-borrowable)
- Column: asset, total in pool (USD), % of collateral
- Filter: `reserve.canBeCollateral === true` from the adapter's evidence
- Purpose: "what is backing the loans"

**Borrowable liquidity list** (right):
- Assets that can be borrowed (excludes collateral-only like sUSDe on Aave Plasma)
- Columns: asset, total supply, available (supply − borrowed), utilization %
- Filter: `reserve.borrowingEnabled === true` or `reserve.borrowCap > 0`
- Purpose: "what is the pool lending out"

For protocols where the distinction doesn't apply (Morpho Blue isolated markets, Pendle, YBS), the card has just one list and the second is hidden (or labelled "N/A"). Simpler layout for those.

---

## Pro-rata math fix (the biggest issue)

### Current (wrong)

```
yourPoolShare = userSupplyUsd / totalPoolSupplyUsd  // e.g. 130M / 287M = 45%
leg[i].usd = reserves[i].supplyUsd × yourPoolShare  // each leg scaled, legs sum to userSupplyUsd (gross)
```

Problem: `userSupplyUsd` here is **asset_usd** (gross), not **net_usd**. So for a $52M net / $130M asset position, legs sum to $130M and donuts over-count.

### Fix

```
yourPoolShare = userNetUsd / totalPoolNetUsd  // net basis on both sides
OR
Use asset-side lens but also compute liability-side netting:
  netClaim[i] = userAsset_i − userDebt_i  (per reserve)
  leg[i].usd = reserve.supplyUsd × (netClaim / totalPoolSupply)
```

Simpler and honest: show **user's net exposure** scaled to the pool composition.

```
forEach reserve r in pool:
  leg[r].pct    = r.supplyUsd / totalPoolSupplyUsd   // pool composition %
  leg[r].usd    = userNetUsd × leg[r].pct             // user's net claim on r
  leg[r].poolUsd = r.supplyUsd                         // raw pool number (shown alongside)
```

Now:
- Sum of leg.usd across a position = userNetUsd ✓
- Sum of donut labels across whale = whale total value ✓
- Percentages still reflect real pool composition ✓
- "Pool $" column shows the absolute pool size for context

For **borrows**, display the full pool borrow USD and a utilization % in the right-hand list — these are pool-level, not user-share-scaled.

For **isolated Morpho Blue markets** the pool's only "reserve" is the single collateral, so `pct = 100%` and `leg.usd = userNetUsd`. Correct and simple.

### What this means for donuts

Whale donuts currently show `$328.19M` for Avant (over-count). After the fix, donuts show Avant's real total (sum of all net_usd across 6 positions ≈ $86.7M). That matches the whale summary card and matches reservoir-monitor's behaviour.

---

## What we need from adapters

Right now adapters emit market_exposure rows but don't consistently expose:

- `reserve.canBeCollateral` (bool) — already in Aave evidence; need to surface in other adapters
- `reserve.borrowingEnabled` / `reserve.borrowCap` — Aave has it; Fluid/Compound/Morpho need it
- `pool.totalSupplyUsd` / `pool.totalBorrowUsd` — exists as evidence on root row, need to promote to an explicit field
- `reserve.available` = supply − borrow (derivable, but let's store it)
- `position.strategy_label` — already on position (p.strategy), just needs to reach the card

Schema additions on `exposure_decomposition` rows — or better, add to the `evidence_json` blob which we already have and is flexible. Renderer parses evidence for the right fields.

---

## Strategy labels

The `strategy` column on the table is the existing `p.strategy` value from the scanner. Today it emits: `lend`, `loop`, `stake`, `lp`, `farm`. Sometimes wrong — noted for a separate fix. For this UI:

- Each card shows a `[lend]` / `[loop]` / `[stake]` / `[lp]` badge in the header
- Same badge colours as the table column (already in whale-common.css: `badge-loop`, `badge-lend`, etc.)
- Sits next to the confidence badge

---

## Card sizing / row-wrapping fix

Current grid: `repeat(auto-fit, minmax(260px, 1fr))`
With min-width 260 and a 1400px container, 1400 / 260 = **5 columns max**. If we have 6 cards, 5 go in row 1 and 1 lonely card in row 2 — or 4+2 depending on actual card content widths.

Fix: `repeat(auto-fit, minmax(520px, 1fr))` for the new wider cards.
- 1400 / 520 = 2.69 → auto-fit collapses to 2 columns
- Containers narrower than 1080px collapse to 1 column
- Number of rows = ceil(N / 2). Rows always full until the last.

This is how index.html's whale cards already behave (they use minmax(380, 1fr) and always fit cleanly).

---

## Handling missing "by token" section

Bug: when `rollup.by_token` is empty (off-chain-heavy whales where all tokens are "REINSURANCE" etc), the donut renders but the legend is empty.

Fix: if a rollup dimension has fewer than 2 distinct values, show a placeholder message in the card instead of an empty legend. Or just always render the 3 donuts with a fallback label.

Add a `title` attribute on each donut's `<div class="exposure-donut-card">` so browser hover tooltips show the section name. Also add a small `<h4>` above each donut if it isn't already clear.

---

## Protocols where this template needs variants

Most positions are lending pools, so two-column (collateral / borrowable) works. Some don't:

| Kind | Left column | Right column |
|---|---|---|
| Aave / Spark / Compound V3 | Collateral assets | Borrowable liquidity |
| Morpho MetaMorpho vault | Markets it routes to (with collateral) | (none — idle + vault APY) |
| Morpho Blue (isolated) | The single collateral | The single loan asset |
| Euler EVK cluster | Collateral vaults | Loan asset pool |
| Fluid lending | Collateral types (from vaults) | The fToken asset |
| Curve LP | Pool tokens (no borrow side) | (hide) |
| Pendle PT/YT/LP | Underlying asset | (hide) |
| YBS (yoUSD, Ethena, etc) | Backing composition | (hide) |
| Off-chain opaque | Denomination | Counterparty + attestation |
| Wallet hold | The token(s) | (hide) |

So the renderer needs a **layout mode** from the root row's evidence. Adapter declares which layout applies. Card renderer picks template.

---

## Implementation phases

### Phase 1 — math fix (highest priority)
- In every adapter, change `yourPoolShare` calculation to use net_usd.
- Update `leg.usd` to be `userNetUsd × pool_composition_pct`.
- Keep `pool_total_usd` separately in evidence_json so the "Pool $" column has the raw pool number.
- Re-run `build-exposure.js`, verify donuts sum to whale total.

### Phase 2 — adapter metadata completion
- Every adapter surfaces: `pool_tvl_usd`, `pool_borrow_usd`, `pool_utilization`, per-leg `is_collateral` / `is_borrowable` / `available_usd`.
- Adapters declare layout mode: `{ layout: "lending" | "isolated_market" | "cluster" | "lp" | "ybs" | "opaque" | "wallet" }`.
- Store in evidence_json on the root row.

### Phase 3 — UI rebuild
- Wider cards (minmax(520px, 1fr))
- Two-column internal layout (collateral / borrowable)
- Column headers inside each list
- Stats strip: whale exposure / pool TVL / total borrowed
- Strategy badge in header
- Full footer with protocol / market / chain / adapter / source / timestamp
- Native donut hover tooltips with section names
- Fallback for empty dimensions

### Phase 4 — filter logic
- Borrowable list filters OUT non-borrowable collateral (Aave's `canBeCollateral && !borrowingEnabled`)
- Collateral list includes everything usable as collateral (includes borrowable things that are ALSO collateral)
- For Morpho Blue, Euler, Fluid: same distinction using their own metadata

### Phase 5 — polish
- Row alternation / hover highlights on leg lists
- Sticky column headers when lists scroll
- Consistent column alignment across cards (use CSS subgrid if we want exact alignment across cards in the same row)
- Mobile layout (collapse to single column internally)

---

## Open decisions for you

1. **Net vs gross exposure.** After the math fix, legs sum to net_usd. For a leveraged position ($130M supply, $77M borrow, $52M net), the card will show "$52.65M whale exposure" and legs that sum to $52.65M. Is that right, or do you want the gross $130M number highlighted somewhere too (e.g. as "asset-side pro-rata")?

2. **Non-borrowable asset filtering.** On Aave Plasma, sUSDe is collateral-only (not borrowable). Should it:
   - Show only in the collateral list (not borrowable list) ← my recommendation
   - Stay in both
   - Be removed entirely

3. **Duplicate same-market cards.** Two Avant wallets both in Aave Plasma. Keep as two cards (your preference) — but do we label them with the wallet address / position name so it's obvious they're different entities, or leave it ambiguous as it is today?

4. **Card count per row.** 2 per row at 1400px container with 520px min — same as "charts-grid" on index.html. OK, or do you want 3 per row (would need min ~450px and tighter layout)?

5. **Pool TVL number.** Should "Pool TVL" show the raw pool size or the pool size net of borrows (liquidity)? Both are useful.

---

## Deliverables

- `src/exposure/adapters/*.js` updated for net-basis math + metadata completion (phases 1+2)
- `whale-common.js renderPositionExposureCard()` rewritten with layout-mode dispatch (phase 3)
- `whale-common.css` new rules for two-column cards + sticky headers + strategy badge reuse (phase 3)
- No change to database schema — all new data goes in `evidence_json`
- Cache-bust on all 12 whale pages
