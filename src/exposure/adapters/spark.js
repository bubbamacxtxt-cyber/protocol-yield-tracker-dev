/**
 * Spark Savings adapter.
 *
 * Spark Savings sUSDS / sUSDC are ERC-4626 vaults that wrap Sky's DSR-style
 * savings rate. The underlying token (USDS or USDC) is the primary exposure.
 * Since Sky ultimately backs these via Maker PSM + RWAs, the deepest honest
 * decomposition is:
 *   sUSDS → USDS (wrapped DAI) → Sky protocol backing (via DeFiLlama)
 *   sUSDC → USDC (PSM-backed) → primary_asset
 *
 * Phase 1: emit a single primary_asset row for the underlying with high
 * confidence (the vault contract is a direct ERC-4626 claim on the
 * underlying). This correctly captures the user's exposure for the savings
 * product; the upstream Sky backing is a separate recursion that can be
 * added later.
 *
 * sGHO (GHO savings) is a similar product: GHO-wrapped savings.
 */

const UNDERLYING_MAP = {
  sUSDS: { symbol: 'USDS', address: null, chain: 'eth' },
  sUSDC: { symbol: 'USDC', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', chain: 'eth' },
  stUSDS: { symbol: 'USDS', address: null, chain: 'eth' },
  sGHO: { symbol: 'GHO', address: '0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f', chain: 'eth' },
};

module.exports = {
  id: 'spark',
  protocol_names: ['Spark', 'Spark Savings', 'Spark Savings Legacy', 'sGHO'],
  protocol_canonicals: ['spark'],
  confidence: 'high',
  references: ['https://docs.spark.fi/'],
  async compute(position, ctx) {
    const tokens = ctx.loadTokens(position.id).filter(t => t.role === 'supply');
    const primary = tokens[0] || null;
    const userUsd = position.net_usd;

    if (!primary) {
      return [{
        kind: 'pool_share',
        venue: position.protocol_name,
        chain: position.chain,
        usd: userUsd,
        source: 'onchain',
        confidence: 'medium',
        evidence: { shallow: true, reason: 'no supply token' },
      }];
    }

    const sym = primary.real_symbol || primary.symbol;
    const under = UNDERLYING_MAP[sym];

    return [{
      kind: 'pool_share',
      venue: position.protocol_name,
      venue_address: primary.address,
      chain: position.chain,
      asset_symbol: sym,
      asset_address: primary.address,
      usd: userUsd,
      source: 'onchain',
      confidence: 'high',
      as_of: ctx.now,
      evidence: {
        layout: 'erc4626_savings',
        strategy: position.strategy || 'stake',
        erc4626: true,
        share_symbol: sym,
        underlying: under?.symbol || '?',
        pool_tvl_usd: null,
        user_net_usd: userUsd,
        wallet: position.wallet,
      },
      children: [{
        kind: 'primary_asset',
        venue: position.protocol_name,
        chain: position.chain,
        asset_symbol: under?.symbol || sym,
        asset_address: under?.address || primary.address,
        usd: userUsd,
        pct_of_parent: 100,
        source: 'onchain',
        confidence: 'high',
        evidence: { share_to_asset_ratio: 'erc4626_direct', is_collateral: false, is_borrowable: false },
      }],
    }];
  },
};
