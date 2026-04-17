#!/usr/bin/env node
/**
 * Euler v2 Scanner - Reservoir Only
 * 
 * Direct Euler subgraph queries for vault positions.
 * Creates positions with supply tokens from Euler API.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const path = require('path');
const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');

const EULER_SUBGRAPH = 'https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-v2-mainnet/latest/gn';

// Known vault → underlying token mapping
const VAULT_UNDERLYING = {
  '0xaf5372792a29dc6b296d6ffd4aa3386aff8f9bb2': { symbol: 'RLUSD', decimals: 18 },
  '0xba98fc35c9dfd69178ad5dce9fa29c64554783b5': { symbol: 'PYUSD', decimals: 18 },
  '0x3a68c35f7c672f18845e6e7f6b6a5c7d5e5f5a5b': { symbol: 'USDC', decimals: 6 },
};

async function querySubgraph(query) {
  const res = await fetch(EULER_SUBGRAPH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  const data = await res.json();
  return data?.data || {};
}

async function getTrackingBalances(wallet) {
  const walletLower = wallet.toLowerCase();
  const query = `{ trackingVaultBalances(where: { account: "${walletLower}" }) { vault { id } balance debt } }`;
  const data = await querySubgraph(query);
  return data?.trackingVaultBalances || [];
}

async function getVaultInfo(vaultAddr) {
  const query = `{
    eulerVault(id: "${vaultAddr.toLowerCase()}") {
      id
      name
      symbol
      asset { id symbol decimals }
    }
  }`;
  const data = await querySubgraph(query);
  return data?.eulerVault || null;
}

async function scanWallet(db, wallet, label) {
  console.log(`\n--- ${label} (${wallet.slice(0,12)}) ---`);
  
  const balances = await getTrackingBalances(wallet);
  if (balances.length === 0) {
    console.log('  No Euler positions');
    return 0;
  }
  
  // Group shares by vault
  const vaultShares = {};
  for (const b of balances) {
    const vaultAddr = (typeof b.vault === 'string' ? b.vault : b.vault?.id)?.toLowerCase();
    if (!vaultAddr) continue;
    if (!vaultShares[vaultAddr]) vaultShares[vaultAddr] = 0n;
    vaultShares[vaultAddr] += BigInt(b.balance || 0);
  }
  
  // Create position or update existing
  let existing = db.prepare(
    "SELECT id FROM positions WHERE wallet = ? AND chain = 'eth' AND protocol_name = 'Euler'"
  ).get(wallet);
  
  let positionId;
  if (existing) {
    // Delete old tokens
    db.prepare("DELETE FROM position_tokens WHERE position_id = ?").run(existing.id);
    positionId = existing.id;
  } else {
    const result = db.prepare(`
      INSERT INTO positions (wallet, chain, protocol_id, protocol_name, position_type, strategy, net_usd, asset_usd, debt_usd, position_index, scanned_at)
      VALUES (?, 'eth', 'euler2', 'Euler', 'Lending', 'lend', 0, 0, 0, '', datetime('now'))
    `).run(wallet);
    positionId = result.lastInsertRowid;
  }
  
  let totalSupply = 0;
  let count = 0;
  
  for (const [vaultAddr, shares] of Object.entries(vaultShares)) {
    if (shares === 0n) continue;
    
    // Create position for each vault with vault address as position_index
    // This allows matching with DeBank positions by underlying token address
    let vaultPosition = db.prepare(
      "SELECT id FROM positions WHERE wallet = ? AND chain = 'eth' AND protocol_name = 'Euler' AND position_index = ?"
    ).get(wallet, vaultAddr);
    
    let vaultPositionId;
    if (vaultPosition) {
      // Update existing - delete old tokens
      db.prepare("DELETE FROM position_tokens WHERE position_id = ?").run(vaultPosition.id);
      vaultPositionId = vaultPosition.id;
    } else {
      // Create new position for this vault
      const result = db.prepare(`
        INSERT INTO positions (wallet, chain, protocol_id, protocol_name, position_type, strategy, net_usd, asset_usd, debt_usd, position_index, scanned_at)
        VALUES (?, 'eth', 'euler2', 'Euler', 'Lending', 'lend', 0, 0, 0, ?, datetime('now'))
      `).run(wallet, vaultAddr);
      vaultPositionId = result.lastInsertRowid;
    }
    
    // Get vault info from subgraph
    let vaultInfo = await getVaultInfo(vaultAddr);
    const symbol = vaultInfo?.symbol || `e${vaultAddr.slice(2, 8)}`;
    const underlying = vaultInfo?.asset?.symbol || VAULT_UNDERLYING[vaultAddr]?.symbol || 'Unknown';
    
    // Insert supply token with USD value of 0 - DeBank merge will fill this in
    db.prepare(`
      INSERT INTO position_tokens (position_id, role, symbol, address, value_usd, apy_base)
      VALUES (?, 'supply', ?, ?, 0, 0)
    `).run(vaultPositionId, symbol, vaultAddr);
    
    console.log(`  ${symbol}: ${(Number(shares) / 1e18).toFixed(2)} shares (${underlying})`);
    count++;
  }
  
  db.prepare(`UPDATE positions SET scanned_at = datetime('now') WHERE id = ?`).run(positionId);
  console.log(`  Created/updated ${count} supply tokens`);
  return count;
}

async function main() {
  const db = new Database(DB_PATH);
  
  const reservoir = [
    { addr: '0x31eae643b679a84b37e3d0b4bd4f5da90fb04a61', label: 'Reservoir-1' },
    { addr: '0x99a95a9e38e927486fc878f41ff8b118eb632b10', label: 'Reservoir-3' },
    { addr: '0x3063c5907faa10c01b242181aa689beb23d2bd65', label: 'Euler-Wallet' },
    { addr: '0x289c204b35859bfb924b9c0759a4fe80f610671c', label: 'Reservoir-2' },
    { addr: '0x41a9eb398518d2487301c61d2b33e4e966a9f1dd', label: 'Reservoir-4' },
  ];
  
  console.log('=== Euler v2 Scanner (Reservoir Only) ===');
  
  let totalFound = 0;
  for (const w of reservoir) {
    const found = await scanWallet(db, w.addr, w.label);
    totalFound += found;
  }
  
  console.log(`\n=== Done: ${totalFound} vault positions ===`);
  db.close();
}

main().catch(console.error);
