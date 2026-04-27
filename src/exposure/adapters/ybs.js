/**
 * Yield-Bearing Stable (YBS) adapter.
 *
 * Strategy:
 *   1. Primary source: DeFiLlama `api.llama.fi/protocol/<slug>` returns
 *      `tokensInUsd[]` \u2014 a time series where the last entry gives current
 *      token composition of the protocol's TVL. This covers every major YBS
 *      (Ethena, Cap, yoUSD, InfiniFi, Sky, usd-ai) with consistent shape,
 *      refreshed daily by DeFiLlama.
 *   2. Per-token protocol_name \u2192 llama slug map.
 *   3. Cache in memory per run + persist to ybs_backing_cache so next run has
 *      a fallback if the endpoint is briefly down.
 *   4. Staleness threshold: 72h on cached data, else confidence=low.
 *
 * Covered protocols and slugs:
 *   yoUSD        \u2192 yo-protocol
 *   Cap stcUSD   \u2192 cap-finance
 *   ethena-usde  \u2192 ethena
 *   infinifi     \u2192 infinifi
 *   Sky (sUSDS)  \u2192 sky
 *   usd-ai       \u2192 usd.ai    (may 400 \u2014 cache fallback kicks in)
 *   Yuzu Money   \u2192 yuzu-money
 *   yzUSDUSDT0   \u2192 yuzu-money (same parent protocol)
 *
 * Fallback path:
 *   If llama returns nothing for a slug, we still emit a single pool_share
 *   row for the primary supply token with `confidence='low'` so coverage is
 *   preserved and the audit flags it as needing attention.
 */

const { opaqueRow } = require('./_base');

const LLAMA_SLUGS = {
  // protocol_name (lowercased, trimmed)      \u2192 llama slug
  'yousd':              'yo-protocol',
  'cap':                'cap-finance',
  'cap stcusd':         'cap-finance',
  'ethena-usde':        'ethena',
  'ethena':             'ethena',
  'infinifi':           'infinifi',
  'infinifiusd autopool': 'infinifi',
  'sky':                'sky',
  'usd-ai':             'usd-ai',
  'yuzu money':         'yuzu-money',
  'yzusdusdt0':         'yuzu-money',
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
    .map(([symbol, usd]) => ({
      symbol,
      usd: Number(usd),
      pct: (Number(usd) / total) * 100,
    }))
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

function loadFromPersistentCache(db, slug) {
  const row = db.prepare('SELECT composition_json, fetched_at FROM ybs_backing_cache WHERE token_address = ? AND chain = ?')
    .get(`llama:${slug}`, 'global');
  if (!row) return null;
  try {
    return { composition: JSON.parse(row.composition_json), as_of: row.fetched_at, from_cache: true };
  } catch { return null; }
}

function saveToPersistentCache(db, slug, backing) {
  if (!backing || !backing.composition?.length) return;
  db.prepare(`INSERT INTO ybs_backing_cache (token_address, chain, composition_json, fetched_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(token_address, chain) DO UPDATE SET
              composition_json = excluded.composition_json,
              fetched_at = excluded.fetched_at`)
    .run(`llama:${slug}`, 'global', JSON.stringify(backing.composition), backing.as_of);
}

function resolveSlug(protocolName) {
  const key = String(protocolName || '').trim().toLowerCase();
  return LLAMA_SLUGS[key] || null;
}

function ageHours(isoString) {
  if (!isoString) return Infinity;
  return (Date.now() - new Date(isoString).getTime()) / 3600000;
}

module.exports = {
  id: 'ybs',
  protocol_names: [
    'yoUSD', 'Cap stcUSD', 'cap', 'Cap', 'ethena-usde', 'infinifi', 'InfiniFi',
    'infinifiUSD Autopool', 'Sky', 'usd-ai', 'Yuzu Money', 'yzUSDUSDT0',
  ],
  confidence: 'high',
  references: ['https://api.llama.fi/protocol/<slug>'],
  async compute(position, ctx) {
    const slug = resolveSlug(position.protocol_name);
    const tokens = ctx.loadTokens(position.id).filter(t => t.role === 'supply');
    const primary = tokens[0] || null;

    let backing = null;
    let source = 'protocol-api';
    let confidence = 'high';

    if (slug) {
      backing = await fetchLlamaBacking(slug, ctx.cache);
      if (backing) {
        saveToPersistentCache(ctx.db, slug, backing);
      } else {
        // Try persistent cache
        const cached = loadFromPersistentCache(ctx.db, slug);
        if (cached) {
          backing = cached;
          source = 'cached';
          const age = ageHours(cached.as_of);
          confidence = age < 24 ? 'high' : age < 72 ? 'medium' : 'low';
        }
      }
    }

    if (backing && backing.composition?.length) {
      const userUsd = position.net_usd;
      return [{
        kind: 'ybs_strategy',
        venue: position.protocol_name,
        asset_symbol: primary?.real_symbol || primary?.symbol,
        asset_address: primary?.address,
        chain: position.chain,
        usd: userUsd,
        source,
        confidence,
        as_of: backing.as_of,
        evidence: {
          llama_slug: slug,
          leg_count: backing.composition.length,
          total_protocol_tvl_usd: backing.total_usd,
          age_hours: ageHours(backing.as_of),
        },
        children: backing.composition.map(b => ({
          kind: 'ybs_strategy',
          venue: position.protocol_name,
          asset_symbol: b.symbol,
          chain: position.chain,
          usd: userUsd * (b.pct / 100),
          pct_of_parent: b.pct,
          source,
          confidence,
          as_of: backing.as_of,
          evidence: { protocol_tvl_in_asset_usd: b.usd },
        })),
      }];
    }

    // Final fallback: single pool_share row with low confidence so audit sees it.
    return [{
      kind: 'pool_share',
      venue: position.protocol_name,
      asset_symbol: primary?.real_symbol || primary?.symbol || position.protocol_name,
      asset_address: primary?.address,
      chain: position.chain,
      usd: position.net_usd,
      source: slug ? 'protocol-api' : 'manual',
      confidence: 'low',
      evidence: {
        shallow: true,
        reason: slug ? `DeFiLlama /protocol/${slug} returned no tokensInUsd` : 'no llama slug mapped for this protocol_name',
        slug,
      },
    }];
  },
};
