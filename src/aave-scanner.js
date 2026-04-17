#!/usr/bin/env node
/**
 * Aave v3 Position Scanner (Multi-chain)
 * 
 * Enriches existing DeBank positions with supply/borrow tokens from Aave GraphQL.
 * Scans all chains where Aave V3 operates.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const DB_PATH = require('path').join(__dirname, '..', 'yield-tracker.db');

const AAVE_GRAPHQL = 'https://api.v3.aave.com/graphql';

const AAVE_POOLS = {
  1: { chainName: 'eth', pools: ['0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'] },
  8453: { chainName: 'base', pools: ['0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'] },
  42161: { chainName: 'arb', pools: ['0x794a61358D6845594F94dc1DB02A252b5b4814aD'] },
  137: { chainName: 'poly', pools: ['0x794a61358D6845594F94dc1DB02A252b5b4814aD'] },
  9745: { chainName: 'plasma', pools: ['0x925a2A7214Ed92428B5b1B090F80b25700095e12'] },
  5000: { chainName: 'mnt', pools: ['0x458F293454fE0d67EC0655f3672301301DD51422'] },
};

async function getUserSupplies(userAddress, chainId) {
  const poolInfo = AAVE_POOLS[chainId];
  if (!poolInfo) return [];
  const marketInputs = poolInfo.pools.map(addr => `{ address: "${addr}", chainId: ${chainId} }`).join(', ');
  try {
    const res = await fetch(AAVE_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ userSupplies(request: { user: "${userAddress}", markets: [${marketInputs}] }) { currency { symbol } balance { usd } apy { value } isCollateral } }`
      })
    });
    const data = await res.json();
    return data?.data?.userSupplies || [];
  } catch { return []; }
}

async function getUserBorrows(userAddress, chainId) {
  const poolInfo = AAVE_POOLS[chainId];
  if (!poolInfo) return [];
  const marketInputs = poolInfo.pools.map(addr => `{ address: "${addr}", chainId: ${chainId} }`).join(', ');
  try {
    const res = await fetch(AAVE_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ userBorrows(request: { user: "${userAddress}", markets: [${marketInputs}] }) { currency { symbol } debt { usd } apy { value } } }`
      })
    });
    const data = await res.json();
    return data?.data?.userBorrows || [];
  } catch { return []; }
}

async function scanWalletChain(wallet, chainId, chainName, db) {
  const [supplies, borrows] = await Promise.all([
    getUserSupplies(wallet, chainId),
    getUserBorrows(wallet, chainId),
  ]);
  
  if (supplies.length === 0 && borrows.length === 0) return 0;
  
  console.log(`  ${chainName}: ${supplies.length} supply, ${borrows.length} borrow`);
  let enriched = 0;
  
  const insertToken = db.prepare(`
    INSERT OR REPLACE INTO position_tokens (position_id, role, symbol, address, value_usd, apy_base, bonus_supply_apy)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertReward = db.prepare(`
    INSERT OR REPLACE INTO position_tokens (position_id, role, symbol, address, value_usd, apy_base)
    VALUES (?, 'reward', ?, ?, ?, ?)
  `);
  
  const transaction = db.transaction(() => {
    for (const s of supplies) {
      const symbol = s.currency?.symbol;
      if (!symbol) continue;
      const apyBase = parseFloat(s.apy?.value || 0) * 100;
      const valueUsd = parseFloat(s.balance?.usd || 0);
      
      // Find or create position
      let pos = db.prepare(`SELECT id FROM positions WHERE wallet = ? AND chain = ? AND protocol_name = 'Aave V3'`).get(wallet, chainName);
      if (!pos) {
        // Create position entry for this chain
        const result = db.prepare(`INSERT INTO positions (wallet, chain, protocol_name, protocol_id, position_type, strategy, net_usd, position_index, scanned_at)
          VALUES (?, ?, 'Aave V3', 'aave-v3', 'Lending', 'lend', ?, '', datetime('now'))`).run(wallet, chainName, valueUsd);
        pos = { id: result.lastInsertRowid };
        console.log(`    Created position ${pos.id} for ${wallet.slice(0,10)} ${chainName}`);
      }
      insertToken.run(pos.id, 'supply', symbol, '', valueUsd, apyBase, null);
      enriched++;
    }
    
    for (const b of borrows) {
      const symbol = b.currency?.symbol;
      if (!symbol) continue;
      const apyBorrow = parseFloat(b.apy?.value || 0) * 100;
      const valueUsd = parseFloat(b.debt?.usd || 0);
      
      let pos = db.prepare(`SELECT id FROM positions WHERE wallet = ? AND chain = ? AND protocol_name = 'Aave V3'`).get(wallet, chainName);
      if (!pos) continue; // Should have been created by supply
      insertToken.run(pos.id, 'borrow', symbol, '', valueUsd, apyBorrow, null);
      enriched++;
    }
  });
  
  transaction();
  return enriched;
}

async function scanWallet(wallet, label, db) {
  console.log(`\n--- ${label} (${wallet.slice(0,12)}) ---`);
  let totalEnriched = 0;
  
  // Scan all chains
  for (const [chainId, info] of Object.entries(AAVE_POOLS)) {
    const enriched = await scanWalletChain(wallet, parseInt(chainId), info.chainName, db);
    totalEnriched += enriched || 0;
  }
  
  if (totalEnriched === 0) console.log('  No positions found');
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
  console.log('=== Aave v3 Scanner (Multi-chain) ===');
  
  for (const w of wallets) {
    await scanWallet(w.addr, w.label, db);
  }
  
  db.close();
}

if (require.main === module) {
  main().catch(console.error);
}
