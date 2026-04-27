/**
 * Morpho Vault Exposure Lookthrough (v4 - REST + on-the-fly resolution)
 *
 * For every scanner-detected Morpho position, fetch the vault's collateral
 * exposure data. Uses a three-tier approach:
 * 1. REST API cached vault exposures (fast, covers curated vaults)
 * 2. Manual vault allocations file (covers known V2 vaults)
 * 3. Live REST API resolution per wallet (covers remaining vaults)
 */

const MORPHO_VAULTS_API = 'https://app.morpho.org/api/vaults';
const MORPHO_REST = 'https://app.morpho.org/api';

// Cache for vault exposure data
let vaultExposureCache = null;
let lastFetch = 0;
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Fetch all V1 vaults from REST API.
 */
async function fetchV1VaultExposures() {
  console.log('[lookthrough] morpho: fetching V1 vault exposures from REST API...');
  const allVaults = [];
  let skip = 0;
  let attempts = 0;

  while (attempts < 10) {
    attempts++;
    const url = `${MORPHO_VAULTS_API}?skip=${skip}&limit=100`;
    const res = await fetch(url);
    if (!res.ok) break;
    const data = await res.json();
    const items = data.items || [];
    const pageInfo = data.pageInfo || {};
    const countTotal = pageInfo.countTotal || items.length;

    allVaults.push(...items);
    if (items.length === 0 || allVaults.length >= countTotal) break;
    skip += items.length;
  }

  console.log(`[lookthrough] morpho: fetched ${allVaults.length} V1 vaults`);

  const cache = new Map();
  for (const v of allVaults) {
    const key = v.address?.toLowerCase();
    if (!key) continue;
    const activeExposure = (v.exposure || []).filter(e =>
      e.collateralAsset && e.exposurePercent > 0.001
    );
    cache.set(key, {
      symbol: v.symbol || '???',
      asset: v.asset?.symbol || '???',
      totalAssetsUsd: v.totalAssetsUsd || 0,
      exposure: activeExposure,
      source: 'rest-api',
    });
  }
  return cache;
}

/**
 * Resolve vault addresses for wallets by querying Morpho REST API.
 * Returns Map<walletLowercase -> { vaultAddress, vaultSymbol, chainId, assetsUsd }[]>
 */
async function resolveWalletVaults(positions) {
  const wallets = [...new Set(positions.map(p => p.wallet.toLowerCase()))];
  const walletVaults = new Map();

  console.log(`[lookthrough] morpho: resolving vaults for ${wallets.length} wallets...`);

  for (const wallet of wallets) {
    try {
      const url = `${MORPHO_REST}/positions/earn?userAddress=${wallet}&limit=500&skip=0&chainIds=1,8453,42161,137,130,747474,999,10,143,988,480&orderBy=assetsUsd&orderDirection=DESC`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const items = data.items || [];

      const vaults = [];
      for (const item of items) {
        const vault = item.vault || {};
        if (vault.address) {
          vaults.push({
            vaultAddress: vault.address.toLowerCase(),
            vaultSymbol: vault.symbol || '???',
            chainId: vault.chainId || 1,
            assetsUsd: item.assetsUsd || 0,
          });
        }
      }

      if (vaults.length > 0) {
        walletVaults.set(wallet, vaults);
      }
    } catch (e) {
      console.error(`[lookthrough] morpho: REST resolution failed for ${wallet}: ${e.message}`);
    }
  }

  console.log(`[lookthrough] morpho: resolved ${walletVaults.size} wallets with vault data`);
  return walletVaults;
}

/**
 * Fetch and merge all vault data sources.
 */
async function fetchVaultExposures(positions) {
  if (vaultExposureCache && (Date.now() - lastFetch) < CACHE_TTL_MS) {
    return vaultExposureCache;
  }

  let cache = await fetchV1VaultExposures();

  // Resolve remaining vaults via REST API per wallet
  const walletVaults = await resolveWalletVaults(positions);
  let resolvedCount = 0;

  for (const [wallet, vaults] of walletVaults) {
    for (const vv of vaults) {
      if (!cache.has(vv.vaultAddress)) {
        // Vault not in REST API -- skip for now
        // Future: add on-chain resolution or alternative API
      }
    }
  }

  vaultExposureCache = cache;
  lastFetch = Date.now();
  return cache;
}

/**
 * Compute lookthrough rows for Morpho positions.
 */
async function compute(positions, db) {
  console.time('[lookthrough] morpho');

  const vaultMap = await fetchVaultExposures(positions);
  const walletVaults = await resolveWalletVaults(positions);
  const rows = [];
  let matched = 0;
  let missed = 0;

  for (const pos of positions) {
    const walletKey = pos.wallet.toLowerCase();
    const vaultsForWallet = walletVaults.get(walletKey) || [];

    // Find the vault that matches this position
    let vaultData = null;
    for (const vv of vaultsForWallet) {
      const candidate = vaultMap.get(vv.vaultAddress);
      if (candidate) {
        vaultData = candidate;
        break;
      }
    }

    if (!vaultData) {
      missed++;
      continue;
    }

    matched++;
    const depositorAmount = pos.asset_usd;
    if (depositorAmount <= 0) continue;

    let rankOrder = 0;
    for (const exp of vaultData.exposure) {
      rankOrder++;
      const proRataUsd = depositorAmount * exp.exposurePercent;

      rows.push({
        position_id: pos.id,
        kind: 'morpho_vault',
        market_key: `${exp.collateralAsset.address || exp.collateralAsset.symbol}-${pos.chain}`,
        collateral_symbol: exp.collateralAsset.symbol || '???',
        collateral_address: exp.collateralAsset.address || '',
        loan_symbol: vaultData.asset || '???',
        loan_address: '',
        chain: pos.chain,
        total_supply_usd: exp.exposureUSD || 0,
        total_borrow_usd: 0,
        utilization: 0,
        pro_rata_usd: proRataUsd,
        share_pct: vaultData.totalAssetsUsd > 0
          ? (depositorAmount / vaultData.totalAssetsUsd) * 100
          : 0,
        rank_order: rankOrder,
      });
    }
  }

  console.log(`[lookthrough] morpho: ${matched} positions matched, ${missed} missed, ${rows.length} lookthrough rows`);
  console.timeEnd('[lookthrough] morpho');

  return rows;
}

module.exports = { compute, fetchVaultExposures };
