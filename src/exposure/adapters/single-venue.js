/**
 * Single-venue adapter — deep via DeFiLlama protocol composition.
 *
 * For protocols where we track a deposit on a specific venue (Dolomite,
 * Gearbox, Venus, Curvance, LFJ, STRATEGY, Yuzu Money, yzUSDUSDT0) we use
 * DeFiLlama's protocol-level token composition as the decomposition. This
 * gives us a weighted breakdown of the venue's TVL in terms of assets held.
 *
 * Same methodology as the YBS adapter — both share an underlying assumption:
 * the user's position is fungible with the protocol's pooled assets.
 *
 * For venues with no llama slug mapped, or where llama returns nothing, we
 * fall back to a shallow pool_share row with medium confidence.
 */

const LLAMA_SLUGS = {
  'dolomite':    'dolomite',
  'gearbox':     'gearbox',
  'curvance':    'curvance',
  'venus flux':  'venus-flux',
  'venus':       'venus-finance',
  'lfj':         'lfj',
  'yuzu money':  'yuzu-money',
  'yzusdusdt0':  'yuzu-money',
  'strategy':    null, // generic DeBank bucket — see handling below
  'ethena':      'ethena',
  'fusdc':       null,
  'yzusd':       'yuzu-money',
};

async function fetchJson(url, timeoutMs = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

async function fetchLlamaBacking(slug, cache) {
  const cacheKey = `llama:${slug}`;
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;

  const j = await fetchJson(`https://api.llama.fi/protocol/${slug}`);
  if (!j || !Array.isArray(j.tokensInUsd) || !j.tokensInUsd.length) {
    cache.set(cacheKey, null);
    return null;
  }
  const latest = j.tokensInUsd[j.tokensInUsd.length - 1];
  const tokens = latest.tokens || {};
  const total = Object.values(tokens).reduce((s, v) => s + Number(v || 0), 0);
  if (total <= 0) { cache.set(cacheKey, null); return null; }

  const composition = Object.entries(tokens)
    .filter(([, usd]) => Number(usd) > 0)
    .map(([symbol, usd]) => ({ symbol, usd: Number(usd), pct: (Number(usd) / total) * 100 }))
    .sort((a, b) => b.usd - a.usd);

  const backing = {
    as_of: new Date(latest.date * 1000).toISOString(),
    total_usd: total,
    composition,
    source_slug: slug,
  };
  cache.set(cacheKey, backing);
  return backing;
}

function resolveSlug(protocolName) {
  const key = String(protocolName || '').trim().toLowerCase();
  return LLAMA_SLUGS[key] || null;
}

module.exports = {
  id: 'single-venue',
  protocol_names: [
    'Dolomite', 'Gearbox', 'Curvance', 'Venus Flux', 'LFJ', 'STRATEGY',
    'Yuzu Money', 'yzUSDUSDT0', 'Ethena', 'fUSDC', 'yzUSD',
  ],
  // Also catch vault-probed positions regardless of the yield-source display name
  match(position) {
    const pid = String(position.protocol_id || '').toLowerCase();
    if (pid === 'vault-probed') return true;
    if (pid === 'ethena-cooldown') return true;
    return false;
  },
  confidence: 'high',
  references: ['https://api.llama.fi/protocol/<slug>'],
  async compute(position, ctx) {
    const tokens = ctx.loadTokens(position.id).filter(t => t.role === 'supply');
    const primary = tokens[0] || null;
    const userUsd = position.net_usd;
    const slug = resolveSlug(position.protocol_name);
    // Extract the on-chain contract address from scanner position_index.
    // Scanners store 'chain:probed:0xADDR', 'chain:wallet:0xADDR', or similar.
    const venueAddr = (String(position.position_index || '').match(/0x[a-fA-F0-9]{40}/) || [])[0]
      || primary?.address
      || null;

    if (slug) {
      const backing = await fetchLlamaBacking(slug, ctx.cache);
      if (backing && backing.composition?.length) {
        return [{
          kind: 'pool_share',
          venue: position.protocol_name,
          venue_address: venueAddr,
          chain: position.chain,
          asset_symbol: primary?.real_symbol || primary?.symbol,
          asset_address: primary?.address,
          usd: userUsd,
          source: 'protocol-api',
          confidence: 'high',
          as_of: backing.as_of,
          evidence: {
            layout: 'single_venue',
            strategy: position.strategy || 'lend',
            llama_slug: slug,
            pool_tvl_usd: backing.total_usd,
            pool_total_borrow_usd: 0,
            pool_available_usd: backing.total_usd,
            pool_utilization: 0,
            leg_count: backing.composition.length,
            user_net_usd: userUsd,
            wallet: position.wallet,
          },
          children: backing.composition.map(b => ({
            kind: 'market_exposure',
            venue: position.protocol_name,
            venue_address: venueAddr,
            chain: position.chain,
            asset_symbol: b.symbol,
            usd: userUsd * (b.pct / 100),
            pct_of_parent: b.pct,
            source: 'protocol-api',
            confidence: 'high',
            as_of: backing.as_of,
            evidence: {
              pool_reserve_total_supply_usd: b.usd,
              is_collateral: true,
              is_borrowable: false,
            },
          })),
        }];
      }
    }

    if (primary) {
      return [{
        kind: 'pool_share',
        venue: position.protocol_name,
        venue_address: venueAddr,
        chain: position.chain,
        asset_symbol: primary.real_symbol || primary.symbol,
        asset_address: primary.address,
        usd: primary.value_usd || userUsd,
        source: slug ? 'protocol-api' : 'onchain',
        confidence: 'high',
        as_of: ctx.now,
        evidence: {
          layout: 'single_asset',
          strategy: position.strategy || 'lend',
          single_asset_venue: true,
          reason: slug ? `DeFiLlama /protocol/${slug} returned no composition — denomination-only decomposition` : 'no llama slug mapped; denomination-only decomposition',
          slug,
          yield_source: position.yield_source,
          user_net_usd: userUsd,
          wallet: position.wallet,
        },
        children: [{
          kind: 'primary_asset',
          venue: position.protocol_name,
          venue_address: venueAddr,
          chain: position.chain,
          asset_symbol: primary.real_symbol || primary.symbol,
          asset_address: primary.address,
          usd: primary.value_usd || userUsd,
          pct_of_parent: 100,
          source: slug ? 'protocol-api' : 'onchain',
          confidence: 'high',
          evidence: { denomination_only: true, is_collateral: false, is_borrowable: false },
        }],
      }];
    }

    return [{
      kind: 'pool_share',
      venue: position.protocol_name,
      venue_address: venueAddr,
      chain: position.chain,
      usd: userUsd,
      source: 'manual',
      confidence: 'low',
      evidence: {
        layout: 'single_asset',
        strategy: position.strategy || 'lend',
        shallow: true,
        reason: 'no supply tokens and no llama slug',
        user_net_usd: userUsd,
        wallet: position.wallet,
      },
    }];
  },
};
