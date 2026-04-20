# Spark coverage plan

Date: 2026-04-20

## Why this exists

The current Spark scanner missed a real Spark position held by InfiniFi wallet `0xd880D7C5CaFdbE2AEc281250995abF612235e563`.

InfiniFi API reports:
- label: `Spark sUSDC`
- strategy id: `spark-sUSDC-refcode`
- underlyingAssetAddress: `0xBc65ad17c5C0a2A4D159fa5a503f4992c7B545FE`

This address matches the current Spark docs for Ethereum `sUSDC`.

So the problem is not that the position is fake. The problem is that our Spark scanner coverage is outdated and too narrow.

## Docs-backed Spark product map

Source: `https://docs.spark.fi/llms-full.txt`

### 1. Spark Savings

Docs say Spark Savings includes canonical `sUSDS` and `sUSDC` tokens.

### Supported Savings token addresses from docs

| Network | USDS | sUSDS | sUSDC |
|---|---|---|---|
| Ethereum | `0xdC035D45d973E3EC169d2276DDab16f1e407384F` | `0xa3931d71877c0e7a3148cb7eb4463524fec27fbd` | `0xBc65ad17c5C0a2A4D159fa5a503f4992c7B545FE` |
| Base | `0x820C137fa70C8691f0e44Dc420a5e53c168921Dc` | `0x5875eEE11Cf8398102FdAd704C9E96607675467a` | `0x3128a0F7f0ea68E7B7c9B00AFa7E41045828e858` |
| Arbitrum | `0x6491c05A82219b8D1479057361ff1654749b876b` | `0xdDb46999F8891663a8F2828d25298f70416d7610` | `0x940098b108fB7D0a7E374f6eDED7760787464609` |
| Optimism | `0x4F13a96EC5C4Cf34e442b46Bbd98a0791F20edC3` | `0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0` | `0xCF9326e24EBfFBEF22ce1050007A43A3c0B6DB55` |
| Unichain | `0x7E10036Acc4B56d4dFCa3b77810356CE52313F9C` | `0xA06b10Db9F390990364A3984C04FaDf1c13691b5` | `0x14d9143BEcC348920b68D123687045db49a016C6` |

### 2. SparkLend

Docs say SparkLend is currently supported on:
- Ethereum
- Gnosis Chain

### 3. Spark app network surface

Docs mention Spark app network selection includes:
- Ethereum
- Base
- Arbitrum
- Gnosis
- Optimism
- Unichain
- Avalanche

This is broader than SparkLend itself. So product support must be modeled per lane, not assumed globally.

## Current scanner gaps

File: `src/spark-scanner.js`

### What current scanner does
- direct SparkLend scan on Ethereum only
- savings scan using hardcoded legacy token set:
  - `spUSDC`
  - `spUSDT`
  - `spETH`
  - `spPYUSD`
  - `stUSDS`

### What is wrong with that
- it does not scan canonical docs-listed `sUSDC`
- it does not scan canonical multi-chain Savings token set
- it only handles Ethereum SparkLend, while docs say SparkLend also exists on Gnosis
- it mixes old/legacy savings token assumptions with current Spark product names

## Inferred coverage model we should implement

### Lane A: direct Spark Savings
Detect direct balances of canonical docs-listed tokens:
- `sUSDS`
- `sUSDC`

Across supported networks:
- Ethereum
- Base
- Arbitrum
- Optimism
- Unichain

Questions to confirm later:
- whether Avalanche has canonical Savings token addresses not shown in this docs table
- whether older `sp*` / `stUSDS` tokens should remain as legacy aliases or be retired

### Lane B: direct SparkLend
Detect direct SparkLend supply / borrow positions on:
- Ethereum
- Gnosis

Questions to confirm later:
- provider address and market config for Gnosis SparkLend

### Lane C: indirect Spark strategy exposure
Examples:
- InfiniFi `spark-sUSDC-refcode`

Rule:
- if an upstream protocol explicitly reports Spark strategy exposure, classify it as Spark exposure even if no direct Spark RPC position is found
- but label it distinctly from direct Spark wallet-held positions

Suggested types:
- `spark-savings-direct`
- `spark-lend-direct`
- `spark-strategy-indirect`

## Implementation plan

### Phase 1. Replace stale Spark Savings registry
- replace legacy `SPARK_SAVINGS` hardcoded set with docs-backed canonical registry
- include chain metadata per token
- start with Ethereum support immediately
- structure registry so Base/Arbitrum/Optimism/Unichain can be added without redesign

### Phase 2. Add direct canonical Savings detection
- detect wallet balances for canonical `sUSDS` and `sUSDC`
- use token balances first
- enrich APY separately
- verify `0xd880...e563` against Ethereum `sUSDC`

### Phase 3. Split legacy tokens from canonical tokens
- move old `spUSDC`, `spUSDT`, `spETH`, `spPYUSD`, `stUSDS` into one of:
  - legacy support list
  - separate deprecated scanner path
  - remove if obsolete and not used

### Phase 4. Add Gnosis SparkLend lane
- find SparkLend Gnosis addresses
- extend Aave-fork scanner config beyond Ethereum

### Phase 5. Add indirect Spark classification
- for protocol API imports like InfiniFi, map Spark-tagged strategies to indirect Spark exposure
- use docs canonical token addresses where strategy returns a Spark token address

## Immediate next checks

1. confirm whether current canonical `sUSDC` and `sUSDS` implement ERC4626 / convertToAssets path the same way as old assumptions
2. identify SparkLend Gnosis addresses from docs or official config
3. search repo for any dependence on old `sp*` symbols before replacing registry

## Bottom line

The current Spark scanner is outdated.

It is not enough to patch `spark-sUSDC-refcode` alone.
We need to update Spark coverage around the current docs-defined product surface:
- canonical Savings tokens
- SparkLend network scope
- indirect Spark strategy classification
