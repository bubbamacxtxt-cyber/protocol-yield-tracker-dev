#!/usr/bin/env node
/**
 * Token Discovery v2
 * 
 * Uses Alchemy to scan wallet token balances, matches against CoinGecko registry,
 * and writes identified wallet-held positions to DB.
 * 
 * Flow:
 * 1. Load whale wallets from data/whales.json
 * 2. For each wallet+chain pair:
 *    - Call alchemy_getTokenBalances
 *    - Filter out zero balances
 *    - Match contract addresses against token registry
 *    - Call alchemy_getTokenMetadata for decimals
 *    - Compute USD value (price from DeFiLlama or hardcoded $1 for stables)
 * 3. Filter to positions > $50K
 * 4. Write to DB as wallet-held source type
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { fetchJSON } = require('./fetch-helper');

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
if (!ALCHEMY_KEY) {
  console.error('Missing ALCHEMY_API_KEY');
  process.exit(1);
}

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'token-registry.json');
const MIN_VALUE_USD = 1000;

// Alchemy RPC endpoints
const RPCS = {
  eth: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  arb: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  base: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  mnt: process.env.ALCHEMY_MNT_RPC_URL || '',
  plasma: process.env.ALCHEMY_PLASMA_RPC_URL || '',
  monad: process.env.ALCHEMY_MONAD_RPC_URL || '',
  sonic: process.env.ALCHEMY_SONIC_RPC_URL || '',
  ink: process.env.ALCHEMY_INK_RPC_URL || '',
  opt: `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  avax: `https://avax-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  bsc: `https://bnb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  poly: `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  blast: `https://blast-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  scroll: `https://scroll-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  zksync: `https://zksync-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  linea: `https://linea-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  bera: `https://berachain-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  abstract: `https://abstract-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  metis: `https://metis-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  gnosis: `https://gnosis-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  celo: `https://celo-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  polygonzkevm: `https://polygonzkevm-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  hyperliquid: '', // No Alchemy RPC yet - custom chain
  hyperevm: '', // No Alchemy RPC yet
};

// Tokens that are explicitly NOT $1 stables (these have real market prices)
const NON_STABLES = new Set([
  'WETH', 'WBTC', 'WSTETH', 'RETH', 'CBETH', 'ETH', 'BTC',
  'WEETH', 'EZETH', 'RSETH', 'SWETH', 'WOETH',
]);

// Load token registry
function loadRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    console.log(`Loaded registry: ${data.tokens_with_addresses} tokens with addresses`);
    return data;
  } catch (e) {
    console.error('Failed to load token registry:', e.message);
    process.exit(1);
  }
}

// Load whale wallets
function loadWallets() {
  const whalesPath = path.join(__dirname, '..', 'data', 'whales.json');
  const whales = JSON.parse(fs.readFileSync(whalesPath, 'utf8'));
  const wallets = [];
  
  for (const [name, config] of Object.entries(whales)) {
    if (Array.isArray(config)) {
      for (const w of config) wallets.push({ whale: name, wallet: w.toLowerCase() });
    } else if (config.vaults) {
      for (const [vault, list] of Object.entries(config.vaults)) {
        for (const w of list) wallets.push({ whale: name, wallet: w.toLowerCase(), vault });
      }
    }
  }
  
  return wallets;
}

// Alchemy RPC call
async function alchemyRpc(chain, method, params) {
  const url = RPCS[chain];
  if (!url) return null;
  
  try {
    const res = await fetchJSON(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    }, 2);
    return res?.result || null;
  } catch (e) {
    console.error(`  Alchemy ${chain} ${method} failed:`, e.message);
    return null;
  }
}

// Get token balances for a wallet
async function getTokenBalances(wallet, chain) {
  const result = await alchemyRpc(chain, 'alchemy_getTokenBalances', [wallet]);
  if (!result?.tokenBalances) return [];
  
  return result.tokenBalances.filter(t => {
    const bal = t.tokenBalance;
    return bal && bal !== '0x0' && !/^0x0+$/.test(bal);
  });
}

// Get token metadata
async function getTokenMetadata(chain, address) {
  return await alchemyRpc(chain, 'alchemy_getTokenMetadata', [address]);
}

// Convert hex balance to decimal
function hexToDecimal(hex) {
  return parseInt(hex, 16);
}

// Format amount with decimals
function formatAmount(rawBalance, decimals) {
  if (!decimals || decimals === 0) return rawBalance;
  return rawBalance / Math.pow(10, decimals);
}

// Get price from DeFiLlama
async function getDefiLlamaPrice(chain, address) {
  try {
    const cgChainMap = {
      eth: 'ethereum',
      base: 'base',
      arb: 'arbitrum',
      mnt: 'mantle',
      opt: 'optimism',
      avax: 'avalanche',
      bsc: 'bsc',
      poly: 'polygon',
      ftm: 'fantom',
      blast: 'blast',
      scroll: 'scroll',
      plasma: 'plasma',
      ink: 'ink',
      monad: 'monad',
      sonic: 'sonic',
    };
    
    const dlChain = cgChainMap[chain] || chain;
    const url = `https://coins.llama.fi/prices/current/${dlChain}:${address}`;
    const data = await fetchJSON(url, {}, 2);
    const key = `${dlChain}:${address.toLowerCase()}`;
    return data?.coins?.[key]?.price || null;
  } catch (e) {
    return null;
  }
}

// Get price — try DeFiLlama, fallback to CoinGecko, never assume $1
async function getTokenPrice(chain, address, symbol, registryEntry) {
  // Try DeFiLlama first
  const dlPrice = await getDefiLlamaPrice(chain, address);
  if (dlPrice) {
    return { price: dlPrice, source: 'defillama' };
  }
  
  // Fallback to CoinGecko if we have the CoinGecko ID
  if (registryEntry?.id) {
    const cgPrice = await getCoinGeckoPrice(registryEntry.id);
    if (cgPrice) {
      return { price: cgPrice, source: 'coingecko' };
    }
  }
  
  // For non-stables with no price, return null (don't assume)
  if (symbol && NON_STABLES.has(symbol.toUpperCase())) {
    return { price: null, source: 'no-price-data' };
  }
  
  // For everything else, return null — let caller decide what to do
  return { price: null, source: 'unknown' };
}

// Get price from CoinGecko by coin ID
async function getCoinGeckoPrice(coinId) {
  try {
    const https = require('https');
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`;
    
    return await new Promise((resolve) => {
      const req = https.get(url, {
        headers: { 'User-Agent': 'ProtocolYieldTracker/1.0 (dev@openclaw.ai)' }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed[coinId]?.usd || null);
          } catch (e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    });
  } catch (e) {
    return null;
  }
}

// Write position to DB
function writeWalletPosition(db, wallet, chain, token, valueUsd) {
  const positionIndex = `${chain}:${token.address}`;
  
  // Check if position already exists
  const existing = db.prepare(`
    SELECT id FROM positions 
    WHERE wallet = ? AND chain = ? AND protocol_id = 'wallet-held' AND position_index = ?
  `).get(wallet, chain, positionIndex);
  
  if (existing) {
    // Update existing
    db.prepare(`
      UPDATE positions 
      SET asset_usd = ?, net_usd = ?, scanned_at = datetime('now')
      WHERE id = ?
    `).run(valueUsd, valueUsd, existing.id);
    
    // Update token
    db.prepare(`
      UPDATE position_tokens 
      SET value_usd = ?, amount = ?
      WHERE position_id = ? AND role = 'supply'
    `).run(valueUsd, token.amount, existing.id);
    
    return existing.id;
  } else {
    // Insert new position
    const result = db.prepare(`
      INSERT INTO positions (wallet, chain, protocol_id, protocol_name, position_type, strategy, 
        net_usd, asset_usd, debt_usd, position_index, scanned_at)
      VALUES (?, ?, 'wallet-held', 'Wallet', 'Wallet', 'hold', ?, ?, 0, ?, datetime('now'))
    `).run(wallet, chain, valueUsd, valueUsd, positionIndex);
    
    const posId = result.lastInsertRowid;
    
    // Insert token
    db.prepare(`
      INSERT INTO position_tokens (position_id, role, symbol, address, amount, price_usd, value_usd)
      VALUES (?, 'supply', ?, ?, ?, ?, ?)
    `).run(posId, token.symbol, token.address, token.amount, token.price, valueUsd);
    
    return posId;
  }
}

// Main scan
async function scanWallet(db, registry, wallet, whale, chain) {
  console.log(`\nScanning ${whale} ${wallet.slice(0, 12)}... on ${chain}`);
  
  const balances = await getTokenBalances(wallet, chain);
  if (!balances.length) {
    console.log('  No token balances');
    return 0;
  }
  
  console.log(`  Found ${balances.length} token balances`);
  
  let foundCount = 0;
  let totalValue = 0;
  
  for (const bal of balances) {
    const address = bal.contractAddress.toLowerCase();
    const lookupKey = `${chain}:${address}`;
    const registryEntry = registry.by_address[lookupKey];
    
    // Skip if not in registry (unknown token)
    if (!registryEntry) continue;
    
    // Get metadata for decimals
    const metadata = await getTokenMetadata(chain, address);
    const decimals = metadata?.decimals || 18;
    const symbol = metadata?.symbol || registryEntry.symbol;
    
    // Calculate amount
    const rawBalance = hexToDecimal(bal.tokenBalance);
    const amount = formatAmount(rawBalance, decimals);
    
    // Skip dust amounts
    if (amount < 0.01) continue;
    
    // Get price
    const priceInfo = await getTokenPrice(chain, address, symbol, registryEntry);
    
    if (!priceInfo.price) {
      console.log(`  ⚠️ ${symbol}: no price, skipping`);
      continue;
    }
    
    // Calculate USD value
    const valueUsd = amount * priceInfo.price;
    
    // Skip below threshold
    if (valueUsd < MIN_VALUE_USD) continue;
    
    // Write to DB
    const token = {
      symbol,
      address,
      amount,
      price: priceInfo.price,
    };
    
    const posId = writeWalletPosition(db, wallet, chain, token, valueUsd);
    
    console.log(`  ✅ ${symbol.padEnd(10)} ${amount.toFixed(4).padStart(12)} @ $${priceInfo.price.toFixed(4)} = $${(valueUsd/1e6).toFixed(2)}M (${priceInfo.source})`);
    
    foundCount++;
    totalValue += valueUsd;
  }
  
  console.log(`  Found ${foundCount} positions, total $${(totalValue/1e6).toFixed(2)}M`);
  return foundCount;
}

// Cleanup old wallet-held positions for scanned wallets
function cleanupOldPositions(db, scannedWallets) {
  const walletList = scannedWallets.map(w => w.toLowerCase());
  const placeholders = walletList.map(() => '?').join(',');
  
  const oldIds = db.prepare(`
    SELECT id FROM positions 
    WHERE protocol_id = 'wallet-held' 
    AND lower(wallet) IN (${placeholders})
    AND scanned_at < datetime('now', '-1 hour')
  `).all(...walletList).map(r => r.id);
  
  if (oldIds.length > 0) {
    const idPlaceholders = oldIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM position_tokens WHERE position_id IN (${idPlaceholders})`).run(...oldIds);
    db.prepare(`DELETE FROM positions WHERE id IN (${idPlaceholders})`).run(...oldIds);
    console.log(`\nCleaned ${oldIds.length} old wallet-held positions`);
  }
}

async function main() {
  console.log('=== Token Discovery v2 ===\n');
  
  const registry = loadRegistry();
  const wallets = loadWallets();
  const db = new Database(DB_PATH);
  
  console.log(`Scanning ${wallets.length} wallets\n`);
  
  // Get unique chains from registry that we have RPCs for
  const availableChains = Object.keys(RPCS).filter(c => RPCS[c]);
  console.log('Available chains:', availableChains.join(', '));
  
  let totalFound = 0;
  const scannedWallets = [];
  
  for (const { whale, wallet, vault } of wallets) {
    // Scan all available chains for each wallet
    for (const chain of availableChains) {
      try {
        const found = await scanWallet(db, registry, wallet, whale, chain);
        totalFound += found;
        if (found > 0) scannedWallets.push(wallet);
      } catch (e) {
        console.error(`  Error scanning ${wallet} on ${chain}:`, e.message);
      }
      
      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 100));
    }
  }
  
  // Cleanup old positions
  if (scannedWallets.length > 0) {
    cleanupOldPositions(db, [...new Set(scannedWallets)]);
  }
  
  console.log(`\n=== Done: ${totalFound} wallet-held positions ===`);
  db.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
