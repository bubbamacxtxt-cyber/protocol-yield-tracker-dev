#!/usr/bin/env node
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const OUTPUT = path.join(__dirname, '..', 'data', 'vaults.json');
const CHAIN_NAMES = { 1:'ETH',130:'Unichain',8453:'Base',9745:'Plasma',42161:'Arb',999:'Hyperliquid',143:'Monad',10:'OP',137:'Polygon',56:'BSC',100:'Gnosis' };
const SOURCE_NAMES = { ipor:'IPOR', upshift:'Upshift' };

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  // Only export vaults whose declared address is a real ERC-20 share token.
  // Proxies / admin contracts (address_valid=0) would cause token-discovery
  // to match the wrong address. NULL = unverified (e.g. chain with no RPC)
  // — include those until we can verify them.
  const vaults = db.prepare(`SELECT address, symbol, name, chain, chain_name, vault_type, status,
    tvl_usd, apy_1d, apy_7d, apy_30d, source, max_drawdown, rating, fetched_at,
    address_valid, onchain_symbol
    FROM vaults
    WHERE tvl_usd >= 1000
      AND (address_valid IS NULL OR address_valid = 1)
    ORDER BY tvl_usd DESC`).all();

  const output = {
    fetched_at: new Date().toISOString(),
    total_tvl: vaults.reduce((s, v) => s + (v.tvl_usd || 0), 0),
    count: vaults.length,
    vaults: vaults.map(v => ({
      protocol: SOURCE_NAMES[v.source] || v.source,
      name: v.name, symbol: v.symbol,
      chain: CHAIN_NAMES[v.chain] || v.chain_name || String(v.chain),
      tvl_usd: Math.round(v.tvl_usd * 100) / 100,
      apy_1d: v.apy_1d != null ? Math.round(v.apy_1d * 100) / 100 : null,
      apy_7d: v.apy_7d != null ? Math.round(v.apy_7d * 100) / 100 : null,
      apy_30d: v.apy_30d != null ? Math.round(v.apy_30d * 100) / 100 : null,
      drawdown: v.max_drawdown != null ? Math.round(v.max_drawdown * 10000) / 100 : null,
      rating: v.rating || null,
      address: v.address,
    })),
  };
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
  console.log(`Exported ${vaults.length} vaults (total TVL: $${(output.total_tvl / 1e6).toFixed(1)}M)`);
  db.close();
}
main();
