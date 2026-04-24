#!/usr/bin/env node
/**
 * curve-scanner.js — Detect Curve LP and gauge positions per wallet.
 *
 * How it works (no extra RPC beyond what build-alchemy-recon.js already did):
 *
 *   1. Load every tracked Curve pool from the curve_pools table (populated
 *      by fetch-curve.js).
 *   2. Build a lookup: `${chain}:${lp_token_or_gauge_address}` -> pool meta.
 *   3. For every wallet+chain pair in alchemy-token-discovery.json, check
 *      each token address against the lookup. A hit means the wallet holds
 *      either the LP share or the staked gauge wrapper.
 *   4. Compute value_usd = balance / total_supply * usd_total.
 *   5. Write as protocol_id = 'curve' with type 'supply', strategy 'lp'
 *      (or 'lp-staked' for gauge holds).
 *
 * Why this covers all chains we track (except Plasma): Curve API returns
 * pools for ethereum, arbitrum, base, avalanche, mantle, bsc, etc. For each
 * pool we get the LP address, so any Curve LP/gauge position held by a
 * tracked whale wallet is detectable as long as build-alchemy-recon was able
 * to enumerate the wallet's tokens (via Alchemy or dRPC).
 *
 * Plasma Curve deployment is not in the official Curve API at the moment;
 * Plasma Curve positions will stay unhandled until that changes or we add
 * an alternate fetcher.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const RECON_PATH = path.join(__dirname, '..', 'data', 'recon', 'alchemy-token-discovery.json');

function loadRecon() {
  try {
    return JSON.parse(fs.readFileSync(RECON_PATH, 'utf8'));
  } catch (e) {
    console.error('Missing alchemy-token-discovery.json. Run build-alchemy-recon.js first.');
    process.exit(1);
  }
}

// Build lookup: "chain:address" -> { pool row, kind: 'lp' | 'gauge' }
function buildPoolIndex(db) {
  const rows = db.prepare(`
    SELECT chain, pool_address, lp_token, gauge, name, lp_symbol,
           coins_symbols, coins_addresses, usd_total, total_supply,
           apy_crv_min, apy_crv_max, registry, is_meta
    FROM curve_pools
    WHERE usd_total > 0 AND total_supply IS NOT NULL
  `).all();

  const idx = new Map();
  for (const r of rows) {
    if (r.lp_token) idx.set(`${r.chain}:${r.lp_token.toLowerCase()}`, { row: r, kind: 'lp' });
    if (r.gauge) idx.set(`${r.chain}:${r.gauge.toLowerCase()}`, { row: r, kind: 'gauge' });
  }
  return idx;
}

function parseBalance(hex) {
  if (!hex || hex === '0x' || /^0x0+$/.test(hex)) return null;
  try { return BigInt(hex); } catch { return null; }
}

// LP tokens on Curve are 18-decimal ERC-20s across registries.
// Gauge tokens mirror the LP decimals.
// We normalize balance and totalSupply both as 18-dec BigInts for the math.
const LP_DECIMALS = 18;

function computeValueUsd(balanceRaw, totalSupplyStr, usdTotal) {
  const ts = BigInt(totalSupplyStr);
  if (ts === 0n) return 0;
  // Do the math in float (BigInt division loses precision for small shares);
  // pool TVL is already a JS number from the API.
  const balanceFloat = Number(balanceRaw) / Math.pow(10, LP_DECIMALS);
  const tsFloat = Number(ts) / Math.pow(10, LP_DECIMALS);
  if (tsFloat === 0) return 0;
  return (balanceFloat / tsFloat) * usdTotal;
}

function writePosition(db, { wallet, chain, pool, kind, balanceRaw, valueUsd }) {
  const positionIndex = `${chain}:curve:${kind}:${pool.lp_token.toLowerCase()}`;
  const existing = db.prepare(`
    SELECT id FROM positions
    WHERE lower(wallet) = ? AND chain = ? AND protocol_id = 'curve' AND position_index = ?
  `).get(wallet.toLowerCase(), chain, positionIndex);

  const strategy = kind === 'gauge' ? 'lp-staked' : 'lp';
  const yieldSource = `curve:${pool.registry}${kind === 'gauge' ? '+gauge' : ''}`;
  const apy = Number.isFinite(pool.apy_crv_min) ? pool.apy_crv_min : null;

  let posId;
  if (existing) {
    db.prepare(`
      UPDATE positions
      SET asset_usd = ?, net_usd = ?, protocol_name = 'Curve',
          position_type = 'Liquidity Pool', strategy = ?, yield_source = ?,
          scanned_at = datetime('now')
      WHERE id = ?
    `).run(valueUsd, valueUsd, strategy, yieldSource, existing.id);
    posId = existing.id;
    db.prepare('DELETE FROM position_tokens WHERE position_id = ?').run(posId);
  } else {
    const res = db.prepare(`
      INSERT INTO positions (
        wallet, chain, protocol_id, protocol_name, position_type, strategy,
        yield_source, net_usd, asset_usd, debt_usd, position_index, scanned_at
      ) VALUES (?, ?, 'curve', 'Curve', 'Liquidity Pool', ?, ?, ?, ?, 0, ?, datetime('now'))
    `).run(wallet.toLowerCase(), chain, strategy, yieldSource, valueUsd, valueUsd, positionIndex);
    posId = res.lastInsertRowid;
  }

  // Write supply tokens: one row per underlying coin in the pool.
  // We split the pool's USD value evenly across coins since we don't know
  // the exact per-coin balances without calling balances(i) on the pool.
  // (Curve's getPools exposes per-coin pool balances but not per-wallet shares.)
  const coinSymbols = (pool.coins_symbols || '').split(',').filter(Boolean);
  const coinAddrs = (pool.coins_addresses || '').split(',').filter(Boolean);
  const n = Math.max(coinSymbols.length, coinAddrs.length, 1);
  const perCoinUsd = valueUsd / n;

  const insTok = db.prepare(`
    INSERT INTO position_tokens (position_id, role, symbol, address, amount, price_usd, value_usd, apy_base)
    VALUES (?, 'supply', ?, ?, NULL, NULL, ?, ?)
  `);
  for (let i = 0; i < n; i++) {
    insTok.run(posId, coinSymbols[i] || '?', coinAddrs[i] || null, perCoinUsd, apy);
  }
  return posId;
}

function cleanupStale(db, scannedWallets, foundKeys) {
  // For each wallet+chain we scanned, drop Curve rows we didn't re-touch.
  // That handles the "whale exited pool X" case cleanly.
  const scannedByKey = new Set(scannedWallets.map(w => `${w.wallet.toLowerCase()}|${w.chain}`));
  const removed = [];
  const rows = db.prepare(`SELECT id, wallet, chain, position_index FROM positions WHERE protocol_id = 'curve'`).all();
  for (const r of rows) {
    const walletChainKey = `${r.wallet.toLowerCase()}|${r.chain}`;
    // Only purge if we scanned this wallet+chain this run.
    if (!scannedByKey.has(walletChainKey)) continue;
    // Skip positions we found this run.
    const signature = `${r.wallet.toLowerCase()}|${r.chain}|${r.position_index}`;
    if (foundKeys.has(signature)) continue;
    db.prepare('DELETE FROM position_tokens WHERE position_id = ?').run(r.id);
    db.prepare('DELETE FROM positions WHERE id = ?').run(r.id);
    removed.push(r.id);
  }
  if (removed.length) console.log(`Cleaned ${removed.length} stale Curve rows`);
}

async function main() {
  const db = new Database(DB_PATH);
  const recon = loadRecon();
  const index = buildPoolIndex(db);

  console.log(`Curve scanner: ${index.size} pool addresses indexed`);
  console.log(`Scanning ${recon.wallets?.length || 0} wallet+chain pairs`);

  const wallets = recon.wallets || [];
  const foundKeys = new Set(); // signatures for cleanup
  let hits = 0, skipped = 0, totalUsd = 0;

  for (const w of wallets) {
    for (const t of (w.tokens || [])) {
      const key = `${w.chain}:${t.address.toLowerCase()}`;
      const match = index.get(key);
      if (!match) continue;

      const balance = parseBalance(t.tokenBalance);
      if (!balance || balance === 0n) continue;

      const valueUsd = computeValueUsd(balance, match.row.total_supply, match.row.usd_total);
      if (valueUsd < 1000) { skipped++; continue; } // dust

      writePosition(db, {
        wallet: w.wallet,
        chain: w.chain,
        pool: match.row,
        kind: match.kind,
        balanceRaw: balance,
        valueUsd,
      });

      const positionIndex = `${w.chain}:curve:${match.kind}:${match.row.lp_token.toLowerCase()}`;
      foundKeys.add(`${w.wallet.toLowerCase()}|${w.chain}|${positionIndex}`);

      hits++;
      totalUsd += valueUsd;
      const kindLbl = match.kind === 'gauge' ? '🔒 STAKED' : '💧 LP    ';
      console.log(`  ${kindLbl} ${w.whale.padEnd(14)} ${w.wallet.slice(0, 10)} ${w.chain.padEnd(6)} ${(match.row.name || '?').padEnd(30).slice(0, 30)} $${(valueUsd / 1e6).toFixed(3)}M`);
    }
  }

  cleanupStale(db, wallets, foundKeys);

  console.log(`\nCurve positions: ${hits} found${skipped ? ` (${skipped} dust <$1K skipped)` : ''}`);
  console.log(`Total Curve TVL across whales: $${(totalUsd / 1e6).toFixed(2)}M`);
  db.close();
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
