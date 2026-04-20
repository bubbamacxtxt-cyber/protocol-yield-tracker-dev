#!/usr/bin/env node
/**
 * Morpho Position Scanner
 * 
 * Replaces DeBank complex_protocol_list for Morpho positions.
 * Uses: Alchemy token balances → vault DB match → API fallback → balanceOf → APY
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');

const MORPHO_INTERNAL_API = 'https://app.morpho.org/api/graphql';
const MORPHO_PUBLIC_API = 'https://api.morpho.org/graphql';
const V2_PERF_HASH = '2450946f568dabb9e65946408befef7d15c529139e2a397c75bf64cbccf1aa9b';

// ============================================
// Alchemy helpers
// ============================================

async function alchemy(method, params) {
  const url = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const text = await res.text();
  if (!text || text.startsWith('<')) {
    throw new Error(`Alchemy non-JSON response for ${method}: ${text.slice(0, 100)}`);
  }
  const data = JSON.parse(text);
  if (data.error) throw new Error(`Alchemy error: ${data.error.message}`);
  return data.result;
}

async function getTokenBalances(wallet) {
  const result = await alchemy('alchemy_getTokenBalances', [wallet, 'erc20']);
  return (result?.tokenBalances || [])
    .map(t => ({ address: t.contractAddress, balance: BigInt(t.tokenBalance || '0') }))
    .filter(t => t.balance > 0n);
}

async function getTokenMetadata(address) {
  const result = await alchemy('alchemy_getTokenMetadata', [address]);
  return {
    symbol: result?.symbol || 'UNKNOWN',
    name: result?.name || '',
    decimals: result?.decimals || 18
  };
}

async function balanceOf(tokenAddress, wallet) {
  const data = '0x70a08231' + '000000000000000000000000' + wallet.slice(2);
  try {
    const result = await alchemy('eth_call', [{ to: tokenAddress, data }, 'latest']);
    return result ? BigInt(result) : 0n;
  } catch { return 0n; }
}

// ============================================
// Morpho API helpers
// ============================================

// Check if address is a Morpho v1 vault
async function lookupV1Vault(address) {
  const res = await fetch(MORPHO_INTERNAL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `{ vaultByAddress(address: "${address}") { address symbol asset { address symbol } } }`
    })
  });
  const data = await res.json();
  return data?.data?.vaultByAddress || null;
}

// Check if address is a Morpho v2 vault
async function lookupV2Vault(address) {
  const res = await fetch(MORPHO_INTERNAL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-apollo-operation-name': 'GetVaultV2Performance' },
    body: JSON.stringify({
      operationName: 'GetVaultV2Performance',
      variables: { address, chainId: 1 },
      extensions: { persistedQuery: { version: 1, sha256Hash: V2_PERF_HASH } }
    })
  });
  const data = await res.json();
  const vault = data?.data?.vaultV2ByAddress;
  if (vault) return { ...vault, version: 'v2' };
  return null;
}

// Get v1 vault APY - uses GetVaultPerformanceApy persisted query
const V1_APY_HASH = 'db4bd5b01c28c4702d575d3cc6718e9fdf02908fe1769a9ac84769183b15d3a1';
async function getV1VaultAPY(address) {
  const res = await fetch(MORPHO_INTERNAL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-apollo-operation-name': 'GetVaultPerformanceApy' },
    body: JSON.stringify({
      operationName: 'GetVaultPerformanceApy',
      variables: { address, chainId: 1 },
      extensions: { persistedQuery: { version: 1, sha256Hash: V1_APY_HASH } }
    })
  });
  const data = await res.json();
  const vault = data?.data?.vaultByAddress;
  if (!vault) return null;
  return {
    netApy: vault.state?.netApy,
    apy: vault.state?.netApyExcludingRewards,
    totalAssetsUsd: vault.state?.totalAssets ? Number(vault.state.totalAssets) / 1e18 : null,
    assetSymbol: vault.asset?.symbol
  };
}

// Combined: try both v1 and v2 endpoints
async function getVaultAPY(address, version) {
  // Try the expected version first
  if (version === 'v1') {
    const v1 = await getV1VaultAPY(address);
    if (v1) return v1;
    const v2 = await getV2VaultAPY(address);
    if (v2) return { netApy: v2.netApy, apy: v2.netApyExcludingRewards, totalAssetsUsd: v2.totalAssetsUsd };
  } else {
    const v2 = await getV2VaultAPY(address);
    if (v2) return { netApy: v2.netApy, apy: v2.netApyExcludingRewards, totalAssetsUsd: v2.totalAssetsUsd };
    const v1 = await getV1VaultAPY(address);
    if (v1) return v1;
  }
  return null;
}

// Get v2 vault APY
async function getV2VaultAPY(address) {
  const res = await fetch(MORPHO_INTERNAL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-apollo-operation-name': 'GetVaultV2Performance' },
    body: JSON.stringify({
      operationName: 'GetVaultV2Performance',
      variables: { address, chainId: 1 },
      extensions: { persistedQuery: { version: 1, sha256Hash: V2_PERF_HASH } }
    })
  });
  const data = await res.json();
  return data?.data?.vaultV2ByAddress || null;
}

// ============================================
// Vault DB helpers
// ============================================

function getVaultFromDB(db, address) {
  return db.prepare('SELECT * FROM morpho_vaults WHERE LOWER(address) = LOWER(?)').get(address);
}

function addVaultToDB(db, address, symbol, assetSymbol, assetAddress, chainName, version) {
  db.prepare(
    'INSERT OR IGNORE INTO morpho_vaults (address, symbol, asset_symbol, asset_address, chain_name, version) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(address, symbol, assetSymbol, assetAddress, chainName, version);
}

// ============================================
// Main scanner
// ============================================

async function scanWallet(db, wallet, label) {
  console.log(`\n--- Scanning ${label} (${wallet.slice(0,12)}) ---`);
  
  const positions = [];
  
  // Step 1: Get all token balances
  const tokens = await getTokenBalances(wallet);
  console.log(`  ${tokens.length} tokens with balance`);
  
  // Step 2: Check each token against vault DB
  let vaultFound = 0;
  let apiLookup = 0;
  
  for (const token of tokens) {
    // Check DB first (fast)
    let vault = getVaultFromDB(db, token.address);
    
    if (vault) {
      vaultFound++;
    } else {
      // Not in DB - try API lookup
      apiLookup++;
      
      // Try v1 first
      let v1 = await lookupV1Vault(token.address);
      if (v1) {
        vault = {
          address: v1.address,
          symbol: v1.symbol,
          asset_symbol: v1.asset?.symbol,
          asset_address: v1.asset?.address,
          version: 'v1',
          chain_name: 'ethereum'
        };
        addVaultToDB(db, vault.address, vault.symbol, vault.asset_symbol, vault.asset_address, vault.chain_name, vault.version);
        console.log(`  + New v1 vault found: ${vault.symbol}`);
      } else {
        // Try v2
        let v2 = await lookupV2Vault(token.address);
        if (v2) {
          vault = {
            address: v2.address,
            symbol: v2.symbol || token.address.slice(0, 12),
            asset_symbol: v2.asset?.symbol,
            asset_address: v2.asset?.address,
            version: 'v2',
            chain_name: 'ethereum'
          };
          addVaultToDB(db, vault.address, vault.symbol, vault.asset_symbol, vault.asset_address, vault.chain_name, vault.version);
          console.log(`  + New v2 vault found: ${vault.symbol}`);
        }
      }
    }
    
    if (!vault) continue;
    
    // Step 3: Get shares amount
    const shares = await balanceOf(token.address, wallet);
    if (shares === 0n) continue;
    
    const meta = await getTokenMetadata(token.address);
    const sharesFormatted = Number(shares) / (10 ** meta.decimals);
    
    // Step 4: Get APY (try both v1 and v2 endpoints)
    let apyBase = null;
    let apyTotal = null;
    let tvl = null;
    
    const apyData = await getVaultAPY(token.address, vault.version);
    if (apyData) {
      apyBase = apyData.apy != null ? apyData.apy * 100 : null;
      apyTotal = apyData.netApy != null ? apyData.netApy * 100 : null;
      tvl = apyData.totalAssetsUsd || null;
    }
    
    const bonusApy = (apyTotal != null && apyBase != null) ? apyTotal - apyBase : null;
    
    console.log(`  ✅ ${vault.symbol}: ${sharesFormatted.toLocaleString()} shares | APY: ${apyBase?.toFixed(2) || '?'}% base + ${bonusApy?.toFixed(2) || '0'}% bonus = ${apyTotal?.toFixed(2) || '?'}%`);
    
    positions.push({
      wallet,
      label,
      protocol_name: 'Morpho',
      protocol_id: 'morpho',
      symbol: vault.symbol || meta.symbol,
      token_address: token.address,  // use actual token address for DB matching
      asset_symbol: vault.asset_symbol,
      amount: sharesFormatted,
      apy_base: apyBase,
      apy_bonus: bonusApy,
      apy_total: apyTotal,
      bonus_supply_apy: bonusApy,
      tvl: tvl,
      version: vault.version
    });
  }
  
  console.log(`  Found from DB: ${vaultFound}, API lookups: ${apiLookup}`);
  return positions;
}

// ============================================
// Save to database
// ============================================

function savePositions(db, positions) {
  const insertPos = db.prepare(`
    INSERT OR IGNORE INTO positions (wallet, chain, protocol_id, protocol_name, position_type, net_usd, position_index, scanned_at)
    VALUES (?, 'ethereum', 'morpho', 'Morpho', 'supply', ?, ?, datetime('now'))
  `);
  
  const updatePos = db.prepare(`
    UPDATE positions SET net_usd = ?, scanned_at = datetime('now')
    WHERE wallet = ? AND chain = 'ethereum' AND protocol_id = 'morpho' AND position_index = ?
  `);
  
  const insertToken = db.prepare(`
    INSERT INTO position_tokens (position_id, role, symbol, address, amount, apy_base, bonus_supply_apy)
    VALUES (?, 'supply', ?, ?, ?, ?, ?)
  `);
  
  const updateToken = db.prepare(`
    UPDATE position_tokens SET amount = ?, apy_base = ?, bonus_supply_apy = ?
    WHERE position_id = ? AND address = ?
  `);
  
  const findPos = db.prepare(
    "SELECT id FROM positions WHERE wallet = ? AND chain = 'ethereum' AND protocol_id = 'morpho' AND position_index = ?"
  );
  
  const findToken = db.prepare(
    "SELECT id FROM position_tokens WHERE position_id = ? AND address = ?"
  );
  
  const transaction = db.transaction(() => {
    for (const pos of positions) {
      // Upsert position
      const apyTotal = (pos.apy_base || 0) + (pos.apy_bonus || 0);
      insertPos.run(pos.wallet, apyTotal, pos.token_address);
      updatePos.run(apyTotal, pos.wallet, pos.token_address);
      
      // Get position ID
      const posRow = findPos.get(pos.wallet, pos.token_address);
      if (!posRow) continue;
      
      // Upsert token
      const tokenRow = findToken.get(posRow.id, pos.token_address);
      if (tokenRow) {
        updateToken.run(pos.amount, pos.apy_base, pos.bonus_supply_apy, posRow.id, pos.token_address);
      } else {
        insertToken.run(posRow.id, pos.symbol, pos.token_address, pos.amount, pos.apy_base, pos.bonus_supply_apy);
      }
    }
  });
  
  transaction();
}

// ============================================
// Morpho REST API (market/borrow positions)
// ============================================

const MORPHO_REST_API = 'https://app.morpho.org/api';

async function getBorrowPositions(userAddress) {
  const chainIds = [1, 8453, 42161, 137, 130, 747474, 999, 10, 143, 988, 480];
  const url = `${MORPHO_REST_API}/positions/borrow?userAddress=${userAddress}&limit=500&skip=0&chainIds=${chainIds.join(',')}&orderBy=borrowAssetsUsd&orderDirection=DESC`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return data.items || [];
  } catch { return []; }
}

async function getEarnPositions(userAddress) {
  const chainIds = [1, 8453, 42161, 137, 130, 747474, 999, 10, 143, 988, 480];
  const url = `${MORPHO_REST_API}/positions/earn?userAddress=${userAddress}&limit=500&skip=0&chainIds=${chainIds.join(',')}&orderBy=assetsUsd&orderDirection=DESC`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return data.items || [];
  } catch { return []; }
}

// ============================================
// CLI interface
// ============================================

async function main() {
  const args = process.argv.slice(2);
  
  // Wallet config
  const wallets = [
    { wallet: '0x31eae643b679a84b37e3d0b4bd4f5da90fb04a61', label: 'Reservoir-1' },
    { wallet: '0x99a95a9e38e927486fc878f41ff8b118eb632b10', label: 'Reservoir-3' },
    { wallet: '0x289c204b35859bfb924b9c0759a4fe80f610671c', label: 'Reservoir-2' },
    { wallet: '0x3063c5907faa10c01b242181aa689beb23d2bd65', label: 'Euler-Wallet' },
  ];
  
  // Can specify specific wallet
  if (args[0]) {
    const found = wallets.find(w => w.label.toLowerCase() === args[0].toLowerCase() || w.wallet.toLowerCase() === args[0].toLowerCase());
    if (found) {
      wallets.length = 0;
      wallets.push(found);
    }
  }
  
  const db = new Database(DB_PATH);
  
  console.log('=== Morpho Position Scanner ===');
  console.log(`Scanning ${wallets.length} wallets...`);
  
  const allPositions = [];
  
  for (const w of wallets) {
    const positions = await scanWallet(db, w.wallet, w.label);
    allPositions.push(...positions);
  }
  
  // Save to DB
  savePositions(db, allPositions);
  
  console.log(`\n=== Vault positions: ${allPositions.length} ===`);
  
  // === REST API: Market/borrow positions ===
  console.log("\n=== Scanning market positions (REST API) ===");
  let totalBorrowUsd = 0;
  for (const w of wallets) {
    const borrowPositions = await getBorrowPositions(w.wallet);
    if (borrowPositions.length > 0) {
      console.log(`  ${w.label}: ${borrowPositions.length} borrow positions`);
      for (const p of borrowPositions) {
        const loan = p.market?.loanAsset?.symbol || "?";
        const coll = p.market?.collateralAsset?.symbol || "?";
        const hf = p.healthFactor?.toFixed(3) || "?";
        const borrowUsd = (p.borrowAssetsUsd / 1e6).toFixed(2);
        console.log(`    ${loan}/${coll}: $${borrowUsd}M borrow, HF=${hf}`);
        totalBorrowUsd += p.borrowAssetsUsd || 0;
      }
    }
  }
  console.log(`  Total borrow: $${(totalBorrowUsd / 1e6).toFixed(2)}M`);

  
  db.close();
}

// Export for use as module
module.exports = { scanWallet, savePositions };

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}
