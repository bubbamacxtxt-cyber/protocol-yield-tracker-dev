#!/usr/bin/env node
/**
 * Spark Position Scanner (Aave-style)
 *
 * Source of truth for SparkLend positions.
 * Uses reusable Aave-fork RPC helpers for SparkLend.
 * Also scans Spark Savings balances.
 *
 * Notes:
 * - SparkLend currently scanned on Ethereum only in this file.
 * - Spark Savings registry is based on current Spark docs.
 * - Designed to tolerate constrained RPCs with raw eth_call fallback.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const Database = require('better-sqlite3');
const { Contract } = require('ethers');
const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const { JsonRpcProvider } = require('ethers');
const { getProvider, scanAaveForkWallet, ERC20_ABI } = require('./aave-fork-rpc');
const { loadActiveWalletChains, loadWhaleWalletMap } = require('./recon-helpers');

const POOL_ADDRESSES_PROVIDER = '0x02C3eA4e34C0cBd694D2adFa2c690EECbC1793eE';

const CHAIN_RPC_URLS = {
  eth: () => process.env.ALCHEMY_RPC_URL || process.env.ETH_RPC_URL || 'https://eth.drpc.org',
  base: () => process.env.BASE_RPC_URL || process.env.ALCHEMY_BASE_RPC_URL || 'https://base.drpc.org',
  arb: () => process.env.ARB_RPC_URL || process.env.ARBITRUM_RPC_URL || process.env.ALCHEMY_ARB_RPC_URL || 'https://arbitrum.drpc.org',
};

// NOTE: `decimals` here means the UNDERLYING token's decimals, not the share
// token's. convertToAssets() returns raw amounts in underlying decimals
// (e.g. 1.09 USDC = 1094557 for 6-decimal USDC), so this is what we need
// to divide by when converting BigInt -> Number.
// Previous bug: decimals=18 was set for sUSDC treating it as share-decimals,
// which made 6.24M USDC read as 0.0000062M. Corrected to match underlying.
const SPARK_SAVINGS_BY_CHAIN = {
  eth: {
    chainId: 1,
    tokens: {
      sUSDS: { address: '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd', underlying: 'USDS', decimals: 18 },
      sUSDC: { address: '0xBc65ad17c5C0a2A4D159fa5a503f4992c7B545FE', underlying: 'USDC', decimals: 6 },
    },
  },
  base: {
    chainId: 8453,
    tokens: {
      sUSDS: { address: '0x5875eEE11Cf8398102FdAd704C9E96607675467a', underlying: 'USDS', decimals: 18 },
      sUSDC: { address: '0x3128a0F7f0ea68E7B7c9B00AFa7E41045828e858', underlying: 'USDC', decimals: 6 },
    },
  },
  arb: {
    chainId: 42161,
    tokens: {
      sUSDS: { address: '0xdDb46999F8891663a8F2828d25298f70416d7610', underlying: 'USDS', decimals: 18 },
      sUSDC: { address: '0x940098b108fB7D0a7E374f6eDED7760787464609', underlying: 'USDC', decimals: 6 },
    },
  },
};

const LEGACY_SPARK_SAVINGS_ETH = {
  spUSDC:  { address: '0x28B3a8fb53B741A8Fd78c0fb9A6B2393d896a43d', underlying: 'USDC',  decimals: 6 },
  spUSDT:  { address: '0xe2e7a17dFf93280dec073C995595155283e3C372', underlying: 'USDT',  decimals: 6 },
  spETH:   { address: '0xfE6eb3b609a7C8352A241f7F3A21CEA4e9209B8f', underlying: 'WETH',  decimals: 18 },
  spPYUSD: { address: '0x80128DbB9f07b93DDE62A6daeadb69ED14a7D354', underlying: 'PYUSD', decimals: 6 },
  stUSDS:  { address: '0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9', underlying: 'USDS',  decimals: 18 },
};

const ERC4626_ABI = [
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function asset() view returns (address)'
];

async function getSparkLendPositions(wallet, label, provider) {
  try {
    const result = await scanAaveForkWallet({
      wallet,
      label,
      chain: 'eth',
      chainId: 1,
      providerAddress: POOL_ADDRESSES_PROVIDER,
      protocolName: 'SparkLend',
      protocolId: 'spark-lend',
      provider,
    });
    return result.positions;
  } catch (err) {
    console.error(`  ❌ SparkLend scan failed for ${wallet.slice(0,12)}:`, err.message);
    return [];
  }
}

async function readSavingsBalance(wallet, label, provider, chain, chainId, symbol, config, protocolName = 'Spark Savings', protocolId = 'spark-savings') {
  try {
    const token = new Contract(config.address, ERC20_ABI, provider);
    const balance = await token.balanceOf(wallet);
    if (balance <= 0n) return null;

    // Resolve the underlying asset amount.
    // convertToAssets() and totalAssets() both return raw values in UNDERLYING
    // decimals (e.g. USDC = 6, USDS = 18), NOT the share token's decimals.
    // When both methods fail, we fall back to the raw share balance — mark it
    // so the division below uses share decimals (18) instead of underlying.
    let underlyingAmount = balance;
    let amountInUnderlying = false;
    try {
      const vault = new Contract(config.address, ERC4626_ABI, provider);
      underlyingAmount = await vault.convertToAssets(balance);
      amountInUnderlying = true;
    } catch {
      try {
        const vault = new Contract(config.address, ERC4626_ABI, provider);
        const totalAssets = await vault.totalAssets();
        const totalSupply = await vault.totalSupply();
        if (totalSupply > 0n) {
          underlyingAmount = (balance * totalAssets) / totalSupply;
          amountInUnderlying = true;
        }
      } catch {
        // Keep raw balance in share decimals when no ERC4626 path works
      }
    }
    const divisorDecimals = amountInUnderlying ? config.decimals : 18;

    return {
      wallet,
      label,
      chain,
      chainId,
      protocol_name: protocolName,
      protocol_id: protocolId,
      position_type: 'supply',
      strategy: 'Savings',
      symbol,
      token_address: config.address,
      amount: Number(underlyingAmount) / (10 ** divisorDecimals),
      value_usd: 0,
      apy_base: null,
    };
  } catch {
    return null;
  }
}

function getChainProvider(chain, defaultProvider) {
  if (chain === 'eth') return defaultProvider;
  const rpcUrl = CHAIN_RPC_URLS[chain]?.();
  if (!rpcUrl) return null;
  return new JsonRpcProvider(rpcUrl);
}

async function getSparkSavingsPositions(wallet, label, provider) {
  const positions = [];

  for (const [chain, meta] of Object.entries(SPARK_SAVINGS_BY_CHAIN)) {
    const chainProvider = getChainProvider(chain, provider);
    if (!chainProvider) continue;

    for (const [symbol, config] of Object.entries(meta.tokens)) {
      const pos = await readSavingsBalance(wallet, label, chainProvider, chain, meta.chainId, symbol, config);
      if (pos) positions.push(pos);
    }
  }

  for (const [symbol, config] of Object.entries(LEGACY_SPARK_SAVINGS_ETH)) {
    const pos = await readSavingsBalance(wallet, label, provider, 'eth', 1, symbol, config, 'Spark Savings Legacy', 'spark-savings-legacy');
    if (pos) positions.push(pos);
  }

  return positions;
}

function savePositions(db, allPositions) {
  const upsertPos = db.prepare(`
    INSERT INTO positions (wallet, chain, protocol_id, protocol_name, position_type, net_usd, position_index, scanned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(wallet, chain, protocol_id, position_index) DO UPDATE SET
      net_usd = excluded.net_usd,
      position_type = excluded.position_type,
      scanned_at = datetime('now')
  `);

  const findPos = db.prepare(`SELECT id FROM positions WHERE wallet = ? AND chain = ? AND protocol_id = ? AND position_index = ?`);

  const upsertToken = db.prepare(`
    INSERT INTO position_tokens (position_id, role, symbol, address, amount, value_usd, apy_base, bonus_supply_apy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const clearTokens = db.prepare(`DELETE FROM position_tokens WHERE position_id = ? AND role = ?`);

  const transaction = db.transaction(() => {
    for (const pos of allPositions) {
      const role = pos.position_type === 'supply' ? 'supply' : 'borrow';
      const posIndex = pos.token_address;
      const netUsd = role === 'borrow' ? -(pos.value_usd || 0) : (pos.value_usd || 0);
      const protocolId = pos.protocol_id;

      upsertPos.run(pos.wallet, pos.chain, protocolId, pos.protocol_name, pos.position_type, netUsd || 0, String(posIndex));
      const posRow = findPos.get(pos.wallet, pos.chain, protocolId, String(posIndex));
      if (!posRow) continue;

      clearTokens.run(posRow.id, role);
      upsertToken.run(
        posRow.id, role, pos.symbol, pos.token_address,
        pos.amount || 0, pos.value_usd || 0,
        pos.apy_base || null, null
      );
    }
  });

  transaction();
}

// DeFiLlama chain slugs for price lookup
const DL_CHAIN_FOR_SPARK = { eth: 'ethereum', base: 'base', arb: 'arbitrum' };

async function priceFromDefiLlama(chain, underlyingSymbol) {
  // For Spark Savings, the underlying is always USDS/USDC/USDT/WETH/PYUSD
  // — all well-known tokens. Price them via the underlying on DefiLlama.
  const addresses = {
    USDC: { eth: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', arb: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
    USDT: { eth: '0xdAC17F958D2ee523a2206206994597C13D831ec7', base: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', arb: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' },
    USDS: { eth: '0xdC035D45d973E3EC169d2276DDab16f1e407384F' },
    WETH: { eth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', base: '0x4200000000000000000000000000000000000006', arb: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
    PYUSD: { eth: '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8' },
  };
  const addr = addresses[underlyingSymbol]?.[chain];
  if (!addr) return null;
  const dlChain = DL_CHAIN_FOR_SPARK[chain] || chain;
  const url = `https://coins.llama.fi/prices/current/${dlChain}:${addr.toLowerCase()}`;
  try {
    const r = await fetch(url);
    const d = await r.json();
    const key = `${dlChain}:${addr.toLowerCase()}`;
    return d?.coins?.[key]?.price || null;
  } catch { return null; }
}

async function enrichSavingsAPY(positions) {
  for (const pos of positions) {
    if (pos.protocol_id !== 'spark-savings' && pos.protocol_id !== 'spark-savings-legacy') continue;

    // Always price the underlying so value_usd is set regardless of blockanalitica success.
    if (pos.value_usd === 0 && pos.amount > 0) {
      // The savings token's underlying is what we care about. Look up the underlying
      // from the savings config (savings scanner stores it implicitly through symbol).
      // For sUSDS/stUSDS → USDS, sUSDC → USDC, spUSDT → USDT, spETH → WETH, spPYUSD → PYUSD.
      const sym = String(pos.symbol || '').toLowerCase();
      let underlying = null;
      if (sym.includes('usds')) underlying = 'USDS';
      else if (sym.includes('usdc')) underlying = 'USDC';
      else if (sym.includes('usdt')) underlying = 'USDT';
      else if (sym.includes('eth')) underlying = 'WETH';
      else if (sym.includes('pyusd')) underlying = 'PYUSD';
      if (underlying) {
        const price = await priceFromDefiLlama(pos.chain, underlying);
        if (price) {
          pos.value_usd = pos.amount * price;
          pos.price_usd = price;
        }
      }
    }

    try {
      const chainid = pos.chainId || 1;
      const res = await fetch(`https://spark.data.blockanalitica.com/v1/tokens/${pos.token_address}/?chainid=${chainid}`);
      const payload = await res.json();
      const data = payload.data || payload;

      if (data.rate) pos.apy_base = parseFloat(data.rate) * 100;
      // NOTE: blockanalitica's price_usd is the SHARE price in underlying units
      // (e.g. 1.094 USDC per sUSDC share), NOT the USD price of the underlying.
      // We already converted the share balance to underlying units via convertToAssets(),
      // so multiplying pos.amount by this would double-apply the exchange rate.
      // Do not use data.price_usd for value_usd — rely on the DeFiLlama USD price
      // of the underlying set above.
    } catch {
      // Keep null APY
    }
  }
  return positions;
}

async function main() {
  const fs = require('fs');
  let walletMap = [];
  const active = loadActiveWalletChains();
  if (active && active.length > 0) {
    const labelByWallet = new Map(loadWhaleWalletMap().map(w => [w.addr, w.label]));
    const seen = new Set();
    for (const row of active) {
      // Spark runtime cleanup: only keep wallet+chain pairs where Spark/Savings is plausibly relevant.
      const chain = String(row.chain || '').toLowerCase();
      if (!['eth', 'base', 'arb'].includes(chain)) continue;
      if (seen.has(`${row.wallet}|${chain}`)) continue;
      seen.add(`${row.wallet}|${chain}`);
      walletMap.push({ addr: row.wallet, label: labelByWallet.get(row.wallet) || row.whale || 'Unknown', chain });
    }
  } else {
    const whales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));
    for (const [label, config] of Object.entries(whales)) {
      const addrs = Array.isArray(config) ? config : (config.vaults ? Object.values(config.vaults).flat() : []);
      for (const addr of addrs) walletMap.push({ addr, label, chain: 'eth' });
    }
  }

  const provider = getProvider();
  const db = new Database(DB_PATH);
  const allPositions = [];

  console.log('=== Spark Scanner ===\n');
  console.log(`Scanning ${walletMap.length} wallets\n`);

  for (const w of walletMap) {
    console.log(`${w.label} (${w.addr.slice(0,12)}...)`);
    const started = Date.now();

    const lendPositions = w.chain === 'eth' ? await getSparkLendPositions(w.addr, w.label, provider) : [];
    for (const p of lendPositions) {
      const usd = p.value_usd > 0 ? `$${p.value_usd.toLocaleString()}` : 'pending';
      const apy = p.apy_base?.toFixed(2) || '?';
      const type = p.position_type === 'supply' ? '✅' : '📊';
      console.log(`  ${type} SparkLend ${p.symbol}: ${usd} | ${p.position_type} | APY: ${apy}%`);
    }

    const savingsPositions = await getSparkSavingsPositions(w.addr, w.label, provider);
    for (const p of savingsPositions) {
      console.log(`  💰 ${p.protocol_name} ${p.symbol}: ${p.amount.toLocaleString()} | pending USD`);
    }

    console.log(`  ⏱ ${(Date.now() - started).toLocaleString()} ms`);
    allPositions.push(...lendPositions, ...savingsPositions);
  }

  console.log('\nEnriching savings APYs...');
  await enrichSavingsAPY(allPositions);
  savePositions(db, allPositions);

  console.log(`\n=== Summary ===`);
  console.log(`Total positions: ${allPositions.length}`);
  console.log(`  SparkLend: ${allPositions.filter(p => p.protocol_id === 'spark-lend').length}`);
  console.log(`  Spark Savings: ${allPositions.filter(p => p.protocol_id === 'spark-savings').length}`);
  console.log(`  Spark Savings Legacy: ${allPositions.filter(p => p.protocol_id === 'spark-savings-legacy').length}`);

  db.close();
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { getSparkLendPositions, getSparkSavingsPositions, savePositions, enrichSavingsAPY, SPARK_SAVINGS_BY_CHAIN };
