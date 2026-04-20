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

const POOL_ADDRESSES_PROVIDER = '0x02C3eA4e34C0cBd694D2adFa2c690EECbC1793eE';

const CHAIN_RPC_URLS = {
  eth: () => process.env.ALCHEMY_RPC_URL || process.env.ETH_RPC_URL || 'https://eth.drpc.org',
  base: () => process.env.BASE_RPC_URL || process.env.ALCHEMY_BASE_RPC_URL || 'https://base.drpc.org',
  arb: () => process.env.ARB_RPC_URL || process.env.ARBITRUM_RPC_URL || process.env.ALCHEMY_ARB_RPC_URL || 'https://arbitrum.drpc.org',
  op: () => process.env.OP_RPC_URL || process.env.OPTIMISM_RPC_URL || process.env.ALCHEMY_OP_RPC_URL || 'https://optimism.drpc.org',
  unichain: () => process.env.UNICHAIN_RPC_URL,
};

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
  op: {
    chainId: 10,
    tokens: {
      sUSDS: { address: '0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0', underlying: 'USDS', decimals: 18 },
      sUSDC: { address: '0xCF9326e24EBfFBEF22ce1050007A43A3c0B6DB55', underlying: 'USDC', decimals: 6 },
    },
  },
  unichain: {
    chainId: 130,
    tokens: {
      sUSDS: { address: '0xA06b10Db9F390990364A3984C04FaDf1c13691b5', underlying: 'USDS', decimals: 18 },
      sUSDC: { address: '0x14d9143BEcC348920b68D123687045db49a016C6', underlying: 'USDC', decimals: 6 },
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

    let underlyingAmount = balance;
    try {
      const vault = new Contract(config.address, ERC4626_ABI, provider);
      underlyingAmount = await vault.convertToAssets(balance);
    } catch {
      try {
        const vault = new Contract(config.address, ERC4626_ABI, provider);
        const totalAssets = await vault.totalAssets();
        const totalSupply = await vault.totalSupply();
        if (totalSupply > 0n) underlyingAmount = (balance * totalAssets) / totalSupply;
      } catch {
        // Keep raw balance when no ERC4626 path works
      }
    }

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
      amount: Number(underlyingAmount) / (10 ** config.decimals),
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

async function enrichSavingsAPY(positions) {
  for (const pos of positions) {
    if (pos.protocol_id !== 'spark-savings' && pos.protocol_id !== 'spark-savings-legacy') continue;

    try {
      const chainid = pos.chainId || 1;
      const res = await fetch(`https://spark.data.blockanalitica.com/v1/tokens/${pos.token_address}/?chainid=${chainid}`);
      const payload = await res.json();
      const data = payload.data || payload;

      if (data.rate) pos.apy_base = parseFloat(data.rate) * 100;
      if (data.price_usd && pos.amount > 0) pos.value_usd = pos.amount * parseFloat(data.price_usd);
    } catch {
      // Keep null APY
    }
  }
  return positions;
}

async function main() {
  const fs = require('fs');
  const whales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));
  const walletMap = [];
  for (const [label, config] of Object.entries(whales)) {
    const addrs = Array.isArray(config) ? config : (config.vaults ? Object.values(config.vaults).flat() : []);
    for (const addr of addrs) walletMap.push({ addr, label });
  }

  const provider = getProvider();
  const db = new Database(DB_PATH);
  const allPositions = [];

  console.log('=== Spark Scanner ===\n');
  console.log(`Scanning ${walletMap.length} wallets\n`);

  for (const w of walletMap) {
    console.log(`${w.label} (${w.addr.slice(0,12)}...)`);
    const started = Date.now();

    const lendPositions = await getSparkLendPositions(w.addr, w.label, provider);
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
