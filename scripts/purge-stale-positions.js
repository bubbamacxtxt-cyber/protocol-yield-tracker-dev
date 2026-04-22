#!/usr/bin/env node
/**
 * Purge stale positions for protocols where we have a native scanner that
 * runs every cycle. If a scanner ran but didn't emit a row for a
 * (wallet, chain) pair, the old row is a ghost and should be deleted.
 *
 * Protocols sourced only from DeBank fetch (e.g., sky, capapp, convex,
 * curve, dolomite, monad_gearbox) are NOT touched here — they live or
 * die based on whether fetch.js processed them this cycle.
 *
 * Rule:
 *   - Only consider scanner-protocol rows (SCANNER_PROTOCOLS).
 *   - Only consider rows older than 6 hours (covers hourly + buffer).
 *   - Only consider rows > $1K (don't churn dust).
 */
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');

// Protocols that have a dedicated scanner running in free-scans-hourly.yml.
// If a wallet+chain has a stale row for any of these, purge it.
const SCANNER_PROTOCOLS = [
  'aave-v3', 'aave3', 'base_aave3', 'plasma_aave3', 'mnt_aave3', 'ink_aave3',
  'morpho',
  'euler2',
  'spark-savings',
  'fluid',
  'pendle-pt', 'pendle-yt', 'pendle-lp',
  'ethena-cooldown',
  'yo-protocol',
  'wallet-held',
  'vault',
  'ybs',
];

function main() {
  const db = new Database(DB_PATH);
  const placeholders = SCANNER_PROTOCOLS.map(() => '?').join(',');
  const r = db.prepare(`
    SELECT id, wallet, chain, protocol_id, net_usd, scanned_at
    FROM positions
    WHERE scanned_at < datetime('now', '-6 hours')
      AND net_usd > 1000
      AND protocol_id IN (${placeholders})
  `).all(...SCANNER_PROTOCOLS);

  console.log(`Stale scanner-protocol rows >6h with >$1K: ${r.length}`);
  let totalStale = 0;
  const delTok = db.prepare('DELETE FROM position_tokens WHERE position_id = ?');
  const delMkt = db.prepare('DELETE FROM position_markets WHERE position_id = ?');
  const delPos = db.prepare('DELETE FROM positions WHERE id = ?');
  for (const row of r) {
    totalStale += row.net_usd || 0;
    console.log(` #${row.id} ${row.wallet.slice(0,12)} ${row.chain} ${row.protocol_id} $${((row.net_usd||0)/1e6).toFixed(2)}M ${row.scanned_at}`);
    delTok.run(row.id); delMkt.run(row.id); delPos.run(row.id);
  }
  console.log(`Deleted $${(totalStale/1e6).toFixed(2)}M of stale scanner-protocol positions`);
  db.close();
}

if (require.main === module) main();
