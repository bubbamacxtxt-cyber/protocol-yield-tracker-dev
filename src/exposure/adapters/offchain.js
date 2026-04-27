/**
 * Off-chain / opaque positions adapter.
 *
 * Covers:
 *   - Private Reinsurance Deals (Re Protocol) — counterparty basket
 *   - Fasanara mGLOBAL (GDADF), Genesis Fund, Digital — credit funds
 *   - Maple Institutional — private credit pool
 *   - RockawayX, Adaptive Frontier — funds
 *   - Cap stcUSD (manual-position variant; Cap-issued stable)
 *   - Deal IDs: MMZ*, HLF*, BYZ*, ICM*, SPR*, SPS* — reinsurance CUSIPs
 *   - Sky (manual-position path via Pareto)
 *
 * Strategy:
 *   For each position we know the *underlying denomination* (USDC, USDz,
 *   USDS, etc. — stored in position_tokens or the manual entry's `underlying`
 *   field). We emit a high-confidence `primary_asset` child pointing at that
 *   token, plus the root `opaque_offchain` row that carries the counterparty
 *   + attestation URL + maturity metadata.
 *
 *   This gives us *honest decomposition*: at the stable-level we know the
 *   exposure denomination with certainty. At the counterparty level we
 *   surface the opacity via evidence + attestation URL.
 */

const DEAL_PREFIX = /^(MMZ|HLF|BYZ|ICM|SPR|SPS)[A-Z0-9]+$/i;

const OPAQUE_MATCHERS = [
  { re: /^Private Reinsurance Deals$/i, category: 'reinsurance',       attestation: null },
  { re: /^Fasanara /i,                  category: 'credit-fund',       attestation: 'https://www.fasanara.com/investor-letters' },
  { re: /^Maple Institutional$/i,       category: 'private-credit',    attestation: 'https://maple.finance/institutional' },
  { re: /^RockawayX$/i,                 category: 'fund',              attestation: 'https://rockawayx.com/' },
  { re: /^Adaptive Frontier$/i,         category: 'fund',              attestation: null },
  { re: /^Sky$/i,                       category: 'stable-issuer',     attestation: 'https://sky.money/' },
  { re: /^Cap stcUSD$|^cap$/i,          category: 'stable-issuer',     attestation: 'https://docs.cap.app/' },
  { re: /^infinifiUSD Autopool$/i,      category: 'stable-issuer',     attestation: 'https://www.infinifi.xyz/' },
  { re: /^sGHO$/i,                      category: 'stable-issuer',     attestation: 'https://docs.aave.com/' },
];

function classify(protocolName) {
  if (DEAL_PREFIX.test(protocolName)) return { category: 'reinsurance-deal', attestation: null };
  for (const m of OPAQUE_MATCHERS) if (m.re.test(protocolName)) return m;
  return null;
}

// Underlying asset lookup: prefer position_tokens.supply[0], fallback to
// yield_source, fallback to 'USD' (for Private Reinsurance Deals).
function pickUnderlying(position, tokens) {
  const primary = tokens.find(t => t.role === 'supply');
  if (primary && (primary.real_symbol || primary.symbol)) {
    return { symbol: primary.real_symbol || primary.symbol, address: primary.address || null };
  }
  // Fallback: if position itself has an `underlying` field (from manual-positions.json)
  if (position.yield_source) return { symbol: position.yield_source.toUpperCase(), address: null };
  return { symbol: 'USD', address: null };
}

module.exports = {
  id: 'offchain',
  protocol_names: [
    'Private Reinsurance Deals', 'Fasanara mGLOBAL (GDADF)', 'Fasanara Genesis Fund',
    'Fasanara Digital', 'Maple Institutional', 'RockawayX', 'Adaptive Frontier',
    'Sky', 'Cap stcUSD', 'cap', 'Cap', 'infinifiUSD Autopool', 'sGHO',
  ],
  confidence: 'high',
  references: [
    'https://maple.finance/institutional',
    'https://www.fasanara.com/',
  ],
  match(position) {
    if (DEAL_PREFIX.test(position.protocol_name || '')) return true;
    return false;
  },
  async compute(position, ctx) {
    const tokens = ctx.loadTokens(position.id);
    const cls = classify(position.protocol_name) || { category: 'unclassified-offchain', attestation: null };
    const under = pickUnderlying(position, tokens);
    const userUsd = position.net_usd;

    return [{
      kind: 'opaque_offchain',
      venue: position.protocol_name,
      chain: position.chain || 'off-chain',
      asset_symbol: under.symbol,
      asset_address: under.address,
      usd: userUsd,
      source: 'manual',
      confidence: 'high',
      as_of: position.scanned_at,
      attestation_url: cls.attestation,
      evidence: {
        layout: 'opaque_offchain',
        strategy: position.strategy || 'rwa',
        counterparty: position.protocol_name,
        category: cls.category,
        yield_source: position.yield_source,
        maturity: position.maturity || null,
        user_net_usd: userUsd,
        wallet: position.wallet,
        decomposable: false,
        decomposition_reason: 'off-chain counterparty \u2014 no trustless lookthrough; attestation link below',
      },
      children: [{
        kind: 'primary_asset',
        venue: position.protocol_name,
        chain: position.chain || 'off-chain',
        asset_symbol: under.symbol,
        asset_address: under.address,
        usd: userUsd,
        pct_of_parent: 100,
        source: 'manual',
        confidence: 'high',
        evidence: { denomination: true, is_collateral: false, is_borrowable: false, note: 'underlying denomination is known; counterparty wrapper is opaque' },
      }],
    }];
  },
};
