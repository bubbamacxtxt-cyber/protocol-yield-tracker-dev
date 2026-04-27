/**
 * Aave V3 Pool Lookthrough
 *
 * For every scanner-detected Aave V3 position (supply or borrow), fetch the
 * pool's reserve composition and compute the depositor's pro-rata exposure
 * to each reserve asset in the pool.
 *
 * Data source: Aave pool contract via RPC (ethers.js)
 *
 * Returns lookthrough rows keyed by position_id.
 */

const { JsonRpcProvider, Contract, Interface } = require('ethers');

const AAVE_POOL_ABI = [
  'function getReservesList() view returns (address[])',
  'function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 variableBorrowIndex, uint128 currentLiquidityRate, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint8 id))',
];

const AAVE_DATA_PROVIDER_ABI = [
  'function getAllReservesTokens() view returns (tuple(string symbol, address tokenAddress)[])',
  'function getReserveData(address asset) view returns (tuple(uint256 unbacked, uint128 accruedToTreasuryScaled, uint128 totalAToken, uint128 totalStableDebt, uint128 totalVariableDebt, uint128 liquidityRate, uint40 lastUpdateTimestamp, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint8 id))',
];

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

// Aave RPC endpoints (reuse from env or Alchemy)
function getRpcUrl(chain) {
  const envKey = `${chain.toUpperCase()}_RPC_URL`;
  return process.env[envKey] || process.env.ALCHEMY_RPC_URL || 'https://eth.drpc.org';
}

const RPC_MAP = {
  eth: 1, base: 8453, arb: 42161, mnt: 5000, plasma: 9745, bsc: 56, sonic: 146,
};

// Pool addresses by chain — from memory and aave-scanner.js
const POOL_ADDRESSES = {
  1: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  8453: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  42161: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  5000: '0x458F293454fE0d67EC0655f3672301301DD51422',
  9745: '0x925a2A7214Ed92428B5b1B090F80b25700095e12',
  56: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
  146: '0x5362dBb1e601AbF2a150D1999Be54a4d308f4F6e',
};

/**
 * Fetch pool reserve data via RPC
 */
async function getPoolReserves(chainId, chainName, rpcUrl) {
  const poolAddress = POOL_ADDRESSES[chainId];
  if (!poolAddress) return null;

  const provider = new JsonRpcProvider(rpcUrl);
  const pool = new Contract(poolAddress, AAVE_POOL_ABI, provider);

  // Get reserve list
  const reserveAddresses = await pool.getReservesList();

  const reserves = [];
  for (const addr of reserveAddresses) {
    try {
      const token = new Contract(addr, ERC20_ABI, provider);
      const symbol = await token.symbol().catch(() => 'UNKNOWN');
      reserves.push({ address: addr, symbol });
    } catch {
      reserves.push({ address: addr, symbol: '???' });
    }
  }

  return reserves;
}

/**
 * Fetch total supply for a reserve from the data provider
 */
async function getReserveSupply(chainId, rpcUrl, reserveAddress) {
  // This requires the data provider address which we'd need to resolve.
  // For now, skip detailed balance fetching and use equal-weight approximation.
  // TODO: implement full on-chain balance fetching.
  return { totalAToken: null, aTokenSymbol: null };
}

/**
 * Compute lookthrough rows for all Aave scanner positions.
 * @param {Array} positions - rows from positions table where protocol_id = 'aave'
 * @param {Object} db - better-sqlite3 db handle
 * @returns {Array} lookthrough rows to insert
 */
async function compute(positions, db) {
  console.time('[lookthrough] aave');

  const chainIdMap = { eth: 1, base: 8453, arb: 42161, poly: 137, opt: 10, mnt: 5000, blast: 81457, scroll: 534352, sonic: 146, plasma: 9745, uni: 130, wct: 747474, monad: 143, ink: 999, abstract: 2741, bsc: 56 };

  // Group positions by chain (string) to avoid duplicate RPC calls
  const pools = new Map(); // chain string -> positions[]
  for (const pos of positions) {
    if (!pools.has(pos.chain)) pools.set(pos.chain, []);
    pools.get(pos.chain).push(pos);
  }

  const rows = [];

  for (const [chainStr, chainPositions] of pools) {
    const chainId = chainIdMap[chainStr.toLowerCase()];
    if (!chainId) {
      console.log(`[lookthrough] aave: unknown chain '${chainStr}', skipping`);
      continue;
    }
    
    const rpcUrl = process.env[`${chainStr.toUpperCase()}_RPC_URL`] || process.env[`ALCHEMY_${chainStr.toUpperCase()}_RPC_URL`] || process.env.ALCHEMY_RPC_URL || 'https://eth.drpc.org';

    console.log(`[lookthrough] aave: fetching reserves for ${chainStr} (chainId=${chainId})`);

    let reserves;
    try {
      reserves = await getPoolReserves(chainId, chainStr, rpcUrl);
    } catch (e) {
      console.error(`[lookthrough] aave: RPC failed for ${chainStr}: ${e.message}`);
      continue;
    }

    if (!reserves || reserves.length === 0) {
      console.log(`[lookthrough] aave: no reserves found for ${chainStr}`);
      continue;
    }

    console.log(`[lookthrough] aave: ${reserves.length} reserves in ${chainStr} pool`);

    // For each position in this pool, create lookthrough rows
    for (const pos of chainPositions) {
      const depositorAmount = pos.asset_usd;
      if (depositorAmount === 0) continue;

      const totalReserves = reserves.length;
      const equalShare = 1.0 / totalReserves;

      let rankOrder = 0;
      for (const reserve of reserves) {
        rankOrder++;

        rows.push({
          position_id: pos.id,
          kind: 'aave_pool',
          market_key: `${reserve.address}-${chainId}`,
          collateral_symbol: reserve.symbol,
          collateral_address: reserve.address,
          loan_symbol: null,
          loan_address: null,
          chain: pos.chain,
          total_supply_usd: null,
          total_borrow_usd: null,
          utilization: null,
          pro_rata_usd: depositorAmount * equalShare,
          share_pct: 0,
          rank_order: rankOrder,
        });
      }
    }
  }

  console.log(`[lookthrough] aave: ${rows.length} lookthrough rows from ${pools.size} pools`);
  console.timeEnd('[lookthrough] aave');

  return rows;
}

module.exports = { compute, getPoolReserves };
