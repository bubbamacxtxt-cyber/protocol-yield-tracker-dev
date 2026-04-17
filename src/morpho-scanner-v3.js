#!/usr/bin/env node
/**
 * Morpho Position Scanner v3 (Standalone)
 * 
 * Source of truth for Morpho positions.
 * Creates positions directly - does not rely on DeBank for position data.
 * 
 * Uses:
 * 1. Morpho REST API for all positions (earn + borrow)
 * 2. GraphQL for APY enrichment
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const DB_PATH = require('path').join(__dirname, '..', 'yield-tracker.db');

const MORPHO_REST = 'https://app.morpho.org/api';
const MORPHO_GRAPHQL = 'https://app.morpho.org/api/graphql';
const ALL_CHAINS = [1, 8453, 42161, 137, 130, 747474, 999, 10, 143, 988, 480];

const V1_APY_HASH = 'db4bd5b01c28c4702d575d3cc6718e9fdf02908fe1769a9ac84769183b15d3a1';
const V2_PERF_HASH = '2450946f568dabb9e65946408befef7d15c529139e2a397c75bf64cbccf1aa9b';

// Symbol mapping for vault names to display symbols
const CHAIN_NAMES = {
  1: 'ETH', 8453: 'BASE', 42161: 'ARB', 137: 'MNT',
  10: 'OPT', 5000: 'MNT', 81457: 'BLAST', 534352: 'SCROLL',
  146: 'SONIC', 9745: 'PLASMA', 130: 'UNI', 747474: 'WCT',
};

const SYMBOL_MAP = {
  'senRLUSDv2': 'RLUSD', 'senPYUSDmain': 'PYUSD', 'senPYUSD': 'PYUSD',
  'steakRUSD': 'rUSD', 'steakUSDC': 'USDC', 'steakUSDT': 'USDT',
  'senAUSDv2': 'AUSD', 'senEURv2': 'EUR', 'senGHOv2': 'GHO',
};

// ============================================
// API Calls
// ============================================
async function getEarnPositions(userAddress) {
  const url = `${MORPHO_REST}/positions/earn?userAddress=${userAddress}&limit=500&skip=0&chainIds=${ALL_CHAINS.join(',')}&orderBy=assetsUsd&orderDirection=DESC`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    return (await res.json()).items || [];
  } catch { return []; }
}

async function getBorrowPositions(userAddress) {
  const url = `${MORPHO_REST}/positions/borrow?userAddress=${userAddress}&limit=500&skip=0&chainIds=${ALL_CHAINS.join(',')}&orderBy=borrowAssetsUsd&orderDirection=DESC`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    return (await res.json()).items || [];
  } catch { return []; }
}

async function getVaultAPY(vaultAddress, version) {
  // Try v2 first if indicated
  if (version === '2.0' || version === 'v2') {
    try {
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
      if (v?.netApy != null) return { netApy: v.netApy, baseApy: v.netApyExcludingRewards };
    } catch {}
  }
  
  // Try v1
  try {
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
    const v = data?.data?.vaultByAddress?.state;
    if (v?.netApy != null) return { netApy: v.netApy, baseApy: v.netApyExcludingRewards };
  } catch {}
  
  // Try v2 as fallback for v1 vaults
  try {
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
    if (v?.netApy != null) return { netApy: v.netApy, baseApy: v.netApyExcludingRewards };
  } catch {}
  
  return null;
}

// ============================================
// Scan single wallet
// ============================================
async function scanWallet(wallet, label) {
  const positions = [];
  
  // Fetch earn and borrow in parallel
  const [earnItems, borrowItems] = await Promise.all([
    getEarnPositions(wallet),
    getBorrowPositions(wallet),
  ]);
  
  // Process earn positions
  for (const item of earnItems) {
    const vault = item.vault || {};
    const symbol = SYMBOL_MAP[vault.symbol] || vault.symbol || vault.asset?.symbol || '?';
    const vaultAddress = vault.address;
    const chainId = vault.chainId || 1;
    
    // Get APY (async, but we'll await all later)
    const apy = await getVaultAPY(vaultAddress, vault.version);
    const apyBase = apy?.baseApy != null ? apy.baseApy * 100 : null;
    const apyNet = apy?.netApy != null ? apy.netApy * 100 : null;
    const bonus = (apyNet != null && apyBase != null) ? apyNet - apyBase : null;
    
    positions.push({
      wallet, label,
      chain: CHAIN_NAMES[chainId] || String(chainId),
      chainId,
      protocol_name: 'Morpho',
      protocol_id: 'morpho',
      position_type: 'supply',
      strategy: 'Lend',
      symbol,
      token_address: vaultAddress,
      asset_address: vault.asset?.address,
      asset_symbol: vault.asset?.symbol,
      amount: item.shares,
      value_usd: item.assetsUsd || 0,
      apy_base: apyBase,
      apy_bonus: bonus,
      pnl_usd: item.pnlUsd,
    });
  }
  
  // Process borrow positions
  for (const item of borrowItems) {
    const market = item.market || {};
    const loanSymbol = market.loanAsset?.symbol || '?';
    const collSymbol = market.collateralAsset?.symbol || '?';
    const chainId = market.chainId || 1;
    
    positions.push({
      wallet, label,
      chain: CHAIN_NAMES[chainId] || String(chainId),
      chainId,
      protocol_name: 'Morpho',
      protocol_id: 'morpho',
      position_type: 'borrow',
      strategy: 'Borrow',
      symbol: loanSymbol,
      collateral_symbol: collSymbol,
      token_address: market.uniqueKey || market.marketId,
      amount: item.borrowShares,
      value_usd: item.borrowAssetsUsd || 0,
      collateral_usd: item.collateralUsd || 0,
      health_factor: item.healthFactor,
      ltv: item.ltv,
      liquidation_distance: item.priceVariationToLiquidationPrice,
      apy_borrow: null,
    });
  }
  
  return positions;
}

// ============================================
// Save to database (upsert by wallet + symbol + role)
// ============================================
function savePositions(db, allPositions) {
  const upsertPos = db.prepare(`
    INSERT INTO positions (wallet, chain, protocol_id, protocol_name, position_type, net_usd, position_index, scanned_at)
    VALUES (?, ?, 'morpho', 'Morpho', ?, ?, ?, datetime('now'))
    ON CONFLICT(wallet, chain, protocol_id, position_index) DO UPDATE SET
      net_usd = excluded.net_usd,
      position_type = excluded.position_type,
      scanned_at = datetime('now')
  `);
  
  const findPos = db.prepare(`SELECT id FROM positions WHERE wallet = ? AND chain = ? AND protocol_id = 'morpho' AND position_index = ?`);
  
  const upsertToken = db.prepare(`
    INSERT INTO position_tokens (position_id, role, symbol, address, amount, value_usd, apy_base, bonus_supply_apy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const clearTokens = db.prepare(`DELETE FROM position_tokens WHERE position_id = ? AND role = ?`);
  
  const transaction = db.transaction(() => {
    for (const pos of allPositions) {
      const role = pos.position_type === 'supply' ? 'supply' : 'borrow';
      const posIndex = pos.token_address;
      const netUsd = role === 'borrow' ? -pos.value_usd : pos.value_usd;
      
      // Upsert position
      upsertPos.run(pos.wallet, pos.chainId, pos.position_type, netUsd || 0, String(posIndex));
      const posRow = findPos.get(pos.wallet, pos.chainId, String(posIndex));
      if (!posRow) continue;
      
      // Clear and re-insert tokens (ensures fresh data each scan)
      clearTokens.run(posRow.id, role);
      
      upsertToken.run(
        posRow.id, role, pos.symbol, pos.token_address,
        pos.amount || 0, pos.value_usd || 0,
        pos.apy_base || null, pos.apy_bonus || null
      );
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
    { addr: '0x41a9eb398518d2487301c61d2b33e4e966a9f1dd', label: 'Reservoir-4' },
    { addr: '0x502d222e8e4daef69032f55f0c1a999effd78fb3', label: 'Reservoir-5' },
  ];
  
  const db = new Database(DB_PATH);
  const allPositions = [];
  
  console.log('=== Morpho Scanner v3 (Standalone) ===\n');
  
  for (const w of wallets) {
    console.log(`--- ${w.label} (${w.addr.slice(0,12)}) ---`);
    const positions = await scanWallet(w.addr, w.label);
    
    for (const p of positions) {
      const usd = (p.value_usd / 1e6).toFixed(2);
      const apy = p.apy_base?.toFixed(2) || '?';
      const bonus = p.apy_bonus?.toFixed(2) || '0';
      const type = p.position_type === 'supply' ? '✅' : '📊';
      console.log(`  ${type} ${p.symbol}: $${usd}M | ${p.position_type} | APY: ${apy}% + ${bonus}%`);
    }
    
    allPositions.push(...positions);
  }
  
  savePositions(db, allPositions);
  
  console.log(`\n=== Summary ===`);
  console.log(`Total positions: ${allPositions.length}`);
  console.log(`Supply: ${allPositions.filter(p => p.position_type === 'supply').length}`);
  console.log(`Borrow: ${allPositions.filter(p => p.position_type === 'borrow').length}`);
  
  db.close();
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { scanWallet, savePositions };
