#!/usr/bin/env node
/**
 * Reusable Aave-fork RPC scanner helpers.
 * Intended for Spark and similar Aave-v3 style protocols.
 */

const { JsonRpcProvider, Contract } = require('ethers');

const ADDRESSES_PROVIDER_ABI = [
  'function getPool() view returns (address)',
  'function getPoolDataProvider() view returns (address)',
  'function getPriceOracle() view returns (address)',
];

const POOL_ABI = [
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getReservesList() view returns (address[])',
];

const DATA_PROVIDER_ABI = [
  'function getAllReservesTokens() view returns (tuple(string symbol, address tokenAddress)[])',
  'function getReserveData(address asset) view returns (uint256 unbacked, uint128 accruedToTreasuryScaled, uint128 totalAToken, uint128 totalStableDebt, uint128 totalVariableDebt, uint128 liquidityRate, uint40 lastUpdateTimestamp, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint8 id)',
  'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const ORACLE_ABI = [
  'function getAssetPrice(address asset) view returns (uint256)',
];

const contextCache = new Map();

function getRpcUrl(rpcUrl) {
  return rpcUrl || process.env.ALCHEMY_RPC_URL || process.env.ETH_RPC_URL || 'https://eth.drpc.org';
}

function getProvider(rpcUrl) {
  return new JsonRpcProvider(getRpcUrl(rpcUrl));
}

function isLimitedBatchRpc(provider) {
  const url = String(provider?._getConnection?.().url || provider?.connection?.url || '');
  return /drpc\.org/i.test(url);
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      out[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

async function resolveAaveForkContracts(providerAddress, provider) {
  const addressesProvider = new Contract(providerAddress, ADDRESSES_PROVIDER_ABI, provider);
  const [poolAddress, dataProviderAddress, oracleAddress] = await Promise.all([
    addressesProvider.getPool(),
    addressesProvider.getPoolDataProvider(),
    addressesProvider.getPriceOracle(),
  ]);

  return {
    addressesProvider,
    pool: new Contract(poolAddress, POOL_ABI, provider),
    dataProvider: new Contract(dataProviderAddress, DATA_PROVIDER_ABI, provider),
    oracle: new Contract(oracleAddress, ORACLE_ABI, provider),
    poolAddress,
    dataProviderAddress,
    oracleAddress,
  };
}

async function getReserves(dataProvider, pool, provider) {
  try {
    const tokens = await dataProvider.getAllReservesTokens();
    return tokens.map(t => ({ symbol: t.symbol, address: t.tokenAddress }));
  } catch {
    const reserveList = await pool.getReservesList();
    const concurrency = isLimitedBatchRpc(provider) ? 2 : 8;
    const reserves = await mapWithConcurrency(reserveList, concurrency, async (address) => {
      try {
        const token = new Contract(address, ERC20_ABI, provider);
        const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
        return { address, symbol, decimals: Number(decimals) };
      } catch {
        return { address, symbol: '?', decimals: null };
      }
    });
    return reserves;
  }
}

async function buildReserveMetadata(reserves, dataProvider, oracle, provider) {
  const concurrency = isLimitedBatchRpc(provider) ? 2 : 8;
  return await mapWithConcurrency(reserves, concurrency, async (reserve) => {
    try {
      const underlying = new Contract(reserve.address, ERC20_ABI, provider);
      const [underlyingDecimals, reserveData, rawPrice] = await Promise.all([
        reserve.decimals != null ? reserve.decimals : underlying.decimals(),
        dataProvider.getReserveData(reserve.address),
        oracle.getAssetPrice(reserve.address).catch(() => 0n),
      ]);

      return {
        address: reserve.address,
        symbol: reserve.symbol,
        decimals: Number(underlyingDecimals),
        aTokenAddress: reserveData[7],
        stableDebtTokenAddress: reserveData[8],
        variableDebtTokenAddress: reserveData[9],
        liquidityRate: reserveData[5],
        oraclePrice: rawPrice,
      };
    } catch {
      return {
        address: reserve.address,
        symbol: reserve.symbol,
        decimals: reserve.decimals ?? 18,
        aTokenAddress: null,
        stableDebtTokenAddress: null,
        variableDebtTokenAddress: null,
        liquidityRate: 0n,
        oraclePrice: 0n,
      };
    }
  });
}

async function getAaveForkContext(providerAddress, provider) {
  const key = `${providerAddress.toLowerCase()}`;
  if (contextCache.has(key)) return contextCache.get(key);

  const contracts = await resolveAaveForkContracts(providerAddress, provider);
  const reserves = await getReserves(contracts.dataProvider, contracts.pool, provider);
  const reserveMeta = await buildReserveMetadata(reserves, contracts.dataProvider, contracts.oracle, provider);

  const value = { contracts, reserveMeta };
  contextCache.set(key, value);
  return value;
}

function priceToUsd(rawPrice, decimals, amount) {
  if (!rawPrice || !amount) return 0;
  return (Number(amount) * Number(rawPrice)) / 1e8;
}

async function scanAaveForkWallet({ wallet, label, chain, chainId, providerAddress, protocolName, protocolId, provider }) {
  const positions = [];
  const { contracts, reserveMeta } = await getAaveForkContext(providerAddress, provider);
  const accountData = await contracts.pool.getUserAccountData(wallet);
  const healthFactor = accountData.healthFactor > 0n ? Number(accountData.healthFactor) / 1e18 : null;

  const concurrency = isLimitedBatchRpc(provider) ? 1 : 6;
  const reserveResults = await mapWithConcurrency(reserveMeta, concurrency, async (reserve) => {
    try {
      const [userData, aTokenBal, stableDebtBal, variableDebtBal] = await Promise.all([
        contracts.dataProvider.getUserReserveData(reserve.address, wallet),
        reserve.aTokenAddress ? new Contract(reserve.aTokenAddress, ERC20_ABI, provider).balanceOf(wallet).catch(() => 0n) : 0n,
        reserve.stableDebtTokenAddress ? new Contract(reserve.stableDebtTokenAddress, ERC20_ABI, provider).balanceOf(wallet).catch(() => 0n) : 0n,
        reserve.variableDebtTokenAddress ? new Contract(reserve.variableDebtTokenAddress, ERC20_ABI, provider).balanceOf(wallet).catch(() => 0n) : 0n,
      ]);
      return { reserve, userData, aTokenBal, stableDebtBal, variableDebtBal };
    } catch {
      return null;
    }
  });

  for (const row of reserveResults) {
    if (!row) continue;
    const { reserve, userData, aTokenBal, stableDebtBal, variableDebtBal } = row;

    const suppliedRaw = aTokenBal > 0n ? aTokenBal : userData.currentATokenBalance;
    const stableDebtRaw = stableDebtBal > 0n ? stableDebtBal : userData.currentStableDebt;
    const variableDebtRaw = variableDebtBal > 0n ? variableDebtBal : userData.currentVariableDebt;

    if (suppliedRaw > 0n) {
      const amount = Number(suppliedRaw) / (10 ** reserve.decimals);
      positions.push({
        wallet, label, chain, chainId,
        protocol_name: protocolName,
        protocol_id: protocolId,
        position_type: 'supply',
        strategy: 'Lend',
        symbol: reserve.symbol,
        token_address: reserve.address,
        amount,
        value_usd: priceToUsd(reserve.oraclePrice, reserve.decimals, amount),
        apy_base: Number(userData.liquidityRate || reserve.liquidityRate || 0n) / 1e25,
        is_collateral: userData.usageAsCollateralEnabled,
        health_factor: healthFactor,
      });
    }

    const totalDebtRaw = stableDebtRaw + variableDebtRaw;
    if (totalDebtRaw > 0n) {
      const amount = Number(totalDebtRaw) / (10 ** reserve.decimals);
      positions.push({
        wallet, label, chain, chainId,
        protocol_name: protocolName,
        protocol_id: protocolId,
        position_type: 'borrow',
        strategy: 'Borrow',
        symbol: reserve.symbol,
        token_address: reserve.address,
        amount,
        value_usd: priceToUsd(reserve.oraclePrice, reserve.decimals, amount),
        apy_base: Number(userData.stableBorrowRate || 0n) / 1e25,
        is_collateral: false,
        health_factor: healthFactor,
      });
    }
  }

  return { positions, accountData, reserveCount: reserveMeta.length };
}

module.exports = {
  getProvider,
  resolveAaveForkContracts,
  getReserves,
  buildReserveMetadata,
  getAaveForkContext,
  scanAaveForkWallet,
  ERC20_ABI,
};
