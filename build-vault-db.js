#!/usr/bin/env node
/**
 * Build complete Morpho vault database
 * Fields: address, symbol, asset_address, asset_symbol, chain_id, version
 * Sources: 
 *   - Internal API for v2 vaults (full data: asset, chain, etc)
 *   - Public API for v1 vaults
 */

const Database = require('better-sqlite3');
const fs = require('fs');

const INTERNAL_API = 'https://app.morpho.org/api/graphql';
const PUBLIC_API = 'https://api.morpho.org/graphql';

const CHAIN_IDS = [1, 42161, 8453, 10, 137, 56, 250, 100, 2500, 81457, 534352, 59144, 84532];
const CHAIN_NAMES = {
  1: 'ethereum', 42161: 'arbitrum', 8453: 'base', 10: 'optimism', 
  137: 'polygon', 56: 'bsc', 250: 'fantom', 100: 'gnosis',
  2500: 'avalanche', 81457: 'blast', 534352: 'scroll', 59144: 'linea',
  84532: 'base-sepolia'
};

async function fetchV2Vaults(chainId, limit = 200) {
  const allVaults = [];
  let skip = 0;
  let hasMore = true;
  
  while (hasMore) {
    const res = await fetch(INTERNAL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ vaultV2s(first: ${limit}, skip: ${skip}, where: { chainId_in: [${chainId}] }) { items { address symbol asset { address symbol } } } }`
      })
    });
    const data = await res.json();
    const items = data?.data?.vaultV2s?.items || [];
    allVaults.push(...items.map(v => ({
      address: v.address,
      symbol: v.symbol || null,
      asset_address: v.asset?.address || null,
      asset_symbol: v.asset?.symbol || null,
      chain_id: chainId,
      version: 'v2'
    })));
    
    if (items.length < limit) hasMore = false;
    skip += limit;
  }
  
  return allVaults;
}

async function fetchV1Vaults() {
  // v1 vaults from public API - check if they have asset info now
  const res = await fetch(PUBLIC_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `{ vaults(first: 200) { items { address symbol asset { address symbol } } } }`
    })
  });
  const data = await res.json();
  const items = data?.data?.vaults?.items || [];
  return items.map(v => ({
    address: v.address,
    symbol: v.symbol || null,
    asset_address: v.asset?.address || null,
    asset_symbol: v.asset?.symbol || null,
    chain_id: 1,
    version: 'v1'
  }));
}

async function main() {
  console.log('=== Building Morpho Vault Database ===\n');
  
  const db = new Database('yield-tracker.db');
  
  // Create table
  db.exec(`
    DROP TABLE IF EXISTS morpho_vaults;
    CREATE TABLE morpho_vaults (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      symbol TEXT,
      asset_address TEXT,
      asset_symbol TEXT,
      chain_id INTEGER NOT NULL,
      chain_name TEXT,
      version TEXT NOT NULL,
      first_seen TEXT DEFAULT (datetime('now')),
      UNIQUE(address, chain_id)
    )
  `);
  
  const insert = db.prepare(`
    INSERT OR IGNORE INTO morpho_vaults (address, symbol, asset_address, asset_symbol, chain_id, chain_name, version)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  let totalVaults = 0;
  
  // Fetch v1 vaults (Ethereum only)
  console.log('Fetching v1 vaults from public API...');
  const v1 = await fetchV1Vaults();
  console.log(`  v1: ${v1.length} vaults`);
  for (const v of v1) {
    insert.run(v.address, v.symbol, v.asset_address, v.asset_symbol, v.chain_id, CHAIN_NAMES[v.chain_id], v.version);
    totalVaults++;
  }
  
  // Fetch v2 vaults per chain
  for (const chainId of CHAIN_IDS) {
    console.log(`Fetching v2 vaults for chain ${chainId} (${CHAIN_NAMES[chainId] || 'unknown'})...`);
    const v2 = await fetchV2Vaults(chainId);
    console.log(`  ${CHAIN_NAMES[chainId] || chainId}: ${v2.length} vaults`);
    
    for (const v of v2) {
      insert.run(v.address, v.symbol, v.asset_address, v.asset_symbol, v.chain_id, CHAIN_NAMES[v.chain_id], v.version);
      totalVaults++;
    }
  }
  
  // Summary
  const stats = db.prepare(`
    SELECT chain_name, version, COUNT(*) as count 
    FROM morpho_vaults 
    GROUP BY chain_name, version 
    ORDER BY chain_name, version
  `).all();
  
  console.log('\n=== Database Summary ===');
  let grandTotal = 0;
  for (const s of stats) {
    console.log(`  ${(s.chain_name || 'unknown').padEnd(12)} ${s.version}: ${s.count}`);
    grandTotal += s.count;
  }
  console.log(`\nTotal: ${grandTotal} vaults`);
  
  // Check data completeness
  const withAsset = db.prepare('SELECT COUNT(*) as c FROM morpho_vaults WHERE asset_address IS NOT NULL').get();
  console.log(`With asset info: ${withAsset.c}/${grandTotal}`);
  
  db.close();
}

main().catch(console.error);
