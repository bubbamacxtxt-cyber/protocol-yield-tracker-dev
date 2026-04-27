/**
 * Aave V3 + Spark exposure adapter.
 *
 * Shallow lens (Phase 2 of rollout): for each Aave position, emit pool_share
 * rows representing every reserve in that market + a market_exposure row for
 * the loan asset itself. This shows "your money sits in a pool that also
 * accepts these other collaterals." Borrowers can draw against any of them,
 * so all co-deposited reserves are secondary risk.
 *
 * Deep lens (future): per-borrower collateral mix via subgraph. Builds on
 * this adapter's reserve fetch; caches borrower mix at (market, loanAsset)
 * keys in borrower_mix_cache. Deep build is a separate PR.
 *
 * Data source: Aave v3 GraphQL (api.v3.aave.com). Same endpoint the aave
 * scanner uses. We re-query market reserves once per (chainId, marketAddress)
 * per run, keyed in ctx.cache.
 */

const AAVE_GRAPHQL = 'https://api.v3.aave.com/graphql';

const CHAIN_NAMES = {
  1: 'eth', 8453: 'base', 42161: 'arb', 5000: 'mnt', 9745: 'plasma',
  999: 'ink', 146: 'sonic', 137: 'poly', 10: 'opt',
};
const NAME_TO_CHAIN = Object.fromEntries(Object.entries(CHAIN_NAMES).map(([k,v]) => [v, Number(k)]));

// Aave v3 markets per chain (see src/aave-scanner.js MARKETS + Spark)
const MARKETS = {
  1: [
    '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', // Main
    '0x0AA97c284e98396202b6A04024F5E2c65026F3c0', // EtherFi
    '0x4e033931ad43597d96D6bcc25c280717730B58B1', // Prime
    '0xAe05Cd22df81871bc7cC2a04BeCfb516bFe332C8', // Lido
  ],
  8453:  ['0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'],
  42161: ['0x794a61358D6845594F94dc1DB02A252b5b4814aD'],
  5000:  ['0x458F293454fE0d67EC0655f3672301301DD51422'],
  9745:  ['0x925a2A7214Ed92428B5b1B090F80b25700095e12'],
  999:   ['0x5362dBb1e601AbF2a150D1999Be54a4d308f4F6e'],
};

async function gql(query) {
  const res = await fetch(AAVE_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Aave GraphQL HTTP ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(`Aave GraphQL: ${JSON.stringify(data.errors).slice(0, 300)}`);
  return data.data || {};
}

async function getMarketReserves(chainId, marketAddress, cache) {
  const key = `aave:reserves:${chainId}:${marketAddress.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached) return cached;
  try {
    const q = `{ market(request: { address: "${marketAddress}", chainId: ${chainId} }) { reserves { underlyingToken { symbol address } size { amount { value } usd } borrowInfo { total { usd } utilizationRate { value } } supplyInfo { canBeCollateral } isFrozen isPaused } } }`;
    const data = await gql(q);
    const reserves = (data?.market?.reserves || []).map(r => ({
      symbol: r.underlyingToken?.symbol || null,
      address: r.underlyingToken?.address || null,
      supplyUsd: Number(r.size?.usd || 0),
      borrowUsd: Number(r.borrowInfo?.total?.usd || 0),
      collateralEnabled: r.supplyInfo?.canBeCollateral !== false,
      utilization: r.borrowInfo?.utilizationRate?.value != null ? Number(r.borrowInfo.utilizationRate.value) : null,
      isFrozen: !!r.isFrozen,
      isPaused: !!r.isPaused,
    }));
    cache.set(key, reserves);
    return reserves;
  } catch (err) {
    cache.set(key, []); // don't hammer on failure
    throw err;
  }
}

function pickMarketForWallet(chain, wallet, suppliedAsset, reserveCache) {
  // Aave v3 on Ethereum has several markets (Main, EtherFi, Prime, Lido).
  // A position can only live in one. We pick the market whose reserve list
  // contains the supplied asset. If multiple match (unlikely) we take the
  // one with the largest matching reserve. Scanner already resolved this —
  // but we need to re-resolve here independently because we pull a whole
  // market's reserve set, not per-user data.
  const chainId = NAME_TO_CHAIN[chain];
  if (!chainId) return null;
  const markets = MARKETS[chainId] || [];
  if (!markets.length) return null;
  if (markets.length === 1) return { chainId, marketAddress: markets[0] };

  const supplySym = String(suppliedAsset || '').toLowerCase();
  let best = null;
  for (const m of markets) {
    const reserves = reserveCache.get(`aave:reserves:${chainId}:${m.toLowerCase()}`);
    if (!reserves) continue; // not yet fetched
    const match = reserves.find(r => String(r.symbol || '').toLowerCase() === supplySym);
    if (match && (!best || match.supplyUsd > best.matchSize)) {
      best = { chainId, marketAddress: m, matchSize: match.supplyUsd };
    }
  }
  if (best) return { chainId: best.chainId, marketAddress: best.marketAddress };
  // Default to first market
  return { chainId, marketAddress: markets[0] };
}

async function resolveMarket(position, ctx) {
  const chainId = NAME_TO_CHAIN[position.chain];
  if (!chainId) return null;
  const markets = MARKETS[chainId] || [];
  if (!markets.length) return null;

  // Pre-warm all market reserves for this chain so pickMarketForWallet works.
  for (const m of markets) {
    const key = `aave:reserves:${chainId}:${m.toLowerCase()}`;
    if (!ctx.cache.get(key)) {
      try { await getMarketReserves(chainId, m, ctx.cache); } catch {}
    }
  }

  const supply = ctx.loadTokens(position.id).filter(t => t.role === 'supply');
  const suppliedSymbol = supply[0]?.real_symbol || supply[0]?.symbol;
  return pickMarketForWallet(position.chain, position.wallet, suppliedSymbol, ctx.cache);
}

module.exports = {
  id: 'aave',
  protocol_names: ['Aave V3', 'Aave V2'],
  protocol_canonicals: ['aave', 'aavev3'],
  confidence: 'high',
  references: ['https://api.v3.aave.com/graphql'],
  async compute(position, ctx) {
    const market = await resolveMarket(position, ctx);
    if (!market) throw new Error(`Aave: no market list for chain=${position.chain}`);
    const reserves = await getMarketReserves(market.chainId, market.marketAddress, ctx.cache);
    if (!reserves.length) throw new Error(`Aave: empty reserve set for ${market.chainId}:${market.marketAddress}`);

    const tokens = ctx.loadTokens(position.id);
    const supplyTokens = tokens.filter(t => t.role === 'supply');
    const userSupplyUsd = supplyTokens.reduce((s, t) => s + (t.value_usd || 0), 0);
    const suppliedSymbol = (supplyTokens[0]?.real_symbol || supplyTokens[0]?.symbol || '').toLowerCase();

    // Find the reserve our user supplied into to compute share
    const ourReserve = reserves.find(r => String(r.symbol || '').toLowerCase() === suppliedSymbol);
    const sharePct = ourReserve && ourReserve.supplyUsd > 0
      ? (userSupplyUsd / ourReserve.supplyUsd) * 100
      : null;

    // Net-basis secondary-exposure lens:
    //   pool_composition_pct[i] = reserve[i].supplyUsd / totalPoolSupplyUsd
    //   leg.usd = position.net_usd * pool_composition_pct[i]
    //
    // Percentages reflect actual pool composition. Leg USDs sum to
    // position.net_usd (not gross), matching Vercel/reservoir-monitor
    // behaviour. The raw pool USD per reserve is kept in evidence so the UI
    // can still show "Pool $" alongside "Your exposure $".
    const totalMarketSupply = reserves.reduce((s, r) => s + r.supplyUsd, 0);
    const totalMarketBorrow = reserves.reduce((s, r) => s + r.borrowUsd, 0);
    const userNetUsd = Number(position.net_usd || 0);

    const children = reserves
      .filter(r => r.supplyUsd > 0)
      .map(r => {
        const isPrimary = String(r.symbol || '').toLowerCase() === suppliedSymbol;
        const compositionPct = totalMarketSupply > 0 ? (r.supplyUsd / totalMarketSupply) : 0;
        const userExposureUsd = userNetUsd * compositionPct;
        return {
          kind: isPrimary ? 'primary_asset' : 'market_exposure',
          venue: `Aave V3 ${position.chain}`,
          venue_address: market.marketAddress,
          chain: position.chain,
          asset_symbol: r.symbol,
          asset_address: r.address,
          usd: userExposureUsd,
          pct_of_parent: compositionPct * 100,
          utilization: r.utilization != null ? r.utilization : (r.supplyUsd > 0 ? r.borrowUsd / r.supplyUsd : null),
          source: 'subgraph',
          confidence: 'high',
          evidence: {
            pool_reserve_total_supply_usd: r.supplyUsd,
            pool_reserve_total_borrow_usd: r.borrowUsd,
            pool_reserve_available_usd: Math.max(0, r.supplyUsd - r.borrowUsd),
            is_collateral: r.collateralEnabled === true,
            is_borrowable: r.isFrozen !== true && r.isPaused !== true && r.borrowUsd > 0,
            is_primary_asset: isPrimary,
            frozen: r.isFrozen,
            paused: r.isPaused,
          },
        };
      });

    return [{
      kind: 'pool_share',
      venue: `Aave V3 ${position.chain}`,
      venue_address: market.marketAddress,
      chain: position.chain,
      asset_symbol: supplyTokens[0]?.real_symbol || supplyTokens[0]?.symbol,
      usd: position.net_usd,
      utilization: totalMarketSupply > 0 ? totalMarketBorrow / totalMarketSupply : null,
      source: 'subgraph',
      confidence: 'high',
      as_of: ctx.now,
      evidence: {
        layout: 'lending_pool',
        strategy: position.strategy || 'lend',
        market_address: market.marketAddress,
        chain_id: market.chainId,
        user_net_usd: userNetUsd,
        user_supply_usd: userSupplyUsd,
        user_share_pct: sharePct,
        pool_tvl_usd: totalMarketSupply,
        pool_total_borrow_usd: totalMarketBorrow,
        pool_available_usd: Math.max(0, totalMarketSupply - totalMarketBorrow),
        pool_utilization: totalMarketSupply > 0 ? totalMarketBorrow / totalMarketSupply : 0,
        reserve_count: reserves.length,
        wallet: position.wallet,
      },
      children,
    }];
  },
};
