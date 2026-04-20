# Pendle v1 plan

Date: 2026-04-20

## Goal

Build a practical API-first Pendle scanner that covers the common real-world cases without overcommitting to hard historical reconstruction in v1.

Target coverage:
- PT holdings
- YT holdings
- Pendle LP holdings
- current economics (not historical locked-in rate reconstruction)
- loop candidate flagging later via existing borrow data

## Why API-first is the right path

Pendle API already returns the hardest metadata we would otherwise need to reconstruct manually:
- market address
- chainId
- expiry
- PT token metadata
- YT token metadata
- SY token metadata
- underlying asset
- PT price
- YT price
- implied APY
- ytFloatingApy
- LP APY breakdowns

That makes Pendle a strong fit for:
1. API for market graph + economics
2. wallet token balance scan for discovery
3. normalized classification layer in our repo

## Docs and API facts confirmed

### Pendle concepts
From Pendle docs:
- `PT` = Principal Token, redeemable to principal at maturity
- `YT` = Yield Token, claim on future yield until maturity
- `SY` = Standardized Yield wrapper
- `LP` = Pendle market LP token, exposed through PendleMarket

### Important semantic caution
Current market `impliedApy` is useful for mark-to-market, but it is **not guaranteed to equal the holder's original locked rate**, unless we reconstruct the buy event history.

For v1 we should store:
- `current_implied_apy`
- `expiry`
- `days_to_expiry`

And explicitly avoid claiming:
- exact historical locked APY
- exact entry timestamp / rate

### API endpoints confirmed
Working endpoints:
- `GET https://api-v2.pendle.finance/core/v2/markets/all?limit=...&skip=...`
- `GET https://api-v2.pendle.finance/core/v1/{chainId}/markets?is_expired=false&limit=...`

Observed market payload includes:
- `chainId`
- `address` (market)
- `expiry`
- `pt.address`, `pt.symbol`, `pt.price.usd`, `pt.baseType`
- `yt.address`, `yt.symbol`, `yt.price.usd`, `yt.baseType`
- `sy.address`, `sy.symbol`
- `details.impliedApy`
- `details.ytFloatingApy`
- `details.underlyingApy`
- `lpApyBreakdown`
- `ytApyBreakdown`

## Existing repo leverage

### Already present
- `fetch-base-apy.js` already queries Pendle API and maps:
  - PT → `impliedApy`
  - YT → `ytFloatingApy`
- `wallet-scanner.js` and existing scanner patterns already use token-balance discovery via Alchemy
- export pipeline already supports token-level positions and APY enrichment

### Implication
Pendle v1 does **not** need a from-scratch valuation engine.
The missing layer is:
- token discovery
- market lookup / token-to-market mapping
- normalized PT/YT/LP position construction

## Recommended Pendle v1 position model

### Common fields
For all Pendle positions:
- `wallet`
- `chain`
- `chainId`
- `protocol_name: 'Pendle'`
- `protocol_id: 'pendle'` or subtype-specific IDs
- `position_type: 'supply'`
- `strategy`
- `market_address`
- `expiry`
- `days_to_expiry`
- `underlying_symbol`
- `underlying_address`
- `sy_address`
- `source_type: 'protocol_api'` or `scanner` depending on final write path
- `source_name: 'pendle-scanner'`
- `discovery_type: 'onchain'`

### PT positions
Suggested fields:
- `strategy: 'pendle-pt'`
- `pendle_position_type: 'pt'`
- `token_address = pt.address`
- `symbol = pt.symbol`
- `value_usd = token_balance * pt.price.usd`
- `apy_base = current implied APY`
- `apy_base_source = 'pendle'`
- `current_implied_apy`
- `pt_price_usd`

### YT positions
Suggested fields:
- `strategy: 'pendle-yt'`
- `pendle_position_type: 'yt'`
- `token_address = yt.address`
- `symbol = yt.symbol`
- `value_usd = token_balance * yt.price.usd`
- `apy_base = ytFloatingApy`
- `current_implied_apy` optionally also stored from market
- `yt_price_usd`

### LP positions
Suggested fields:
- `strategy: 'pendle-lp'`
- `pendle_position_type: 'lp'`
- `token_address = market.address`
- `symbol = market.symbol` (often `PENDLE-LPT`)
- `value_usd` from market/API price if exposed, else fallback logic needed
- `apy_base` from LP APY breakdown aggregated field if reliable
- `lp_apy_components` from `lpApyBreakdown`

## Discovery strategy

## Step 1. Build a Pendle market registry
For each supported chain we care about, fetch all non-expired markets and build registries:
- `ptAddress -> market`
- `ytAddress -> market`
- `lpAddress/marketAddress -> market`

Likely initial chains:
- Ethereum
- Arbitrum
- Base
- Plasma if needed

## Step 2. Scan wallets for Pendle token balances
Use wallet token balance discovery, likely Alchemy where supported.

Two practical options:
1. scan every wallet for all known PT/YT/LP addresses on each chain
2. fetch broad token balances and intersect with Pendle registry

Recommendation:
- prefer broad token balance scan where Alchemy is available
- intersect against Pendle registry
- avoid one-call-per-token loops if possible

## Step 3. Classify by token address
If address matches:
- PT registry → PT position
- YT registry → YT position
- market/lp registry → LP position

## Step 4. Write normalized positions
Store in positions + position_tokens using the same DB pattern as Aave/Euler/Spark.

## What not to do in v1

Do not try to fully reconstruct:
- historical locked PT rate
- entry timestamp
- weighted average cost basis across buys/transfers
- realized versus unrealized fixed yield

That is event-history work and should be v2.

## Loop detection plan

Not part of core Pendle discovery, but realistic as a follow-on.

Heuristic v1.5:
- wallet holds PT
- wallet also has borrow positions in Aave / Morpho / Euler / Spark
- optionally same chain and related underlying family

Label as:
- `pendle-loop-candidate`

Do not overclaim exact loop mechanics in first pass.

## Risks / gotchas

### 1. LP valuation may be the trickiest part
PT and YT are straightforward if API price is present.
LP may require:
- explicit LP price if returned
- or TVL/supply-derived fallback
- or temporarily partial support if price field is missing

### 2. Expired markets
Need explicit handling:
- current endpoint supports `is_expired=false`
- expired PT/YT may still be held in wallets
- v1 can ignore expired first, but this should be called out

### 3. Cross-chain discovery support varies by RPC provider
Need to align Pendle-supported chains with wallet scanning capability.

## Proposed implementation order

### Phase 1. Market registry and docs note
- add Pendle v1 plan doc
- add market fetch helper
- build token-address registries by chain

### Phase 2. PT/YT discovery
- scan tracked wallets for Pendle PT and YT token balances
- create normalized PT/YT positions
- attach current APY and expiry data from market registry

### Phase 3. LP discovery
- detect Pendle LP token balances by market address
- add LP classification
- attach best available LP APY fields

### Phase 4. Export + QA
- ensure export renders PT/YT/LP distinctly
- check overlap with DeBank positions
- verify whales with real Pendle holdings

### Phase 5. Optional loop candidate flagging
- join with borrow positions from existing scanners
- add heuristic strategy label only

## Bottom line

Pendle is complicated, but API-first makes v1 realistic.

The correct v1 is:
- discovery
- classification
- current economics

Not:
- full historical locked-rate reconstruction

That gives us useful Pendle coverage quickly without disappearing into event archaeology.
