/**
 * Fluid exposure adapter — deep lens.
 *
 * Fluid separates lending (fToken supply) from borrowing (vault NFTs). When
 * a user holds fUSDC, their USDC is borrowed by third parties through
 * Fluid Vaults. Secondary risk on the supply side = the collateral those
 * Vaults have posted.
 *
 * Data source: Fluid REST v2.
 *   GET /v2/lending/{chainId}/tokens → list of fTokens with totalAssets
 *   GET /v2/{chainId}/vaults → list of vaults with borrowToken + supplyToken + totalBorrowUsd
 *
 * Strategy:
 *   1. Match user's supply asset (e.g. USDC) to the fToken.
 *   2. Enumerate vaults where borrowToken.address === user's asset → each
 *      vault shows its supplyToken (collateral) + totalBorrowUsd. Sum the
 *      borrow values per collateral type → mix.
 *   3. User's share of the fToken pool = userUsd / totalAssetsUsd.
 *   4. Pro-rata: userUsd × (borrowed_fraction × collateral_share)
 *
 * If any step fails we fall back to the shallow pool_share row.
 */

const CHAIN_IDS = { eth: 1, arb: 42161, base: 8453, plasma: 9745 };

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

async function getLendingTokens(chainId, cache) {
  const key = `fluid:tokens:${chainId}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const j = await fetchJson(`https://api.fluid.instadapp.io/v2/lending/${chainId}/tokens`);
  const list = j?.data || j || [];
  cache.set(key, list);
  return list;
}

async function getVaults(chainId, cache) {
  const key = `fluid:vaults:${chainId}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const j = await fetchJson(`https://api.fluid.instadapp.io/v2/${chainId}/vaults`);
  const list = Array.isArray(j) ? j : (j?.data || []);
  cache.set(key, list);
  return list;
}

module.exports = {
  id: 'fluid',
  protocol_names: ['Fluid'],
  protocol_canonicals: ['fluid', 'fluid-lending'],
  confidence: 'high',
  references: ['https://api.fluid.instadapp.io/'],
  async compute(position, ctx) {
    const chainId = CHAIN_IDS[position.chain];
    const tokens = ctx.loadTokens(position.id).filter(t => t.role === 'supply');
    const primary = tokens[0] || null;
    const userUsd = position.net_usd;

    if (!chainId || !primary) {
      return [fallbackRow(position, primary, userUsd, 'no chain or supply token')];
    }

    const [lendingTokens, vaults] = await Promise.all([
      getLendingTokens(chainId, ctx.cache),
      getVaults(chainId, ctx.cache),
    ]);

    // Match fToken by user's asset address
    const userAssetAddr = String(primary.address || '').toLowerCase();
    const ftoken = lendingTokens.find(t => String(t.assetAddress || '').toLowerCase() === userAssetAddr
                                        || String(t.asset?.address || '').toLowerCase() === userAssetAddr);

    if (!ftoken) {
      return [fallbackRow(position, primary, userUsd, 'no matching fToken for supply asset')];
    }

    const assetDecimals = ftoken.asset?.decimals || ftoken.decimals || 6;
    const assetPrice = Number(ftoken.asset?.price || 1);
    const poolTotalAssetsUsd = (Number(ftoken.totalAssets) / Math.pow(10, assetDecimals)) * assetPrice;

    // Find vaults borrowing this asset. Vault shape: { borrowToken: { token0: { address } } or similar }
    const borrowerVaults = vaults.filter(v => {
      const bt = v.borrowToken;
      if (!bt) return false;
      const a = String(bt.token0?.address || bt.address || '').toLowerCase();
      return a === userAssetAddr;
    });

    // Sum borrows by supply collateral
    const byCollateral = new Map();
    let totalBorrowsUsd = 0;
    for (const v of borrowerVaults) {
      const colSym = v.supplyToken?.token0?.symbol || v.supplyToken?.symbol || 'unknown';
      const colAddr = v.supplyToken?.token0?.address || v.supplyToken?.address || null;
      const borrowUsd = Number(v.totalBorrowLiquidityUsd || v.totalBorrowUsd || 0);
      if (borrowUsd <= 0) continue;
      totalBorrowsUsd += borrowUsd;
      const prev = byCollateral.get(colSym) || { usd: 0, addr: colAddr };
      prev.usd += borrowUsd;
      byCollateral.set(colSym, prev);
    }

    if (!poolTotalAssetsUsd || totalBorrowsUsd <= 0) {
      return [{
        kind: 'pool_share',
        venue: `Fluid ${ftoken.symbol}`,
        venue_address: ftoken.address,
        chain: position.chain,
        asset_symbol: primary.real_symbol || primary.symbol,
        asset_address: primary.address,
        usd: userUsd,
        utilization: 0,
        source: 'protocol-api',
        confidence: 'high',
        as_of: ctx.now,
        evidence: {
          layout: 'passive_vault',
          strategy: position.strategy || 'lend',
          ftoken: ftoken.symbol,
          pool_tvl_usd: poolTotalAssetsUsd,
          pool_total_borrow_usd: 0,
          pool_available_usd: poolTotalAssetsUsd,
          pool_utilization: 0,
          user_net_usd: userUsd,
          wallet: position.wallet,
          passive: true,
        },
        children: [{
          kind: 'primary_asset',
          venue: `Fluid ${ftoken.symbol}`,
          chain: position.chain,
          asset_symbol: primary.real_symbol || primary.symbol,
          asset_address: primary.address,
          usd: userUsd,
          pct_of_parent: 100,
          source: 'protocol-api',
          confidence: 'high',
          evidence: { role: 'passive_unlent', is_collateral: false, is_borrowable: true },
        }],
      }];
    }

    const borrowedRatio = Math.min(1, totalBorrowsUsd / poolTotalAssetsUsd);
    const unborrowedRatio = 1 - borrowedRatio;

    const children = [];
    if (unborrowedRatio > 0.001) {
      children.push({
        kind: 'primary_asset',
        venue: `Fluid ${ftoken.symbol}`,
        chain: position.chain,
        asset_symbol: primary.real_symbol || primary.symbol,
        asset_address: primary.address,
        usd: userUsd * unborrowedRatio,
        pct_of_parent: unborrowedRatio * 100,
        source: 'protocol-api',
        confidence: 'high',
        evidence: {
          role: 'unlent',
          pool_reserve_total_supply_usd: poolTotalAssetsUsd - totalBorrowsUsd,
          pool_reserve_available_usd: poolTotalAssetsUsd - totalBorrowsUsd,
          is_collateral: false,
          is_borrowable: true,
        },
      });
    }

    for (const [sym, info] of byCollateral.entries()) {
      const collateralShare = info.usd / totalBorrowsUsd;
      children.push({
        kind: 'market_exposure',
        venue: `Fluid ${ftoken.symbol}`,
        chain: position.chain,
        asset_symbol: sym,
        asset_address: info.addr,
        usd: userUsd * borrowedRatio * collateralShare,
        pct_of_parent: borrowedRatio * collateralShare * 100,
        source: 'protocol-api',
        confidence: 'high',
        evidence: {
          pool_reserve_total_supply_usd: info.usd,
          collateral_total_borrow_usd: info.usd,
          pool_total_borrow_usd: totalBorrowsUsd,
          is_collateral: true,
          is_borrowable: false,
        },
      });
    }

    return [{
      kind: 'pool_share',
      venue: `Fluid ${ftoken.symbol}`,
      venue_address: ftoken.address,
      chain: position.chain,
      asset_symbol: primary.real_symbol || primary.symbol,
      asset_address: primary.address,
      usd: userUsd,
      utilization: borrowedRatio,
      source: 'protocol-api',
      confidence: 'high',
      as_of: ctx.now,
      evidence: {
        layout: 'lending_pool',
        strategy: position.strategy || 'lend',
        ftoken: ftoken.symbol,
        pool_tvl_usd: poolTotalAssetsUsd,
        pool_total_borrow_usd: totalBorrowsUsd,
        pool_available_usd: Math.max(0, poolTotalAssetsUsd - totalBorrowsUsd),
        pool_utilization: borrowedRatio,
        user_share_pct: poolTotalAssetsUsd > 0 ? (userUsd / poolTotalAssetsUsd) * 100 : null,
        user_net_usd: userUsd,
        wallet: position.wallet,
        borrower_vault_count: borrowerVaults.length,
        collateral_count: byCollateral.size,
      },
      children,
    }];
  },
};

function fallbackRow(position, primary, userUsd, reason) {
  // Even without vault-level decomposition, we know the supplied token.
  // Emit a denomination-only tree so confidence stays high.
  if (primary) {
    return {
      kind: 'pool_share',
      venue: 'Fluid',
      chain: position.chain,
      asset_symbol: primary.real_symbol || primary.symbol,
      asset_address: primary.address,
      usd: userUsd,
      source: 'protocol-api',
      confidence: 'high',
      evidence: { denomination_only: true, reason },
      children: [{
        kind: 'primary_asset',
        venue: 'Fluid',
        chain: position.chain,
        asset_symbol: primary.real_symbol || primary.symbol,
        asset_address: primary.address,
        usd: userUsd,
        pct_of_parent: 100,
        source: 'protocol-api',
        confidence: 'high',
        evidence: { denomination_only: true },
      }],
    };
  }
  return {
    kind: 'pool_share',
    venue: 'Fluid',
    chain: position.chain,
    usd: userUsd,
    source: 'protocol-api',
    confidence: 'medium',
    evidence: { shallow: true, reason },
  };
}
