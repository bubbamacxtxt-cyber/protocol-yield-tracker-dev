/**
 * Compound V3 (Comet) adapter.
 *
 * Each Comet market has one base asset (borrow/supply in kind) and N accepted
 * collaterals. As a base-asset supplier, your secondary risk is all the
 * collaterals backing the base asset.
 *
 * Deep lens: enumerate accepted collaterals via Comet.numAssets() +
 * Comet.getAssetInfo(i). Emits pool_share root + one market_exposure child
 * per collateral, sized pro-rata to the collateral's on-chain totalsCollateral
 * balance vs. total accepted-collateral USD. Falls back to equal-weight pro
 * rata when price oracle queries fail.
 *
 * Confidence:
 *   - 'high' when we successfully read numAssets() + getAssetInfo() for
 *     every collateral and price + balance lookups succeed.
 *   - 'medium' when we know the collateral list but can't size it (no prices
 *     or totalsCollateral fails) — we emit equal-weight market_exposure rows.
 *   - falls back to a shallow pool_share if the Comet contract can't be
 *     resolved (unknown market / no RPC).
 */

const { JsonRpcProvider, Contract } = require('ethers');

// Chain → Comet market address (base asset pool). Sourced from Compound V3
// deployments table and matched against src/compound-scanner.js.
const COMET_MARKETS = {
  eth: {
    USDC:  '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
    USDT:  '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840',
    WETH:  '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
    USDS:  '0x5D409e56D886231aDAf00c8775665AD0f9897b56',
  },
  base: {
    USDC:  '0xb125E6687d4313864e53df431d5425969c15Eb2F',
    USDbC: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf',
    WETH:  '0x46e6b214b524310239732D51387075E0e70970bf',
    AERO:  '0x784efeB622244d2348d4F2522f8860B96fbEcE89',
  },
  arb: {
    USDC:  '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf',
    'USDC.e': '0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA',
    USDT:  '0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07',
    WETH:  '0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486',
  },
  poly: {
    USDC:  '0xF25212E676D1F7F89Cd72fFEe66158f541246445',
  },
  scroll: {
    USDC:  '0xB2f97c1Bd3bf02f5e74d13f02E3e26F93D77CE44',
  },
  opt: {
    USDC:  '0x2e44e174f7D53F0212823acC11C01A11d58c5bCB',
    USDT:  '0x995E394b8B2437aC8Ce61Ee0bC610D617962B214',
    WETH:  '0xE36A30D249f7761327fd973001A32010b521b6Fd',
  },
  mnt: {
    USDe:  '0x606174f62cd968d8e684c645080fa694c1D7786E',
  },
  uni: {
    WETH:  '0x2c7118c4C88B9841FCF839074c26Ae8f035f2921',
  },
};

const CHAIN_RPC = {
  eth:  process.env.ETH_RPC_URL  || process.env.ALCHEMY_RPC_URL,
  base: process.env.BASE_RPC_URL,
  arb:  process.env.ARB_RPC_URL,
  poly: process.env.POLY_RPC_URL,
  opt:  process.env.OPT_RPC_URL,
  scroll: process.env.SCROLL_RPC_URL,
  mnt:  process.env.ALCHEMY_MNT_RPC_URL || process.env.MANTLE_RPC_URL,
  uni:  process.env.UNICHAIN_RPC_URL,
};

const COMET_ABI = [
  'function numAssets() view returns (uint8)',
  'function getAssetInfo(uint8 i) view returns (tuple(uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap))',
  'function baseToken() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function totalBorrow() view returns (uint256)',
  'function getPrice(address priceFeed) view returns (uint256)',
  'function totalsCollateral(address asset) view returns (uint128 totalSupplyAsset, uint128 _reserved)',
];

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

function resolveCometForPosition(position) {
  const chainMarkets = COMET_MARKETS[position.chain] || {};
  // scanner stores position_index = comet contract address (from compound-scanner.js)
  const pi = String(position.position_index || '').toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(pi)) {
    return pi;
  }
  // Fallback: pick by supplied asset symbol.
  // This branch is rarely hit (scanner always sets position_index).
  return null;
}

async function getCometComposition(cometAddress, chain, cache) {
  const key = `compound:comet:${chain}:${cometAddress}`;
  if (cache.get(key)) return cache.get(key);

  const rpc = CHAIN_RPC[chain];
  if (!rpc) {
    cache.set(key, { error: `no RPC configured for chain=${chain}` });
    return cache.get(key);
  }

  const provider = new JsonRpcProvider(rpc);
  const comet = new Contract(cometAddress, COMET_ABI, provider);

  let numAssets, baseToken;
  try {
    [numAssets, baseToken] = await Promise.all([comet.numAssets(), comet.baseToken()]);
  } catch (err) {
    cache.set(key, { error: `numAssets/baseToken failed: ${err.message}` });
    return cache.get(key);
  }

  const collaterals = [];
  for (let i = 0; i < Number(numAssets); i++) {
    try {
      const info = await comet.getAssetInfo(i);
      collaterals.push({
        index: i,
        asset: info.asset,
        priceFeed: info.priceFeed,
        scale: info.scale,
        supplyCap: info.supplyCap,
      });
    } catch (err) {
      // non-fatal, skip
    }
  }

  // Enrich with symbols + totalsCollateral + price
  for (const c of collaterals) {
    try {
      const tok = new Contract(c.asset, ERC20_ABI, provider);
      const [sym, dec] = await Promise.all([
        tok.symbol().catch(() => '???'),
        tok.decimals().catch(() => 18),
      ]);
      c.symbol = sym;
      c.decimals = Number(dec);
    } catch {}
    try {
      const totals = await comet.totalsCollateral(c.asset);
      c.totalSupplyAsset = BigInt(totals[0]).toString();
    } catch {}
    try {
      const priceRaw = await comet.getPrice(c.priceFeed);
      // price is scaled by 1e8 (USD), per Compound V3 docs.
      c.priceUsd = Number(priceRaw) / 1e8;
    } catch {}
    // Compute USD value when possible
    if (c.totalSupplyAsset && c.priceUsd != null && c.decimals != null) {
      const amt = Number(c.totalSupplyAsset) / Math.pow(10, c.decimals);
      c.totalUsd = amt * c.priceUsd;
    } else {
      c.totalUsd = null;
    }
  }

  const result = { baseToken: baseToken.toLowerCase(), collaterals };
  cache.set(key, result);
  return result;
}

module.exports = {
  id: 'compound',
  protocol_names: ['Compound', 'Compound V3', 'Compound3'],
  protocol_canonicals: ['compound', 'compound-v3', 'compound3'],
  confidence: 'high',
  references: ['https://docs.compound.finance/'],
  async compute(position, ctx) {
    const comet = resolveCometForPosition(position);
    const tokens = ctx.loadTokens(position.id).filter(t => t.role === 'supply');
    const supplyUsd = position.net_usd;

    if (!comet) {
      // No Comet address — shallow fallback
      return [{
        kind: 'pool_share',
        venue: 'Compound V3',
        chain: position.chain,
        asset_symbol: tokens[0]?.real_symbol || tokens[0]?.symbol,
        asset_address: tokens[0]?.address,
        usd: supplyUsd,
        source: 'onchain',
        confidence: 'medium',
        evidence: { reason: 'comet market unresolved' },
      }];
    }

    let composition;
    try {
      composition = await getCometComposition(comet, position.chain, ctx.cache);
    } catch (err) {
      composition = { error: err.message };
    }

    if (composition.error) {
      return [{
        kind: 'pool_share',
        venue: 'Compound V3',
        chain: position.chain,
        asset_symbol: tokens[0]?.real_symbol || tokens[0]?.symbol,
        asset_address: tokens[0]?.address,
        usd: supplyUsd,
        source: 'onchain',
        confidence: 'medium',
        evidence: { comet: comet, error: composition.error },
      }];
    }

    const collaterals = composition.collaterals || [];
    if (!collaterals.length) {
      return [{
        kind: 'pool_share',
        venue: 'Compound V3',
        chain: position.chain,
        asset_symbol: tokens[0]?.real_symbol || tokens[0]?.symbol,
        asset_address: tokens[0]?.address,
        usd: supplyUsd,
        source: 'onchain',
        confidence: 'medium',
        evidence: { comet, reason: 'no collaterals enumerated' },
      }];
    }

    // Root: pool_share representing the base-asset supply position
    const root = {
      kind: 'pool_share',
      venue: 'Compound V3',
      chain: position.chain,
      asset_symbol: tokens[0]?.real_symbol || tokens[0]?.symbol,
      asset_address: tokens[0]?.address,
      usd: supplyUsd,
      source: 'onchain',
      confidence: 'high',
      evidence: {
        comet,
        collateral_count: collaterals.length,
        base_token: composition.baseToken,
      },
      children: [],
    };

    // Size by totalUsd when available; fall back to equal weight.
    const withUsd = collaterals.filter(c => c.totalUsd && c.totalUsd > 0);
    const totalSized = withUsd.reduce((s, c) => s + c.totalUsd, 0);

    for (const c of collaterals) {
      const pct = totalSized > 0 && c.totalUsd
        ? (c.totalUsd / totalSized)
        : (1 / collaterals.length);
      root.children.push({
        kind: 'market_exposure',
        venue: 'Compound V3',
        chain: position.chain,
        asset_symbol: c.symbol,
        asset_address: c.asset,
        usd: supplyUsd * pct,
        pct_of_parent: pct * 100,
        source: 'onchain',
        confidence: totalSized > 0 ? 'high' : 'medium',
        evidence: {
          total_collateral_usd: c.totalUsd,
          price_usd: c.priceUsd,
          weighting: totalSized > 0 ? 'pro-rata totalsCollateral' : 'equal',
        },
      });
    }

    return [root];
  },
};
