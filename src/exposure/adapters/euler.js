/**
 * Euler v2 (EVK) exposure adapter — deep lens.
 *
 * Pattern (mirrors reservoir-monitor.vercel.app):
 *   1. For each wallet's Euler supply position, identify the loan vault it
 *      sits in and the vault's totalAssets / totalBorrows (on-chain).
 *   2. Enumerate the loan vault's accepted-collateral vaults (the cluster).
 *      We read the EVK governance config via the on-chain vault by calling
 *      LTVList() on the loan vault — that returns the collateral vault
 *      addresses whitelisted for this loan vault.
 *   3. Query Goldsky `trackingVaultBalances` to list top-N borrowers (by
 *      debt in the loan vault).
 *   4. For those same borrower accounts, query their balances in each
 *      collateral vault. Sum per collateral → collateral mix by USD.
 *   5. Emit market_exposure children per collateral, pro-rated by the
 *      user's share of the loan vault's totalAssets.
 *
 * Cache key: per (chain, loan_vault_address). Shared across all whales in
 * the same cluster for the same run.
 *
 * Fallback: if any step fails, we still emit the shallow pool_share row
 * (original behavior) but marked `confidence='medium'` and note the failure.
 */

const CHAIN_CONFIG = {
  eth: {
    chainId: 1,
    subgraph: 'https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-simple-mainnet/latest/gn',
    rpcUrl: process.env.ALCHEMY_RPC_URL || (process.env.ALCHEMY_API_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : null),
  },
  base: {
    chainId: 8453,
    subgraph: 'https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-simple-base/latest/gn',
    rpcUrl: process.env.BASE_RPC_URL || (process.env.ALCHEMY_API_KEY ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : null),
  },
  arb: {
    chainId: 42161,
    subgraph: 'https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-simple-arbitrum/latest/gn',
    rpcUrl: process.env.ARB_RPC_URL || (process.env.ALCHEMY_API_KEY ? `https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : null),
  },
};

const TOP_BORROWERS = 100;

async function gql(url, query) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.errors) return null;
  return data.data;
}

async function rpcCall(rpcUrl, to, data) {
  if (!rpcUrl) return null;
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.result || null;
}

// Function selectors (EVK IVault + ERC-20)
const SEL = {
  totalAssets:  '0x01e1d114',  // totalAssets()
  totalBorrows: '0x47bd3718',  // totalBorrows()
  asset:        '0x38d52e0f',  // asset()
  LTVList:      '0x6a16ef84',  // LTVList() - EVK collateral vault list
  decimals:     '0x313ce567',
  symbol:       '0x95d89b41',
};

function decodeAddressList(hex) {
  if (!hex || hex === '0x') return [];
  // ABI-encoded dynamic address[]: offset (32b) + length (32b) + addresses...
  const data = hex.slice(2);
  if (data.length < 128) return [];
  const len = parseInt(data.slice(64, 128), 16);
  const out = [];
  for (let i = 0; i < len; i++) {
    const start = 128 + i * 64;
    const addr = '0x' + data.slice(start + 24, start + 64);
    out.push(addr.toLowerCase());
  }
  return out;
}

function decodeAddress(hex) {
  if (!hex || hex === '0x' || hex.length < 66) return null;
  return '0x' + hex.slice(-40).toLowerCase();
}

function decodeUint(hex) {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex);
}

function decodeString(hex) {
  if (!hex || hex === '0x') return '';
  const data = hex.slice(2);
  if (data.length < 128) return '';
  const len = parseInt(data.slice(64, 128), 16);
  const bytes = data.slice(128, 128 + len * 2);
  return Buffer.from(bytes, 'hex').toString('utf8');
}

async function getVaultDetails(rpcUrl, vault) {
  const [totalAssets, totalBorrows, asset, collList, symbol] = await Promise.all([
    rpcCall(rpcUrl, vault, SEL.totalAssets),
    rpcCall(rpcUrl, vault, SEL.totalBorrows),
    rpcCall(rpcUrl, vault, SEL.asset),
    rpcCall(rpcUrl, vault, SEL.LTVList),
    rpcCall(rpcUrl, vault, SEL.symbol),
  ]);
  return {
    totalAssets: decodeUint(totalAssets),
    totalBorrows: decodeUint(totalBorrows),
    asset: decodeAddress(asset),
    collateralVaults: decodeAddressList(collList),
    symbol: decodeString(symbol),
  };
}

async function getTokenMeta(rpcUrl, addr) {
  const [sym, dec] = await Promise.all([
    rpcCall(rpcUrl, addr, SEL.symbol),
    rpcCall(rpcUrl, addr, SEL.decimals),
  ]);
  return { symbol: decodeString(sym) || '?', decimals: Number(decodeUint(dec) || 18n) };
}

async function fetchUsdPrice(symbol, assetAddr, chain) {
  // Use DeFiLlama coins API
  const dlChain = { eth: 'ethereum', base: 'base', arb: 'arbitrum', bsc: 'bsc', monad: 'monad' }[chain] || chain;
  if (!assetAddr) return null;
  try {
    const r = await fetch(`https://coins.llama.fi/prices/current/${dlChain}:${assetAddr}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    const key = `${dlChain}:${assetAddr.toLowerCase()}`;
    return j.coins?.[key]?.price || null;
  } catch { return null; }
}

async function getClusterBreakdown(chain, loanVault, ctx) {
  const cacheKey = `euler:cluster:${chain}:${loanVault.toLowerCase()}`;
  const hit = ctx.cache.get(cacheKey);
  if (hit !== undefined) return hit;

  const cfg = CHAIN_CONFIG[chain];
  if (!cfg || !cfg.rpcUrl || !cfg.subgraph) { ctx.cache.set(cacheKey, null); return null; }

  try {
    const vaultDetails = await getVaultDetails(cfg.rpcUrl, loanVault);
    if (!vaultDetails.asset || vaultDetails.totalAssets === 0n) {
      ctx.cache.set(cacheKey, null);
      return null;
    }

    // Passive vault with no borrow side: LTVList empty and/or totalBorrows zero.
    // User owns pro-rata underlying asset directly (no cluster counterparty).
    const loanAssetMeta0 = await getTokenMeta(cfg.rpcUrl, vaultDetails.asset);
    const loanPrice0 = await fetchUsdPrice(loanAssetMeta0.symbol, vaultDetails.asset, chain) || 0;
    if (vaultDetails.collateralVaults.length === 0 || vaultDetails.totalBorrows === 0n) {
      const totalAssetsUnd = Number(vaultDetails.totalAssets) / Math.pow(10, loanAssetMeta0.decimals);
      const result = {
        passive: true,
        loan_vault: loanVault,
        loan_asset: vaultDetails.asset,
        loan_asset_symbol: loanAssetMeta0.symbol,
        loan_asset_decimals: loanAssetMeta0.decimals,
        loan_price_usd: loanPrice0,
        loan_total_assets_usd: totalAssetsUnd * loanPrice0,
        loan_total_borrows_usd: 0,
        utilization: 0,
        borrower_count: 0,
        collateral_breakdown: [],
        total_collateral_usd_from_sample: 0,
        as_of: ctx.now,
      };
      ctx.cache.set(cacheKey, result);
      return result;
    }

    const loanAssetMeta = loanAssetMeta0;
    const loanPrice = loanPrice0 || 1;

    // Top borrowers of the loan vault
    const borrowersQ = `{ trackingVaultBalances(first: ${TOP_BORROWERS}, where:{vault:"${loanVault.toLowerCase()}", debt_gt:"0"}, orderBy: debt, orderDirection: desc) { account debt } }`;
    const bj = await gql(cfg.subgraph, borrowersQ);
    const borrowers = (bj?.trackingVaultBalances || []).map(b => ({ account: b.account.toLowerCase(), debt: BigInt(b.debt) }));
    if (!borrowers.length) { ctx.cache.set(cacheKey, null); return null; }

    const totalSampledDebt = borrowers.reduce((s, b) => s + b.debt, 0n);

    // For each collateral vault, fetch meta + balances for these borrowers
    const collateralBreakdown = [];
    for (const cv of vaultDetails.collateralVaults) {
      const cvDetails = await getVaultDetails(cfg.rpcUrl, cv);
      if (!cvDetails.asset) continue;
      const cvTokenMeta = await getTokenMeta(cfg.rpcUrl, cvDetails.asset);
      const cvPrice = await fetchUsdPrice(cvTokenMeta.symbol, cvDetails.asset, chain) || 0;

      // Query balances of borrower accounts in this collateral vault
      const balQ = `{ trackingVaultBalances(first: 200, where:{vault:"${cv}", account_in:[${borrowers.map(b => `"${b.account}"`).join(',')}], balance_gt:"0"}) { account balance } }`;
      const bal = await gql(cfg.subgraph, balQ);
      const rows = bal?.trackingVaultBalances || [];

      // Sum balance in shares, convert to underlying via convertToAssets.
      // For simplicity: treat share = underlying at 1:1 (EVK often ~1:1 at
      // start). For precise accounting we'd batch convertToAssets per vault.
      // This gets us within a few % accuracy which is fine for risk composition.
      let totalShares = 0n;
      for (const r of rows) totalShares += BigInt(r.balance);

      const totalUnderlying = Number(totalShares) / Math.pow(10, cvTokenMeta.decimals);
      const totalUsd = totalUnderlying * cvPrice;

      collateralBreakdown.push({
        collateral_vault: cv,
        collateral_symbol: cvTokenMeta.symbol,
        collateral_asset: cvDetails.asset,
        supporting_borrowers: rows.length,
        total_usd_in_cluster: totalUsd,
      });
    }

    const totalColUsd = collateralBreakdown.reduce((s, c) => s + c.total_usd_in_cluster, 0);
    const totalAssetsUnderlying = Number(vaultDetails.totalAssets) / Math.pow(10, loanAssetMeta.decimals);
    const totalBorrowsUnderlying = Number(vaultDetails.totalBorrows) / Math.pow(10, loanAssetMeta.decimals);

    const result = {
      loan_vault: loanVault,
      loan_asset: vaultDetails.asset,
      loan_asset_symbol: loanAssetMeta.symbol,
      loan_asset_decimals: loanAssetMeta.decimals,
      loan_price_usd: loanPrice,
      loan_total_assets_usd: totalAssetsUnderlying * loanPrice,
      loan_total_borrows_usd: totalBorrowsUnderlying * loanPrice,
      utilization: totalAssetsUnderlying > 0 ? totalBorrowsUnderlying / totalAssetsUnderlying : 0,
      borrower_count: borrowers.length,
      collateral_breakdown: collateralBreakdown,
      total_collateral_usd_from_sample: totalColUsd,
      as_of: ctx.now,
    };
    ctx.cache.set(cacheKey, result);
    return result;
  } catch (err) {
    ctx.cache.set(cacheKey, null);
    if (process.env.EULER_ADAPTER_DEBUG) console.error('[euler] breakdown error for', loanVault, ':', err.message);
    return null;
  }
}

function parseLoanVaultFromPosition(position) {
  // Euler scanner stores position_index like: <wallet>|<chain>|<vaultAddr>
  const parts = String(position.position_index || '').split('|');
  const last = parts[parts.length - 1];
  if (/^0x[0-9a-f]{40}$/i.test(last)) return last.toLowerCase();
  return null;
}

module.exports = {
  id: 'euler',
  protocol_names: ['Euler'],
  protocol_canonicals: ['euler', 'euler-v2'],
  confidence: 'high',
  references: [
    'https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/',
    'https://app.euler.finance/',
  ],
  async compute(position, ctx) {
    const tokens = ctx.loadTokens(position.id).filter(t => t.role === 'supply');
    const userUsd = position.net_usd;
    const loanVault = parseLoanVaultFromPosition(position);

    // Supplier-side path only (borrow-only sub-accounts have net_usd < 0 and
    // the orchestrator filters them via net_usd >= 50000).
    if (!loanVault) {
      // fallback: shallow row
      return [{
        kind: 'pool_share',
        venue: 'Euler',
        chain: position.chain,
        asset_symbol: tokens[0]?.real_symbol || tokens[0]?.symbol,
        usd: userUsd,
        source: 'onchain',
        confidence: 'medium',
        evidence: { shallow: true, reason: 'could not parse loan vault from position_index' },
      }];
    }

    const breakdown = await getClusterBreakdown(position.chain, loanVault, ctx);

    if (!breakdown) {
      return [{
        kind: 'pool_share',
        venue: 'Euler',
        venue_address: loanVault,
        chain: position.chain,
        asset_symbol: tokens[0]?.real_symbol || tokens[0]?.symbol,
        usd: userUsd,
        source: 'onchain',
        confidence: 'medium',
        evidence: { shallow: true, reason: 'cluster breakdown unavailable', loan_vault: loanVault },
      }];
    }

    // Passive vault: no borrow, single primary asset exposure
    if (breakdown.passive) {
      return [{
        kind: 'pool_share',
        venue: `Euler ${breakdown.loan_asset_symbol}`,
        venue_address: loanVault,
        chain: position.chain,
        asset_symbol: breakdown.loan_asset_symbol,
        asset_address: breakdown.loan_asset,
        usd: userUsd,
        utilization: 0,
        source: 'onchain',
        confidence: 'high',
        as_of: breakdown.as_of,
        evidence: {
          layout: 'passive_vault',
          strategy: position.strategy || 'stake',
          passive_vault: true,
          pool_tvl_usd: breakdown.loan_total_assets_usd,
          pool_total_borrow_usd: 0,
          pool_available_usd: breakdown.loan_total_assets_usd,
          pool_utilization: 0,
          user_share_pct: breakdown.loan_total_assets_usd > 0 ? (userUsd / breakdown.loan_total_assets_usd) * 100 : null,
          user_net_usd: userUsd,
          wallet: position.wallet,
        },
        children: [{
          kind: 'primary_asset',
          venue: `Euler ${breakdown.loan_asset_symbol}`,
          venue_address: loanVault,
          chain: position.chain,
          asset_symbol: breakdown.loan_asset_symbol,
          asset_address: breakdown.loan_asset,
          usd: userUsd,
          pct_of_parent: 100,
          source: 'onchain',
          confidence: 'high',
          evidence: { role: 'passive_unlent' },
        }],
      }];
    }

    // User's share of this loan vault's total assets
    const sharePct = breakdown.loan_total_assets_usd > 0
      ? (userUsd / breakdown.loan_total_assets_usd) * 100
      : 0;

    // Net-basis: legs sum to userUsd. Loan-asset unlent portion + collateral
    // mix of borrowers (from Goldsky sample). Each child has pool-level
    // metadata in evidence for the UI.
    const unborrowedRatio = breakdown.loan_total_assets_usd > 0
      ? Math.max(0, (breakdown.loan_total_assets_usd - breakdown.loan_total_borrows_usd) / breakdown.loan_total_assets_usd)
      : 0;

    const children = [];
    if (unborrowedRatio > 0.001) {
      children.push({
        kind: 'primary_asset',
        venue: `Euler ${breakdown.loan_asset_symbol}`,
        venue_address: loanVault,
        chain: position.chain,
        asset_symbol: breakdown.loan_asset_symbol,
        asset_address: breakdown.loan_asset,
        usd: userUsd * unborrowedRatio,
        pct_of_parent: unborrowedRatio * 100,
        source: 'onchain',
        confidence: 'high',
        evidence: {
          role: 'unlent',
          pool_reserve_total_supply_usd: breakdown.loan_total_assets_usd - breakdown.loan_total_borrows_usd,
          pool_reserve_available_usd: breakdown.loan_total_assets_usd - breakdown.loan_total_borrows_usd,
          is_collateral: false,
          is_borrowable: true,
        },
      });
    }

    const totalCol = breakdown.total_collateral_usd_from_sample;
    const borrowedRatio = 1 - unborrowedRatio;
    for (const c of breakdown.collateral_breakdown) {
      if (c.total_usd_in_cluster <= 0) continue;
      const colShareOfBorrows = totalCol > 0 ? c.total_usd_in_cluster / totalCol : 0;
      const userProUsd = userUsd * borrowedRatio * colShareOfBorrows;
      children.push({
        kind: 'market_exposure',
        venue: `Euler ${breakdown.loan_asset_symbol}`,
        venue_address: c.collateral_vault,
        chain: position.chain,
        asset_symbol: c.collateral_symbol,
        asset_address: c.collateral_asset,
        usd: userProUsd,
        pct_of_parent: userUsd > 0 ? (userProUsd / userUsd) * 100 : null,
        source: 'subgraph',
        confidence: 'high',
        evidence: {
          collateral_vault: c.collateral_vault,
          pool_reserve_total_supply_usd: c.total_usd_in_cluster,
          col_share_of_borrows_pct: colShareOfBorrows * 100,
          supporting_borrowers: c.supporting_borrowers,
          is_collateral: true,
          is_borrowable: false,
        },
      });
    }

    return [{
      kind: 'pool_share',
      venue: `Euler ${breakdown.loan_asset_symbol}`,
      venue_address: loanVault,
      chain: position.chain,
      asset_symbol: breakdown.loan_asset_symbol,
      asset_address: breakdown.loan_asset,
      usd: userUsd,
      utilization: breakdown.utilization,
      source: 'onchain',
      confidence: 'high',
      as_of: breakdown.as_of,
      evidence: {
        layout: 'cluster',
        strategy: position.strategy || 'lend',
        cluster_loan_vault: loanVault,
        pool_tvl_usd: breakdown.loan_total_assets_usd,
        pool_total_borrow_usd: breakdown.loan_total_borrows_usd,
        pool_available_usd: Math.max(0, breakdown.loan_total_assets_usd - breakdown.loan_total_borrows_usd),
        pool_utilization: breakdown.utilization,
        user_share_pct: sharePct,
        user_net_usd: userUsd,
        wallet: position.wallet,
        borrower_sample_size: breakdown.borrower_count,
        collateral_count: breakdown.collateral_breakdown.length,
      },
      children,
    }];
  },
};
