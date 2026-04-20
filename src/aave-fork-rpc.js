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

function getProvider(rpcUrl) {
  return new JsonRpcProvider(rpcUrl || process.env.ALCHEMY_RPC_URL || process.env.ETH_RPC_URL || 'https://eth.drpc.org');
}

async function resolveAaveForkContracts(providerAddress, provider) {
  const addressesProvider = new Contract(providerAddress, ADDRESSES_PROVIDER_ABI, provider);
  const poolAddress = await addressesProvider.getPool();
  const dataProviderAddress = await addressesProvider.getPoolDataProvider();
  const oracleAddress = await addressesProvider.getPriceOracle();

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
    const reserves = [];
    for (const address of reserveList) {
      try {
        const token = new Contract(address, ERC20_ABI, provider);
        const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
        reserves.push({ address, symbol, decimals: Number(decimals) });
      } catch {
        reserves.push({ address, symbol: '?', decimals: null });
      }
    }
    return reserves;
  }
}

async function buildReserveMetadata(reserves, dataProvider, oracle, provider) {
  const meta = [];
  for (const reserve of reserves) {
    try {
      const underlying = new Contract(reserve.address, ERC20_ABI, provider);
      const [underlyingDecimals, reserveData, rawPrice] = await Promise.all([
        reserve.decimals != null ? reserve.decimals : underlying.decimals(),
        dataProvider.getReserveData(reserve.address),
        oracle.getAssetPrice(reserve.address).catch(() => 0n),
      ]);

      meta.push({
        address: reserve.address,
        symbol: reserve.symbol,
        decimals: Number(underlyingDecimals),
        aTokenAddress: reserveData[7],
        stableDebtTokenAddress: reserveData[8],
        variableDebtTokenAddress: reserveData[9],
        liquidityRate: reserveData[5],
        oraclePrice: rawPrice,
      });
    } catch {
      meta.push({
        address: reserve.address,
        symbol: reserve.symbol,
        decimals: reserve.decimals ?? 18,
        aTokenAddress: null,
        stableDebtTokenAddress: null,
        variableDebtTokenAddress: null,
        liquidityRate: 0n,
        oraclePrice: 0n,
      });
    }
  }
  return meta;
}

function priceToUsd(rawPrice, decimals, amount) {
  // Aave-style oracle usually returns base-currency price with 8 decimals when base is USD-ish.
  // For Spark mainnet this is good enough for current scanner usage.
  if (!rawPrice || !amount) return 0;
  return (Number(amount) * Number(rawPrice)) / 1e8;
}

async function scanAaveForkWallet({ wallet, label, chain, chainId, providerAddress, protocolName, protocolId, provider }) {
  const positions = [];
  const contracts = await resolveAaveForkContracts(providerAddress, provider);
  const accountData = await contracts.pool.getUserAccountData(wallet);
  const healthFactor = accountData.healthFactor > 0n ? Number(accountData.healthFactor) / 1e18 : null;

  const reserves = await getReserves(contracts.dataProvider, contracts.pool, provider);
  const reserveMeta = await buildReserveMetadata(reserves, contracts.dataProvider, contracts.oracle, provider);

  for (const reserve of reserveMeta) {
    try {
      const [userData, aTokenBal, stableDebtBal, variableDebtBal] = await Promise.all([
        contracts.dataProvider.getUserReserveData(reserve.address, wallet),
        reserve.aTokenAddress ? new Contract(reserve.aTokenAddress, ERC20_ABI, provider).balanceOf(wallet).catch(() => 0n) : 0n,
        reserve.stableDebtTokenAddress ? new Contract(reserve.stableDebtTokenAddress, ERC20_ABI, provider).balanceOf(wallet).catch(() => 0n) : 0n,
        reserve.variableDebtTokenAddress ? new Contract(reserve.variableDebtTokenAddress, ERC20_ABI, provider).balanceOf(wallet).catch(() => 0n) : 0n,
      ]);

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
    } catch {
      // skip reserve
    }
  }

  return { positions, accountData, reserveCount: reserveMeta.length };
}

module.exports = {
  getProvider,
  resolveAaveForkContracts,
  getReserves,
  buildReserveMetadata,
  scanAaveForkWallet,
  ERC20_ABI,
};
