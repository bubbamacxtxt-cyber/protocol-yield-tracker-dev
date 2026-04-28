/**
 * Curve LP adapter.
 *
 * A Curve LP share is a pro-rata claim on every token in the pool. We already
 * have scanner output in `position_tokens` with role='supply' split across
 * each underlying. So we can emit lp_underlying rows directly from that,
 * with high confidence (scanner writes scaled USD per leg).
 */

module.exports = {
  id: 'curve',
  protocol_names: ['Curve'],
  protocol_canonicals: ['curve'],
  confidence: 'high',
  references: ['https://curve.fi/'],
  async compute(position, ctx) {
    const tokens = ctx.loadTokens(position.id).filter(t => t.role === 'supply');
    const total = tokens.reduce((s, t) => s + (t.value_usd || 0), 0) || position.net_usd;
    // Extract Curve pool address from scanner-set position_index:
    //   '<chain>:curve:lp:0xPOOL'  or  '<chain>:curve:gauge:0xPOOL'
    const poolAddr = (String(position.position_index || '').match(/0x[a-fA-F0-9]{40}/) || [])[0] || null;
    if (!tokens.length) {
      return [{
        kind: 'lp_underlying',
        venue: 'Curve',
        venue_address: poolAddr,
        chain: position.chain,
        usd: position.net_usd,
        source: 'onchain',
        confidence: 'medium',
        evidence: { shallow: true, reason: 'Curve LP with no per-leg scanner output' },
      }];
    }
    // Wrap in a root pool_share so layout metadata travels with the row set.
    return [{
      kind: 'pool_share',
      venue: 'Curve',
      venue_address: poolAddr,
      chain: position.chain,
      asset_symbol: tokens[0]?.real_symbol || tokens[0]?.symbol,
      asset_address: tokens[0]?.address,
      usd: position.net_usd,
      source: 'onchain',
      confidence: 'high',
      as_of: ctx.now,
      evidence: {
        layout: 'lp_pool',
        strategy: position.strategy || 'lp',
        leg_count: tokens.length,
        user_net_usd: position.net_usd,
        wallet: position.wallet,
      },
      children: tokens.map(t => ({
        kind: 'lp_underlying',
        venue: 'Curve',
        venue_address: poolAddr,
        chain: position.chain,
        asset_symbol: t.real_symbol || t.symbol,
        asset_address: t.address,
        usd: t.value_usd || 0,
        pct_of_parent: total > 0 ? ((t.value_usd || 0) / total) * 100 : null,
        source: 'onchain',
        confidence: 'high',
        evidence: {
          curve_leg: true,
          pool_reserve_total_supply_usd: t.value_usd || 0,
          is_collateral: true,
          is_borrowable: false,
        },
      })),
    }];
  },
};
