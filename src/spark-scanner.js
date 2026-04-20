#!/usr/bin/env node
/**
 * Spark Position Scanner (Aave-style)
 *
 * Source of truth for SparkLend positions.
 * Uses reusable Aave-fork RPC helpers for SparkLend.
 * Also scans Spark Savings vaults (spUSDC, spUSDT, etc.)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const Database = require('better-sqlite3');
const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const { getProvider, scanAaveForkWallet, ERC20_ABI } = require('./aave-fork-rpc');

const POOL_ADDRESSES_PROVIDER = '0x02C3eA4e34C0cBd694D2adFa2c690EECbC1793eE';

const SPARK_SAVINGS = {
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

async function getSparkSavingsPositions(wallet, label, provider) {
  const positions = [];

  for (const [name, config] of Object.entries(SPARK_SAVINGS)) {
    try {
      const token = new (require('ethers').Contract)(config.address, ERC20_ABI, provider);
      const balance = await token.balanceOf(wallet);

      if (balance > 0n) {
        let underlyingAmount = balance;

        try {
          const vault = new (require('ethers').Contract)(config.address, ERC4626_ABI, provider);
          underlyingAmount = await vault.convertToAssets(balance);
        } catch {
          try {
            const vault = new (require('ethers').Contract)(config.address, ERC4626_ABI, provider);
            const totalAssets = await vault.totalAssets();
            const totalSupply = await vault.totalSupply();
            if (totalSupply > 0n) {
              underlyingAmount = (balance * totalAssets) / totalSupply;
            }
          } catch {
            // Keep raw balance
          }
        }

        const formattedAmount = Number(underlyingAmount) / (10 ** config.decimals);

        positions.push({
          wallet, label,
          chain: 'eth',
          chainId: 1,
          protocol_name: 'Spark Savings',
          protocol_id: 'spark-savings',
          position_type: 'supply',
          strategy: 'Savings',
          symbol: name,
          token_address: config.address,
          amount: formattedAmount,
          value_usd: 0,
          apy_base: null,
        });
      }
    } catch {
      // Skip failed tokens
    }
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
    if (pos.protocol_id !== 'spark-savings') continue;

    try {
      const res = await fetch(`https://spark.data.blockanalitica.com/v1/tokens/${pos.token_address}/?chainid=1`);
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

    const lendPositions = await getSparkLendPositions(w.addr, w.label, provider);
    for (const p of lendPositions) {
      const usd = p.value_usd > 0 ? `$${p.value_usd.toLocaleString()}` : 'pending';
      const apy = p.apy_base?.toFixed(2) || '?';
      const type = p.position_type === 'supply' ? '✅' : '📊';
      console.log(`  ${type} SparkLend ${p.symbol}: ${usd} | ${p.position_type} | APY: ${apy}%`);
    }

    const savingsPositions = await getSparkSavingsPositions(w.addr, w.label, provider);
    for (const p of savingsPositions) {
      console.log(`  💰 Spark Savings ${p.symbol}: ${p.amount.toLocaleString()} | pending USD`);
    }

    allPositions.push(...lendPositions, ...savingsPositions);
  }

  console.log('\nEnriching savings APYs...');
  await enrichSavingsAPY(allPositions);
  savePositions(db, allPositions);

  console.log(`\n=== Summary ===`);
  console.log(`Total positions: ${allPositions.length}`);
  console.log(`  SparkLend: ${allPositions.filter(p => p.protocol_id === 'spark-lend').length}`);
  console.log(`  Spark Savings: ${allPositions.filter(p => p.protocol_id === 'spark-savings').length}`);

  db.close();
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { getSparkLendPositions, getSparkSavingsPositions, savePositions, enrichSavingsAPY };
