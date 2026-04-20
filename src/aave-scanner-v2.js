#!/usr/bin/env node
/**
 * Aave v3 Position Scanner v2 (Standalone)
 * 
 * Source of truth for Aave v3 positions.
 * Creates positions directly from Aave GraphQL API.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const Database = require('better-sqlite3');
const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');

const AAVE_GRAPHQL = 'https://api.v3.aave.com/graphql';
const MERIT_API = 'https://apps.aavechan.com/api/merit/aprs';

// Known market addresses per chain
const CHAIN_NAMES = {
  1: 'eth', 8453: 'base', 42161: 'arb', 137: 'poly',
  10: 'opt', 5000: 'mnt', 81457: 'blast', 534352: 'scroll',
  146: 'sonic', 9745: 'plasma', 130: 'uni', 747474: 'wct',
  143: 'monad', 999: 'ink',
};

const MARKETS = {
  1: [
    '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', // AaveV3Ethereum
    '0x0AA97c284e98396202b6A04024F5E2c65026F3c0', // EtherFi
    '0x4e033931ad43597d96D6bcc25c280717730B58B1', // Lido
    '0xAe05Cd22df81871bc7cC2a04BeCfb516bFe332C8', // Horizon
  ],
  8453: ['0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'],
  42161: ['0x794a61358D6845594F94dc1DB02A252b5b4814aD'],
  137: ['0x794a61358D6845594F94dc1DB02A252b5b4814aD'],
};

async function getUserSupplies(userAddress, chainId) {
  const markets = MARKETS[chainId] || MARKETS[1];
  const marketInputs = markets.map(addr => `{ address: "${addr}", chainId: ${chainId} }`).join(', ');
  try {
    const res = await fetch(AAVE_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ userSupplies(request: { user: "${userAddress}", markets: [${marketInputs}] }) { currency { symbol address } balance { amount { value } usd } apy { value } isCollateral } }`
      })
    });
    const data = await res.json();
    return data?.data?.userSupplies || [];
  } catch { return []; }
}

async function getUserBorrows(userAddress, chainId) {
  const markets = MARKETS[chainId] || MARKETS[1];
  const marketInputs = markets.map(addr => `{ address: "${addr}", chainId: ${chainId} }`).join(', ');
  try {
    const res = await fetch(AAVE_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ userBorrows(request: { user: "${userAddress}", markets: [${marketInputs}] }) { currency { symbol address } debt { amount { value } usd } apy { value } } }`
      })
    });
    const data = await res.json();
    return data?.data?.userBorrows || [];
  } catch { return []; }
}

async function getUserMarketState(userAddress, marketAddress, chainId) {
  try {
    const res = await fetch(AAVE_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ userMarketState(request: { user: "${userAddress}", market: "${marketAddress}", chainId: ${chainId} }) { netWorth healthFactor totalCollateralBase totalDebtBase netAPY { value } } }`
      })
    });
    const data = await res.json();
    return data?.data?.userMarketState || null;
  } catch { return null; }
}

async function getMeritAPRs(userAddress) {
  try {
    const res = await fetch(`${MERIT_API}?user=${userAddress}`);
    const data = await res.json();
    return data?.currentAPR?.actionsAPR || {};
  } catch { return {}; }
}

async function scanWallet(wallet, label) {
  const positions = [];
  const chainId = 1;
  
  const [supplies, borrows, meritAPRs, state] = await Promise.all([
    getUserSupplies(wallet, chainId),
    getUserBorrows(wallet, chainId),
    getMeritAPRs(wallet),
    getUserMarketState(wallet, MARKETS[1][0], chainId),
  ]);
  
  // Process supplies
  for (const s of supplies) {
    const symbol = s.currency?.symbol || '?';
    const apyBase = parseFloat(s.apy?.value || 0) * 100;
    const meritKey = `ethereum-supply-${symbol.toLowerCase()}`;
    const bonus = meritAPRs[meritKey] || null;
    
    positions.push({
      wallet, label,
      chain: CHAIN_NAMES[chainId] || String(chainId),
      chainId,
      protocol_name: 'Aave v3',
      protocol_id: 'aave-v3',
      position_type: 'supply',
      strategy: 'Lend',
      symbol,
      token_address: s.currency?.address,
      amount: parseFloat(s.balance?.amount?.value || 0),
      value_usd: parseFloat(s.balance?.usd || 0),
      apy_base: apyBase,
      apy_bonus: bonus,
      is_collateral: s.isCollateral || false,
    });
  }
  
  // Process borrows
  for (const b of borrows) {
    const symbol = b.currency?.symbol || '?';
    const apyBorrow = parseFloat(b.apy?.value || 0) * 100;
    
    positions.push({
      wallet, label,
      chain: CHAIN_NAMES[chainId] || String(chainId),
      chainId,
      protocol_name: 'Aave v3',
      protocol_id: 'aave-v3',
      position_type: 'borrow',
      strategy: 'Borrow',
      symbol,
      token_address: b.currency?.address,
      amount: parseFloat(b.debt?.amount?.value || 0),
      value_usd: parseFloat(b.debt?.usd || 0),
      apy_base: apyBorrow,  // Store borrow APY as apy_base for cost calculation
    });
  }
  
  return positions;
}

function savePositions(db, allPositions) {
  const upsertPos = db.prepare(`
    INSERT INTO positions (wallet, chain, protocol_id, protocol_name, position_type, net_usd, position_index, scanned_at)
    VALUES (?, ?, 'aave-v3', 'Aave v3', ?, ?, ?, datetime('now'))
    ON CONFLICT(wallet, chain, protocol_id, position_index) DO UPDATE SET
      net_usd = excluded.net_usd,
      position_type = excluded.position_type,
      scanned_at = datetime('now')
  `);
  
  const findPos = db.prepare(`SELECT id FROM positions WHERE wallet = ? AND chain = ? AND protocol_id = 'aave-v3' AND position_index = ?`);
  
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
      
      upsertPos.run(pos.wallet, pos.chain, pos.position_type, netUsd || 0, String(posIndex));
      const posRow = findPos.get(pos.wallet, pos.chain, String(posIndex));
      if (!posRow) continue;
      
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

async function main() {
  const fs = require('fs');
  const whales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));
  const walletMap = [];
  for (const [label, config] of Object.entries(whales)) {
    const addrs = Array.isArray(config) ? config : (config.vaults ? Object.values(config.vaults).flat() : []);
    for (const addr of addrs) {
      walletMap.push({ addr, label });
    }
  }
  
  const db = new Database(DB_PATH);
  const allPositions = [];
  
  console.log('=== Aave v3 Scanner v2 ===\n');
  console.log(`Scanning ${walletMap.length} wallets on ${Object.keys(MARKETS).length} chains\n`);
  
  for (const w of walletMap) {
    const positions = await scanWallet(w.addr, w.label);
    
    for (const p of positions) {
      const usd = (p.value_usd / 1e6).toFixed(2);
      const apy = p.position_type === 'supply' ? (p.apy_base?.toFixed(2) || '?') : (p.apy_borrow?.toFixed(2) || '?');
      const bonus = p.apy_bonus?.toFixed(2) || '0';
      const type = p.position_type === 'supply' ? '✅' : '📊';
      console.log(`  ${type} ${p.symbol}: $${usd}M | ${p.position_type} | APY: ${apy}%${p.apy_bonus ? ' + ' + bonus + '%' : ''}`);
    }
    
    allPositions.push(...positions);
  }
  
  savePositions(db, allPositions);
  
  console.log(`\n=== Summary ===`);
  console.log(`Total: ${allPositions.length} positions found`);
  
  db.close();
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { scanWallet, savePositions };
