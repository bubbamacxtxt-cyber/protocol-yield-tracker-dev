#!/usr/bin/env node
/**
 * Morpho Position Scanner v2 (Simplified)
 * 
 * Enriches existing DeBank positions with APY data from Morpho REST API.
 * Does NOT create new positions - that's DeBank's job.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const DB_PATH = require('path').join(__dirname, '..', 'yield-tracker.db');

const MORPHO_REST = 'https://app.morpho.org/api';
const MORPHO_GRAPHQL = 'https://app.morpho.org/api/graphql';
const ALL_CHAINS = [1, 8453, 42161, 137, 130, 747474, 999, 10, 143, 988, 480];

const V1_APY_HASH = 'db4bd5b01c28c4702d575d3cc6718e9fdf02908fe1769a9ac84769183b15d3a1';
const V2_PERF_HASH = '2450946f568dabb9e65946408befef7d15c529139e2a397c75bf64cbccf1aa9b';

async function getEarnPositions(userAddress) {
  const url = `${MORPHO_REST}/positions/earn?userAddress=${userAddress}&limit=500&skip=0&chainIds=${ALL_CHAINS.join(',')}&orderBy=assetsUsd&orderDirection=DESC`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return data.items || [];
}

async function getBorrowPositions(userAddress) {
  const url = `${MORPHO_REST}/positions/borrow?userAddress=${userAddress}&limit=500&skip=0&chainIds=${ALL_CHAINS.join(',')}&orderBy=borrowAssetsUsd&orderDirection=DESC`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return data.items || [];
}

async function getVaultAPY(vaultAddress, version) {
  if (version === '2.0' || version === 'v2') {
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

async function getMarketAPY(marketId, chainId) {
  const res = await fetch(MORPHO_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `{ marketStateByUniqueKey(marketId: "${marketId}", chainId: ${chainId}) { supplyApy borrowApy } }`
    })
  });
  const data = await res.json();
  return data?.data?.marketStateByUniqueKey || null;
}

const symbolMap = {
  'senRLUSDv2': 'RLUSD', 'senPYUSDmain': 'PYUSD',
  'steakRUSD': 'rUSD', 'steakUSDC': 'USDC',
};

async function scanWallet(wallet, label, db) {
  console.log(`\n--- ${label} (${wallet.slice(0,12)}) ---`);
  
  const [earnItems, borrowItems] = await Promise.all([
    getEarnPositions(wallet),
    getBorrowPositions(wallet),
  ]);
  
  console.log(`  Earn: ${earnItems.length}, Borrow: ${borrowItems.length}`);
  
  // Pre-fetch all APYs (async, before DB transaction)
  const apyData = new Map();
  for (const item of earnItems) {
    const vault = item.vault || {};
    const apy = await getVaultAPY(vault.address, vault.version);
    apyData.set(vault.address, apy);
  }
  
  for (const item of borrowItems) {
    const market = item.market || {};
    const marketApy = await getMarketAPY(market.uniqueKey, market.chainId);
    apyData.set(market.uniqueKey, marketApy);
  }
  
  // Now update DB with pre-fetched APYs
  const findSupply = db.prepare(`SELECT p.id, pt.id as token_id FROM positions p JOIN position_tokens pt ON pt.position_id = p.id WHERE p.wallet = ? AND p.protocol_name = 'Morpho' AND pt.symbol = ? AND pt.role = 'supply'`);
  const findBorrow = db.prepare(`SELECT p.id, pt.id as token_id FROM positions p JOIN position_tokens pt ON pt.position_id = p.id WHERE p.wallet = ? AND p.protocol_name = 'Morpho' AND pt.symbol = ? AND pt.role = 'borrow'`);
  const updateToken = db.prepare(`UPDATE position_tokens SET apy_base = ?, bonus_supply_apy = ?, value_usd = ? WHERE id = ?`);
  const updateNet = db.prepare(`UPDATE positions SET net_usd = ?, scanned_at = datetime('now') WHERE id = ?`);
  
  let enriched = 0;
  const transaction = db.transaction(() => {
    for (const item of earnItems) {
      const vault = item.vault || {};
      const symbol = symbolMap[vault.symbol] || vault.symbol || vault.asset?.symbol;
      if (!symbol) continue;
      
      const apy = apyData.get(vault.address);
      const apyBase = apy?.baseApy ? apy.baseApy * 100 : null;
      const apyNet = apy?.netApy ? apy.netApy * 100 : null;
      const bonus = (apyNet && apyBase) ? apyNet - apyBase : null;
      
      const pos = findSupply.get(wallet, symbol);
      if (pos) {
        updateToken.run(apyBase, bonus, item.assetsUsd || 0, pos.token_id);
        updateNet.run(item.assetsUsd || 0, pos.id);
        enriched++;
      }
    }
    
    for (const item of borrowItems) {
      const market = item.market || {};
      const symbol = market.loanAsset?.symbol;
      if (!symbol) continue;
      
      const marketApy = apyData.get(market.uniqueKey);
      const apyBorrow = marketApy?.borrowApy ? marketApy.borrowApy * 100 : null;
      
      const pos = findBorrow.get(wallet, symbol);
      if (pos) {
        updateToken.run(apyBorrow, null, item.borrowAssetsUsd || 0, pos.token_id);
        updateNet.run(-item.borrowAssetsUsd || 0, pos.id);
        enriched++;
      }
    }
  });
  
  transaction();
  console.log(`  Enriched: ${enriched} positions`);
}

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
  console.log('=== Morpho Scanner v2 (Enrich Only) ===');
  
  for (const w of wallets) {
    await scanWallet(w.addr, w.label, db);
  }
  
  db.close();
}

if (require.main === module) {
  main().catch(console.error);
}
