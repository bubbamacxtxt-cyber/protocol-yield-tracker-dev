#!/usr/bin/env node
/**
 * Token Discovery v3 — Layer 2 of the v3 architecture
 *
 * Uses Alchemy to scan wallet token balances. Each token is matched in
 * priority order against three lists:
 *
 *   1. VAULT LIST  (data/vaults.json)  → write as vault position with vault APY
 *   2. YBS LIST    (data/stables.json) → write as yield-bearing position with YBS APY
 *   3. TOKEN LIST  (data/token-registry.json) → write as wallet-held position
 *
 * Gated by the DeBank recon output: only wallet+chain pairs that DeBank
 * says hold >= $50K are scanned. This is Layer 1's job, we just consume it.
 *
 * No hardcoded prices. Prices come from DeFiLlama or CoinGecko.
 * No price → position is skipped with a warning (caller decides how to handle).
 *
 * Position minimum: $50K value. Below that, we don't create a line.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { fetchJSON } = require('./fetch-helper');
const { loadActiveWalletChains } = require('./recon-helpers');

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
if (!ALCHEMY_KEY) {
  console.error('Missing ALCHEMY_API_KEY');
  process.exit(1);
}

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'token-registry.json');
const VAULTS_PATH = path.join(__dirname, '..', 'data', 'vaults.json');
const YBS_PATH = path.join(__dirname, '..', 'data', 'stables.json');

// $50K minimum per-position threshold (your vision)
const MIN_POSITION_USD = 50000;
// $50K minimum per-chain threshold (Layer 1 filter)
const MIN_CHAIN_USD = 50000;

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
  hyperliquid: `https://hyperliquid-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
};

// Chain name aliases (DeBank → Alchemy/registry)
const CHAIN_ALIAS = {
  ethereum: 'eth',
  arbitrum: 'arb',
  optimism: 'opt',
  polygon: 'poly',
  avalanche: 'avax',
  mantle: 'mnt',
  hyper: 'hyperliquid',
  hyperevm: 'hyperliquid',
};

function normalizeChain(chain) {
  const lower = String(chain || '').toLowerCase();
  return CHAIN_ALIAS[lower] || lower;
}

// Chain → DeFiLlama slug
const DL_CHAIN_MAP = {
  eth: 'ethereum',
  base: 'base',
  arb: 'arbitrum',
  mnt: 'mantle',
  opt: 'optimism',
  avax: 'avalanche',
  bsc: 'bsc',
  poly: 'polygon',
  blast: 'blast',
  scroll: 'scroll',
  plasma: 'plasma',
  ink: 'ink',
  monad: 'monad',
  sonic: 'sonic',
  linea: 'linea',
  zksync: 'era',
  gnosis: 'xdai',
  celo: 'celo',
  hyperliquid: 'hyperliquid',
};

// ═══════════════════════════════════════════════════════════════
// LOADERS
// ═══════════════════════════════════════════════════════════════

function loadRegistry() {
  const data = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  console.log(`Loaded registry: ${data.tokens_with_addresses} tokens with addresses`);
  return data;
}

/**
 * Build vault index: chain:address → vault entry
 * Uses the chain alias table since data/vaults.json uses mixed casing.
 */
function loadVaults() {
  const data = JSON.parse(fs.readFileSync(VAULTS_PATH, 'utf8'));
  const byAddress = {};
  for (const v of data.vaults || []) {
    if (!v.address) continue;
    const chain = normalizeChain(v.chain);
    const key = `${chain}:${v.address.toLowerCase()}`;
    byAddress[key] = v;
  }
  console.log(`Loaded vaults: ${Object.keys(byAddress).length} indexed by chain:address`);
  return byAddress;
}

/**
 * Build YBS ticker index: SYMBOL (uppercase) → YBS entry
 *
 * YBS tokens are matched by TICKER after DeFiLlama confirms the symbol,
 * because the same yield-bearing token (e.g. sUSDe) exists on multiple
 * chains at different addresses but has the same underlying APY.
 *
 * Also keep an address index as an O(1) hint for known direct matches.
 */
function loadYbs() {
  const data = JSON.parse(fs.readFileSync(YBS_PATH, 'utf8'));
  const bySymbol = {};
  const byAddress = {};
  for (const s of data.stables || []) {
    // Normalize tickers — name + aliases all map to the same entry
    const tickers = new Set();
    if (s.name) tickers.add(String(s.name).toUpperCase());
    for (const alias of (s.aliases || [])) {
      if (alias) tickers.add(String(alias).toUpperCase());
    }
    for (const t of tickers) bySymbol[t] = s;

    // Known addresses (if any) — still useful as direct hints
    const chain = normalizeChain(s.chain);
    for (const addr of (s.addresses || [])) {
      if (!addr) continue;
      byAddress[`${chain}:${addr.toLowerCase()}`] = s;
    }
  }
  console.log(`Loaded YBS: ${Object.keys(bySymbol).length} tickers, ${Object.keys(byAddress).length} known addresses`);
  return { bySymbol, byAddress };
}

// ═══════════════════════════════════════════════════════════════
// ALCHEMY RPC
// ═══════════════════════════════════════════════════════════════

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

async function getTokenBalances(wallet, chain) {
  const result = await alchemyRpc(chain, 'alchemy_getTokenBalances', [wallet]);
  if (!result?.tokenBalances) return [];
  return result.tokenBalances.filter(t => {
    const bal = t.tokenBalance;
    return bal && bal !== '0x0' && !/^0x0+$/.test(bal);
  });
}

async function getTokenMetadata(chain, address) {
  return await alchemyRpc(chain, 'alchemy_getTokenMetadata', [address]);
}

function hexToDecimal(hex) {
  return parseInt(hex, 16);
}

function formatAmount(rawBalance, decimals) {
  if (!decimals || decimals === 0) return rawBalance;
  return rawBalance / Math.pow(10, decimals);
}

// ═══════════════════════════════════════════════════════════════
// ERC-4626 VAULT VALUE CALCULATION
// ═══════════════════════════════════════════════════════════════

/**
 * For an ERC-4626 vault, call convertToAssets(shares) via RPC.
 * Function selector: 0x07a2d13a convertToAssets(uint256)
 * Returns: uint256 assets
 */
async function convertToAssets(chain, vaultAddress, shares) {
  // Encode call: selector + uint256 padded
  const selector = '0x07a2d13a';
  const paddedShares = BigInt(Math.floor(shares)).toString(16).padStart(64, '0');
  const data = selector + paddedShares;

  const result = await alchemyRpc(chain, 'eth_call', [
    { to: vaultAddress, data },
    'latest'
  ]);

  if (!result || result === '0x') return null;
  try {
    return BigInt(result).toString();
  } catch (e) {
    return null;
  }
}

/**
 * Try to get the underlying asset address from an ERC-4626 vault.
 * Function selector: 0x38d52e0f asset()
 */
async function getVaultAsset(chain, vaultAddress) {
  const result = await alchemyRpc(chain, 'eth_call', [
    { to: vaultAddress, data: '0x38d52e0f' },
    'latest'
  ]);
  if (!result || result === '0x') return null;
  // Address is last 40 hex chars
  return '0x' + result.slice(-40).toLowerCase();
}

/**
 * Calculate USD value of a vault position.
 * Priority:
 *   1. ERC-4626: convertToAssets(shares) × price(underlying)
 *   2. Fallback: shares × TVL / totalSupply  (shares as fraction of vault)
 *   3. Last resort: null (flagged for review)
 */
async function calculateVaultValue(chain, vault, shareAmount, decimals) {
  // Method 1: ERC-4626
  try {
    const rawShares = Math.floor(shareAmount * Math.pow(10, decimals));
    const underlyingRaw = await convertToAssets(chain, vault.address, rawShares);
    if (underlyingRaw) {
      const underlyingAddr = await getVaultAsset(chain, vault.address);
      if (underlyingAddr) {
        // Get decimals of underlying (assume 6 for USD stables, 18 for ETH)
        const meta = await getTokenMetadata(chain, underlyingAddr);
        const uDecimals = meta?.decimals ?? 18;
        const underlyingAmount = Number(BigInt(underlyingRaw)) / Math.pow(10, uDecimals);
        const price = await getDefiLlamaPrice(chain, underlyingAddr);
        if (price) {
          return {
            value_usd: underlyingAmount * price,
            method: 'erc4626',
            underlying_address: underlyingAddr,
            underlying_amount: underlyingAmount,
            underlying_price: price,
          };
        }
      }
    }
  } catch (e) {
    // fall through
  }

  // Method 2: TVL proportion — but we don't have totalSupply locally,
  // so skip unless the vault entry provides share price hints.
  // For Upshift/IPOR, TVL alone is fine if there's only one wallet holding it,
  // but that's not safe. Skip.

  // Method 3: Use share_price field if available
  if (vault.share_price && vault.share_price > 0) {
    return {
      value_usd: shareAmount * vault.share_price,
      method: 'share_price',
    };
  }

  // Last resort: null value, flag for review
  return { value_usd: null, method: 'unknown' };
}

// ═══════════════════════════════════════════════════════════════
// PRICE LOOKUPS
// ═══════════════════════════════════════════════════════════════

/**
 * DeFiLlama lookup that returns both price AND symbol.
 * Used for YBS ticker-based matching (see scan loop).
 */
async function getDefiLlamaEntry(chain, address) {
  try {
    const dlChain = DL_CHAIN_MAP[chain] || chain;
    const url = `https://coins.llama.fi/prices/current/${dlChain}:${address}`;
    const data = await fetchJSON(url, {}, 2);
    const key = `${dlChain}:${address.toLowerCase()}`;
    const entry = data?.coins?.[key];
    if (!entry) return null;
    return {
      price: entry.price || null,
      symbol: entry.symbol || null,
      decimals: entry.decimals || null,
      confidence: entry.confidence || 0,
    };
  } catch (e) {
    return null;
  }
}

async function getDefiLlamaPrice(chain, address) {
  const entry = await getDefiLlamaEntry(chain, address);
  return entry?.price || null;
}

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

// CoinGecko chain slug map (for /coins/{platform}/contract/{address} endpoint)
const CG_PLATFORM = {
  eth: 'ethereum',
  arb: 'arbitrum-one',
  opt: 'optimistic-ethereum',
  base: 'base',
  poly: 'polygon-pos',
  avax: 'avalanche',
  bsc: 'binance-smart-chain',
  mnt: 'mantle',
  blast: 'blast',
  scroll: 'scroll',
  ink: 'ink',
  monad: 'monad',
  sonic: 'sonic',
  plasma: 'plasma',
  linea: 'linea',
  zksync: 'zksync',
  gnosis: 'xdai',
  celo: 'celo',
  hyperliquid: 'hyperliquid',
};

// Cache CG contract lookups across a single run (one entry per chain:address)
const _cgContractCache = new Map();

// CoinGecko free tier: ~30 req/min. Rate-limit to 1 request / 2.2s = ~27/min.
let _cgLastRequestAt = 0;
async function _cgThrottle() {
  const delay = 2200;
  const since = Date.now() - _cgLastRequestAt;
  if (since < delay) {
    await new Promise(r => setTimeout(r, delay - since));
  }
  _cgLastRequestAt = Date.now();
}

/**
 * Fetch canonical symbol from CoinGecko for a specific chain+address.
 * This is the authoritative ticker for YBS matching — bridged versions
 * of the same token share the same symbol.
 *
 * Returns { id, symbol, name } or null.
 */
async function getCoinGeckoTicker(chain, address) {
  const cacheKey = `${chain}:${address.toLowerCase()}`;
  if (_cgContractCache.has(cacheKey)) return _cgContractCache.get(cacheKey);

  const platform = CG_PLATFORM[chain];
  if (!platform) {
    _cgContractCache.set(cacheKey, null);
    return null;
  }

  // Skip the CG call for obviously irrelevant tokens to conserve rate limit.
  // Only hit CG if the local registry ticker hints at a possible YBS match.
  // (We pass the hint in via a side-channel — see scan loop.)

  await _cgThrottle();

  try {
    const https = require('https');
    const url = `https://api.coingecko.com/api/v3/coins/${platform}/contract/${address.toLowerCase()}`;
    const result = await new Promise((resolve) => {
      const req = https.get(url, {
        headers: { 'User-Agent': 'ProtocolYieldTracker/1.0 (dev@openclaw.ai)' }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed?.symbol) {
              resolve({ id: parsed.id, symbol: String(parsed.symbol).toUpperCase(), name: parsed.name });
            } else {
              resolve(null);
            }
          } catch (e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    });
    _cgContractCache.set(cacheKey, result);
    return result;
  } catch (e) {
    _cgContractCache.set(cacheKey, null);
    return null;
  }
}

async function getTokenPrice(chain, address, registryEntry) {
  const dlPrice = await getDefiLlamaPrice(chain, address);
  if (dlPrice) return { price: dlPrice, source: 'defillama' };

  if (registryEntry?.id) {
    const cgPrice = await getCoinGeckoPrice(registryEntry.id);
    if (cgPrice) return { price: cgPrice, source: 'coingecko' };
  }

  return { price: null, source: 'none' };
}

// ═══════════════════════════════════════════════════════════════
// DB WRITERS
// ═══════════════════════════════════════════════════════════════

function writeVaultPosition(db, wallet, chain, vault, token, valueUsd, apy) {
  const positionIndex = `${chain}:vault:${token.address}`;
  const existing = db.prepare(`
    SELECT id FROM positions
    WHERE wallet = ? AND chain = ? AND protocol_id = 'vault' AND position_index = ?
  `).get(wallet, chain, positionIndex);

  let posId;
  if (existing) {
    db.prepare(`
      UPDATE positions
      SET asset_usd = ?, net_usd = ?, protocol_name = ?, yield_source = ?, scanned_at = datetime('now')
      WHERE id = ?
    `).run(valueUsd, valueUsd, vault.protocol || 'Vault', `vault:${vault.symbol}`, existing.id);
    posId = existing.id;
    db.prepare(`DELETE FROM position_tokens WHERE position_id = ?`).run(posId);
  } else {
    const result = db.prepare(`
      INSERT INTO positions (wallet, chain, protocol_id, protocol_name, position_type, strategy,
        net_usd, asset_usd, debt_usd, position_index, yield_source, scanned_at)
      VALUES (?, ?, 'vault', ?, 'supply', 'vault', ?, ?, 0, ?, ?, datetime('now'))
    `).run(wallet, chain, vault.protocol || 'Vault', valueUsd, valueUsd, positionIndex, `vault:${vault.symbol}`);
    posId = result.lastInsertRowid;
  }

  db.prepare(`
    INSERT INTO position_tokens (position_id, role, symbol, address, amount, price_usd, value_usd, apy_base)
    VALUES (?, 'supply', ?, ?, ?, ?, ?, ?)
  `).run(posId, vault.symbol || token.symbol, token.address, token.amount, token.price || 0, valueUsd, apy || 0);

  return posId;
}

function writeYbsPosition(db, wallet, chain, ybs, token, valueUsd, apy) {
  const positionIndex = `${chain}:ybs:${token.address}`;
  const existing = db.prepare(`
    SELECT id FROM positions
    WHERE wallet = ? AND chain = ? AND protocol_id = 'ybs' AND position_index = ?
  `).get(wallet, chain, positionIndex);

  let posId;
  if (existing) {
    db.prepare(`
      UPDATE positions
      SET asset_usd = ?, net_usd = ?, protocol_name = ?, yield_source = ?, scanned_at = datetime('now')
      WHERE id = ?
    `).run(valueUsd, valueUsd, ybs.protocol || 'YBS', `ybs:${ybs.name}`, existing.id);
    posId = existing.id;
    db.prepare(`DELETE FROM position_tokens WHERE position_id = ?`).run(posId);
  } else {
    const result = db.prepare(`
      INSERT INTO positions (wallet, chain, protocol_id, protocol_name, position_type, strategy,
        net_usd, asset_usd, debt_usd, position_index, yield_source, scanned_at)
      VALUES (?, ?, 'ybs', ?, 'supply', 'ybs', ?, ?, 0, ?, ?, datetime('now'))
    `).run(wallet, chain, ybs.protocol || 'YBS', valueUsd, valueUsd, positionIndex, `ybs:${ybs.name}`);
    posId = result.lastInsertRowid;
  }

  db.prepare(`
    INSERT INTO position_tokens (position_id, role, symbol, address, amount, price_usd, value_usd, apy_base)
    VALUES (?, 'supply', ?, ?, ?, ?, ?, ?)
  `).run(posId, ybs.name || token.symbol, token.address, token.amount, token.price || 0, valueUsd, apy || 0);

  return posId;
}

function writeWalletHeldPosition(db, wallet, chain, token, valueUsd) {
  const positionIndex = `${chain}:wallet:${token.address}`;
  const existing = db.prepare(`
    SELECT id FROM positions
    WHERE wallet = ? AND chain = ? AND protocol_id = 'wallet-held' AND position_index = ?
  `).get(wallet, chain, positionIndex);

  let posId;
  if (existing) {
    db.prepare(`
      UPDATE positions
      SET asset_usd = ?, net_usd = ?, scanned_at = datetime('now')
      WHERE id = ?
    `).run(valueUsd, valueUsd, existing.id);
    posId = existing.id;
    db.prepare(`DELETE FROM position_tokens WHERE position_id = ?`).run(posId);
  } else {
    const result = db.prepare(`
      INSERT INTO positions (wallet, chain, protocol_id, protocol_name, position_type, strategy,
        net_usd, asset_usd, debt_usd, position_index, scanned_at)
      VALUES (?, ?, 'wallet-held', 'Wallet', 'Wallet', 'hold', ?, ?, 0, ?, datetime('now'))
    `).run(wallet, chain, valueUsd, valueUsd, positionIndex);
    posId = result.lastInsertRowid;
  }

  db.prepare(`
    INSERT INTO position_tokens (position_id, role, symbol, address, amount, price_usd, value_usd)
    VALUES (?, 'supply', ?, ?, ?, ?, ?)
  `).run(posId, token.symbol, token.address, token.amount, token.price || 0, valueUsd);

  return posId;
}

// ═══════════════════════════════════════════════════════════════
// MAIN SCAN
// ═══════════════════════════════════════════════════════════════

async function scanWalletChain(db, registry, vaultIndex, ybsIndex, wallet, whale, chain) {
  const rpc = RPCS[chain];
  if (!rpc) {
    console.log(`  ⚠️ No RPC for ${chain}, skipping`);
    return { vault: 0, ybs: 0, wallet: 0, skipped: 0 };
  }

  const balances = await getTokenBalances(wallet, chain);
  if (!balances.length) return { vault: 0, ybs: 0, wallet: 0, skipped: 0 };

  console.log(`\n  [${chain}] ${whale} ${wallet.slice(0, 12)}... (${balances.length} token balances)`);

  const counts = { vault: 0, ybs: 0, wallet: 0, skipped: 0 };

  for (const bal of balances) {
    const address = bal.contractAddress.toLowerCase();
    const lookupKey = `${chain}:${address}`;

    // Get metadata early (needed for amount calc)
    const metadata = await getTokenMetadata(chain, address);
    const decimals = metadata?.decimals || 18;
    const symbol = metadata?.symbol || 'UNKNOWN';
    const rawBalance = hexToDecimal(bal.tokenBalance);
    const amount = formatAmount(rawBalance, decimals);

    if (amount < 0.01) continue;

    // ─── PRIORITY 1: Vault match ─────────────────────────────
    const vault = vaultIndex[lookupKey];
    if (vault) {
      const result = await calculateVaultValue(chain, vault, amount, decimals);
      if (result.value_usd && result.value_usd >= MIN_POSITION_USD) {
        const token = {
          symbol: vault.symbol || symbol,
          address,
          amount,
          price: result.underlying_price || null,
        };
        writeVaultPosition(db, wallet, chain, vault, token, result.value_usd, vault.apy_30d || vault.apy_7d || 0);
        console.log(`  🟡 VAULT  ${(vault.symbol || symbol).padEnd(15)} ${amount.toFixed(4).padStart(12)} = $${(result.value_usd / 1e6).toFixed(2)}M APY ${(vault.apy_30d || 0).toFixed(2)}% (${result.method})`);
        counts.vault++;
      } else if (result.value_usd === null) {
        console.log(`  ⚠️ VAULT  ${vault.symbol || symbol} value unknown (flagged for review)`);
        counts.skipped++;
      }
      continue;
    }

    // ─── PRIORITY 2: YBS match (ticker-based via local CoinGecko registry)
    //
    // Per user spec: YBS tokens have multiple bridged addresses with the
    // same yield. We use our local CoinGecko-built token registry
    // (data/token-registry.json) as the canonical source for tickers —
    // this is effectively an offline snapshot of CoinGecko's ticker data.
    //
    // The registry stores the same CG symbol for every bridged chain of a
    // token, so sUSDe on Arb resolves to the same 'SUSDE' ticker as on ETH.
    //
    // Matching strategy:
    //   1. Look up chain:address in registry → get CG ticker
    //   2. If ticker not found, fall back to on-chain symbol from metadata
    //   3. Match ticker against YBS list
    //
    // APY comes from YBS list. Price comes from DeFiLlama.
    const registryEntryForYbs = registry.by_address[lookupKey];
    const metadataTicker = metadata?.symbol ? metadata.symbol.toUpperCase() : null;
    const registryTicker = registryEntryForYbs?.symbol ? registryEntryForYbs.symbol.toUpperCase() : null;

    // Prefer registry ticker (canonical across bridged chains),
    // fall back to on-chain metadata symbol for tokens not yet in CG.
    const candidateTicker = registryTicker || metadataTicker;
    const ybs = candidateTicker ? ybsIndex.bySymbol[candidateTicker] : null;

    if (ybs) {
      const price = await getDefiLlamaPrice(chain, address);
      if (price) {
        const valueUsd = amount * price;
        if (valueUsd >= MIN_POSITION_USD) {
          const token = { symbol: ybs.name || candidateTicker, address, amount, price };
          const apy = ybs.apy_30d || ybs.apy_7d || ybs.apy_1d || 0;
          writeYbsPosition(db, wallet, chain, ybs, token, valueUsd, apy);
          const tickerSource = registryTicker ? 'registry' : 'onchain';
          console.log(`  🔵 YBS    ${(ybs.name || candidateTicker).padEnd(15)} ${amount.toFixed(4).padStart(12)} @ $${price.toFixed(4)} = $${(valueUsd / 1e6).toFixed(2)}M APY ${apy.toFixed(2)}% (${tickerSource}:${candidateTicker})`);
          counts.ybs++;
        }
      } else {
        console.log(`  ⚠️ YBS    ${ybs.name} (${candidateTicker}) no DeFiLlama price on ${chain}`);
        counts.skipped++;
      }
      continue;
    }

    // ─── PRIORITY 3: Plain token from registry ───────────────
    // Use our local registry as the identity gate: only track known tokens.
    const registryEntry = registry.by_address[lookupKey];
    if (!registryEntry) continue; // unknown token — skip silently

    const priceInfo = await getTokenPrice(chain, address, registryEntry);
    if (!priceInfo.price) continue;

    const valueUsd = amount * priceInfo.price;
    if (valueUsd < MIN_POSITION_USD) continue;

    const token = { symbol, address, amount, price: priceInfo.price };
    writeWalletHeldPosition(db, wallet, chain, token, valueUsd);
    console.log(`  ⚪ WALLET ${symbol.padEnd(15)} ${amount.toFixed(4).padStart(12)} @ $${priceInfo.price.toFixed(4)} = $${(valueUsd / 1e6).toFixed(2)}M`);
    counts.wallet++;
  }

  return counts;
}

// ═══════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════

function cleanupStale(db, activePairs, runStartIso) {
  // Project rule: every Layer 2 run is a full refresh. Any vault/ybs/wallet-held
  // row for a wallet+chain pair that we scanned but didn't re-touch must be
  // deleted, otherwise stale rows poison the whale page.
  //
  // Scope: only delete rows for the wallet+chain pairs we actually scanned.
  // This protects positions on chains we had no RPC for.
  const kinds = ['vault', 'ybs', 'wallet-held'];
  let removed = 0;

  // Build the set of (wallet, chain) pairs we scanned
  const scannedKeys = new Set(activePairs.map(p => `${p.wallet.toLowerCase()}|${p.chain.toLowerCase()}`));

  for (const kind of kinds) {
    const rows = db.prepare(`
      SELECT id, wallet, chain FROM positions
      WHERE protocol_id = ? AND (scanned_at IS NULL OR scanned_at < ?)
    `).all(kind, runStartIso);

    const idsToDelete = rows
      .filter(r => scannedKeys.has(`${String(r.wallet).toLowerCase()}|${String(r.chain).toLowerCase()}`))
      .map(r => r.id);

    if (idsToDelete.length === 0) continue;
    const ph = idsToDelete.map(() => '?').join(',');
    db.prepare(`DELETE FROM position_tokens WHERE position_id IN (${ph})`).run(...idsToDelete);
    const result2 = db.prepare(`DELETE FROM positions WHERE id IN (${ph})`).run(...idsToDelete);
    removed += result2.changes;
  }
  if (removed > 0) console.log(`\nCleaned ${removed} stale ${kinds.join('/')} rows for scanned wallet+chain pairs`);
  return removed;
}

// Keep legacy signature for backward compat, but never called now.
function _legacyCleanupStale(db) {
  const kinds = ['vault', 'ybs', 'wallet-held'];
  let removed = 0;
  for (const kind of kinds) {
    const result = db.prepare(`
      DELETE FROM position_tokens
      WHERE position_id IN (
        SELECT id FROM positions
        WHERE protocol_id = ? AND scanned_at < datetime('now', '-2 hour')
      )
    `).run(kind);
    const result2 = db.prepare(`
      DELETE FROM positions
      WHERE protocol_id = ? AND scanned_at < datetime('now', '-2 hour')
    `).run(kind);
    removed += result2.changes;
  }
  if (removed > 0) console.log(`\nCleaned ${removed} stale vault/ybs/wallet-held rows`);
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('=== Token Discovery v3 ===');
  console.log(`Position threshold: $${MIN_POSITION_USD.toLocaleString()}\n`);

  const registry = loadRegistry();
  const vaultIndex = loadVaults();
  const ybsIndex = loadYbs();

  // Layer 1 gate: only scan wallet+chain pairs DeBank says hold >= $50K
  const activePairs = loadActiveWalletChains(MIN_CHAIN_USD);
  if (!activePairs) {
    console.error('ERROR: debank-wallet-summary.json missing. Run build-debank-recon.js first.');
    process.exit(1);
  }

  // Normalize chain names and filter to chains we have RPCs for
  const scanPairs = [];
  const skippedByChain = {};
  for (const p of activePairs) {
    const chain = normalizeChain(p.chain);
    if (!RPCS[chain]) {
      skippedByChain[p.chain] = (skippedByChain[p.chain] || 0) + 1;
      continue;
    }
    scanPairs.push({ ...p, chain });
  }

  console.log(`Active wallet+chain pairs from DeBank recon: ${activePairs.length}`);
  console.log(`Scannable (have RPC): ${scanPairs.length}`);
  if (Object.keys(skippedByChain).length > 0) {
    console.log('Skipped chains (no RPC):', JSON.stringify(skippedByChain));
  }
  console.log('');

  const db = new Database(DB_PATH);

  // Record the run start so cleanup can drop any row not refreshed this run.
  const runStartIso = new Date(Date.now() - 5000).toISOString().slice(0, 19).replace('T', ' ');

  const totals = { vault: 0, ybs: 0, wallet: 0, skipped: 0 };

  for (const pair of scanPairs) {
    try {
      const counts = await scanWalletChain(db, registry, vaultIndex, ybsIndex, pair.wallet, pair.whale, pair.chain);
      totals.vault += counts.vault;
      totals.ybs += counts.ybs;
      totals.wallet += counts.wallet;
      totals.skipped += counts.skipped;
    } catch (e) {
      console.error(`  ERROR scanning ${pair.wallet} on ${pair.chain}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  cleanupStale(db, scanPairs, runStartIso);

  console.log(`\n=== Token Discovery v3 Complete ===`);
  console.log(`  🟡 Vault positions:  ${totals.vault}`);
  console.log(`  🔵 YBS positions:    ${totals.ybs}`);
  console.log(`  ⚪ Wallet-held:      ${totals.wallet}`);
  console.log(`  ⚠️ Skipped (no value/price): ${totals.skipped}`);

  db.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
