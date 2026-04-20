#!/usr/bin/env node
/**
 * onchain-scanner.js
 * 
 * On-chain position discovery via Transfer events and balanceOf.
 * Replaces unreliable API position queries with direct RPC calls.
 * 
 * Strategy:
 * 1. Maintain a registry of known vault addresses (Morpho v1/v2, Euler)
 * 2. Scan Transfer events TO wallet from each vault (= minted shares)
 * 3. For each vault with balance, probe for metadata (name, asset, APY)
 * 4. Enrich with Merkl rewards
 * 5. Run full vault list periodically to catch new deployments
 */

const RPC_URL = 'https://eth.drpc.org';
const TRANSFER_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// ─── RPC helpers ────────────────────────────────────────────

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const data = await res.json();
  if (data.error) throw new Error(`RPC error: ${data.error.message}`);
  return data.result;
}

async function getBlockNumber() {
  const hex = await rpc('eth_blockNumber', []);
  return parseInt(hex, 16);
}

// ─── ERC-20 helpers ─────────────────────────────────────────

async function balanceOf(token, wallet) {
  const data = '0x70a08231' + '000000000000000000000000' + wallet.slice(2);
  try {
    const result = await rpc('eth_call', [{ to: token, data }, 'latest']);
    if (!result || result === '0x') return 0n;
    return BigInt(result);
  } catch { return 0n; }
}

async function decimals(token) {
  try {
    const result = await rpc('eth_call', [{ to: token, data: '0x313ce567' }, 'latest']);
    return result && result !== '0x' ? parseInt(result, 16) : 18;
  } catch { return 18; }
}

async function symbol(token) {
  try {
    const result = await rpc('eth_call', [{ to: token, data: '0x95d89b41' }, 'latest']);
    if (!result || result === '0x') return 'UNKNOWN';
    const len = parseInt(result.slice(2, 66), 16);
    if (len > 20 || len === 0) return 'UNKNOWN';
    return Buffer.from(result.slice(66, 66 + len * 2), 'hex').toString();
  } catch { return 'UNKNOWN'; }
}

async function name(token) {
  try {
    const result = await rpc('eth_call', [{ to: token, data: '0x06fdde03' }, 'latest']);
    if (!result || result === '0x') return '';
    const len = parseInt(result.slice(2, 66), 16);
    if (len > 50 || len === 0) return '';
    return Buffer.from(result.slice(66, 66 + len * 2), 'hex').toString();
  } catch { return ''; }
}

// ─── ERC-4626 vault detection ───────────────────────────────

async function probeVault(vaultAddr) {
  // asset() → underlying token address
  try {
    const result = await rpc('eth_call', [{ to: vaultAddr, data: '0x52ef1b7d' }, 'latest']);
    if (result && result !== '0x') {
      return '0x' + result.slice(-40);
    }
  } catch {}
  return null;
}

// ─── Transfer event scanner ─────────────────────────────────
// Scan Transfer events TO wallet from specific token contracts

async function scanTransfersTo(wallet, tokenAddresses, fromBlock, toBlock) {
  const walletTopic = '0x000000000000000000000000' + wallet.slice(2).toLowerCase();
  const results = [];
  
  // Batch scan: all Transfer events TO wallet (no address filter)
  // Works on some RPCs but may time out on others
  const params = {
    fromBlock: '0x' + fromBlock.toString(16),
    toBlock: '0x' + toBlock.toString(16),
    topics: [TRANSFER_SIG, null, walletTopic]
  };
  
  // If specific addresses, use them as address filter
  if (tokenAddresses && tokenAddresses.length > 0) {
    // Scan each address individually (more reliable)
    for (const addr of tokenAddresses) {
      params.address = addr;
      try {
        const logs = await rpc('eth_getLogs', [params]);
        if (logs && logs.length > 0) {
          results.push({ address: addr.toLowerCase(), count: logs.length, lastBlock: parseInt(logs[logs.length-1].blockNumber, 16) });
        }
      } catch (e) {
        // Some RPCs don't support address filter with topics
      }
    }
  }
  
  return results;
}

// ─── Vault Registry ─────────────────────────────────────────
// This grows as we discover new vaults

const VAULT_REGISTRY = new Map();

// Known token addresses → symbol mapping (bypasses broken RPC symbol())
const TOKEN_SYMBOLS = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
  '0x6c3ea9036406852006290770bedfcaba0e23a0e8': 'PYUSD',
  '0x8292bb45bf1ee4d140127049757c2e0ff06317ed': 'RLUSD',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
  '0x4fabb145d64652a948d72533023f6e7a623c7c53': 'BUSD',
  '0x514910771af9ca656af840dff83e8264ecf986ca': 'LINK',
  '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': 'AAVE',
  '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2': 'MKR',
  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': 'UNI',
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'WBTC',
  '0x58d97b57bb95320f9a05dc918aef65434969c2b2': 'senRLUSDv1',
  '0xb576765fb15505433af24fee2c0325895c559fb2': 'senRLUSDv2',
  '0x4d15e62900b9f518352a94daf6c46b11775e3697': 'unknown',
  '0x6dc58a0fdfc8d694e571dc59b9a52eeea780e6bf': 'senRLUSDv2',
  '0xaf5372792a29dc6b296d6ffd4aa3386aff8f9bb2': 'eRLUSD-7',
  '0x69ebf644533655b5d3b6455e8e47dde21b5993f1': 'ePYUSD-6',
  '0xba98fc35c9dfd69178ad5dce9fa29c64554783b5': 'ePYUSD-6',
  '0x36716540fcab3ee593651ea4a00a48c85d6fd74c': 'senPYUSD',
  '0xb576765fb15505433af24fee2c0325895c559fb2': 'RLUSD_v1_shares',
  '0xd533a949740bb3306d119cc777fa900ba034cd52': 'CRV',
};

function lookupSymbol(addr) {
  return TOKEN_SYMBOLS[addr.toLowerCase()] || 'UNKNOWN';
}

// Load from file if exists
function loadRegistry() {
  try {
    const fs = require('fs');
    const data = fs.readFileSync('/home/node/.openclaw/workspace/protocol-yield-tracker/data/vault-registry.json', 'utf8');
    const parsed = JSON.parse(data);
    for (const [addr, info] of Object.entries(parsed)) {
      VAULT_REGISTRY.set(addr.toLowerCase(), info);
    }
    console.log(`  Loaded ${VAULT_REGISTRY.size} vaults from registry`);
  } catch {
    console.log('  No vault registry file, starting fresh');
  }
}

function saveRegistry() {
  const fs = require('fs');
  const dir = '/home/node/.openclaw/workspace/protocol-yield-tracker/data';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const obj = {};
  for (const [k, v] of VAULT_REGISTRY) obj[k] = v;
  fs.writeFileSync(`${dir}/vault-registry.json`, JSON.stringify(obj, null, 2));
}

function registerVault(address, info) {
  VAULT_REGISTRY.set(address.toLowerCase(), {
    ...info,
    address: address.toLowerCase(),
    discoveredAt: new Date().toISOString()
  });
}

// ─── Known vault seeding ────────────────────────────────────
// Start with vaults we've already found

function seedKnownVaults() {
  const known = [
    // Morpho v2 MetaMorpho vaults
    { address: '0x6dC58a0FdfC8D694e571DC59B9A52EEEa780E6bf', symbol: 'senRLUSDv2', asset: 'RLUSD', assetAddress: '0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD', protocol: 'morpho-v2', chain: 1 },
    // Euler vaults  
    { address: '0xaF5372792a29dC6b296d6FFD4AA3386aff8f9BB2', symbol: 'eRLUSD-7', asset: 'RLUSD', assetAddress: '0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD', protocol: 'euler', chain: 1 },
    { address: '0x69ebF644533655B5D3b6455e8E47ddE21b5993f1', symbol: 'ePYUSD-6', asset: 'PYUSD', assetAddress: '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8', protocol: 'euler', chain: 1 },
    { address: '0xba98fC35C9dfd69178AD5dcE9FA29c64554783b5', symbol: 'ePYUSD-6', asset: 'PYUSD', assetAddress: '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8', protocol: 'euler', chain: 1 },
    // Additional vaults discovered via Transfer events
    { address: '0xb576765fb15505433af24fee2c0325895c559fb2', symbol: 'RLUSD_v1_shares', asset: 'RLUSD', protocol: 'morpho-v1', chain: 1 },
    { address: '0x58d97b57bb95320f9a05dc918aef65434969c2b2', symbol: 'senRLUSDv1', asset: 'RLUSD', protocol: 'morpho-v1', chain: 1 },
  ];
  
  for (const v of known) {
    registerVault(v.address, v);
  }
  console.log(`  Seeded ${known.length} known vaults`);
}

// ─── Main scan pipeline ─────────────────────────────────────

async function scanWallet(wallet, label) {
  console.log(`\n🔍 Scanning ${label} (${wallet.slice(0,12)}...)`);
  
  const currentBlock = await getBlockNumber();
  const scanFrom = currentBlock - 50000; // Last ~7 days
  const positions = [];
  
  // Scan each registered vault
  for (const [vaultAddr, vaultInfo] of VAULT_REGISTRY) {
    const bal = await balanceOf(vaultAddr, wallet);
    if (bal > 0n) {
      const dec = await decimals(vaultAddr);
      const shares = Number(bal) / (10 ** dec);
      
      console.log(`  ✅ ${vaultInfo.symbol || 'Unknown'}: ${shares.toLocaleString()} shares`);
      
      positions.push({
        vault: vaultAddr,
        symbol: vaultInfo.symbol || 'Unknown',
        asset: vaultInfo.asset || 'Unknown',
        protocol: vaultInfo.protocol || 'unknown',
        shares,
        decimals: dec,
        rawBalance: bal.toString()
      });
    }
  }
  
  return { wallet, label, positions, block: currentBlock, scanFrom };
}

// ─── Discover new vaults from Transfer events ───────────────
// Scan Transfer events TO wallet to find tokens we haven't registered

async function discoverNewVaults(wallet, fromBlock, toBlock) {
  console.log('\n🔎 Discovering new vault/transfer tokens...');
  
  const walletTopic = '0x000000000000000000000000' + wallet.slice(2).toLowerCase();
  
  // Chunk into 5000-block batches (free RPC limit)
  const logs = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + 5000, toBlock);
    try {
      const batch = await rpc('eth_getLogs', [{
        fromBlock: '0x' + start.toString(16),
        toBlock: '0x' + end.toString(16),
        topics: [TRANSFER_SIG, null, walletTopic]
      }]);
      if (batch) logs.push(...batch);
    } catch (e) {
      process.stdout.write('.');
    }
    start = end + 1;
  }
  
  if (logs.length === 0) {
    console.log('  No Transfer events found in block range');
    return [];
  }
  
  // Group by token address
const tokenTransfers = new Map();
for (const log of logs) {
  const addr = log.address.toLowerCase();
  if (!tokenTransfers.has(addr)) {
    tokenTransfers.set(addr, { count: 0, lastBlock: 0 });
  }
  const t = tokenTransfers.get(addr);
  t.count++;
  t.lastBlock = Math.max(t.lastBlock, parseInt(log.blockNumber, 16));
}

console.log(`  Found ${logs.length} Transfer events to ${tokenTransfers.size} unique tokens`);

// Probe each token that we don't already know
const newTokens = [];
for (const [addr, info] of tokenTransfers) {
  if (VAULT_REGISTRY.has(addr)) continue;
  
  // Check balance first
  const bal = await balanceOf(addr, wallet);
  if (bal === 0n) continue;
  
  // Probe for vault interface
  const underlying = await probeVault(addr);
  const sym = lookupSymbol(addr);
  const nm = sym;
  const dec = await decimals(addr);
  
  const tokenInfo = {
    address: addr,
    symbol: sym,
    name: nm,
    decimals: dec,
    transfers: info.count,
    balance: bal.toString(),
    isVault: underlying !== null,
    underlyingAsset: underlying
  };
  
  newTokens.push(tokenInfo);
  
  if (underlying) {
    console.log(`  🏦 NEW VAULT: ${sym} (${nm}) → underlying: ${underlying.slice(0,12)}`);
  } else {
    const balNum = Number(bal) / (10 ** dec);
    if (balNum > 0.01) {
      console.log(`  🪙 NEW TOKEN: ${sym} = ${balNum.toLocaleString()}`);
    }
  }
}

    return newTokens;
}

// ─── Run ────────────────────────────────────────────────────

async function main() {
  const wallets = [
    { label: 'Reservoir', addr: '0x3063c5907faa10c01b242181aa689beb23d2bd65' },
    { label: 'Reservoir-2', addr: '0x289c204b35859bfb924b9c0759a4fe80f610671c' },
    { label: 'Makina', addr: '0xd1a1c248b253f1fc60eacd90777b9a63f8c8c1bc' },
  ];
  
  console.log('=== On-Chain Position Scanner ===\n');
  console.log('RPC:', RPC_URL);
  console.log('Block:', await getBlockNumber());
  
  // Load/seed vault registry
  loadRegistry();
  if (VAULT_REGISTRY.size === 0) {
    seedKnownVaults();
  }
  console.log(`Registry: ${VAULT_REGISTRY.size} vaults\n`);
  
  // Scan each wallet
  for (const w of wallets) {
    const result = await scanWallet(w.addr, w.label);
    
    // Also scan for new tokens/vaults via Transfer events
    const currentBlock = result.block;
    const fromBlock = currentBlock - 100000;
    
    const newTokens = await discoverNewVaults(w.addr, fromBlock, currentBlock);
    
    // Register new vaults found
    for (const t of newTokens) {
      if (t.isVault) {
        registerVault(t.address, {
          symbol: t.symbol,
          asset: t.underlyingAsset,
          protocol: 'discovered',
          chain: 1
        });
      }
    }
    
    console.log(`  Total positions: ${result.positions.length}`);
    for (const p of result.positions) {
      console.log(`    ${p.protocol} ${p.symbol} (${p.asset}): ${p.shares.toLocaleString()} shares`);
    }
  }
  
  // Save updated registry
  saveRegistry();
  console.log(`\nRegistry saved: ${VAULT_REGISTRY.size} vaults`);
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { scanWallet, discoverNewVaults, balanceOf, probeVault, VAULT_REGISTRY };
