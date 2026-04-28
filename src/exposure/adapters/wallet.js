/**
 * Wallet holds adapter.
 *
 * A plain token sitting in a wallet is a primary exposure to that token. If
 * it's a yield-bearing stable (sUSDe, sUSDS, stcUSD, etc.), the orchestrator
 * will (in future) let us recurse via a companion YBS adapter. For now we
 * emit the top-level token exposure; the YBS recursion layer can attach
 * children later using this row's asset_address.
 */

const { primaryAssetRow } = require('./_base');

module.exports = {
  id: 'wallet',
  protocol_names: ['Wallet'],
  protocol_canonicals: ['wallet', 'wallet-held'],
  confidence: 'high',
  references: [],
  async compute(position, ctx) {
    const tokens = ctx.loadTokens(position.id).filter(t => (t.role === 'supply'));
    const total = tokens.reduce((s, t) => s + (t.value_usd || 0), 0) || position.net_usd;

    const children = tokens.length
      ? tokens.map(t => ({
          ...primaryAssetRow({
            symbol: t.real_symbol || t.symbol,
            address: t.address,
            chain: position.chain,
            usd: t.value_usd || 0,
            pct: total > 0 ? ((t.value_usd || 0) / total) * 100 : null,
          }),
          evidence: { is_collateral: false, is_borrowable: false, wallet_hold: true },
        }))
      : [{
          ...primaryAssetRow({
            symbol: position.yield_source || position.protocol_name,
            chain: position.chain,
            usd: position.net_usd,
          }),
          evidence: { is_collateral: false, is_borrowable: false, wallet_hold: true },
        }];

    // For wallet holds, the "venue_address" is the token contract itself.
    const tokenAddr = tokens[0]?.address
      || (String(position.position_index || '').match(/0x[a-fA-F0-9]{40}/) || [])[0]
      || null;

    return [{
      kind: 'pool_share',
      venue: 'Wallet hold',
      venue_address: tokenAddr,
      chain: position.chain,
      asset_symbol: tokens[0]?.real_symbol || tokens[0]?.symbol || position.protocol_name,
      asset_address: tokens[0]?.address,
      usd: position.net_usd,
      source: 'onchain',
      confidence: 'high',
      as_of: ctx.now,
      evidence: {
        layout: 'wallet_hold',
        strategy: 'hold',
        leg_count: children.length,
        user_net_usd: position.net_usd,
        wallet: position.wallet,
      },
      children,
    }];
  },
};
