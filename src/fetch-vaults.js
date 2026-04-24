#!/usr/bin/env node
/**
 * fetch-vaults.js — Fetch vault data from IPOR and Upshift (August Digital)
 * Normalizes all rates to APY, writes to vaults table + vault_apy_history.
 *
 * Upshift discovery: pulls the FULL vault list from the August Digital API
 * every run (was previously limited to vaults already in the DB — we'd
 * never pick up newly-launched vaults).
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const IPOR_API = 'https://api.ipor.io/dapp/plasma-vaults-list';
const AUGUST_API = 'https://api.augustdigital.io/api/v1/tokenized_vault';

// Upshift's `chain` field is a chain ID (not a string name).
const CHAIN_MAP = {
  1: { name: 'eth', display: 'ETH' },
  10: { name: 'opt', display: 'OP' },
  56: { name: 'bsc', display: 'BSC' },
  100: { name: 'gnosis', display: 'Gnosis' },
  130: { name: 'unichain', display: 'Unichain' },
  137: { name: 'poly', display: 'Polygon' },
  143: { name: 'monad', display: 'Monad' },
  999: { name: 'hyperliquid', display: 'Hyperliquid' },
  8453: { name: 'base', display: 'Base' },
  9745: { name: 'plasma', display: 'Plasma' },
  42161: { name: 'arb', display: 'Arb' },
  43114: { name: 'avax', display: 'Avax' },
};

function aprToApy(aprPct) {
  return (Math.exp(aprPct / 100) - 1) * 100;
}

async function fetchIpor() {
  console.log('Fetching IPOR vaults...');
  const res = await fetch(IPOR_API, { headers: { 'Accept-Encoding': 'gzip' } });
  if (!res.ok) throw new Error(`IPOR API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const vaults = data.plasmaVaults || [];
  console.log(`  Got ${vaults.length} IPOR vaults`);
  const now = new Date().toISOString();
  return vaults.map(v => ({
    address: v.address.toLowerCase(),
    symbol: v.vaultSymbol,
    name: v.name,
    chain: v.chainId,
    chain_name: CHAIN_MAP[v.chainId]?.name || String(v.chainId),
    vault_type: 'IPOR Fusion',
    status: 'active',
    tvl_usd: parseInt(v.tvlUsd_18 || '0') / 1e18,
    apy_1d: aprToApy(parseFloat(v.apr || '0')),
    apy_7d: null,
    apy_30d: null,
    source: 'ipor',
    max_drawdown: null,
    rating: v.xerberusVaultRating || null,
    fetched_at: now,
  }));
}

/**
 * Upshift / August Digital discovery.
 *
 * The /tokenized_vault endpoint (no address) returns the full vault catalogue
 * including new launches. We keep all visible mainnet-like vaults.
 *
 * Only-visible / is_visible filter: August returns many "TEST" / internal
 * vaults. We skip status=closed and anything flagged as a test. We keep all
 * remaining vaults so new launches propagate automatically.
 */
async function fetchUpshift() {
  console.log('Fetching Upshift vaults from August Digital (full catalogue)...');
  const res = await fetch(AUGUST_API);
  if (!res.ok) throw new Error(`August API ${res.status}: ${await res.text()}`);
  const list = await res.json();
  console.log(`  August API returned ${list.length} vaults (unfiltered)`);

  const now = new Date().toISOString();
  const vaults = [];
  for (const v of list) {
    if (!v.address) continue;
    if (v.status === 'closed') continue;

    // Drop obvious test vaults by name heuristic.
    const nameUpper = String(v.vault_name || '').toUpperCase();
    if (/^TEST|_TEST|VKTEST|IX_TEST|OP_TEST/.test(nameUpper)) continue;

    const chainId = typeof v.chain === 'number' ? v.chain : parseInt(v.chain);
    const chainInfo = CHAIN_MAP[chainId];
    if (!chainInfo) continue; // skip non-EVM (Solana/Sui) and unknown chain IDs

    const apy30 = (v.historical_apy?.['30'] || 0) * 100;
    const apy7 = (v.historical_apy?.['7'] || 0) * 100;
    const apy1 = (v.historical_apy?.['1'] || 0) * 100;
    const tvl = v.latest_reported_tvl || v.tvl || 0;

    vaults.push({
      address: v.address.toLowerCase(),
      symbol: v.receipt_token_symbol || v.vault_name,
      name: v.vault_name,
      chain: chainId,
      chain_name: chainInfo.name,
      vault_type: v.public_type || 'Upshift Vault',
      status: v.status || 'active',
      tvl_usd: tvl,
      apy_1d: apy1,
      apy_7d: apy7,
      apy_30d: apy30,
      source: 'upshift',
      max_drawdown: v.max_daily_drawdown != null ? v.max_daily_drawdown : null,
      rating: v.risk || null,
      fetched_at: now,
    });
  }
  console.log(`  Kept ${vaults.length} Upshift vaults after filtering`);
  return vaults;
}

async function main() {
  const db = new Database(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS vault_apy_history (
    vault_address TEXT NOT NULL, source TEXT NOT NULL, timestamp TEXT NOT NULL,
    apy REAL, tvl_usd REAL, PRIMARY KEY (vault_address, timestamp))`);
  try { db.exec('ALTER TABLE vaults ADD COLUMN rating TEXT'); } catch (e) {}

  const now = new Date().toISOString();
  const iporVaults = await fetchIpor();
  const upshiftVaults = await fetchUpshift();

  const upsert = db.prepare(`INSERT INTO vaults
    (address, symbol, name, chain, chain_name, vault_type, status, tvl_usd, apy_1d, apy_7d, apy_30d, source, max_drawdown, rating, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      tvl_usd=excluded.tvl_usd,
      apy_1d=excluded.apy_1d,
      apy_7d=excluded.apy_7d,
      apy_30d=excluded.apy_30d,
      rating=excluded.rating,
      fetched_at=excluded.fetched_at,
      status=excluded.status,
      vault_type=excluded.vault_type,
      chain=excluded.chain,
      chain_name=excluded.chain_name,
      symbol=excluded.symbol,
      name=excluded.name`);

  // Compute 7d/30d from history for IPOR (IPOR API only gives 1d)
  const historyRows = db.prepare(`SELECT vault_address,
    AVG(CASE WHEN timestamp >= datetime('now','-1 day') THEN apy END) as apy_1d,
    AVG(CASE WHEN timestamp >= datetime('now','-7 days') THEN apy END) as apy_7d,
    AVG(CASE WHEN timestamp >= datetime('now','-30 days') THEN apy END) as apy_30d
    FROM vault_apy_history WHERE source='ipor' GROUP BY vault_address`).all();
  const historyApy = {};
  for (const r of historyRows) historyApy[r.vault_address] = r;

  const insertHistory = db.prepare(`INSERT OR IGNORE INTO vault_apy_history
    (vault_address, source, timestamp, apy, tvl_usd) VALUES (?, ?, ?, ?, ?)`);

  let iporCount = 0;
  for (const v of iporVaults) {
    const h = historyApy[v.address];
    if (h) { if (h.apy_7d != null) v.apy_7d = h.apy_7d; if (h.apy_30d != null) v.apy_30d = h.apy_30d; }
    upsert.run(v.address, v.symbol, v.name, v.chain, v.chain_name, v.vault_type, v.status,
      v.tvl_usd, v.apy_1d, v.apy_7d, v.apy_30d, v.source, v.max_drawdown, v.rating, v.fetched_at);
    insertHistory.run(v.address, v.source, now, v.apy_1d, v.tvl_usd);
    iporCount++;
  }
  console.log(`Wrote ${iporCount} IPOR vaults`);

  let upCount = 0;
  for (const v of upshiftVaults) {
    upsert.run(v.address, v.symbol, v.name, v.chain, v.chain_name, v.vault_type, v.status,
      v.tvl_usd, v.apy_1d, v.apy_7d, v.apy_30d, v.source, v.max_drawdown, v.rating, v.fetched_at);
    insertHistory.run(v.address, v.source, now, v.apy_30d, v.tvl_usd);
    upCount++;
  }
  console.log(`Wrote ${upCount} Upshift vaults`);

  db.close();
  console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
