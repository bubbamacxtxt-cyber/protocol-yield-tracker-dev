/**
 * Morpho exposure adapter (v2).
 *
 * Data source: Morpho REST `positions/earn` endpoint (the same one
 * morpho-scanner uses). For each user position it returns a `vault.exposure[]`
 * array with collateral → exposureUSD → exposurePercent already computed. We
 * just scale by the user's share and emit children. This handles both
 * Morpho V1 MetaMorpho vaults and V2 vaults (Sentora RLUSD Main, August AUSD
 * V2, etc.) through one code path.
 *
 * Cache key: wallet address. One REST call per wallet per refresh, shared
 * across all positions on that wallet.
 *
 * Fallback: if the REST endpoint doesn't return a vault matching this
 * position's supply token address, emit a shallow pool_share row keyed on
 * the loan asset.
 */

const MORPHO_REST = 'https://app.morpho.org/api';
const ALL_CHAINS = [1, 8453, 42161, 137, 130, 747474, 999, 10, 143, 988, 480, 5000, 146, 56];

const CHAIN_NAMES = {
  1: 'eth', 8453: 'base', 42161: 'arb', 137: 'poly', 10: 'opt', 5000: 'mnt',
  146: 'sonic', 130: 'uni', 747474: 'wct', 143: 'monad', 999: 'ink', 56: 'bsc',
};

async function fetchBlueMarket(uniqueKey, chainId, cache) {
  const key = `morpho:blue:${chainId}:${uniqueKey}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const q = `{ marketByUniqueKey(uniqueKey: "${uniqueKey}", chainId: ${chainId}) { uniqueKey collateralAsset { symbol address } loanAsset { symbol address } state { supplyAssetsUsd borrowAssetsUsd collateralAssetsUsd utilization } } }`;
  try {
    const res = await fetch('https://app.morpho.org/api/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    if (!res.ok) { cache.set(key, null); return null; }
    const data = await res.json();
    const market = data?.data?.marketByUniqueKey || null;
    cache.set(key, market);
    return market;
  } catch {
    cache.set(key, null);
    return null;
  }
}

async function tryMorphoBlueByIndex(position, ctx) {
  // position_index = "<wallet>|<chain>|<loanAddr>|<uniqueKey>"
  const parts = String(position.position_index || '').split('|');
  const uniqueKey = parts[3];
  if (!uniqueKey || !/^0x[0-9a-f]{64}$/i.test(uniqueKey)) return null;
  const chainId = {
    eth: 1, base: 8453, arb: 42161, poly: 137, opt: 10, mnt: 5000,
    uni: 130, wct: 747474, ink: 999, monad: 143, bsc: 56,
  }[position.chain];
  if (!chainId) return null;

  const market = await fetchBlueMarket(uniqueKey, chainId, ctx.cache);
  if (!market) return null;

  // This is an isolated market — the user supplies collateral and borrows
  // loanAsset. Secondary risk on the supply side = the collateral they posted
  // (explicit, no pro-rata). We emit two children: the primary collateral and
  // the loan-asset exposure (for the borrow leg). Root row carries the market
  // total supply/borrow + utilization.
  const tokens = ctx.loadTokens(position.id);
  const supplyTokens = tokens.filter(t => t.role === 'supply');
  const borrowTokens = tokens.filter(t => t.role === 'borrow');

  // Net-basis: legs sum to position.net_usd. Isolated market so single leg
  // covers 100% of user exposure (their collateral balance is what they owe
  // pro-rata exposure to).
  const children = [];
  const userNetUsd = Number(position.net_usd || 0);
  for (const t of supplyTokens) {
    children.push({
      kind: 'primary_asset',
      venue: `Morpho Blue ${market.collateralAsset?.symbol || 'mkt'}/${market.loanAsset?.symbol || '?'}`,
      venue_address: uniqueKey,
      chain: position.chain,
      asset_symbol: t.real_symbol || t.symbol,
      asset_address: t.address,
      usd: userNetUsd,
      pct_of_parent: 100,
      source: 'subgraph',
      confidence: 'high',
      evidence: {
        isolated_market: true,
        role: 'collateral',
        pool_reserve_total_supply_usd: Number(market.state?.collateralAssetsUsd || 0),
        is_collateral: true,
        is_borrowable: false,
        user_supply_usd: Number(t.value_usd || 0),
      },
    });
  }

  return [{
    kind: 'market_exposure',
    venue: `Morpho Blue ${market.collateralAsset?.symbol || '?'}/${market.loanAsset?.symbol || '?'}`,
    venue_address: uniqueKey,
    chain: position.chain,
    asset_symbol: `${market.collateralAsset?.symbol || '?'} / ${market.loanAsset?.symbol || '?'}`,
    asset_address: market.collateralAsset?.address || null,
    usd: position.net_usd,
    utilization: market.state?.utilization ?? null,
    source: 'subgraph',
    confidence: 'high',
    as_of: ctx.now,
    evidence: {
      layout: 'isolated_market',
      strategy: position.strategy || 'lend',
      blue_market: true,
      unique_key: uniqueKey,
      pool_tvl_usd: Number(market.state?.supplyAssetsUsd || 0),
      pool_total_borrow_usd: Number(market.state?.borrowAssetsUsd || 0),
      pool_collateral_usd: Number(market.state?.collateralAssetsUsd || 0),
      pool_available_usd: Math.max(0, Number(market.state?.supplyAssetsUsd || 0) - Number(market.state?.borrowAssetsUsd || 0)),
      pool_utilization: market.state?.utilization ?? 0,
      collateral_symbol: market.collateralAsset?.symbol,
      loan_symbol: market.loanAsset?.symbol,
      user_borrowed_usd: borrowTokens.reduce((s, t) => s + (t.value_usd || 0), 0),
      user_net_usd: position.net_usd,
      wallet: position.wallet,
    },
    children,
  }];
}

async function fetchMarketsForLoanAsset(loanAssetAddress, chainId, cache) {
  // v2 MetaMorpho vaults aren't indexed by `vaultByAddress`, but per-market
  // state is still available via the `markets()` query filtered by loan
  // asset. Multiple sub-markets can share the same (loan, collateral) pair
  // with different oracle/irm/lltv, so we aggregate by collateral address.
  const key = `morpho:marketsbyloan:${chainId}:${String(loanAssetAddress).toLowerCase()}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const q = `{ markets(first: 100, where: { loanAssetAddress_in: ["${loanAssetAddress}"], chainId_in: [${chainId}] }) {
    items {
      uniqueKey
      collateralAsset { symbol address }
      loanAsset { symbol address }
      state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization }
    }
  } }`;
  try {
    const res = await fetch('https://app.morpho.org/api/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    if (!res.ok) { cache.set(key, null); return null; }
    const data = await res.json();
    const markets = data?.data?.markets?.items || [];
    const byCol = new Map();
    for (const m of markets) {
      const col = String(m.collateralAsset?.address || '').toLowerCase() || '_idle';
      const prev = byCol.get(col) || {
        collateral_symbol: m.collateralAsset?.symbol || 'Idle',
        collateral_address: m.collateralAsset?.address || null,
        loan_symbol: m.loanAsset?.symbol,
        supplyAssetsUsd: 0,
        borrowAssetsUsd: 0,
        market_count: 0,
      };
      prev.supplyAssetsUsd += Number(m.state?.supplyAssetsUsd || 0);
      prev.borrowAssetsUsd += Number(m.state?.borrowAssetsUsd || 0);
      prev.market_count++;
      byCol.set(col, prev);
    }
    cache.set(key, byCol);
    return byCol;
  } catch {
    cache.set(key, null);
    return null;
  }
}

async function fetchVaultAllocations(vaultAddress, chainId, cache) {
  // Try GraphQL vaultByAddress for per-market state (v1 MetaMorpho vaults).
  // Returns null for v2 vaults the subgraph doesn't index.
  const key = `morpho:gqlvault:${chainId}:${vaultAddress.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const q = `{ vaultByAddress(address: "${vaultAddress}", chainId: ${chainId}) {
    state {
      totalAssetsUsd
      allocation {
        supplyAssetsUsd
        market {
          uniqueKey
          collateralAsset { symbol address }
          loanAsset { symbol address }
          state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization }
        }
      }
    }
  } }`;
  try {
    const res = await fetch('https://app.morpho.org/api/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    if (!res.ok) { cache.set(key, null); return null; }
    const data = await res.json();
    const out = data?.data?.vaultByAddress?.state || null;
    cache.set(key, out);
    return out;
  } catch {
    cache.set(key, null);
    return null;
  }
}

async function fetchEarn(wallet, cache) {
  const key = `morpho:earn:${wallet.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const url = `${MORPHO_REST}/positions/earn?userAddress=${wallet}&limit=500&skip=0&chainIds=${ALL_CHAINS.join(',')}&orderBy=assetsUsd&orderDirection=DESC`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      cache.set(key, []);
      return [];
    }
    const data = await res.json();
    const items = data.items || [];
    cache.set(key, items);
    return items;
  } catch {
    cache.set(key, []);
    return [];
  }
}

module.exports = {
  id: 'morpho',
  protocol_names: ['Morpho'],
  protocol_canonicals: ['morpho', 'morpho-blue', 'morpho-v2'],
  confidence: 'high',
  references: ['https://app.morpho.org/api/positions/earn'],
  async compute(position, ctx) {
    const items = await fetchEarn(position.wallet, ctx.cache);

    // Match: same chain as position, same supply token address (which in our
    // morpho scanner output is the vault address).
    const tokens = ctx.loadTokens(position.id).filter(t => t.role === 'supply');
    const supplyAddr = (tokens[0]?.address || '').toLowerCase();
    const match = items.find(it => {
      const va = String(it.vault?.address || '').toLowerCase();
      const chainName = CHAIN_NAMES[it.vault?.chainId];
      return va && va === supplyAddr && chainName === position.chain;
    }) || items.find(it => {
      // Fallback: match by chain + asset symbol when address doesn't line up
      const chainName = CHAIN_NAMES[it.vault?.chainId];
      const assetSym = (it.vault?.asset?.symbol || '').toLowerCase();
      const suppliedSym = (tokens[0]?.real_symbol || tokens[0]?.symbol || '').toLowerCase();
      return chainName === position.chain && assetSym === suppliedSym &&
             Math.abs(Number(it.assetsUsd || 0) - position.net_usd) / position.net_usd < 0.1;
    });

    if (!match) {
      // No matching earn item — could be a Morpho Blue direct borrow position.
      // The position_index has the form "<wallet>|<chain>|<loanAssetAddr>|<uniqueKey>"
      // where uniqueKey is the 32-byte Blue market id. If present, resolve the
      // market via GraphQL and decompose as an isolated (collateral / loan)
      // market_exposure row — the whale has a direct loan against one collateral,
      // so secondary risk is just that collateral.
      const blueRows = await tryMorphoBlueByIndex(position, ctx);
      if (blueRows) return blueRows;

      return [{
        kind: 'pool_share',
        venue: 'Morpho',
        chain: position.chain,
        asset_symbol: tokens[0]?.real_symbol || tokens[0]?.symbol,
        asset_address: tokens[0]?.address,
        usd: position.net_usd,
        source: 'protocol-api',
        confidence: 'low',
        evidence: {
          shallow: true,
          reason: 'no matching Morpho earn item for this wallet/chain/token',
          wallet: position.wallet,
          earn_items_returned: items.length,
        },
      }];
    }

    const vault = match.vault || {};
    const userUsd = Number(match.assetsUsd || position.net_usd);
    const vaultTotalUsd = Number(vault.totalAssetsUsd || 0);
    const sharePct = vaultTotalUsd > 0 ? (userUsd / vaultTotalUsd) * 100 : null;

    // MetaMorpho vaults are supply aggregators. Each allocation is a
    // Morpho Blue market (collateral / loan pair) the vault supplies into.
    // For v1 vaults we can query GraphQL for per-market state (supply,
    // borrow, utilization). For v2 vaults GraphQL doesn't index them, so we
    // fall back to REST's supply-only `exposure[]`.
    //
    // Net-basis: legs sum to userUsd. The "borrowable" column in the UI is
    // derived from per-market state when we have it.
    const chainIdFromVault = Number(match.vault?.chainId || 0) || { eth: 1, base: 8453, arb: 42161, poly: 137, opt: 10, mnt: 5000, uni: 130, wct: 747474, ink: 999, monad: 143, bsc: 56 }[position.chain];
    const gqlState = chainIdFromVault ? await fetchVaultAllocations(vault.address, chainIdFromVault, ctx.cache) : null;

    let children = [];
    let totalBorrowUsd = 0;

    if (gqlState && Array.isArray(gqlState.allocation) && gqlState.allocation.length) {
      // v1 path: real per-market state from GraphQL.
      const totalVaultSupply = Number(gqlState.totalAssetsUsd || 0) || vaultTotalUsd;
      for (const a of gqlState.allocation) {
        const marketSupplyInVault = Number(a.supplyAssetsUsd || 0);
        if (marketSupplyInVault <= 0) continue;
        const m = a.market || {};
        const mState = m.state || {};
        const col = m.collateralAsset?.symbol || 'Idle';
        const colAddr = m.collateralAsset?.address || null;
        const loanSym = m.loanAsset?.symbol || vault.asset?.symbol || '?';
        const isIdle = !m.collateralAsset;
        const compositionPct = totalVaultSupply > 0 ? marketSupplyInVault / totalVaultSupply : 0;
        const userExposureUsd = userUsd * compositionPct;
        const marketSupply = Number(mState.supplyAssetsUsd || 0);
        const marketBorrow = Number(mState.borrowAssetsUsd || 0);
        const marketAvailable = Math.max(0, marketSupply - marketBorrow);
        // Attribute vault-proportional share of market borrow to this allocation
        const vaultShareOfMarket = marketSupply > 0 ? marketSupplyInVault / marketSupply : 0;
        totalBorrowUsd += marketBorrow * vaultShareOfMarket;
        children.push({
          kind: isIdle ? 'primary_asset' : 'market_exposure',
          venue: `Morpho ${vault.name || vault.symbol}`,
          venue_address: m.uniqueKey || vault.address,
          chain: position.chain,
          asset_symbol: isIdle ? loanSym : `${col} / ${loanSym}`,
          asset_address: colAddr,
          usd: userExposureUsd,
          pct_of_parent: compositionPct * 100,
          source: 'subgraph',
          confidence: 'high',
          as_of: ctx.now,
          evidence: {
            market_unique_key: m.uniqueKey,
            collateral_symbol: col,
            collateral_address: colAddr,
            loan_symbol: loanSym,
            pool_reserve_total_supply_usd: marketSupply,
            pool_reserve_total_borrow_usd: marketBorrow,
            pool_reserve_available_usd: marketAvailable,
            market_utilization: Number(mState.utilization || 0),
            vault_allocation_usd: marketSupplyInVault,
            is_collateral: !isIdle,
            is_borrowable: false,   // markets are allocations, not borrowable from the vault
            is_idle: isIdle,
          },
        });
      }
    } else {
      // v2 path: combine REST exposure (per-collateral USD in vault) with
      // subgraph markets() query filtered by loan asset (per-market state).
      const exposures = Array.isArray(vault.exposure) ? vault.exposure : [];
      const loanAsset = vault.asset?.address;
      const marketsByCol = (loanAsset && chainIdFromVault)
        ? await fetchMarketsForLoanAsset(loanAsset, chainIdFromVault, ctx.cache)
        : null;

      children = exposures
        .filter(e => Number(e.exposureUSD || 0) > 0)
        .map(e => {
          const isIdle = !e.collateralAsset;
          const collSym = e.collateralAsset?.symbol || 'Idle';
          const collAddr = e.collateralAsset?.address || null;
          const collKey = collAddr ? String(collAddr).toLowerCase() : '_idle';
          const compositionPct = Number(e.exposurePercent || 0);
          const userExposureUsd = userUsd * compositionPct;
          const userSupplyInMarket = Number(e.exposureUSD);
          const marketAgg = marketsByCol ? marketsByCol.get(collKey) : null;
          const marketSupply = marketAgg ? marketAgg.supplyAssetsUsd : 0;
          const marketBorrow = marketAgg ? marketAgg.borrowAssetsUsd : 0;
          const marketAvailable = Math.max(0, marketSupply - marketBorrow);
          const util = marketSupply > 0 ? marketBorrow / marketSupply : 0;
          return {
            kind: isIdle ? 'primary_asset' : 'market_exposure',
            venue: `Morpho ${vault.name || vault.symbol}`,
            venue_address: vault.address,
            chain: position.chain,
            asset_symbol: isIdle ? vault.asset?.symbol : `${collSym} / ${vault.asset?.symbol}`,
            asset_address: collAddr,
            usd: userExposureUsd,
            pct_of_parent: compositionPct * 100,
            source: marketAgg ? 'subgraph' : 'protocol-api',
            confidence: 'high',
            as_of: ctx.now,
            evidence: {
              collateral_symbol: collSym,
              collateral_address: collAddr,
              pool_reserve_total_supply_usd: marketSupply || userSupplyInMarket,
              pool_reserve_total_borrow_usd: marketBorrow,
              pool_reserve_available_usd: marketAvailable,
              market_utilization: util,
              market_count: marketAgg ? marketAgg.market_count : 0,
              vault_allocation_usd: userSupplyInMarket,
              is_collateral: !isIdle,
              is_borrowable: false,
              is_idle: isIdle,
            },
          };
        });
      // Vault-level total borrow from market aggregates:
      // for each exposure, the vault holds a fraction of that market's supply,
      // so is on the hook for that fraction of that market's borrow.
      if (marketsByCol) {
        totalBorrowUsd = 0;
        for (const e of exposures) {
          const collKey = String(e.collateralAsset?.address || '').toLowerCase() || '_idle';
          const marketAgg = marketsByCol.get(collKey);
          if (!marketAgg || !marketAgg.supplyAssetsUsd) continue;
          const shareOfMarket = Math.min(1, Number(e.exposureUSD) / marketAgg.supplyAssetsUsd);
          totalBorrowUsd += marketAgg.borrowAssetsUsd * shareOfMarket;
        }
      }
    }

    return [{
      kind: 'pool_share',
      venue: `Morpho ${vault.name || vault.symbol || 'vault'}`,
      venue_address: vault.address,
      chain: position.chain,
      asset_symbol: vault.asset?.symbol,
      asset_address: vault.asset?.address,
      usd: userUsd,
      source: 'protocol-api',
      confidence: 'high',
      as_of: ctx.now,
      evidence: {
        layout: 'metamorpho_vault',
        strategy: position.strategy || 'lend',
        vault_name: vault.name,
        vault_symbol: vault.symbol,
        vault_version: vault.version,
        pool_tvl_usd: vaultTotalUsd,
        pool_total_borrow_usd: totalBorrowUsd,
        pool_available_usd: Math.max(0, vaultTotalUsd - totalBorrowUsd),
        pool_utilization: vaultTotalUsd > 0 ? totalBorrowUsd / vaultTotalUsd : 0,
        user_share_pct: sharePct,
        user_net_usd: userUsd,
        wallet: position.wallet,
        exposure_count: children.length,
        allocation_source: (gqlState && gqlState.allocation?.length) ? 'graphql' : 'rest',
        has_per_market_state: Boolean(gqlState && gqlState.allocation?.length),
      },
      children,
    }];
  },
};
