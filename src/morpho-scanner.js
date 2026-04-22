#!/usr/bin/env node
/**
 * Morpho Position Scanner v4
 *
 * Scanner-owned position assembly:
 * - emit combined wallet+chain rows for wallets with supply and/or borrow exposure
 * - stop emitting raw borrow-only fragments as final modeled rows
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const path = require('path');
const { loadActiveWalletChains, loadWhaleWalletMap, hasProtocolHint } = require('./recon-helpers');
const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');

const MORPHO_REST = 'https://app.morpho.org/api';
const MORPHO_GRAPHQL = 'https://app.morpho.org/api/graphql';
const ALL_CHAINS = [1, 8453, 42161, 137, 130, 747474, 999, 10, 143, 988, 480];

const CHAIN_NAMES = {
  1: 'eth', 8453: 'base', 42161: 'arb', 137: 'poly',
  10: 'opt', 5000: 'mnt', 81457: 'blast', 534352: 'scroll',
  146: 'sonic', 9745: 'plasma', 130: 'uni', 747474: 'wct',
  143: 'monad', 999: 'ink', 2741: 'abstract',
};

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

async function getMarketAPY(uniqueKey, chainId) {
  if (!uniqueKey) return null;
  try {
    const res = await fetch(MORPHO_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ marketByUniqueKey(uniqueKey: "${uniqueKey}", chainId: ${chainId}) { state { supplyApy borrowApy } } }`
      })
    });
    const data = await res.json();
    const state = data?.data?.marketByUniqueKey?.state;
    if (state) return { supplyApy: state.supplyApy * 100, borrowApy: state.borrowApy * 100 };
  } catch {}
  return null;
}

async function scanWallet(wallet, label, allowedChains = null) {
  const [earnItems, borrowItems] = await Promise.all([
    getEarnPositions(wallet),
    getBorrowPositions(wallet),
  ]);

  const rows = new Map();
  const chainAllowed = allowedChains ? new Set(allowedChains.map(String)) : null;

  for (const item of earnItems) {
    const vault = item.vault || {};
    const chainId = String(vault.chainId || 1);
    if (chainAllowed && !chainAllowed.has(chainId)) continue;
    const chain = CHAIN_NAMES[vault.chainId || 1] || String(vault.chainId || 1);
    const key = `${wallet.toLowerCase()}|${chain}`;
    if (!rows.has(key)) rows.set(key, { wallet, label, chain, chainId: Number(chainId), supply: [], borrow: [], health_rate: item.healthFactor || null });
    const row = rows.get(key);
    row.supply.push({
      symbol: vault.symbol || vault.asset?.symbol || '?',
      address: vault.address || '',
      amount: Number(item.shares || 0),
      value_usd: Number(item.assetsUsd || 0),
      apy_base: vault.netApyExcludingRewards != null ? vault.netApyExcludingRewards * 100 : (vault.netApy != null ? vault.netApy * 100 : null),
      bonus_supply_apy: vault.netApy != null && vault.netApyExcludingRewards != null ? (vault.netApy - vault.netApyExcludingRewards) * 100 : null,
    });
  }

  for (const item of borrowItems) {
    const market = item.market || {};
    const chainId = String(market.chainId || 1);
    if (chainAllowed && !chainAllowed.has(chainId)) continue;
    const chain = CHAIN_NAMES[market.chainId || 1] || String(market.chainId || 1);
    const key = `${wallet.toLowerCase()}|${chain}`;
    if (!rows.has(key)) rows.set(key, { wallet, label, chain, chainId: Number(chainId), supply: [], borrow: [], health_rate: item.healthFactor || null });
    const row = rows.get(key);
    const marketApy = await getMarketAPY(market.uniqueKey, market.chainId || 1);

    const collateralAsset = market.collateralAsset || {};
    const collateralUsd = Number(item.collateralUsd || 0);
    if (collateralUsd > 0 && collateralAsset.address) {
      const existingSupply = row.supply.find(s => String(s.address).toLowerCase() === String(collateralAsset.address).toLowerCase());
      if (existingSupply) {
        existingSupply.value_usd = Math.max(Number(existingSupply.value_usd || 0), collateralUsd);
      } else {
        row.supply.push({
          symbol: collateralAsset.symbol || '?',
          address: collateralAsset.address || '',
          amount: Number(item.collateral || 0),
          value_usd: collateralUsd,
          apy_base: marketApy?.supplyApy || null,
          bonus_supply_apy: null,
        });
      }
    }

    row.borrow.push({
      symbol: market.loanAsset?.symbol || '?',
      address: market.uniqueKey || market.marketId || '',
      amount: Number(item.borrowShares || 0),
      value_usd: Number(item.borrowAssetsUsd || 0),
      apy_base: marketApy?.borrowApy || null,
      collateral_address: collateralAsset.address || '',
      collateral_symbol: collateralAsset.symbol || '?',
      collateral_usd: collateralUsd,
    });
    if (item.healthFactor != null) row.health_rate = item.healthFactor;
  }

  const out = [];
  for (const row of rows.values()) {
    const asset_usd = row.supply.reduce((s, t) => s + (t.value_usd || 0), 0);
    const debt_usd = row.borrow.reduce((s, t) => s + (t.value_usd || 0), 0);

    // Group by explicit collateral asset first; borrow endpoint carries the collateral leg even when earn endpoint is empty.
    if (row.borrow.length > 0) {
      const borrowGroups = new Map();
      for (const b of row.borrow) {
        const k = String(b.collateral_address || '').toLowerCase() || 'no-collateral';
        if (!borrowGroups.has(k)) borrowGroups.set(k, []);
        borrowGroups.get(k).push(b);
      }

      const usedSupply = new Set();
      for (const [collateralKey, borrows] of borrowGroups.entries()) {
        let supply = row.supply.find(s => String(s.address || '').toLowerCase() === collateralKey) || null;
        if (!supply && borrows[0]?.collateral_address) {
          supply = {
            symbol: borrows[0].collateral_symbol || '?',
            address: borrows[0].collateral_address || '',
            amount: 0,
            value_usd: Math.max(...borrows.map(b => Number(b.collateral_usd || 0))),
            apy_base: null,
            bonus_supply_apy: null,
          };
        }
        if (supply) usedSupply.add(String(supply.address || '').toLowerCase());
        const debt = borrows.reduce((sum, b) => sum + Number(b.value_usd || 0), 0);
        const asset = Number(supply?.value_usd || 0);
        out.push({
          wallet: row.wallet,
          label: row.label,
          chain: row.chain,
          chainId: row.chainId,
          protocol_name: 'Morpho',
          protocol_id: 'morpho',
          position_type: supply ? 'supply' : 'borrow',
          strategy: supply ? 'lend' : 'borrow',
          position_index: `${row.wallet.toLowerCase()}|${row.chain}|${collateralKey}|${borrows.map(b => String(b.address || b.symbol).toLowerCase()).join('+')}`,
          health_rate: row.health_rate,
          net_usd: asset - debt,
          asset_usd: asset,
          debt_usd: debt,
          supply: supply ? [supply] : [],
          borrow: borrows.map(({ collateral_address, collateral_symbol, collateral_usd, ...rest }) => rest),
        });
      }

      for (const s of row.supply) {
        const key = String(s.address || '').toLowerCase();
        if (usedSupply.has(key)) continue;
        out.push({
          wallet: row.wallet,
          label: row.label,
          chain: row.chain,
          chainId: row.chainId,
          protocol_name: 'Morpho',
          protocol_id: 'morpho',
          position_type: 'supply',
          strategy: 'lend',
          position_index: `${row.wallet.toLowerCase()}|${row.chain}|${key}|noborrow`,
          health_rate: row.health_rate,
          net_usd: Number(s.value_usd || 0),
          asset_usd: Number(s.value_usd || 0),
          debt_usd: 0,
          supply: [s],
          borrow: [],
        });
      }
    } else if (row.supply.length > 0) {
      for (const s of row.supply) {
        out.push({
          wallet: row.wallet,
          label: row.label,
          chain: row.chain,
          chainId: row.chainId,
          protocol_name: 'Morpho',
          protocol_id: 'morpho',
          position_type: 'supply',
          strategy: 'lend',
          position_index: `${row.wallet.toLowerCase()}|${row.chain}|${String(s.address || s.symbol).toLowerCase()}|noborrow`,
          health_rate: row.health_rate,
          net_usd: Number(s.value_usd || 0),
          asset_usd: Number(s.value_usd || 0),
          debt_usd: 0,
          supply: [s],
          borrow: [],
        });
      }
    }
  }
  return out.filter(r => r.asset_usd > 0 || r.debt_usd > 0);
}

function savePositions(db, rows) {
  const upsertPos = db.prepare(`
    INSERT INTO positions (wallet, chain, protocol_id, protocol_name, position_type, strategy, health_rate, net_usd, asset_usd, debt_usd, position_index, scanned_at)
    VALUES (?, ?, 'morpho', 'Morpho', 'supply', 'lend', ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(wallet, chain, protocol_id, position_index) DO UPDATE SET
      health_rate = excluded.health_rate,
      net_usd = excluded.net_usd,
      asset_usd = excluded.asset_usd,
      debt_usd = excluded.debt_usd,
      scanned_at = datetime('now')
  `);
  const findPos = db.prepare(`SELECT id FROM positions WHERE wallet = ? AND chain = ? AND protocol_id = 'morpho' AND position_index = ?`);
  const clearTokens = db.prepare(`DELETE FROM position_tokens WHERE position_id = ?`);
  const clearMarkets = db.prepare(`DELETE FROM position_markets WHERE position_id = ?`);
  const insertToken = db.prepare(`
    INSERT INTO position_tokens (position_id, role, symbol, address, amount, value_usd, apy_base, bonus_supply_apy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteOldRows = db.prepare(`SELECT id FROM positions WHERE lower(wallet) = lower(?) AND protocol_id IN ('morpho', 'morphoblue', 'monad_morphoblue')`);
  const deletePos = db.prepare(`DELETE FROM positions WHERE id = ?`);

  const tx = db.transaction(() => {
    const seenWallet = new Set();
    for (const row of rows) {
      if (!seenWallet.has(row.wallet.toLowerCase())) {
        seenWallet.add(row.wallet.toLowerCase());
        const old = deleteOldRows.all(row.wallet);
        for (const r of old) {
          clearMarkets.run(r.id);
          clearTokens.run(r.id);
          deletePos.run(r.id);
        }
      }
      upsertPos.run(row.wallet, row.chain, row.health_rate, row.net_usd, row.asset_usd, row.debt_usd, row.position_index);
      const pos = findPos.get(row.wallet, row.chain, row.position_index);
      if (!pos) continue;
      clearTokens.run(pos.id);
      for (const t of row.supply) insertToken.run(pos.id, 'supply', t.symbol, t.address, t.amount || 0, t.value_usd || 0, t.apy_base || null, t.bonus_supply_apy || null);
      for (const t of row.borrow) insertToken.run(pos.id, 'borrow', t.symbol, t.address, t.amount || 0, t.value_usd || 0, t.apy_base || null, null);
    }
  });
  tx();
}

async function main() {
  let wallets = [];
  const active = loadActiveWalletChains();
  if (active && active.length > 0) {
    const labelByWallet = new Map(loadWhaleWalletMap().map(w => [w.addr, w.label]));
    const grouped = new Map();
    for (const row of active) {
      // Removed hasProtocolHint gate (2026-04-22 audit GAP 1).
      // Scan every active wallet — Morpho REST returns empty for wallets
      // with no position, so no cost penalty. Relying on DeBank's protocol
      // detection was making coverage dependent on their crawler being
      // perfect, which caused us to miss positions in practice.
      const k = row.wallet;
      if (!grouped.has(k)) grouped.set(k, { addr: row.wallet, label: labelByWallet.get(row.wallet) || row.whale || 'Unknown', chains: [] });
      grouped.get(k).chains.push(Number({ eth:1, base:8453, arb:42161, poly:137, uni:130, wct:747474, ink:999, opt:10, monad:143 }[row.chain] || 0));
    }
    wallets = [...grouped.values()];
  } else {
    wallets = [
      { addr: '0x31eae643b679a84b37e3d0b4bd4f5da90fb04a61', label: 'Reservoir-1', chains: ALL_CHAINS },
      { addr: '0x99a95a9e38e927486fc878f41ff8b118eb632b10', label: 'Reservoir-3', chains: ALL_CHAINS },
    ];
  }

  const db = new Database(DB_PATH);
  const rows = [];
  console.log('=== Morpho Scanner v4 ===\n');
  for (const w of wallets) {
    console.log(`--- ${w.label} (${w.addr.slice(0,12)}) ---`);
    const found = await scanWallet(w.addr, w.label, w.chains.filter(Boolean));
    for (const r of found) {
      console.log(`  ${r.chain}: $${(r.net_usd/1e6).toFixed(2)}M | supply ${r.supply.length} | borrow ${r.borrow.length}`);
    }
    rows.push(...found);
  }
  savePositions(db, rows);
  console.log(`\n=== Summary ===`);
  console.log(`Total combined Morpho rows: ${rows.length}`);
  db.close();
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
module.exports = { scanWallet, savePositions };
