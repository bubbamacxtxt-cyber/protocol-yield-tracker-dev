#!/usr/bin/env node
/**
 * Spark Position Scanner (Aave-style)
 * 
 * Source of truth for SparkLend positions.
 * Uses PoolAddressesProvider → Pool → DataProvider pattern.
 * Also scans Spark Savings vaults (spUSDC, spUSDT, etc.)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const Database = require('better-sqlite3');
const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');

// Spark PoolAddressesProvider (Ethereum mainnet)
const POOL_ADDRESSES_PROVIDER = '0x02C3eA4e34C0cBd694D2adFa2c690EECbC1793eE';

// Spark Savings tokens (from BlockAnalitica + docs)
const SPARK_SAVINGS = {
  spUSDC:  { address: '0x28B3a8fb53B741A8Fd78c0fb9A6B2393d896a43d', underlying: 'USDC',  decimals: 6 },
  spUSDT:  { address: '0xe2e7a17dFf93280dec073C995595155283e3C372', underlying: 'USDT',  decimals: 6 },
  spETH:   { address: '0xfE6eb3b609a7C8352A241f7F3A21CEA4e9209B8f', underlying: 'WETH',  decimals: 18 },
  spPYUSD: { address: '0x80128DbB9f07b93DDE62A6daeadb69ED14a7D354', underlying: 'PYUSD', decimals: 6 },
  stUSDS:  { address: '0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9', underlying: 'USDS',  decimals: 18 },
};

const ADDRESSES_PROVIDER_ABI = [
  'function getPool() view returns (address)',
  'function getPoolDataProvider() view returns (address)',
  'function getPriceOracle() view returns (address)'
];

const POOL_ABI = [
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getReservesList() view returns (address[])'
];

const DATA_PROVIDER_ABI = [
  'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
  'function getReserveData(address asset) view returns (uint256 unbacked, uint128 accruedToTreasuryScaled, uint128 totalAToken, uint128 totalStableDebt, uint128 totalVariableDebt, uint128 liquidityRate, uint40 lastUpdateTimestamp, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint8 id)',
  'function getAllReservesTokens() view returns (tuple(string symbol, address tokenAddress)[])'
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
];

const ERC4626_ABI = [
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function asset() view returns (address)'
];

// Simple RPC provider (using Alchemy if available, fallback to public)
function getProvider() {
  const rpcUrl = process.env.ALCHEMY_RPC_URL || process.env.ETH_RPC_URL || 'https://eth.drpc.org';
  return new (require('ethers').JsonRpcProvider)(rpcUrl);
}

async function getSparkLendPositions(wallet, label, provider) {
  const positions = [];
  
  try {
    // Step 1: Get contracts from AddressProvider
    const addressProvider = new (require('ethers').Contract)(
      POOL_ADDRESSES_PROVIDER, ADDRESSES_PROVIDER_ABI, provider
    );
    
    const poolAddress = await addressProvider.getPool();
    const dataProviderAddress = await addressProvider.getPoolDataProvider();
    
    const pool = new (require('ethers').Contract)(poolAddress, POOL_ABI, provider);
    const dataProvider = new (require('ethers').Contract)(dataProviderAddress, DATA_PROVIDER_ABI, provider);
    
    // Step 2: Get user account summary
    const accountData = await pool.getUserAccountData(wallet);
    const healthFactor = accountData.healthFactor;
    
    // Step 3: Get all reserves
    let reserves;
    try {
      const tokens = await dataProvider.getAllReservesTokens();
      reserves = tokens.map(t => ({ address: t.tokenAddress, symbol: t.symbol }));
    } catch {
      // Fallback: getReservesList + manual symbol lookup
      const reserveList = await pool.getReservesList();
      reserves = [];
      for (const addr of reserveList) {
        try {
          const token = new (require('ethers').Contract)(addr, ERC20_ABI, provider);
          const symbol = await token.symbol();
          reserves.push({ address: addr, symbol });
        } catch {
          reserves.push({ address: addr, symbol: '?' });
        }
      }
    }
    
    // Step 4: Check each reserve for user positions
    for (const reserve of reserves) {
      try {
        const data = await dataProvider.getUserReserveData(reserve.address, wallet);
        
        const supplied = data.currentATokenBalance;
        const stableDebt = data.currentStableDebt;
        const variableDebt = data.currentVariableDebt;
        const supplyApy = data.liquidityRate;
        const borrowApy = data.stableBorrowRate;
        const underlyingToken = new (require('ethers').Contract)(reserve.address, ERC20_ABI, provider);
        const underlyingDecimals = await underlyingToken.decimals();
        
        if (supplied > 0n) {
          const rawBalance = supplied;
          const formattedBalance = Number(rawBalance) / (10 ** Number(underlyingDecimals));
          
          positions.push({
            wallet, label,
            chain: 'eth',
            chainId: 1,
            protocol_name: 'SparkLend',
            protocol_id: 'spark-lend',
            position_type: 'supply',
            strategy: 'Lend',
            symbol: reserve.symbol,
            token_address: reserve.address,
            amount: formattedBalance,
            value_usd: 0, // Will be enriched later
            apy_base: (Number(supplyApy) / 1e25), // Ray to percent
            is_collateral: data.usageAsCollateralEnabled,
            health_factor: healthFactor > 0n ? Number(healthFactor) / 1e18 : null,
          });
        }
        
        if (stableDebt > 0n || variableDebt > 0n) {
          const totalDebt = stableDebt + variableDebt;
          const formattedDebt = Number(totalDebt) / (10 ** Number(underlyingDecimals));
          
          positions.push({
            wallet, label,
            chain: 'eth',
            chainId: 1,
            protocol_name: 'SparkLend',
            protocol_id: 'spark-lend',
            position_type: 'borrow',
            strategy: 'Borrow',
            symbol: reserve.symbol,
            token_address: reserve.address,
            amount: formattedDebt,
            value_usd: 0, // Will be enriched later
            apy_base: (Number(borrowApy) / 1e25), // Ray to percent
            is_collateral: false,
            health_factor: healthFactor > 0n ? Number(healthFactor) / 1e18 : null,
          });
        }
      } catch (err) {
        // Skip failed reserves
      }
    }
  } catch (err) {
    console.error(`  ❌ SparkLend scan failed for ${wallet.slice(0,12)}:`, err.message);
  }
  
  return positions;
}

async function getSparkSavingsPositions(wallet, label, provider) {
  const positions = [];
  
  for (const [name, config] of Object.entries(SPARK_SAVINGS)) {
    try {
      const token = new (require('ethers').Contract)(config.address, ERC20_ABI, provider);
      const balance = await token.balanceOf(wallet);
      
      if (balance > 0n) {
        let underlyingAmount = balance;
        
        // Try ERC-4626 conversion
        try {
          const vault = new (require('ethers').Contract)(config.address, ERC4626_ABI, provider);
          underlyingAmount = await vault.convertToAssets(balance);
        } catch {
          // Fallback: totalAssets / totalSupply
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
          value_usd: 0, // Will be enriched later
          apy_base: null, // Will be enriched from BlockAnalitica
        });
      }
    } catch (err) {
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
  // Fetch APY from BlockAnalitica for Spark Savings tokens
  for (const pos of positions) {
    if (pos.protocol_id !== 'spark-savings') continue;
    
    try {
      const res = await fetch(`https://spark.data.blockanalitica.com/v1/tokens/${pos.token_address}/?chainid=1`);
      const payload = await res.json();
      const data = payload.data || payload; // Handle both {data: {...}} and direct response
      
      if (data.rate) {
        pos.apy_base = parseFloat(data.rate) * 100; // Convert decimal to percent
      }
      if (data.price_usd && pos.amount > 0) {
        pos.value_usd = pos.amount * parseFloat(data.price_usd);
      }
    } catch {
      // Keep null APY
    }
  }
  return positions;
}

async function main() {
  const fs = require('fs');
  const { JsonRpcProvider } = require('ethers');
  
  const whales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));
  const walletMap = [];
  for (const [label, config] of Object.entries(whales)) {
    const addrs = Array.isArray(config) ? config : (config.vaults ? Object.values(config.vaults).flat() : []);
    for (const addr of addrs) {
      walletMap.push({ addr, label });
    }
  }
  
  const provider = getProvider();
  const db = new Database(DB_PATH);
  const allPositions = [];
  
  console.log('=== Spark Scanner ===\n');
  console.log(`Scanning ${walletMap.length} wallets\n`);
  
  for (const w of walletMap) {
    console.log(`${w.label} (${w.addr.slice(0,12)}...)`);
    
    // Scan SparkLend
    const lendPositions = await getSparkLendPositions(w.addr, w.label, provider);
    for (const p of lendPositions) {
      const usd = p.value_usd > 0 ? `$${p.value_usd.toLocaleString()}` : 'pending';
      const apy = p.apy_base?.toFixed(2) || '?';
      const type = p.position_type === 'supply' ? '✅' : '📊';
      console.log(`  ${type} SparkLend ${p.symbol}: ${usd} | ${p.position_type} | APY: ${apy}%`);
    }
    
    // Scan Spark Savings
    const savingsPositions = await getSparkSavingsPositions(w.addr, w.label, provider);
    for (const p of savingsPositions) {
      console.log(`  💰 Spark Savings ${p.symbol}: ${p.amount.toLocaleString()} | pending USD`);
    }
    
    allPositions.push(...lendPositions, ...savingsPositions);
  }
  
  // Enrich savings APYs
  console.log('\nEnriching savings APYs...');
  await enrichSavingsAPY(allPositions);
  
  // Save to DB
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
