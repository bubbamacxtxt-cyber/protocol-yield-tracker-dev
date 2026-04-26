#!/usr/bin/env node
/**
 * fetch-infinifi.js
 * Fetches InfiniFi protocol positions from their public API
 * No Cloudflare bypass needed — hits API subdomains directly.
 *
 * Sources:
 *   - https://eth-api.infinifi.xyz/api/protocol/data
 *   - https://plasma-api.infinifi.xyz/api/protocol/data
 *
 * Outputs: data/manual-positions.json (InfiniFi section)
 */

const fs = require('fs');
const path = require('path');

const API_ENDPOINTS = [
  { chain: 'eth', url: 'https://eth-api.infinifi.xyz/api/protocol/data' },
  { chain: 'plasma', url: 'https://plasma-api.infinifi.xyz/api/protocol/data' },
];

// Map API strategy names to yield sources
const YIELD_SOURCE_MAP = {
  'fasanara-rwa-farm': 'fasanara',
  'fasanara-gdaf': 'fasanara',
  'falconx-farm': 'falconx',
  'morpho-v2-sentora-pyusd': 'sentora',
  'morpho-steakUSDCinfinifi': 'morpho',
  'maple-farm-institutional': 'maple',
  'maple-farm-syrup': 'maple',
  'spark-sUSDC-refcode': 'spark',
  'aavev3': 'aave',
  'aavev3-horizon-usdc': 'aave',
  'aavev3-rlusd-farm': 'aave',
  'sGHO': 'gho',
  'reservoir-wsrUSD': 'reservoir',
  'gauntlet-alpha-farm': 'gauntlet',
  'cowswap-sUSDe-v2': 'ethena',
  'tokemak-auto-infinifiUSD': 'tokemak',
  'tokemak-autoUSD': 'tokemak',
  'capfarm': 'cap',
  'fluid-fUSDC': 'fluid',
};

// Map API strategy names to strategy types
const STRATEGY_MAP = {
  'fasanara-rwa-farm': 'rwa',
  'fasanara-gdaf': 'rwa',
  'falconx-farm': 'rwa',
  'morpho-v2-sentora-pyusd': 'rwa',
  'morpho-steakUSDCinfinifi': 'rwa',
  'maple-farm-institutional': 'rwa',
  'maple-farm-syrup': 'rwa',
  'sGHO': 'rwa',
  'reservoir-wsrUSD': 'rwa',
  'gauntlet-alpha-farm': 'rwa',
  'cowswap-sUSDe-v2': 'rwa',
  'capfarm': 'rwa',
  'tokemak-auto-infinifiUSD': 'rwa',
  'tokemak-autoUSD': 'rwa',
  'spark-sUSDC-refcode': 'spark-strategy-indirect',
  'aavev3': 'lend',
  'aavev3-horizon-usdc': 'lend',
  'aavev3-rlusd-farm': 'lend',
  'fluid-fUSDC': 'lend',
};

function formatMaturity(timestampMs) {
  if (!timestampMs || timestampMs === 0) return null;
  return new Date(timestampMs).toISOString().split('T')[0];
}

function classifySparkExposure(farm) {
  const name = String(farm.name || '');
  const label = String(farm.label || '');
  if (!/spark/i.test(name) && !/spark/i.test(label)) return null;

  return {
    spark_exposure_type: 'indirect_strategy',
    spark_product_type: /susdc/i.test(name) || /susdc/i.test(label) ? 'savings' : 'unknown',
    spark_token_address: farm.underlyingAssetAddress || null,
    spark_token_symbol: farm.underlyingAssetSymbol || null,
  };
}

function mapFarmToPosition(farm, chain) {
  const assetsUsd = farm.assetsNormalized || 0;
  const sparkMeta = classifySparkExposure(farm);

  return {
    wallet: farm.address,
    chain,
    protocol_name: farm.label,
    protocol_id: farm.name,
    position_type: farm.type === 'LIQUID' ? 'Liquid' : 'Illiquid',
    strategy: STRATEGY_MAP[farm.name] || 'rwa',
    yield_source: YIELD_SOURCE_MAP[farm.name] || farm.label.toLowerCase().split(' ')[0],
    health_rate: null,
    net_usd: assetsUsd,
    asset_usd: assetsUsd,
    debt_usd: 0,
    supply: [{
      symbol: farm.underlyingAssetSymbol || 'USDC',
      real_symbol: farm.underlyingAssetSymbol || 'USDC',
      amount: assetsUsd,
      price_usd: 1,
      value_usd: assetsUsd,
    }],
    borrow: [],
    rewards: [],
    apy_current: parseFloat((farm.APY * 100).toFixed(2)),
    apy_avg: parseFloat(((farm.avgApy || farm.APY) * 100).toFixed(2)),
    apy_base: parseFloat(((farm.apyBase || farm.APY) * 100).toFixed(2)),
    apy_rewards: 0.00,
    maturity: formatMaturity(farm.maturityTimestampMs),
    bucket_weeks: farm.bucket || null,
    underlying: farm.underlyingAssetSymbol || 'USDC',
    paused: farm.isPaused || false,
    manual: false,
    source_type: 'protocol_api',
    source_name: 'fetch-infinifi',
    discovery_type: 'onchain',
    ...(sparkMeta || {}),
  };
}

async function fetchChain(endpoint) {
  console.log(`  Fetching ${endpoint.chain}...`);
  const res = await fetch(endpoint.url);
  if (!res.ok) throw new Error(`${endpoint.chain}: HTTP ${res.status}`);
  const json = await res.json();
  const farms = json.data?.farms || [];

  // Filter out PROTOCOL type and zero/near-zero positions
  const realFarms = farms.filter(f => f.type !== 'PROTOCOL' && (f.assetsNormalized || 0) > 100);
  // Exclude Morpho vault farms — the Morpho scanner reads these on-chain directly
  // and is the authoritative source. Importing them here would double-count.
  const SCANNER_COVERED = new Set(['morpho-steakUSDCinfinifi']);
  const filteredFarms = realFarms.filter(f => !SCANNER_COVERED.has(f.name));
  console.log(`  ${endpoint.chain}: ${farms.length} total, ${realFarms.length} real (> $100), ${filteredFarms.length} after excluding scanner-covered`);

  return filteredFarms.map(f => mapFarmToPosition(f, endpoint.chain));

  return filteredFarms.map(f => mapFarmToPosition(f, endpoint.chain));
}

async function main() {
  console.log('InfiniFi API Fetcher');
  console.log('====================\n');

  const allPositions = [];
  for (const endpoint of API_ENDPOINTS) {
    try {
      const positions = await fetchChain(endpoint);
      allPositions.push(...positions);
    } catch (err) {
      console.error(`  ERROR on ${endpoint.chain}: ${err.message}`);
    }
  }

  // Sort by net_usd descending
  allPositions.sort((a, b) => b.net_usd - a.net_usd);

  const totalUsd = allPositions.reduce((sum, p) => sum + p.net_usd, 0);
  console.log(`\nTotal: ${allPositions.length} positions, $${totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

  // 6. Write to separate file (don't clobber other whales)
  const whalesDir = path.join(__dirname, '..', 'data', 'whales');
  if (!fs.existsSync(whalesDir)) fs.mkdirSync(whalesDir, { recursive: true });
  const outFile = path.join(whalesDir, 'infinifi.json');
  fs.writeFileSync(outFile, JSON.stringify({ InfiniFi: allPositions }, null, 2));
  console.log(`\nWrote ${outFile}`);
  console.log(`  InfiniFi: ${allPositions.length} positions`);

  // Also update manual-positions.json (merge all whales)
  const manualPath = path.join(__dirname, '..', 'data', 'manual-positions.json');
  let existing = {};
  if (fs.existsSync(manualPath)) {
    existing = JSON.parse(fs.readFileSync(manualPath, 'utf8'));
  }
  existing.InfiniFi = allPositions;
  fs.writeFileSync(manualPath, JSON.stringify(existing, null, 2));
  console.log(`\nWrote ${manualPath}`);
  console.log(`  InfiniFi: ${allPositions.length} positions`);

  // Also run export to update data.json
  console.log('\nRunning export...');
  try {
    require('child_process').execSync('node src/export.js', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  } catch (err) {
    console.error('Export failed:', err.message);
  }

  // Print summary table
  console.log('\n--- InfiniFi Positions ---');
  console.log('Label'.padEnd(35) + 'Type'.padEnd(12) + 'Assets (USD)'.padStart(16) + ' APY'.padStart(8) + ' Maturity');
  console.log('-'.repeat(85));
  for (const p of allPositions) {
    const maturity = p.maturity || '-';
    console.log(
      p.protocol_name.padEnd(35) +
      p.position_type.padEnd(12) +
      `$${p.net_usd.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`.padStart(16) +
      `${p.apy_current}%`.padStart(8) +
      ` ${maturity}`
    );
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
