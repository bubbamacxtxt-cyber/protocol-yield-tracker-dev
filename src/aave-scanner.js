#!/usr/bin/env node
/**
 * Aave v3 Position Scanner
 * 
 * Uses Aave's GraphQL API for position discovery
 * - userSupplies: get all supplied assets
 * - userBorrows: get all borrowed assets
 * - userMarketState: get aggregate state (health factor, net worth, APY)
 * 
 * Also fetches Merkl reward APRs via Merit API
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const DB_PATH = require('path').join(__dirname, '..', 'yield-tracker.db');

const AAVE_GRAPHQL = 'https://api.v3.aave.com/graphql';
const MERIT_API = 'https://apps.aavechan.com/api/merit/aprs';

// Known market addresses per chain
const MARKETS = {
  1: [ // Ethereum
    '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', // AaveV3Ethereum
    '0x0AA97c284e98396202b6A04024F5E2c65026F3c0', // AaveV3EthereumEtherFi
    '0x4e033931ad43597d96D6bcc25c280717730B58B1', // AaveV3EthereumLido
    '0xAe05Cd22df81871bc7cC2a04BeCfb516bFe332C8', // AaveV3EthereumHorizon
  ],
  8453: [ // Base
    '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  ],
  42161: [ // Arbitrum
    '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  ],
  137: [ // Polygon
    '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  ],
};

// ============================================
// Fetch user supplies for a market
// ============================================
async function getUserSupplies(userAddress, chainId) {
  const markets = MARKETS[chainId] || MARKETS[1];
  const marketInputs = markets.map(addr => `{ address: "${addr}", chainId: ${chainId} }`).join(', ');
  
  const res = await fetch(AAVE_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `{ userSupplies(request: { user: "${userAddress}", markets: [${marketInputs}] }) { market { name address } currency { symbol address decimals } balance { amount { value } usd } apy { value } isCollateral } }`
    })
  });
  const data = await res.json();
  return data?.data?.userSupplies || [];
}

// ============================================
// Fetch user borrows for a market
// ============================================
async function getUserBorrows(userAddress, chainId) {
  const markets = MARKETS[chainId] || MARKETS[1];
  const marketInputs = markets.map(addr => `{ address: "${addr}", chainId: ${chainId} }`).join(', ');
  
  const res = await fetch(AAVE_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `{ userBorrows(request: { user: "${userAddress}", markets: [${marketInputs}] }) { market { name address } currency { symbol address decimals } debt { amount { value } usd } apy { value } } }`
    })
  });
  const data = await res.json();
  return data?.data?.userBorrows || [];
}

// ============================================
// Fetch user market state (health factor, etc.)
// ============================================
async function getUserMarketState(userAddress, marketAddress, chainId) {
  const res = await fetch(AAVE_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `{ userMarketState(request: { user: "${userAddress}", market: "${marketAddress}", chainId: ${chainId} }) { netWorth healthFactor totalCollateralBase totalDebtBase availableBorrowsBase userEarnedAPY { value } userDebtAPY { value } netAPY { value } } }`
    })
  });
  const data = await res.json();
  return data?.data?.userMarketState || null;
}

// ============================================
// Fetch Merkl reward APRs
// ============================================
async function getMeritAPRs(userAddress) {
  try {
    const res = await fetch(`${MERIT_API}?user=${userAddress}`);
    const data = await res.json();
    return data?.currentAPR?.actionsAPR || {};
  } catch {
    return {};
  }
}

// ============================================
// Scan wallet
// ============================================
async function scanWallet(wallet, label, db) {
  console.log(`\n--- ${label} (${wallet.slice(0,12)}) ---`);
  
  const enrichments = { supply: [], borrow: [] };
  const chainId = 1;
  
  // Get supplies, borrows, and state in parallel
  const [supplies, borrows, state] = await Promise.all([
    getUserSupplies(wallet, chainId),
    getUserBorrows(wallet, chainId),
    getUserMarketState(wallet, MARKETS[1][0], chainId),
  ]);
  
  // Get Merkl rewards
  const meritAPRs = await getMeritAPRs(wallet);
  
  console.log(`  Supply positions: ${supplies.length}`);
  console.log(`  Borrow positions: ${borrows.length}`);
  
  // Process supplies - prepare enrichment data
  for (const s of supplies) {
    const meritKey = `ethereum-supply-${s.currency?.symbol?.toLowerCase()}`;
    
    const enrich = {
      wallet, label,
      symbol: s.currency?.symbol || '?',
      value_usd: parseFloat(s.balance?.usd || 0),
      apy_base: parseFloat(s.apy?.value || 0) * 100,
      apy_bonus: meritAPRs[meritKey] || null,
    };
    
    if (enrich.value_usd > 0.01) {
      console.log(`    ✅ ${enrich.symbol}: $${enrich.value_usd.toFixed(2)} | APY: ${enrich.apy_base.toFixed(2)}%${enrich.apy_bonus ? ' + ' + enrich.apy_bonus.toFixed(2) + '%' : ''}`);
      enrichments.supply.push(enrich);
    }
  }
  
  // Process borrows - prepare enrichment data  
  for (const b of borrows) {
    const enrich = {
      wallet, label,
      symbol: b.currency?.symbol || '?',
      value_usd: parseFloat(b.debt?.usd || 0),
      apy_borrow: parseFloat(b.apy?.value || 0) * 100,
    };
    
    if (enrich.value_usd > 0.01) {
      console.log(`    📊 ${enrich.symbol}: $${enrich.value_usd.toFixed(2)} borrow | APY: ${enrich.apy_borrow.toFixed(2)}%`);
      enrichments.borrow.push(enrich);
    }
  }
  
  // Show aggregate state
  if (state && parseFloat(state.netWorth || 0) !== 0) {
    console.log(`  Health Factor: ${state.healthFactor ? parseFloat(state.healthFactor).toFixed(3) : 'N/A'}`);
    console.log(`  Net Worth: $${parseFloat(state.netWorth || 0).toFixed(2)}`);
    console.log(`  Net APY: ${parseFloat(state.netAPY?.value || 0) * 100}%`);
  }
  
  return enrichments;
}

// ============================================
// Enrich existing DeBank positions with APY data
// ============================================
function enrichPositions(db, enrichments) {
  // Find existing positions by symbol and protocol
  const findSupplyPos = db.prepare(`
    SELECT p.id, pt.id as token_id, pt.value_usd as old_usd 
    FROM positions p 
    JOIN position_tokens pt ON pt.position_id = p.id 
    WHERE p.wallet = ? AND p.protocol_name = 'Aave v3' AND p.position_type = 'Lending' AND pt.symbol = ? AND pt.role = 'supply'
  `);
  const findBorrowPos = db.prepare(`
    SELECT p.id, pt.id as token_id 
    FROM positions p 
    JOIN position_tokens pt ON pt.position_id = p.id 
    WHERE p.wallet = ? AND p.protocol_name = 'Aave v3' AND p.position_type = 'Lending' AND pt.symbol = ? AND pt.role = 'borrow'
  `);
  const updateToken = db.prepare(`UPDATE position_tokens SET apy_base = ?, bonus_supply_apy = ? WHERE id = ?`);
  const updateNetUsd = db.prepare(`UPDATE positions SET net_usd = ?, scanned_at = datetime('now') WHERE id = ?`);
  
  const transaction = db.transaction(() => {
    // Enrich supply positions
    for (const e of enrichments.supply) {
      const posRow = findSupplyPos.get(e.wallet, e.symbol);
      if (posRow) {
        updateToken.run(e.apy_base || null, e.apy_bonus || null, posRow.token_id);
        updateNetUsd.run(e.value_usd || 0, posRow.id);
      }
    }
    
    // Enrich borrow positions
    for (const e of enrichments.borrow) {
      const posRow = findBorrowPos.get(e.wallet, e.symbol);
      if (posRow) {
        updateToken.run(e.apy_borrow || null, null, posRow.token_id);
      }
    }
  });
  
  transaction();
}

// ============================================
// CLI
// ============================================
async function main() {
  const wallets = [
    { addr: '0x31eae643b679a84b37e3d0b4bd4f5da90fb04a61', label: 'Reservoir-1' },
    { addr: '0x99a95a9e38e927486fc878f41ff8b118eb632b10', label: 'Reservoir-3' },
    { addr: '0x289c204b35859bfb924b9c0759a4fe80f610671c', label: 'Reservoir-2' },
    { addr: '0x3063c5907faa10c01b242181aa689beb23d2bd65', label: 'Euler-Wallet' },
    { addr: '0x41a9eb398518d2487301c61d2b33e4e966a9f1dd', label: 'Reservoir-4' },
    { addr: '0x502d222e8e4daef69032f55f0c1a999effd78fb3', label: 'Reservoir-5' },
    { addr: '0x815f5bb257e88b67216a344c7c83a3ea4ee74748', label: 'Test-Wallet' },
  ];
  
  const db = new Database(DB_PATH);
  const allEnrichments = { supply: [], borrow: [] };
  
  console.log('=== Aave v3 Scanner ===\n');
  
  for (const w of wallets) {
    const enrichments = await scanWallet(w.addr, w.label, db);
    allEnrichments.supply.push(...enrichments.supply);
    allEnrichments.borrow.push(...enrichments.borrow);
  }
  
  enrichPositions(db, allEnrichments);
  
  console.log(`\n=== Summary ===`);
  console.log(`Enriched ${allEnrichments.supply.length} supply + ${allEnrichments.borrow.length} borrow positions`);
  
  db.close();
}

module.exports = { getUserSupplies, getUserBorrows, getUserMarketState, scanWallet };

if (require.main === module) {
  main().catch(console.error);
}
