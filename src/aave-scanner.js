#!/usr/bin/env node
/**
 * Aave v3 Position Scanner v3
 *
 * Source of truth for Aave v3 positions.
 * Builds combined wallet+chain rows from Aave GraphQL instead of emitting raw supply/borrow fragments.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const Database = require('better-sqlite3');
const { loadActiveWalletChains, loadWhaleWalletMap, hasProtocolHint } = require('./recon-helpers');
const { decomposeAaveFromDebank } = require('./aave-decompose');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const AAVE_GRAPHQL = 'https://api.v3.aave.com/graphql';
const MERIT_API = 'https://apps.aavechan.com/api/merit/aprs';

const CHAIN_NAMES = {
  1: 'eth', 8453: 'base', 42161: 'arb', 137: 'poly',
  10: 'opt', 5000: 'mnt', 81457: 'blast', 534352: 'scroll',
  146: 'sonic', 9745: 'plasma', 130: 'uni', 747474: 'wct',
  143: 'monad', 999: 'ink',
};

const CHAIN_IDS = { eth: 1, base: 8453, arb: 42161, mnt: 5000, plasma: 9745, ink: 999 };

function allowedAaveChainFromRecon(row) {
  const chain = String(row.chain || '').toLowerCase();
  const protocols = (row.protocols || []).map(p => String(p.protocol_id || p.protocol_name || '').toLowerCase());
  const aaveUsd = (row.protocols || []).filter(p => String(p.protocol_id || '').toLowerCase().includes('aave')).reduce((s,p)=>s+Number(p.total_usd||0),0);
  if (aaveUsd < 50000) return false;
  if (!protocols.some(x => x.includes('aave'))) return false;

  // Scan any chain where DeBank shows Aave exposure >= $50K.
  // Chain-gating is owned by loadActiveWalletChains(50000).
  return true;
}

const MARKETS = {
  1: [
    '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    '0x0AA97c284e98396202b6A04024F5E2c65026F3c0',
    '0x4e033931ad43597d96D6bcc25c280717730B58B1',
    '0xAe05Cd22df81871bc7cC2a04BeCfb516bFe332C8',
  ],
  8453: ['0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'],
  42161: ['0x794a61358D6845594F94dc1DB02A252b5b4814aD'],
  5000: ['0x458F293454fE0d67EC0655f3672301301DD51422'],
  9745: ['0x925a2A7214Ed92428B5b1B090F80b25700095e12'],
  999: ['0x5362dBb1e601AbF2a150D1999Be54a4d308f4F6e'],
};

async function gql(query) {
  const res = await fetch(AAVE_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  const data = await res.json();
  return data?.data || {};
}

async function getUserSupplies(userAddress, chainId) {
  const markets = MARKETS[chainId] || [];
  if (!markets.length) return [];
  const marketInputs = markets.map(addr => `{ address: "${addr}", chainId: ${chainId} }`).join(', ');
  try {
    const data = await gql(`{ userSupplies(request: { user: "${userAddress}", markets: [${marketInputs}] }) { currency { symbol address } balance { amount { value } usd } apy { value } isCollateral } }`);
    return data.userSupplies || [];
  } catch { return []; }
}

async function getUserBorrows(userAddress, chainId) {
  const markets = MARKETS[chainId] || [];
  if (!markets.length) return [];
  const marketInputs = markets.map(addr => `{ address: "${addr}", chainId: ${chainId} }`).join(', ');
  try {
    const data = await gql(`{ userBorrows(request: { user: "${userAddress}", markets: [${marketInputs}] }) { currency { symbol address } debt { amount { value } usd } apy { value } } }`);
    return data.userBorrows || [];
  } catch { return []; }
}

async function getUserMarketState(userAddress, marketAddress, chainId) {
  try {
    const data = await gql(`{ userMarketState(request: { user: "${userAddress}", market: "${marketAddress}", chainId: ${chainId} }) { netWorth healthFactor totalCollateralBase totalDebtBase netAPY { value } } }`);
    return data.userMarketState || null;
  } catch { return null; }
}

async function getMeritAPRs(userAddress) {
  try {
    const res = await fetch(`${MERIT_API}?user=${userAddress}`);
    const data = await res.json();
    return data?.currentAPR?.actionsAPR || {};
  } catch { return {}; }
}

function buildCombinedRow(wallet, label, chainId, supplies, borrows, meritAPRs, state) {
  const chain = CHAIN_NAMES[chainId] || String(chainId);
  const supplyTokens = [];
  const borrowTokens = [];

  for (const s of supplies) {
    const symbol = s.currency?.symbol || '?';
    const apyBase = parseFloat(s.apy?.value || 0) * 100;
    const meritKey = `ethereum-supply-${symbol.toLowerCase()}`;
    const bonus = meritAPRs[meritKey] || null;
    supplyTokens.push({
      role: 'supply',
      symbol,
      address: s.currency?.address || '',
      amount: parseFloat(s.balance?.amount?.value || 0),
      value_usd: parseFloat(s.balance?.usd || 0),
      apy_base: apyBase,
      bonus_supply_apy: bonus,
      is_collateral: !!s.isCollateral,
    });
  }

  for (const b of borrows) {
    const symbol = b.currency?.symbol || '?';
    const apyBorrow = parseFloat(b.apy?.value || 0) * 100;
    borrowTokens.push({
      role: 'borrow',
      symbol,
      address: b.currency?.address || '',
      amount: parseFloat(b.debt?.amount?.value || 0),
      value_usd: parseFloat(b.debt?.usd || 0),
      apy_base: apyBorrow,
    });
  }

  const assetUsd = supplyTokens.reduce((s, t) => s + (t.value_usd || 0), 0);
  const debtUsd = borrowTokens.reduce((s, t) => s + (t.value_usd || 0), 0);
  const netUsd = assetUsd - debtUsd;

  return {
    wallet,
    label,
    chain,
    chainId,
    protocol_name: 'Aave V3',
    protocol_id: 'aave-v3',
    position_type: 'Lending',
    strategy: 'lend',
    position_index: `${wallet.toLowerCase()}|${chain}`,
    health_rate: state?.healthFactor ? Number(state.healthFactor) : null,
    net_usd: netUsd,
    asset_usd: assetUsd,
    debt_usd: debtUsd,
    supply: supplyTokens,
    borrow: borrowTokens,
  };
}

async function scanWallet(wallet, label, chainIds) {
  const out = [];
  for (const chainId of (Array.isArray(chainIds) ? chainIds : [chainIds])) {
    const markets = MARKETS[chainId] || [];
    if (!markets.length) continue;
    const [supplies, borrows, meritAPRs, state] = await Promise.all([
      getUserSupplies(wallet, chainId),
      getUserBorrows(wallet, chainId),
      getMeritAPRs(wallet),
      getUserMarketState(wallet, markets[0], chainId),
    ]);

    if ((!supplies || supplies.length === 0) && (!borrows || borrows.length === 0)) continue;
    out.push(buildCombinedRow(wallet, label, chainId, supplies || [], borrows || [], meritAPRs || {}, state || null));
  }
  const filtered = out.filter(r => Math.abs(r.net_usd || 0) >= 50000);
  const decomposed = [];
  for (const row of filtered) {
    const expanded = decomposeAaveFromDebank(row.wallet, row.chain, row);
    decomposed.push(...expanded);
  }
  return decomposed;
}

function savePositions(db, rows) {
  const upsertPos = db.prepare(`
    INSERT INTO positions (wallet, chain, protocol_id, protocol_name, position_type, strategy, health_rate, net_usd, asset_usd, debt_usd, position_index, scanned_at)
    VALUES (?, ?, 'aave-v3', 'Aave V3', 'Lending', 'lend', ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(wallet, chain, protocol_id, position_index) DO UPDATE SET
      health_rate = excluded.health_rate,
      net_usd = excluded.net_usd,
      asset_usd = excluded.asset_usd,
      debt_usd = excluded.debt_usd,
      scanned_at = datetime('now')
  `);
  const findPos = db.prepare(`SELECT id FROM positions WHERE wallet = ? AND chain = ? AND protocol_id = 'aave-v3' AND position_index = ?`);
  const clearTokens = db.prepare(`DELETE FROM position_tokens WHERE position_id = ?`);
  const clearMarkets = db.prepare(`DELETE FROM position_markets WHERE position_id = ?`);
  const insertToken = db.prepare(`
    INSERT INTO position_tokens (position_id, role, symbol, address, amount, value_usd, apy_base, bonus_supply_apy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteOldRows = db.prepare(`SELECT id, chain, position_index FROM positions WHERE lower(wallet) = lower(?) AND protocol_id IN ('aave-v3','aave3','base_aave3','plasma_aave3','mnt_aave3','ink_aave3')`);
  const deletePos = db.prepare(`DELETE FROM positions WHERE id = ?`);

  const tx = db.transaction(() => {
    const seenWalletChain = new Set();
    const keepKeys = new Set(rows.map(r => `${r.wallet.toLowerCase()}|${r.chain}|${r.position_index}`));
    for (const row of rows) {
      const walletKey = `${row.wallet.toLowerCase()}`;
      if (!seenWalletChain.has(walletKey)) {
        seenWalletChain.add(walletKey);
        const old = deleteOldRows.all(row.wallet);
        for (const r of old) {
          const staleKey = `${row.wallet.toLowerCase()}|${r.chain}|${r.position_index}`;
          if (!keepKeys.has(staleKey)) {
            clearMarkets.run(r.id);
            clearTokens.run(r.id);
            deletePos.run(r.id);
          }
        }
      }

      upsertPos.run(row.wallet, row.chain, row.health_rate, row.net_usd, row.asset_usd, row.debt_usd, row.position_index);
      const pos = findPos.get(row.wallet, row.chain, row.position_index);
      if (!pos) continue;
      clearTokens.run(pos.id);
      for (const t of row.supply) {
        insertToken.run(pos.id, 'supply', t.symbol, t.address, t.amount || 0, t.value_usd || 0, t.apy_base || null, t.bonus_supply_apy || null);
      }
      for (const t of row.borrow) {
        insertToken.run(pos.id, 'borrow', t.symbol, t.address, t.amount || 0, t.value_usd || 0, t.apy_base || null, null);
      }
    }
  });
  tx();
}

async function main() {
  let walletMap = [];
  const active = loadActiveWalletChains();
  if (active && active.length > 0) {
    const labelByWallet = new Map(loadWhaleWalletMap().map(w => [w.addr, w.label]));
    const seen = new Set();
    for (const row of active) {
      // Removed hasProtocolHint gate (2026-04-22 audit GAP 1).
      // We used to skip wallets where DeBank didn't mention Aave, but that
      // makes coverage depend on DeBank's protocol detection being perfect.
      // Instead: scan every active wallet+chain where Aave V3 is deployed.
      // Aave GraphQL returns empty for wallets with no position — no cost.
      if (!allowedAaveChainFromRecon(row)) continue;
      const chainId = CHAIN_IDS[String(row.chain || '').toLowerCase()];
      if (!chainId) continue;
      const key = `${row.wallet}|${chainId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      walletMap.push({ addr: row.wallet, label: labelByWallet.get(row.wallet) || row.whale || 'Unknown', chainId });
    }
  } else {
    const fs = require('fs');
    const whales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));
    for (const [label, config] of Object.entries(whales)) {
      const addrs = Array.isArray(config) ? config : (config.vaults ? Object.values(config.vaults).flat() : []);
      for (const addr of addrs) walletMap.push({ addr, label, chainId: 1 });
    }
  }

  const db = new Database(DB_PATH);
  const rows = [];
  console.log('=== Aave v3 Scanner v3 ===\n');
  console.log(`Scanning ${walletMap.length} wallet+chain pairs\n`);

  for (const w of walletMap) {
    const walletRows = await scanWallet(w.addr, w.label, [w.chainId || 1]);
    if (!walletRows || walletRows.length === 0) continue;
    for (const row of walletRows) {
      console.log(`  ${w.label} ${w.addr.slice(0,10)} ${row.chain}: $${(row.net_usd/1e6).toFixed(2)}M net | supply ${row.supply.length} | borrow ${row.borrow.length}`);
      rows.push(row);
    }
  }

  savePositions(db, rows);
  console.log(`\n=== Summary ===`);
  console.log(`Total combined Aave rows: ${rows.length}`);
  db.close();
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
module.exports = { scanWallet, savePositions };
