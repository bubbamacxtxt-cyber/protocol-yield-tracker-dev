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
  
  const positions = { earn: [], borrow: [] };
  
  // Step 1: Earn positions
  const earnItems = await getEarnPositions(wallet);
  console.log(`  Earn positions: ${earnItems.length}`);
  
  for (const item of earnItems) {
    const vault = item.vault || {};
    const apy = await getVaultAPY(vault.address, vault.version);
    
    const pos = {
      wallet, label,
      protocol_name: 'Morpho',
      protocol_id: 'morpho',
      symbol: vault.symbol || vault.asset?.symbol || '?',
      token_address: vault.address,
      asset_symbol: vault.asset?.symbol,
      amount: Number(item.shares) / (10 ** (vault.asset?.decimals || 18)),
      value_usd: item.assetsUsd,
      apy_base: apy?.baseApy ? apy.baseApy * 100 : null,
      apy_total: apy?.netApy ? apy.netApy * 100 : null,
      version: vault.version || 'unknown',
      chain: vault.chainId || 1,
      type: 'earn',
      pnl_usd: item.pnlUsd
    };
    
    pos.apy_bonus = (pos.apy_total && pos.apy_base) ? pos.apy_total - pos.apy_base : null;
    
    console.log(`    ✅ ${pos.symbol}: $${(pos.value_usd / 1e6).toFixed(2)}M | APY: ${pos.apy_base?.toFixed(2) || '?'}% + ${pos.apy_bonus?.toFixed(2) || '0'}%`);
    positions.earn.push(pos);
  }
  
  // Step 2: Borrow positions
  const borrowItems = await getBorrowPositions(wallet);
  console.log(`  Borrow positions: ${borrowItems.length}`);
  
  for (const item of borrowItems) {
    const market = item.market || {};
    const loanSymbol = market.loanAsset?.symbol || '?';
    const collSymbol = market.collateralAsset?.symbol || '?';
    
    // Get APY for this market
    const marketApy = await getMarketAPY(market.uniqueKey || market.marketId, market.chainId);
    
    const pos = {
      wallet, label,
      protocol_name: 'Morpho',
      protocol_id: 'morpho',
      symbol: `${loanSymbol}/${collSymbol}`,
      token_address: market.uniqueKey || market.marketId,
      asset_symbol: loanSymbol,
      collateral_symbol: collSymbol,
      value_usd: item.borrowAssetsUsd,
      collateral_usd: item.collateralUsd,
      health_factor: item.healthFactor,
      ltv: item.ltv,
      liquidation_distance: item.priceVariationToLiquidationPrice,
      apy_borrow: marketApy?.borrowApy ? marketApy.borrowApy * 100 : null,
      chain: market.chainId || 1,
      type: 'borrow'
    };
    
    console.log(`    📊 ${pos.symbol}: $${(pos.value_usd / 1e6).toFixed(2)}M borrow | HF: ${pos.health_factor?.toFixed(3)}`);
    positions.borrow.push(pos);
  }
  
  return positions;
}

// ============================================
// Save to database
// ============================================
function savePositions(db, allPositions) {
  const insertPos = db.prepare(`INSERT OR IGNORE INTO positions (wallet, chain, protocol_id, protocol_name, position_type, net_usd, position_index, scanned_at) VALUES (?, ?, 'morpho', 'Morpho', ?, ?, ?, datetime('now'))`);
  const updatePos = db.prepare(`UPDATE positions SET net_usd = ?, scanned_at = datetime('now') WHERE wallet = ? AND chain = ? AND protocol_id = 'morpho' AND position_index = ?`);
  const insertToken = db.prepare(`INSERT INTO position_tokens (position_id, role, symbol, address, amount, apy_base, bonus_supply_apy) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const findPos = db.prepare(`SELECT id FROM positions WHERE wallet = ? AND chain = ? AND protocol_id = 'morpho' AND position_index = ?`);
  const findToken = db.prepare(`SELECT id FROM position_tokens WHERE position_id = ? AND address = ?`);
  const updateToken = db.prepare(`UPDATE position_tokens SET amount = ?, apy_base = ?, bonus_supply_apy = ? WHERE id = ?`);
  
  const transaction = db.transaction(() => {
    for (const type of ['earn', 'borrow']) {
      for (const pos of allPositions[type]) {
        const posIndex = pos.token_address;
        const netUsd = pos.value_usd || 0;
        
        insertPos.run(pos.wallet, pos.chain, pos.type, netUsd || 0, String(posIndex));
        updatePos.run(netUsd || 0, pos.wallet, pos.chain, String(posIndex));
        
        const posRow = findPos.get(pos.wallet, pos.chain, String(posIndex));
        if (!posRow) continue;
        
        const addr = pos.type === 'earn' ? pos.token_address : 'market_' + pos.token_address;
        const existing = findToken.get(posRow.id, addr);
        if (existing) {
          updateToken.run(pos.amount || 0, pos.apy_base || null, pos.apy_bonus || null, existing.id);
        } else {
          insertToken.run(posRow.id, 'supply', pos.symbol, addr, pos.amount || 0, pos.apy_base || null, pos.apy_bonus || null);
        }
      }
    }
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
  
  savePositions(db, allPositions);
  
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
