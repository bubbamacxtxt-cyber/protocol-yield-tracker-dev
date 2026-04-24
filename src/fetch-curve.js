#!/usr/bin/env node
/**
 * fetch-curve.js — fetch all Curve pools across chains/registries and
 * populate the curve_pools table.
 *
 * Curve API: https://docs.curve.finance/developer/integration/api/curve-api
 *
 *   GET /api/getPools/<chain>/<registry>
 *
 * Fields of interest per pool:
 *   address          - pool contract
 *   lpTokenAddress   - ERC-20 share token wallets hold (== address for stable-ng)
 *   gaugeAddress     - staked LP wrapper (wallets that stake LP hold this)
 *   usdTotal         - pool TVL in USD
 *   totalSupply      - raw LP token supply (1e18 normalized by Curve)
 *   name             - pool name
 *   symbol           - LP token symbol
 *   coins[]          - underlying tokens
 *   gaugeCrvApy      - [min, max] CRV emission APY
 *
 * A wallet holding `balance` LP tokens out of `totalSupply` has pool value
 * `balance / totalSupply * usdTotal`. The curve scanner uses that exact math.
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');

// Chain slug used by Curve API -> our internal chain code
const CHAIN_MAP = {
  ethereum: 'eth',
  arbitrum: 'arb',
  base: 'base',
  avalanche: 'avax',
  mantle: 'mnt',
  bsc: 'bsc',
  optimism: 'opt',
  polygon: 'poly',
  fantom: 'ftm',
  sonic: 'sonic',
  // Note: Plasma does NOT have an official Curve deployment in the API.
};

const REGISTRIES = [
  'main', 'crypto',
  'factory', 'factory-crypto', 'factory-twocrypto', 'factory-tricrypto',
  'factory-stable-ng', 'factory-crvusd', 'factory-eywa',
];

async function fetchPools(chain, registry) {
  const url = `https://api.curve.finance/api/getPools/${chain}/${registry}`;
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return { pools: [], error: `HTTP ${res.status}` };
    const data = await res.json();
    if (!data?.success) return { pools: [], error: data?.errorMessage || 'not success' };
    return { pools: data.data?.poolData || [], error: null };
  } catch (e) {
    return { pools: [], error: e.message };
  }
}

function normalizeAddress(a) {
  return a ? a.toLowerCase() : null;
}

async function main() {
  const db = new Database(DB_PATH);

  // Schema: curve_pools is the single source of truth for (chain, lp_token)
  // -> pool metadata. Used by curve-scanner.js for address matching + valuation.
  db.exec(`CREATE TABLE IF NOT EXISTS curve_pools (
    chain TEXT NOT NULL,
    pool_address TEXT NOT NULL,
    lp_token TEXT NOT NULL,
    gauge TEXT,
    registry TEXT NOT NULL,
    name TEXT,
    lp_symbol TEXT,
    coins_symbols TEXT,
    coins_addresses TEXT,
    usd_total REAL,
    total_supply TEXT,
    apy_base REAL,
    apy_crv_min REAL,
    apy_crv_max REAL,
    is_meta INTEGER,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (chain, lp_token)
  )`);

  const upsert = db.prepare(`INSERT INTO curve_pools
    (chain, pool_address, lp_token, gauge, registry, name, lp_symbol,
     coins_symbols, coins_addresses, usd_total, total_supply,
     apy_base, apy_crv_min, apy_crv_max, is_meta, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chain, lp_token) DO UPDATE SET
      pool_address = excluded.pool_address,
      gauge = excluded.gauge,
      registry = excluded.registry,
      name = excluded.name,
      lp_symbol = excluded.lp_symbol,
      coins_symbols = excluded.coins_symbols,
      coins_addresses = excluded.coins_addresses,
      usd_total = excluded.usd_total,
      total_supply = excluded.total_supply,
      apy_base = excluded.apy_base,
      apy_crv_min = excluded.apy_crv_min,
      apy_crv_max = excluded.apy_crv_max,
      is_meta = excluded.is_meta,
      fetched_at = excluded.fetched_at`);

  const now = new Date().toISOString();
  let total = 0, errors = 0;
  const perChainStats = {};

  for (const [apiChain, ourChain] of Object.entries(CHAIN_MAP)) {
    perChainStats[ourChain] = { fetched: 0, errors: 0 };
    for (const reg of REGISTRIES) {
      const { pools, error } = await fetchPools(apiChain, reg);
      if (error) {
        // factory-eywa often 404s; don't be noisy about it
        if (!/HTTP 404/.test(error) && reg !== 'factory-eywa') {
          console.warn(`  ! ${apiChain}/${reg}: ${error}`);
        }
        perChainStats[ourChain].errors++;
        errors++;
        continue;
      }
      for (const p of pools) {
        const lp = normalizeAddress(p.lpTokenAddress) || normalizeAddress(p.address);
        if (!lp) continue;
        const coins = p.coins || [];
        upsert.run(
          ourChain,
          normalizeAddress(p.address),
          lp,
          normalizeAddress(p.gaugeAddress) || null,
          reg,
          p.name || null,
          p.symbol || null,
          coins.map(c => c.symbol || '').join(','),
          coins.map(c => normalizeAddress(c.address) || '').join(','),
          p.usdTotal ?? null,
          p.totalSupply != null ? String(p.totalSupply) : null,
          null, // apy_base — not directly in getPools; fetch-base-apy.js handles it
          Array.isArray(p.gaugeCrvApy) ? p.gaugeCrvApy[0] : null,
          Array.isArray(p.gaugeCrvApy) ? p.gaugeCrvApy[1] : null,
          p.isMetaPool ? 1 : 0,
          now,
        );
        perChainStats[ourChain].fetched++;
        total++;
      }
    }
  }

  console.log(`\nCurve pools fetched: ${total} across ${Object.keys(perChainStats).length} chains`);
  for (const [ch, s] of Object.entries(perChainStats)) {
    console.log(`  ${ch.padEnd(6)}: ${s.fetched} pools${s.errors ? `  (${s.errors} registry errors)` : ''}`);
  }
  if (errors) console.log(`Total registry fetch errors: ${errors}`);

  // Remove stale rows (pools that disappeared from the API). Anything older
  // than 48h gets dropped \u2014 this catches deprecated pools and chain outages.
  const staleBefore = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const deleted = db.prepare('DELETE FROM curve_pools WHERE fetched_at < ?').run(staleBefore);
  if (deleted.changes) console.log(`Pruned ${deleted.changes} stale pool rows (>48h old)`);

  db.close();
  console.log('Done!');
}

main().catch(err => {
  console.error('fetch-curve failed:', err);
  process.exit(1);
});
