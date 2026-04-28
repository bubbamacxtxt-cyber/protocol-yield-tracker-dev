#!/usr/bin/env node
/**
 * Purge stale positions.
 *
 * Two categories of cleanup:
 *
 *   1. Scanner-protocol ghosts (>6h old, >$1K): protocols where we have a
 *      dedicated scanner that runs every cycle. If the scanner ran but
 *      didn't emit a row for a (wallet, chain) pair, the old row is a
 *      ghost and should be deleted.
 *
 *   2. DeBank-only protocols (>48h old, any size): protocols we don't
 *      have a native scanner for — rows were written by the old fetch.js
 *      pipeline and never refreshed after we removed fetch.js from the
 *      hourly cycle. These rows are 8+ days old and giving false-positive
 *      whale positions. Drop them after 48h so the fresh recon cycle owns
 *      the data.
 */
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');

// Protocols with a dedicated scanner in free-scans-hourly.yml
// (stale rows deleted at >6h / >$1K).
const SCANNER_PROTOCOLS = [
  'aave-v3', 'aave3', 'base_aave3', 'plasma_aave3', 'mnt_aave3', 'ink_aave3',
  'morpho',
  'euler2',
  'spark-savings',
  'fluid',
  'pendle-pt', 'pendle-yt', 'pendle-lp',
  'ethena-cooldown',
  'yo-protocol',
  'curve',
  'compound3',
  'wallet-held',
  'vault',
  'vault-probed',
  'ybs',
];

// Protocols that ONLY arrived via DeBank's fetch.js lane.
// We no longer run fetch.js in the hourly cycle, so these rows go stale
// quickly. Drop any >48h old (regardless of size) so stale sells/closes
// don't linger in the whale totals.
const DEBANK_ONLY_PROTOCOLS = [
  // Legacy chain-prefixed variants of protocols we now scan canonically.
  // Scanners write their canonical protocol_id; these old rows age out
  // via the 48h rule.
  'arb_curve', 'plasma_curve',     // curve-scanner writes 'curve'
  'capapp',                        // stcUSD captured as YBS via token-discovery
  'upshift',                       // upshift vaults captured as vault-probed
  'sky',                           // sUSDS captured as YBS
  'convex',                        // TODO: needs dedicated scanner
  'arb_usdai', 'usd-ai',           // sUSDai captured as YBS
  'infinifixyz',                   // siUSD + LIUSD captured as YBS

  // Protocols imported daily via debank-import.js. Rows are refreshed
  // every 24h; 48h window means a single missed recon won't purge them.
  'dolomite',
  'gearbox', 'monad_gearbox',
  'curvance', 'monad_curvance',
  'traderjoe', 'avax_traderjoexyz', 'monad_traderjoexyz',
  'venusflux', 'bsc_venusflux',
  'ethstrat',
  'yuzumoney', 'plasma_yuzumoney',
];

function main() {
  const db = new Database(DB_PATH);
  let totalRemoved = 0;
  let totalUsd = 0;

  const delTok = db.prepare('DELETE FROM position_tokens WHERE position_id = ?');
  const delMkt = db.prepare('DELETE FROM position_markets WHERE position_id = ?');
  const delPos = db.prepare('DELETE FROM positions WHERE id = ?');

  // --- Tier 1: scanner ghosts (>6h, >$1K) -----------------------
  {
    const placeholders = SCANNER_PROTOCOLS.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id, wallet, chain, protocol_id, net_usd, scanned_at
      FROM positions
      WHERE scanned_at < datetime('now', '-10 hours')
        AND net_usd > 1000
        AND protocol_id IN (${placeholders})
    `).all(...SCANNER_PROTOCOLS);

    console.log(`[Tier 1] Stale scanner-protocol rows >6h with >$1K: ${rows.length}`);
    for (const r of rows) {
      console.log(` #${r.id} ${r.wallet.slice(0,12)} ${r.chain} ${r.protocol_id} $${((r.net_usd||0)/1e6).toFixed(2)}M ${r.scanned_at}`);
      delTok.run(r.id); delMkt.run(r.id); delPos.run(r.id);
      totalRemoved++; totalUsd += r.net_usd || 0;
    }
  }

  // --- Tier 2: DeBank-only stale orphans (>48h, any size) --------
  {
    const placeholders = DEBANK_ONLY_PROTOCOLS.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id, wallet, chain, protocol_id, net_usd, scanned_at
      FROM positions
      WHERE scanned_at < datetime('now', '-48 hours')
        AND protocol_id IN (${placeholders})
    `).all(...DEBANK_ONLY_PROTOCOLS);

    console.log(`[Tier 2] Stale DeBank-only rows >48h: ${rows.length}`);
    for (const r of rows) {
      console.log(` #${r.id} ${r.wallet.slice(0,12)} ${r.chain} ${r.protocol_id} $${((r.net_usd||0)/1e6).toFixed(2)}M ${r.scanned_at}`);
      delTok.run(r.id); delMkt.run(r.id); delPos.run(r.id);
      totalRemoved++; totalUsd += r.net_usd || 0;
    }
  }

  console.log(`\nDeleted ${totalRemoved} positions totalling $${(totalUsd/1e6).toFixed(2)}M`);
  db.close();
}

if (require.main === module) main();
