/**
 * Pendle adapter.
 *
 * PT  — redeems 1:1 to SY at maturity. Exposure = SY underlying.
 * YT  — claim on yield of SY. Exposure = SY underlying but labeled yield_only.
 * LP  — PT + SY pair. Split by pool reserves when scanner provides legs.
 *
 * Pendle fallback rows (protocol_id='pendle2' etc.) are already flagged
 * unresolved upstream; we emit a shallow unknown-ish row for them so they're
 * visible in the audit as "pendle position needing resolution".
 *
 * v1: use scanner-provided supply tokens as the exposure. If the supply
 * token is itself a known YBS (sUSDe, sUSDS, stcUSD, etc.), we mark it so
 * a future recursion pass can decompose it further.
 */

const YBS_TOKENS_BY_SYMBOL = new Set([
  'susde', 'usde', 'susds', 'susdc', 'stcusd', 'yousd', 'iusd', 'susdai',
]);

function isYbsSymbol(sym) {
  return sym && YBS_TOKENS_BY_SYMBOL.has(String(sym).toLowerCase());
}

// Extract the underlying asset symbol from a Pendle PT/YT/LP token name.
// Examples: PT-sUSDE-18JUN2026 → sUSDE, PT-USDe-15JAN2026 → USDe, LP-sUSDE-xxx → sUSDE
function extractUnderlyingSym(symbol) {
  if (!symbol) return null;
  const s = String(symbol);
  const m = s.match(/^(?:PT|YT|LP)-([^-]+)(?:-|$)/i);
  if (m) return m[1];
  return s;
}

module.exports = {
  id: 'pendle',
  protocol_names: ['Pendle', 'Pendle Fallback'],
  protocol_canonicals: ['pendle'],
  confidence: 'high',
  references: ['https://app.pendle.finance/'],
  async compute(position, ctx) {
    const tokens = ctx.loadTokens(position.id).filter(t => t.role === 'supply');
    const total = tokens.reduce((s, t) => s + (t.value_usd || 0), 0) || position.net_usd;

    const strategy = String(position.strategy || '').toLowerCase();
    const yieldOnly = strategy.includes('yt') || strategy.includes('yield');
    // Pendle market / PT token address from position_index or the supply token
    const marketAddr = (String(position.position_index || '').match(/0x[a-fA-F0-9]{40}/) || [])[0]
      || tokens[0]?.address
      || null;

    if (!tokens.length) {
      return [{
        kind: 'pendle_underlying',
        venue: position.protocol_name,
        venue_address: marketAddr,
        chain: position.chain,
        usd: position.net_usd,
        source: 'subgraph',
        confidence: 'medium',
        evidence: { shallow: true, reason: 'pendle position has no supply tokens', yield_only: yieldOnly, strategy },
      }];
    }

    return [{
      kind: 'pool_share',
      venue: position.protocol_name,
      venue_address: marketAddr,
      chain: position.chain,
      asset_symbol: tokens[0]?.real_symbol || tokens[0]?.symbol,
      asset_address: tokens[0]?.address,
      usd: position.net_usd,
      source: 'subgraph',
      confidence: 'high',
      as_of: ctx.now,
      evidence: {
        layout: 'pendle',
        strategy: position.strategy || 'farm',
        yield_only: yieldOnly,
        leg_count: tokens.length,
        user_net_usd: position.net_usd,
        wallet: position.wallet,
      },
      children: tokens.map(t => {
        const ptSym = t.real_symbol || t.symbol;
        const underlyingSym = extractUnderlyingSym(ptSym);
        const recursesToYbs = isYbsSymbol(underlyingSym);
        return {
          kind: recursesToYbs ? 'pendle_underlying' : 'primary_asset',
          venue: position.protocol_name,
          chain: position.chain,
          asset_symbol: underlyingSym,
          asset_address: t.address,
          usd: t.value_usd || 0,
          pct_of_parent: total > 0 ? ((t.value_usd || 0) / total) * 100 : null,
          source: 'subgraph',
          confidence: 'high',
          evidence: {
            original_pt_symbol: ptSym,
            strategy,
            yield_only: yieldOnly,
            redeems_to: underlyingSym,
            recurses_to_ybs: recursesToYbs,
            pool_reserve_total_supply_usd: t.value_usd || 0,
            is_collateral: true,
            is_borrowable: false,
          },
        };
      }),
    }];
  },
};
