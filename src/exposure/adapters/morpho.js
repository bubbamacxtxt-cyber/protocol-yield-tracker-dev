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

    // Net-basis lens: legs sum to userUsd (the whale's actual deposit into
    // this vault). `exposurePercent` from Morpho is already a fraction of
    // vault total, so leg.usd = userUsd * exposurePercent. Vault TVL is
    // promoted to root evidence for the UI.
    const exposures = Array.isArray(vault.exposure) ? vault.exposure : [];
    const children = exposures
      .filter(e => Number(e.exposureUSD || 0) > 0)
      .map(e => {
        const isIdle = !e.collateralAsset;
        const collSym = e.collateralAsset?.symbol || 'Idle';
        const collAddr = e.collateralAsset?.address || null;
        const compositionPct = Number(e.exposurePercent || 0);
        const userExposureUsd = userUsd * compositionPct;
        return {
          kind: isIdle ? 'primary_asset' : 'market_exposure',
          venue: `Morpho ${vault.name || vault.symbol}`,
          venue_address: vault.address,
          chain: position.chain,
          asset_symbol: isIdle ? vault.asset?.symbol : `${collSym} / ${vault.asset?.symbol}`,
          asset_address: collAddr,
          usd: userExposureUsd,
          pct_of_parent: compositionPct * 100,
          source: 'protocol-api',
          confidence: 'high',
          as_of: ctx.now,
          evidence: {
            collateral_symbol: collSym,
            collateral_address: collAddr,
            pool_reserve_total_supply_usd: Number(e.exposureUSD),
            is_collateral: !isIdle,
            is_borrowable: false, // MetaMorpho markets are isolated; loan side is just the vault asset
            is_idle: isIdle,
          },
        };
      });

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
        pool_total_borrow_usd: 0, // MetaMorpho vaults don't borrow; suppliers own the full asset side
        pool_available_usd: vaultTotalUsd,
        pool_utilization: 0,
        user_share_pct: sharePct,
        user_net_usd: userUsd,
        wallet: position.wallet,
        exposure_count: children.length,
      },
      children,
    }];
  },
};
