#!/usr/bin/env node
/**
 * Morpho REST API Position Discovery
 * Uses the same endpoints as app.morpho.org website
 * 
 * GET /api/positions/earn?userAddress=...&chainIds=...&limit=500&skip=0
 * GET /api/positions/borrow?userAddress=...&chainIds=...&limit=500&skip=0
 */

const BASE_URL = 'https://app.morpho.org/api';

// All chains Morpho supports
const CHAIN_IDS = [1, 8453, 42161, 137, 130, 747474, 999, 10, 143, 988, 480];

async function getEarnPositions(userAddress, chainIds = CHAIN_IDS) {
  const url = `${BASE_URL}/positions/earn?userAddress=${userAddress}&limit=500&skip=0&chainIds=${chainIds.join(',')}&orderBy=assetsUsd&orderDirection=DESC&faceting=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Earn API error: ${res.status}`);
  const data = await res.json();
  return data.items || [];
}

async function getBorrowPositions(userAddress, chainIds = CHAIN_IDS) {
  const url = `${BASE_URL}/positions/borrow?userAddress=${userAddress}&limit=500&skip=0&chainIds=${chainIds.join(',')}&orderBy=borrowAssetsUsd&orderDirection=DESC&faceting=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Borrow API error: ${res.status}`);
  const data = await res.json();
  return data.items || [];
}

// Format a position for display
function formatPosition(pos, type) {
  const m = pos.market || {};
  const loan = m.loanAsset?.symbol || '?';
  const coll = m.collateralAsset?.symbol || '?';
  const chain = m.chainId;
  
  if (type === 'borrow') {
    return {
      chain,
      pair: `${loan}/${coll}`,
      collateralUsd: pos.collateralUsd,
      borrowUsd: pos.borrowAssetsUsd,
      healthFactor: pos.healthFactor,
      ltv: pos.ltv,
      liquidationDistance: pos.priceVariationToLiquidationPrice,
      marketId: m.uniqueKey || m.marketId
    };
  } else {
    return {
      chain,
      asset: loan,
      assetsUsd: pos.assetsUsd,
      shares: pos.shares,
      assets: pos.assets,
      marketId: m.uniqueKey || m.marketId
    };
  }
}

// Scan all positions for a wallet
async function scanPositions(userAddress) {
  const earn = await getEarnPositions(userAddress);
  const borrow = await getBorrowPositions(userAddress);
  
  return {
    earn: earn.map(p => formatPosition(p, 'earn')),
    borrow: borrow.map(p => formatPosition(p, 'borrow')),
    totalEarnUsd: earn.reduce((a, p) => a + (p.assetsUsd || 0), 0),
    totalBorrowUsd: borrow.reduce((a, p) => a + (p.borrowAssetsUsd || 0), 0),
    healthFactors: borrow.map(p => p.healthFactor).filter(Boolean)
  };
}

module.exports = { getEarnPositions, getBorrowPositions, scanPositions, formatPosition };

// CLI
if (require.main === module) {
  const wallet = process.argv[2] || '0x815f5BB257e88b67216a344C7C83a3eA4EE74748';
  
  async function main() {
    console.log(`=== Morpho Position Scanner (REST API) ===`);
    console.log(`Wallet: ${wallet}\n`);
    
    const result = await scanPositions(wallet);
    
    console.log(`EARN (vault) positions: ${result.earn.length}`);
    for (const p of result.earn) {
      console.log(`  ${p.asset}: $${(p.assetsUsd / 1e6).toFixed(2)}M`);
    }
    
    console.log(`\nBORROW positions: ${result.borrow.length}`);
    for (const p of result.borrow) {
      console.log(`  ${p.pair} (chain ${p.chain}):`);
      console.log(`    Collateral: $${(p.collateralUsd / 1e6).toFixed(2)}M`);
      console.log(`    Borrow: $${(p.borrowUsd / 1e6).toFixed(2)}M`);
      console.log(`    Health Factor: ${p.healthFactor?.toFixed(3)}`);
      console.log(`    LTV: ${(p.ltv * 100).toFixed(1)}%`);
    }
    
    console.log(`\nTotals:`);
    console.log(`  Earn: $${(result.totalEarnUsd / 1e6).toFixed(2)}M`);
    console.log(`  Borrow: $${(result.totalBorrowUsd / 1e6).toFixed(2)}M`);
    console.log(`  Min Health: ${Math.min(...result.healthFactors).toFixed(3)}`);
  }
  
  main().catch(console.error);
}
