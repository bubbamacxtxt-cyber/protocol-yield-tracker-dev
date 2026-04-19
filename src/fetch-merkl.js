#!/usr/bin/env node
/**
 * fetch-merkl.js
 * Fetches Merkl incentive campaigns and applies bonus APYs to positions.
 */

const Database = require('better-sqlite3');
const path = require('path');
const https = require('https');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const MERKL_BASE = 'https://api.merkl.xyz/v4';

const CHAINS = {
  eth: 1, arb: 42161, base: 8453, plasma: 9745,
  mnt: 5000, sonic: 146, bsc: 56, monad: 143, hyper: 999, ink: 57073,
};

const PROTOCOL_MAP = {
  'Aave V3': ['aave', 'aave-v3'],
  'Morpho': ['morpho', 'morpho-blue', 'morpho-vault'],
  'Euler': ['euler', 'euler-v2'],
  'Venus': ['venus'],
  'Spark': ['spark'],
  'Silo': ['silo-finance', 'silo-finance-v2'],
  'Fluid': ['fluid'],
  'Curve': ['curve', 'curve-dex'],
  'Convex': ['convex'],
  'Pendle': ['pendle', 'pendle-v2'],
  'Compound V3': ['compound-v3', 'compound'],
};

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept': 'application/json' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error for ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

async function fetchMerklOpportunities() {
  const all = [];
  for (const [chainName, chainId] of Object.entries(CHAINS)) {
    let page = 0;
    while (true) {
      try {
        const url = `${MERKL_BASE}/opportunities?chainId=${chainId}&items=100&page=${page}`;
        const data = await httpGet(url);
        const items = Array.isArray(data) ? data : (data.data || []);
        if (items.length === 0) break;
        for (const item of items) {
          if (item.status === 'LIVE') {
            all.push({ ...item, _chainName: chainName });
          }
        }
        if (items.length < 100) break;
        page++;
      } catch (e) {
        console.log(`  ⚠ ${chainName} page ${page}: ${e.message}`);
        break;
      }
    }
    const count = all.filter(i => i._chainName === chainName).length;
    console.log(`  ${chainName}: ${count} live`);
  }
  return all;
}

function parseCampaignRules(campaign) {
  const rules = {
    bonusSide: campaign.action === 'BORROW' ? 'borrow' : 'supply',
    eligibleTokens: (campaign.tokens || []).map(t => ({
      address: t.address?.toLowerCase(),
      symbol: t.symbol,
    })),
    requiredBorrows: [],
    maxHealthFactor: null,
    minOfTokens: null,
    isNetLending: false,
    isVaultCampaign: false,
    morphoMarketId: null, // For MORPHOBORROW/MORPHOSUPPLY: the specific market ID
  };

  // For Morpho campaigns, the identifier is the market ID
  // Only positions in THIS specific market should get the bonus
  if (campaign.type === 'MORPHOBORROW' || campaign.type === 'MORPHOSUPPLY' || campaign.type === 'MORPHOVAULT' || campaign.type === 'MORPHOSUPPLY_SINGLETOKEN') {
    rules.morphoMarketId = campaign.identifier?.toLowerCase();
  }

  // Multi-token campaigns are vault-specific (underlying + vault share)
  // Exception: Aave campaigns with aTokens are normal lending positions
  const directTypes = ['MORPHOSUPPLY_SINGLETOKEN', 'MORPHOBORROW', 'AAVE_NET_LENDING', 'DOLOMITE_NET_LENDING', 'AAVE_SUPPLY'];
  const isDirectType = directTypes.includes(campaign.type);
  const hasMultiTokens = rules.eligibleTokens.length > 1;
  const isAave = campaign.protocol?.id?.startsWith('aave');
  rules.isVaultCampaign = hasMultiTokens && !isDirectType && !isAave;

  // Parse conditions from description
  const text = `${campaign.name || ''} ${campaign.description || ''}`.toLowerCase();

  // Match "borrow TOKEN1, TOKEN2, or TOKEN3 and ..." 
  const borrowMatch = text.match(/borrow\s+(.*?)(?:\s+and\s+)/i);
  if (borrowMatch) {
    rules.requiredBorrows = borrowMatch[1].split(/[,\s]+or\s+|\s*,\s*/).map(s => s.trim().toUpperCase()).filter(s => s.length > 1 && s.length <= 10);
  }

  const hfMatch = text.match(/health factor (?:below|under|less than) (\d+\.?\d*)/i);
  if (hfMatch) {
    rules.maxHealthFactor = parseFloat(hfMatch[1]);
  }

  // Match patterns like "lowest amount of tokens lent across sUSDe and USDe"
  const minMatch = text.match(/lowest.*?(\w+)\s+and\s+(\w+)/i);
  if (minMatch && minMatch[1].length <= 10 && minMatch[2].length <= 10) {
    rules.minOfTokens = [minMatch[1].toUpperCase(), minMatch[2].toUpperCase()];
  }

  if (['AAVE_NET_LENDING', 'DOLOMITE_NET_LENDING'].includes(campaign.type)) {
    rules.isNetLending = true;
  }

  return rules;
}

function matchesPosition(campaign, rules, position, allPositions) {
  // Chain check
  if (position.chain !== campaign._chainName) return false;

  // Protocol check
  const merklProtocols = PROTOCOL_MAP[position.protocol_name] || 
    [position.protocol_name.toLowerCase().replace(/\s+/g, '-')];
  if (!merklProtocols.includes(campaign.protocol?.id)) return false;

  // Role check: match campaign action to position role
  const posRole = position.role; // 'supply', 'borrow', or 'reward'
  const campaignAction = campaign.action; // 'LEND', 'BORROW', 'HOLD', 'POOL', etc.
  
  // LEND/HOLD/POOL/DROP campaigns only match supply positions
  if (['LEND', 'HOLD', 'POOL', 'DROP'].includes(campaignAction) && posRole !== 'supply') return false;
  // BORROW campaigns only match borrow positions  
  if (campaignAction === 'BORROW' && posRole !== 'borrow') return false;

  // Vault campaigns don't match our underlying-token positions
  if (rules.isVaultCampaign) return false;

  // For Morpho: match by market ID if specified
  // position_index contains the market ID for Morpho positions
  if (rules.morphoMarketId && position.protocol_name === 'Morpho') {
    const posMarketId = position.position_index?.toLowerCase();
    if (posMarketId !== rules.morphoMarketId) return false;
  }

  // For Aave: match by market name from campaign title
  // e.g., 'Borrow USDC from Aave Horizon market' → position must be in Horizon
  if (campaign.protocol?.id === 'aave') {
    const campaignName = campaign.name || '';
    const marketName = position.market_name || '';
    
    // If campaign specifies a market, check position is in it
    if (campaignName.includes('Horizon') && !marketName.includes('Horizon')) return false;
    if (campaignName.includes('Core') && !marketName.includes('Ethereum') && marketName.includes('Horizon')) return false;
    if (campaignName.includes('EtherFi') && !marketName.includes('EtherFi')) return false;
    if (campaignName.includes('Lido') && !marketName.includes('Lido')) return false;
  }

  // For Euler: match by vault address (identifier)
  if (campaign.protocol?.id === 'euler' && rules.morphoMarketId) {
    if (!position.market_id || position.market_id.toLowerCase() !== rules.morphoMarketId) return false;
  }

  // For Fluid: match by vault address (identifier)
  if (campaign.protocol?.id === 'fluid' && rules.morphoMarketId) {
    if (!position.market_id || position.market_id.toLowerCase() !== rules.morphoMarketId) return false;
  }

  // Token symbol match
  const posSymbol = position.symbol?.toUpperCase();
  
  // For 'min of X and Y' campaigns: bonus applies to eligible tokens (USDe, sUSDe)
  if (rules.minOfTokens && rules.minOfTokens.length === 2) {
    // minOfTokens determines which token gets bonus when BOTH are present
    // If only one is present, it gets the bonus
    const walletSupplies = allPositions
      .filter(p => p.role === 'supply' && p.wallet === position.wallet)
      .map(p => p.symbol?.toUpperCase());
    const hasBoth = rules.minOfTokens.every(t => walletSupplies.includes(t));
    if (hasBoth) {
      // Only USDe gets bonus when both present (it's the 'min of' target)
      if (posSymbol === 'SUSDE') return false;
      if (posSymbol !== 'USDE') return false;
    } else {
      // Only one present - must be one of the minOfTokens
      if (!rules.minOfTokens.includes(posSymbol)) return false;
    }
  } else {
    if (!rules.eligibleTokens.some(t => t.symbol?.toUpperCase() === posSymbol)) return false;
  }

  // Conditions
  if (rules.requiredBorrows.length > 0) {
    const walletBorrows = allPositions
      .filter(p => p.role === 'borrow' && p.wallet === position.wallet)
      .map(p => p.symbol?.toUpperCase());
    if (!rules.requiredBorrows.some(rb => walletBorrows.includes(rb))) return false;
  }

  if (rules.maxHealthFactor != null && (!position.health_rate || position.health_rate >= rules.maxHealthFactor)) {
    return false;
  }

  if (rules.minOfTokens) {
    // minOfTokens: if wallet has BOTH tokens, only reward the one with lower amount
    // If wallet has only ONE of them, reward it
    const walletSupplies = allPositions
      .filter(p => p.role === 'supply' && p.wallet === position.wallet)
      .map(p => p.symbol?.toUpperCase());
    const hasAnyMinToken = rules.minOfTokens.some(t => walletSupplies.includes(t));
    const hasAllMinTokens = rules.minOfTokens.every(t => walletSupplies.includes(t));
    // If wallet has only one of the required tokens, reward it only if it's the eligible one
    if (!hasAnyMinToken) return false;
    // If wallet doesn't have ALL minOfTokens, only allow if the current position is one of them
    if (!hasAllMinTokens && !rules.minOfTokens.includes(posSymbol)) return false;
  }

  return true;
}

async function main() {
  console.log('=== Merkl Bonus APY ===\n');

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Reset
  db.prepare('UPDATE position_tokens SET bonus_supply_apy = NULL, bonus_supply_source = NULL, bonus_borrow_apy = NULL, bonus_borrow_source = NULL').run();

  // Fetch
  console.log('Fetching Merkl opportunities...');
  const opportunities = await fetchMerklOpportunities();
  console.log(`Total: ${opportunities.length} live campaigns\n`);

  // Filter to our protocols
  const relevant = opportunities.filter(o => {
    const pid = o.protocol?.id?.toLowerCase();
    return Object.values(PROTOCOL_MAP).flat().includes(pid);
  });
  console.log(`${relevant.length} campaigns for our protocols\n`);

  // Parse rules
  const parsed = relevant.map(c => ({ campaign: c, rules: parseCampaignRules(c) }));

  // Log by protocol
  const byProto = {};
  for (const p of parsed) {
    const pid = p.campaign.protocol?.id || '?';
    if (!byProto[pid]) byProto[pid] = [];
    byProto[pid].push(p);
  }
  for (const [pid, items] of Object.entries(byProto)) {
    const vaultCount = items.filter(i => i.rules.isVaultCampaign).length;
    const directCount = items.length - vaultCount;
    console.log(`${pid}: ${items.length} (${directCount} direct, ${vaultCount} vault)`);
    for (const { campaign, rules } of items.filter(i => !i.rules.isVaultCampaign).slice(0, 3)) {
      const notes = [];
      if (rules.requiredBorrows.length) notes.push(`need:${rules.requiredBorrows}`);
      if (rules.maxHealthFactor) notes.push(`HF<${rules.maxHealthFactor}`);
      if (rules.isNetLending) notes.push('net');
      console.log(`  ${(campaign.action || '').padEnd(6)} ${(campaign.apr || 0).toFixed(2).padStart(6)}% ${campaign._chainName.padEnd(6)} ${campaign.name?.slice(0, 45)}`);
      if (notes.length) console.log(`         ${notes.join(', ')}`);
    }
  }

  // Load positions (with market enrichment)
  const positions = db.prepare(`
    SELECT pt.*, p.wallet, p.chain, p.protocol_name, p.health_rate, p.position_index,
      pm.market_id, pm.market_name
    FROM position_tokens pt
    JOIN positions p ON pt.position_id = p.id
    LEFT JOIN position_markets pm ON pm.position_id = p.id
  `).all();
  console.log(`\n${positions.length} positions\n`);

  // Match
  const updateSupply = db.prepare('UPDATE position_tokens SET bonus_supply_apy = ?, bonus_supply_source = ? WHERE id = ?');
  const updateBorrow = db.prepare('UPDATE position_tokens SET bonus_borrow_apy = ?, bonus_borrow_source = ? WHERE id = ?');

  let supplyCount = 0, borrowCount = 0, noBonus = 0;

  db.transaction(() => {
    for (const pos of positions) {
      let bonusSupply = 0, bonusBorrow = 0;
      const srcSupply = [], srcBorrow = [];

      for (const { campaign, rules } of parsed) {
        if (!matchesPosition(campaign, rules, pos, positions)) continue;
        const bonus = campaign.apr || 0;
        if (bonus <= 0) continue;

        const slug = campaign.protocol?.id || 'merkl';
        const name = campaign.name?.slice(0, 40) || '';
        const src = `${slug}:${campaign._chainName}(${bonus.toFixed(2)}%)`;
        
        if (rules.bonusSide === 'supply') {
          bonusSupply += bonus;
          srcSupply.push(src);
        } else {
          bonusBorrow += bonus;
          srcBorrow.push(src);
        }
      }

      if (bonusSupply > 0) {
        updateSupply.run(bonusSupply, srcSupply.join('; '), pos.id);
        supplyCount++;
      }
      if (bonusBorrow > 0) {
        updateBorrow.run(bonusBorrow, srcBorrow.join('; '), pos.id);
        borrowCount++;
      }
      if (bonusSupply === 0 && bonusBorrow === 0) noBonus++;
    }
  })();

  console.log('=== Results ===');
  console.log(`Supply bonuses: ${supplyCount}`);
  console.log(`Borrow bonuses: ${borrowCount}`);
  console.log(`No bonus: ${noBonus}`);

  // Show top
  const top = db.prepare(`
    SELECT pt.symbol, pt.bonus_supply_apy, pt.bonus_borrow_apy, p.chain, p.protocol_name
    FROM position_tokens pt JOIN positions p ON pt.position_id = p.id
    WHERE pt.bonus_supply_apy > 0 OR pt.bonus_borrow_apy > 0
    ORDER BY (COALESCE(pt.bonus_supply_apy, 0) + COALESCE(pt.bonus_borrow_apy, 0)) DESC
    LIMIT 10
  `).all();

  if (top.length) {
    console.log('\nTop bonuses:');
    for (const r of top) {
      const sup = r.bonus_supply_apy ? `+${r.bonus_supply_apy.toFixed(2)}% supply` : '';
      const bor = r.bonus_borrow_apy ? `+${r.bonus_borrow_apy.toFixed(2)}% borrow` : '';
      console.log(`  ${r.symbol.padEnd(8)} ${r.chain.padEnd(6)} ${r.protocol_name.padEnd(14)} ${sup} ${bor}`);
    }
  }

  db.close();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
