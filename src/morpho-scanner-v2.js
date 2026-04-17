#!/usr/bin/env node
/**
 * Morpho Position Scanner v2 (Simplified)
 * 
 * 3 calls per wallet:
 * 1. REST /api/positions/earn → vault positions
 * 2. REST /api/positions/borrow → market positions
 * 3. GraphQL APY → enrich with APY data
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const DB_PATH = require('path').join(__dirname, '..', 'yield-tracker.db');

const MORPHO_REST = 'https://app.morpho.org/api';
const MORPHO_GRAPHQL = 'https://app.morpho.org/api/graphql';
const ALL_CHAINS = [1, 8453, 42161, 137, 130, 747474, 999, 10, 143, 988, 480];

// APY persisted query hashes
const V1_APY_HASH = 'db4bd5b01c28c4702d575d3cc6718e9fdf02908fe1769a9ac84769183b15d3a1';
const V2_PERF_HASH = '2450946f568dabb9e65946408befef7d15c529139e2a397c75bf64cbccf1aa9b';

// ============================================
// Step 1: Get earn positions (vault positions)
// ============================================
async function getEarnPositions(userAddress) {
  const url = `${MORPHO_REST}/positions/earn?userAddress=${userAddress}&limit=500&skip=0&chainIds=${ALL_CHAINS.join(',')}&orderBy=assetsUsd&orderDirection=DESC`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Earn API: ${res.status}`);
  const data = await res.json();
  return data.items || [];
}

// ============================================
// Step 2: Get borrow positions (market positions)
// ============================================
async function getBorrowPositions(userAddress) {
  const url = `${MORPHO_REST}/positions/borrow?userAddress=${userAddress}&limit=500&skip=0&chainIds=${ALL_CHAINS.join(',')}&orderBy=borrowAssetsUsd&orderDirection=DESC`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Borrow API: ${res.status}`);
  const data = await res.json();
  return data.items || [];
}

// ============================================
// Step 3: Get APY for a vault
// ============================================
async function getVaultAPY(vaultAddress, version) {
  if (version === '2.0' || version === 'v2') {
    // Try v2 first
    const res = await fetch(MORPHO_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-apollo-operation-name': 'GetVaultV2Performance' },
      body: JSON.stringify({
        operationName: 'GetVaultV2Performance',
        variables: { address: vaultAddress, chainId: 1 },
        extensions: { persistedQuery: { version: 1, sha256Hash: V2_PERF_HASH } }
      })
    });
    const data = await res.json();
    const v = data?.data?.vaultV2ByAddress;
    if (v) return { netApy: v.netApy, baseApy: v.netApyExcludingRewards };
  }
  
  // Try v1
  const res = await fetch(MORPHO_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-apollo-operation-name': 'GetVaultPerformanceApy' },
    body: JSON.stringify({
      operationName: 'GetVaultPerformanceApy',
      variables: { address: vaultAddress, chainId: 1 },
      extensions: { persistedQuery: { version: 1, sha256Hash: V1_APY_HASH } }
    })
  });
  const data = await res.json();
  const v = data?.data?.vaultByAddress;
  if (v) return { netApy: v.state?.netApy, baseApy: v.state?.netApyExcludingRewards };
  
  return null;
}

// ============================================
// Get market APY for borrow positions
// ============================================
async function getMarketAPY(marketId, chainId) {
  // Market APY data - use the market supplyApy from market query
  // For simplicity, we'll fetch it from the REST allocation endpoint
  const vaultRes = await fetch(MORPHO_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `{ marketStateByUniqueKey(marketId: "${marketId}", chainId: ${chainId}) { supplyApy borrowApy rewards { asset { symbol } supplyApr } } }`
    })
  });
  const data = await vaultRes.json();
  return data?.data?.marketStateByUniqueKey || null;
}

// ============================================
// Main scanner
// ============================================
async function scanWallet(wallet, label, db) {
  console.log(`\n--- ${label} (${wallet.slice(0,12)}) ---`);
  
  const updates = { earn: [], borrow: [] };
  
  // Step 1: Earn positions - update existing positions with APY data
  const earnItems = await getEarnPositions(wallet);
  console.log(`  Earn positions: ${earnItems.length}`);
  
  for (const item of earnItems) {
    const vault = item.vault || {};
    const apy = await getVaultAPY(vault.address, vault.version);
    
    // Find existing position to update
    const assetAddr = vault.asset?.address?.toLowerCase();
    const vaultAddr = vault.address?.toLowerCase();
    
    const update = {
      wallet, label,
      symbol: vault.symbol || vault.asset?.symbol || '?',
      vault_address: vault.address,
      asset_address: vault.asset?.address,
      value_usd: item.assetsUsd,
      shares: item.shares,
      apy_base: apy?.baseApy ? apy.baseApy * 100 : null,
      apy_total: apy?.netApy ? apy.netApy * 100 : null,
      chain: vault.chainId || 1,
    };
    
    update.apy_bonus = (update.apy_total && update.apy_base) ? update.apy_total - update.apy_base : null;
    
    console.log(`    ✅ ${update.symbol}: $${(update.value_usd / 1e6).toFixed(2)}M | APY: ${update.apy_base?.toFixed(2) || '?'}% + ${update.apy_bonus?.toFixed(2) || '0'}%`);
    updates.earn.push(update);
  }
  
  // Step 2: Borrow positions - update existing positions with HF data
  const borrowItems = await getBorrowPositions(wallet);
  console.log(`  Borrow positions: ${borrowItems.length}`);
  
  for (const item of borrowItems) {
    const market = item.market || {};
    const loanSymbol = market.loanAsset?.symbol || '?';
    const collSymbol = market.collateralAsset?.symbol || '?';
    
    const marketApy = await getMarketAPY(market.uniqueKey || market.marketId, market.chainId);
    
    const update = {
      wallet, label,
      symbol: loanSymbol,
      coll_symbol: collSymbol,
      market_key: market.uniqueKey || market.marketId,
      value_usd: item.borrowAssetsUsd,
      collateral_usd: item.collateralUsd,
      health_factor: item.healthFactor,
      ltv: item.ltv,
      liquidation_distance: item.priceVariationToLiquidationPrice,
      apy_borrow: marketApy?.borrowApy ? marketApy.borrowApy * 100 : null,
      chain: market.chainId || 1,
    };
    
    console.log(`    📊 ${update.symbol}/${update.coll_symbol}: $${(update.value_usd / 1e6).toFixed(2)}M borrow | HF: ${update.health_factor?.toFixed(3)}`);
    updates.borrow.push(update);
  }
  
  return updates;
}

// ============================================
// Save to database
// ============================================
function enrichPositions(db, updates) {
  // Find existing DeBank positions and update their APY/health data
  const findPos = db.prepare(`SELECT p.id, pt.id as token_id FROM positions p JOIN position_tokens pt ON pt.position_id = p.id WHERE p.wallet = ? AND p.protocol_name = 'Morpho' AND p.position_type = 'Lending' AND pt.symbol = ? AND pt.role = 'supply'`);
  const updateToken = db.prepare(`UPDATE position_tokens SET apy_base = ?, bonus_supply_apy = ? WHERE id = ?`);
  const updateNetUsd = db.prepare(`UPDATE positions SET net_usd = ?, scanned_at = datetime('now') WHERE id = ?`);
  
  const transaction = db.transaction(() => {
    for (const update of updates.earn) {
      // Find existing position by symbol
      const posRow = findPos.get(update.wallet, update.symbol);
      if (posRow) {
        // Update APY data
        updateToken.run(update.apy_base || null, update.apy_bonus || null, posRow.token_id);
        updateNetUsd.run(update.value_usd || 0, posRow.id);
      }
      
      // Also update by asset address (some positions use different symbols)
      // Try common variants
      const symbolVariants = {
        'senRLUSDv2': 'RLUSD',
        'senPYUSDmain': 'PYUSD',
        'steakRUSD': 'rUSD',
        'steakUSDC': 'USDC',
      };
      
      if (symbolVariants[update.symbol]) {
        const altPos = findPos.get(update.wallet, symbolVariants[update.symbol]);
        if (altPos) {
          updateToken.run(update.apy_base || null, update.apy_bonus || null, altPos.token_id);
          updateNetUsd.run(update.value_usd || 0, altPos.id);
        }
      }
    }
    
    // Update borrow positions - find by wallet and update health factor
    // Note: DeBank handles borrow positions differently, we just enrich
  });
  
  transaction();
}

// ============================================
// CLI
// ============================================
async function main() {
  const wallets = [
    { addr: '0x31eae643b679a84b37e3d0b4bd4f5da90fb04a61', label: 'Reservoir-1' },
    { addr: '0x99a95a9e38e927486fc878f41ff8b118eb632b10', label: 'Reservoir-3' },
    { addr: '0x289c204b35859bfb924b9c0759a4fe80f610671c', label: 'Reservoir-2' },
    { addr: '0x3063c5907faa10c01b242181aa689beb23d2bd65', label: 'Euler-Wallet' },
  ];
  
  const db = new Database(DB_PATH);
  const allPositions = { earn: [], borrow: [] };
  
  console.log('=== Morpho Scanner v2 (Simplified) ===\n');
  
  for (const w of wallets) {
    const result = await scanWallet(w.addr, w.label, db);
    allPositions.earn.push(...result.earn);
    allPositions.borrow.push(...result.borrow);
  }
  
  enrichPositions(db, allPositions);
  
  console.log(`\n=== Summary ===`);
  console.log(`Earn positions: ${allPositions.earn.length}`);
  console.log(`Borrow positions: ${allPositions.borrow.length}`);
  console.log(`Total: ${allPositions.earn.length + allPositions.borrow.length}`);
  
  db.close();
}

module.exports = { getEarnPositions, getBorrowPositions, getVaultAPY, scanWallet };

if (require.main === module) {
  main().catch(console.error);
}
