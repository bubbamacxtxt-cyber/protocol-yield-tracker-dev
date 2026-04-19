#!/usr/bin/env node
/**
 * Aave v3 Scanner - Reservoir Only
 * 
 * Direct Aave GraphQL queries - NO DeBank dependency for position data.
 * DeBank is only used to discover which chains have positions (initial scan).
 * 
 * Flow:
 * 1. For each Reservoir wallet, query Aave GraphQL on all chains
 * 2. Create positions directly from Aave data
 * 3. Include supply tokens, borrow tokens, APY, health factor
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const path = require('path');
const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');

const AAVE_GRAPHQL = 'https://api.v3.aave.com/graphql';

// Aave v3 pool addresses per chain
const AAVE_POOLS = {
  eth:    { chainId: 1,    pools: ['0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', '0x0AA97c284e98396202b6A04024F5E2c65026F3c0', '0x4e033931ad43597d96D6bcc25c280717730B58B1'] },
  base:   { chainId: 8453, pools: ['0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'] },
  arb:    { chainId: 42161, pools: ['0x794a61358D6845594F94dc1DB02A252b5b4814aD'] },
  plasma: { chainId: 9745, pools: ['0x925a2A7214Ed92428B5b1B090F80b25700095e12'] },
  mnt:    { chainId: 5000, pools: ['0x458F293454fE0d67EC0655f3672301301DD51422'] },
  poly:   { chainId: 137,  pools: ['0x794a61358D6845594F94dc1DB02A252b5b4814aD'] },
};

async function queryAave(user, chainId, pools) {
  const marketInputs = pools.map(addr => `{ address: "${addr}", chainId: ${chainId} }`).join(', ');
  const query = `{
    userSupplies(request: { user: "${user}", markets: [${marketInputs}] }) {
      currency { symbol }
      balance { usd }
      apy { value }
      isCollateral
    }
    userBorrows(request: { user: "${user}", markets: [${marketInputs}] }) {
      currency { symbol }
      debt { usd }
      apy { value }
    }
    userMarketState(request: { user: "${user}", market: "${pools[0]}", chainId: ${chainId} }) {
      healthFactor
    }
  }`;
  
  const res = await fetch(AAVE_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  const data = await res.json();
  return data?.data || {};
}

function upsertPosition(db, wallet, chain, chainId, aaveData) {
  const { userSupplies = [], userBorrows = [], userMarketState } = aaveData;
  
  // Skip if no supplies and no borrows
  if (userSupplies.length === 0 && userBorrows.length === 0) return null;
  
  const totalSupply = userSupplies.reduce((s, x) => s + parseFloat(x.balance?.usd || 0), 0);
  const totalBorrow = userBorrows.reduce((s, x) => s + parseFloat(x.debt?.usd || 0), 0);
  const netUsd = totalSupply - totalBorrow;
  
  const hf = userMarketState?.healthFactor ? parseFloat(userMarketState.healthFactor) : null;
  
  // Find existing position or create new one
  const existing = db.prepare(
    "SELECT id FROM positions WHERE wallet = ? AND chain = ? AND protocol_name = 'Aave V3'"
  ).get(wallet, chain);
  
  let positionId;
  if (existing) {
    db.prepare(`
      UPDATE positions SET
        net_usd = ?, asset_usd = ?, debt_usd = ?, health_rate = ?, scanned_at = datetime('now')
      WHERE id = ?
    `).run(netUsd, totalSupply, totalBorrow, hf, existing.id);
    positionId = existing.id;
  } else {
    const result = db.prepare(`
      INSERT INTO positions (wallet, chain, protocol_id, protocol_name, position_type, strategy, net_usd, asset_usd, debt_usd, health_rate, position_index, scanned_at)
      VALUES (?, ?, 'aave-v3', 'Aave V3', 'Lending', 'lend', ?, ?, ?, ?, '', datetime('now'))
    `).run(wallet, chain, netUsd, totalSupply, totalBorrow, hf);
    positionId = result.lastInsertRowid;
  }
  
  // Clear existing tokens
  db.prepare("DELETE FROM position_tokens WHERE position_id = ?").run(positionId);
  
  // Insert supply tokens
  for (const s of userSupplies) {
    db.prepare(`
      INSERT INTO position_tokens (position_id, role, symbol, address, value_usd, apy_base)
      VALUES (?, 'supply', ?, ?, ?, ?)
    `).run(
      positionId,
      s.currency?.symbol || '?',
      s.currency?.address || '',
      parseFloat(s.balance?.usd || 0),
      parseFloat(s.apy?.value || 0) * 100  // Convert to percent
    );
  }
  
  // Insert borrow tokens
  for (const b of userBorrows) {
    db.prepare(`
      INSERT INTO position_tokens (position_id, role, symbol, address, value_usd, apy_base)
      VALUES (?, 'borrow', ?, ?, ?, ?)
    `).run(
      positionId,
      b.currency?.symbol || '?',
      b.currency?.address || '',
      parseFloat(b.debt?.usd || 0),
      parseFloat(b.apy?.value || 0) * 100
    );
  }
  
  return { positionId, supplies: userSupplies.length, borrows: userBorrows.length };
}

async function scanWallet(db, wallet, label) {
  console.log(`\n--- ${label} (${wallet.slice(0,12)}) ---`);
  let totalPositions = 0;
  
  for (const [chain, info] of Object.entries(AAVE_POOLS)) {
    const data = await queryAave(wallet, info.chainId, info.pools);
    const result = upsertPosition(db, wallet, chain, info.chainId, data);
    
    if (result) {
      totalPositions++;
      console.log(`  ${chain}: ${result.supplies} supply, ${result.borrows} borrow`);
    }
  }
  
  if (totalPositions === 0) console.log('  No Aave positions');
  return totalPositions;
}

async function main() {
  const db = new Database(DB_PATH);
  const fs = require('fs');
  
  // Load all whale wallets from whales.json
  const whales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));
  const walletMap = [];
  for (const [name, config] of Object.entries(whales)) {
    const wallets = Array.isArray(config) ? config : (config.vaults ? Object.values(config.vaults).flat() : []);
    for (const w of wallets) {
      walletMap.push({ addr: w.toLowerCase(), label: name });
    }
  }
  
  console.log('=== Aave v3 Scanner ===');
  console.log(`Scanning ${walletMap.length} wallets on ${Object.keys(AAVE_POOLS).length} chains`);
  
  let totalFound = 0;
  for (const w of walletMap) {
    const found = await scanWallet(db, w.addr, w.label);
    totalFound += found;
    await new Promise(r => setTimeout(r, 100)); // Rate limit
  }
  
  console.log(`\n=== Done: ${totalFound} positions found ===`);
  db.close();
}

main().catch(console.error);
