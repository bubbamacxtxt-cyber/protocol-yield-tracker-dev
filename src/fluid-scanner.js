#!/usr/bin/env node
/**
 * Fluid Scanner
 *
 * Scans tracked wallets for positions in:
 *   - Fluid Lending (ERC-4626 fTokens: fUSDC, fUSDT, fGHO, fwstETH, fWETH,
 *     fEURC, fARB, fUSDtb, fUSDe, fUSDT0)
 *   - Fluid Vaults (leveraged supply+borrow positions, NFT-gated)
 *
 * Data sources:
 *   - Fluid REST API:
 *     /v2/lending/{chainId}/tokens   → fToken registry
 *     /v2/borrowing/{chainId}/vaults → vault registry (addr, tokens, rates)
 *   - Fluid on-chain:
 *     VaultFactory (ERC-721)   0x324c5Dc1fC42c7a4D43d92df1eBA58a54d13Bf2d
 *     VaultPositionsResolver   0xaA21a86030EAa16546A759d2d10fd3bF9D053Bc7
 *     (same addresses on mainnet, arb, base, polygon, plasma, bnb)
 *
 * Flow:
 *   Lending:
 *     For each wallet × chain × fToken → balanceOf → convertToAssets → USD
 *   Vaults:
 *     For each wallet:
 *       1. factory.balanceOf(wallet) to count NFTs
 *       2. factory.tokenOfOwnerByIndex to enumerate NFT IDs
 *       3. resolver.getPositionsForNftIds([nftIds]) \u2192 {nftId, owner, supply, borrow}
 *          (resolver also returns vault addr via _vaultAndOwnerByNftId internally,
 *           so positions returned are in vault's own units after exchange prices)
 *       4. resolver.getPositionDataRaw(vault, nftId) then parse? OR simpler:
 *          call VaultResolver.positionByNftId(nftId) for the richer output
 *
 * Per docs/TOKEN-RULES.md: Fluid is a protocol scanner. Its output is the
 * authoritative source for Fluid. Lending wrappers (fUSDC etc) do not
 * belong to YBS or vault lists.
 *
 * Rate format (docs):
 *   All rates returned in 1e2 precision (1% = 100, 100% = 10000).
 *   Scanner divides by 100 to get percentage APY.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { ethers } = require('ethers');
const { fetchJSON } = require('./fetch-helper');
const { loadActiveWalletChains, loadWhaleWalletMap } = require('./recon-helpers');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;

// Fluid contracts (same addresses on all chains)
const FLUID_VAULT_FACTORY = '0x324c5Dc1fC42c7a4D43d92df1eBA58a54d13Bf2d';
const FLUID_POSITIONS_RESOLVER = '0xaA21a86030EAa16546A759d2d10fd3bF9D053Bc7';
const FLUID_VAULT_RESOLVER = '0xA5C3E16523eeeDDcC34706b0E6bE88b4c6EA95cC';

const FLUID_CHAINS = {
  eth:    { chainId: 1,     alchemy: 'https://eth-mainnet.g.alchemy.com/v2/' },
  base:   { chainId: 8453,  alchemy: 'https://base-mainnet.g.alchemy.com/v2/' },
  arb:    { chainId: 42161, alchemy: 'https://arb-mainnet.g.alchemy.com/v2/' },
  plasma: { chainId: 9745,  alchemy: process.env.ALCHEMY_PLASMA_RPC_URL || '' },
};

const DL_CHAIN = { eth: 'ethereum', base: 'base', arb: 'arbitrum', plasma: 'plasma' };

// Function selectors (precomputed to avoid repeated keccak calls)
const SEL_BALANCE_OF = '0x70a08231';                  // balanceOf(address)
const SEL_TOKEN_OF_OWNER_BY_INDEX = '0x2f745c59';     // tokenOfOwnerByIndex(address, uint256)
const SEL_CONVERT_TO_ASSETS = '0x07a2d13a';           // convertToAssets(uint256)
const SEL_GET_POSITIONS_FOR_NFT_IDS = '0x5bbf0e14';   // getPositionsForNftIds(uint256[])

// ───────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────

let _lastRpcAt = 0;
async function _rpcThrottle() {
  const wait = 150 - (Date.now() - _lastRpcAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastRpcAt = Date.now();
}

async function rpc(chain, method, params) {
  const cfg = FLUID_CHAINS[chain];
  if (!cfg?.alchemy) return null;
  await _rpcThrottle();
  const url = cfg.alchemy.includes(ALCHEMY_KEY || '') ? cfg.alchemy : `${cfg.alchemy}${ALCHEMY_KEY}`;
  const res = await fetchJSON(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }, 3);
  return res?.result;
}

async function ethCall(chain, to, data) {
  const result = await rpc(chain, 'eth_call', [{ to, data }, 'latest']);
  return (result && result !== '0x') ? result : null;
}

async function balanceOf(chain, token, wallet) {
  const padded = wallet.replace(/^0x/, '').padStart(64, '0').toLowerCase();
  const r = await ethCall(chain, token, SEL_BALANCE_OF + padded);
  if (!r) return 0n;
  try { return BigInt(r); } catch { return 0n; }
}

async function getDefiLlamaPrice(chain, address) {
  try {
    const dlChain = DL_CHAIN[chain] || chain;
    const url = `https://coins.llama.fi/prices/current/${dlChain}:${address.toLowerCase()}`;
    const data = await fetchJSON(url, {}, 2);
    const key = `${dlChain}:${address.toLowerCase()}`;
    return data?.coins?.[key]?.price || null;
  } catch { return null; }
}

// ───────────────────────────────────────────────────────
// Fluid REST API
// ───────────────────────────────────────────────────────

async function loadFluidLendingTokens(chain) {
  const cfg = FLUID_CHAINS[chain];
  if (!cfg?.chainId) return [];
  try {
    const data = await fetchJSON(`https://api.fluid.instadapp.io/v2/lending/${cfg.chainId}/tokens`, {}, 2);
    const items = Array.isArray(data) ? data : (data?.data || []);
    return items.map(t => ({
      address: String(t.address || '').toLowerCase(),
      symbol: t.symbol || 'fToken',
      decimals: t.decimals || 18,
      asset: String(t.assetAddress || t.asset?.address || '').toLowerCase(),
      assetSymbol: t.asset?.symbol || '?',
      assetDecimals: t.asset?.decimals || 18,
      assetPrice: t.asset?.price ? Number(t.asset.price) : null,
      // Rates returned in 1e2 precision (1% = 100). Divide by 100 for percent.
      supplyApy: t.supplyRate != null ? Number(t.supplyRate) / 100 : null,
      rewardsApy: t.rewardsRate != null && Number(t.rewardsRate) > 0 ? Number(t.rewardsRate) / 100 : null,
    }));
  } catch (e) {
    console.log(`  ${chain} Fluid lending tokens failed:`, e.message);
    return [];
  }
}

async function loadFluidVaults(chain) {
  const cfg = FLUID_CHAINS[chain];
  if (!cfg?.chainId) return {};
  try {
    const data = await fetchJSON(`https://api.fluid.instadapp.io/v2/borrowing/${cfg.chainId}/vaults`, {}, 2);
    const items = Array.isArray(data) ? data : (data?.data || []);
    const map = {};
    for (const v of items) {
      const addr = String(v.address || '').toLowerCase();
      if (!addr) continue;
      const supplyToken = v.supplyToken?.token0;
      const borrowToken = v.borrowToken?.token0;
      map[addr] = {
        id: v.id,
        address: addr,
        type: v.type,
        supplyToken: supplyToken ? {
          address: String(supplyToken.address || '').toLowerCase(),
          symbol: supplyToken.symbol || '?',
          decimals: supplyToken.decimals || 18,
          price: supplyToken.price ? Number(supplyToken.price) : null,
          stakingApr: supplyToken.stakingApr != null ? Number(supplyToken.stakingApr) / 100 : null,
        } : null,
        borrowToken: borrowToken ? {
          address: String(borrowToken.address || '').toLowerCase(),
          symbol: borrowToken.symbol || '?',
          decimals: borrowToken.decimals || 18,
          price: borrowToken.price ? Number(borrowToken.price) : null,
        } : null,
        supplyApy: v.supplyRate?.vault?.rate != null ? Number(v.supplyRate.vault.rate) / 100 : null,
        borrowApy: v.borrowRate?.vault?.rate != null ? Number(v.borrowRate.vault.rate) / 100 : null,
      };
    }
    return map;
  } catch (e) {
    console.log(`  ${chain} Fluid vaults failed:`, e.message);
    return {};
  }
}

// ───────────────────────────────────────────────────────
// On-chain NFT enumeration + position resolve
// ───────────────────────────────────────────────────────

async function getNftIds(chain, wallet) {
  const padded = wallet.replace(/^0x/, '').padStart(64, '0').toLowerCase();
  const balResult = await ethCall(chain, FLUID_VAULT_FACTORY, SEL_BALANCE_OF + padded);
  if (!balResult) return [];
  const count = Number(BigInt(balResult));
  if (count === 0) return [];

  const ids = [];
  for (let i = 0; i < count; i++) {
    const ipad = BigInt(i).toString(16).padStart(64, '0');
    const r = await ethCall(chain, FLUID_VAULT_FACTORY, SEL_TOKEN_OF_OWNER_BY_INDEX + padded + ipad);
    if (r) ids.push(BigInt(r));
  }
  return ids;
}

async function resolvePositions(chain, nftIds) {
  if (nftIds.length === 0) return [];
  const offset = '0000000000000000000000000000000000000000000000000000000000000020';
  const length = BigInt(nftIds.length).toString(16).padStart(64, '0');
  const body = nftIds.map(n => n.toString(16).padStart(64, '0')).join('');
  const data = SEL_GET_POSITIONS_FOR_NFT_IDS + offset + length + body;

  const r = await ethCall(chain, FLUID_POSITIONS_RESOLVER, data);
  if (!r) return [];
  const abi = ethers.AbiCoder.defaultAbiCoder();
  try {
    const decoded = abi.decode(['tuple(uint256,address,uint256,uint256)[]'], r);
    return decoded[0].map(p => ({
      nftId: p[0],
      owner: String(p[1]).toLowerCase(),
      supply: p[2],
      borrow: p[3],
    }));
  } catch (e) {
    console.log('  decode positions failed:', e.message);
    return [];
  }
}

// Map NFT → vault address. VaultResolver exposes vaultByNftId(uint256).
// Selector: 0x1949138e
const SEL_VAULT_BY_NFT_ID = '0x1949138e';

async function getVaultAddressForNftId(chain, nftId) {
  const padded = nftId.toString(16).padStart(64, '0');
  const r = await ethCall(chain, FLUID_VAULT_RESOLVER, SEL_VAULT_BY_NFT_ID + padded);
  if (!r) return null;
  // Last 40 hex chars = address
  const addr = '0x' + r.slice(-40).toLowerCase();
  if (addr === '0x0000000000000000000000000000000000000000') return null;
  return addr;
}

// ───────────────────────────────────────────────────────
// DB writers
// ───────────────────────────────────────────────────────

function upsertFluidLendingPosition(db, wallet, chain, token, supplyInfo) {
  const positionIndex = `fluid-lending:${token.address}`;
  const valueUsd = Number(supplyInfo.value_usd || 0);

  const existing = db.prepare(`
    SELECT id FROM positions
    WHERE lower(wallet) = ? AND chain = ? AND protocol_id = 'fluid-lending' AND position_index = ?
  `).get(wallet.toLowerCase(), chain, positionIndex);

  let positionId;
  if (existing) {
    positionId = existing.id;
    db.prepare('DELETE FROM position_tokens WHERE position_id = ?').run(positionId);
    db.prepare('DELETE FROM position_markets WHERE position_id = ?').run(positionId);
    db.prepare(`
      UPDATE positions
      SET protocol_id = 'fluid-lending', protocol_name = 'Fluid',
          position_type = 'Lending', strategy = 'lend',
          net_usd = ?, asset_usd = ?, debt_usd = 0, scanned_at = datetime('now')
      WHERE id = ?
    `).run(valueUsd, valueUsd, positionId);
  } else {
    const result = db.prepare(`
      INSERT INTO positions (
        wallet, chain, protocol_id, protocol_name, position_type, strategy,
        net_usd, asset_usd, debt_usd, position_index, scanned_at
      ) VALUES (?, ?, 'fluid-lending', 'Fluid', 'Lending', 'lend', ?, ?, 0, ?, datetime('now'))
    `).run(wallet.toLowerCase(), chain, valueUsd, valueUsd, positionIndex);
    positionId = result.lastInsertRowid;
  }

  db.prepare(`
    INSERT INTO position_tokens (position_id, role, symbol, address, amount, price_usd, value_usd, apy_base, bonus_supply_apy)
    VALUES (?, 'supply', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    positionId,
    token.assetSymbol, token.asset,
    supplyInfo.amount, supplyInfo.price, valueUsd,
    token.supplyApy != null ? Number(token.supplyApy) : 0,
    token.rewardsApy != null && token.rewardsApy > 0 ? Number(token.rewardsApy) : null
  );
  return positionId;
}

function upsertFluidVaultPosition(db, wallet, chain, nftId, vault, supplyInfo, borrowInfo) {
  const positionIndex = `fluid-vault:${nftId.toString()}`;
  const supplyUsd = Number(supplyInfo?.value_usd || 0);
  const borrowUsd = Number(borrowInfo?.value_usd || 0);
  const netUsd = supplyUsd - borrowUsd;

  const existing = db.prepare(`
    SELECT id FROM positions
    WHERE lower(wallet) = ? AND chain = ? AND protocol_id = 'fluid-vault' AND position_index = ?
  `).get(wallet.toLowerCase(), chain, positionIndex);

  let positionId;
  if (existing) {
    positionId = existing.id;
    db.prepare('DELETE FROM position_tokens WHERE position_id = ?').run(positionId);
    db.prepare('DELETE FROM position_markets WHERE position_id = ?').run(positionId);
    db.prepare(`
      UPDATE positions
      SET protocol_id = 'fluid-vault', protocol_name = 'Fluid',
          position_type = 'Lending', strategy = ?,
          net_usd = ?, asset_usd = ?, debt_usd = ?,
          scanned_at = datetime('now')
      WHERE id = ?
    `).run(borrowUsd > 0 ? 'lend-borrow' : 'lend', netUsd, supplyUsd, borrowUsd, positionId);
  } else {
    const result = db.prepare(`
      INSERT INTO positions (
        wallet, chain, protocol_id, protocol_name, position_type, strategy,
        net_usd, asset_usd, debt_usd, position_index, scanned_at
      ) VALUES (?, ?, 'fluid-vault', 'Fluid', 'Lending', ?, ?, ?, ?, ?, datetime('now'))
    `).run(wallet.toLowerCase(), chain, borrowUsd > 0 ? 'lend-borrow' : 'lend', netUsd, supplyUsd, borrowUsd, positionIndex);
    positionId = result.lastInsertRowid;
  }

  if (supplyInfo) {
    db.prepare(`
      INSERT INTO position_tokens (position_id, role, symbol, address, amount, price_usd, value_usd, apy_base)
      VALUES (?, 'supply', ?, ?, ?, ?, ?, ?)
    `).run(
      positionId, supplyInfo.symbol, supplyInfo.address || '',
      supplyInfo.amount, supplyInfo.price, supplyUsd,
      vault?.supplyApy != null ? Number(vault.supplyApy) : 0
    );
  }
  if (borrowInfo) {
    db.prepare(`
      INSERT INTO position_tokens (position_id, role, symbol, address, amount, price_usd, value_usd, apy_base)
      VALUES (?, 'borrow', ?, ?, ?, ?, ?, ?)
    `).run(
      positionId, borrowInfo.symbol, borrowInfo.address || '',
      borrowInfo.amount, borrowInfo.price, borrowUsd,
      vault?.borrowApy != null ? Number(vault.borrowApy) : 0
    );
  }

  return positionId;
}

function cleanupStaleForWallet(db, wallet, seenKeys) {
  const existing = db.prepare(`
    SELECT id, position_index FROM positions
    WHERE lower(wallet) = ? AND protocol_id IN ('fluid-lending', 'fluid-vault')
  `).all(wallet.toLowerCase());
  const toDelete = existing
    .filter(r => !seenKeys.has(String(r.position_index || '').toLowerCase()))
    .map(r => r.id);
  if (toDelete.length === 0) return 0;
  const ph = toDelete.map(() => '?').join(',');
  db.prepare(`DELETE FROM position_markets WHERE position_id IN (${ph})`).run(...toDelete);
  db.prepare(`DELETE FROM position_tokens WHERE position_id IN (${ph})`).run(...toDelete);
  db.prepare(`DELETE FROM positions WHERE id IN (${ph})`).run(...toDelete);
  return toDelete.length;
}

// ───────────────────────────────────────────────────────
// Main scan per wallet × chain
// ───────────────────────────────────────────────────────

async function scanLendingOnChain(db, wallet, chain, fTokens) {
  const seenKeys = new Set();
  let positions = 0;
  let totalUsd = 0;

  for (const token of fTokens) {
    const shares = await balanceOf(chain, token.address, wallet);
    if (shares === 0n) continue;

    // ERC-4626 share → underlying amount via convertToAssets
    const sharesPadded = shares.toString(16).padStart(64, '0');
    const assetsHex = await ethCall(chain, token.address, SEL_CONVERT_TO_ASSETS + sharesPadded);
    const underlyingRaw = assetsHex ? BigInt(assetsHex) : shares;
    const amount = Number(underlyingRaw) / Math.pow(10, token.assetDecimals);

    const price = token.assetPrice || await getDefiLlamaPrice(chain, token.asset);
    const valueUsd = price ? amount * price : 0;
    if (valueUsd < 1000) continue;

    upsertFluidLendingPosition(db, wallet, chain, token, { amount, price, value_usd: valueUsd });
    seenKeys.add(`fluid-lending:${token.address}`);
    positions++;
    totalUsd += valueUsd;
    console.log(`    ${chain} ${token.symbol.padEnd(10)} (${token.assetSymbol.padEnd(7)}) $${(valueUsd / 1e6).toFixed(2)}M  APY ${(token.supplyApy || 0).toFixed(2)}%${token.rewardsApy ? ` + ${token.rewardsApy.toFixed(2)}% rewards` : ''}`);
  }

  return { seenKeys, positions, totalUsd };
}

async function scanVaultsOnChain(db, wallet, chain, vaultRegistry) {
  const seenKeys = new Set();
  let positions = 0;
  let totalNetUsd = 0;

  const nftIds = await getNftIds(chain, wallet);
  if (nftIds.length === 0) return { seenKeys, positions, totalNetUsd };

  // Resolve raw supply/borrow for each NFT
  const resolved = await resolvePositions(chain, nftIds);
  if (resolved.length === 0) return { seenKeys, positions, totalNetUsd };

  for (const pos of resolved) {
    if (pos.supply === 0n && pos.borrow === 0n) continue;

    // Which vault does this NFT belong to?
    const vaultAddr = await getVaultAddressForNftId(chain, pos.nftId);
    if (!vaultAddr) continue;
    const vaultMeta = vaultRegistry[vaultAddr];
    if (!vaultMeta) {
      console.log(`    ${chain} nftId ${pos.nftId} vault ${vaultAddr.slice(0, 10)} not in API registry, skipping`);
      continue;
    }

    const supplyToken = vaultMeta.supplyToken;
    const borrowToken = vaultMeta.borrowToken;
    if (!supplyToken) continue;

    const supplyAmount = Number(pos.supply) / Math.pow(10, supplyToken.decimals);
    const borrowAmount = borrowToken ? Number(pos.borrow) / Math.pow(10, borrowToken.decimals) : 0;
    const supplyPrice = supplyToken.price || await getDefiLlamaPrice(chain, supplyToken.address);
    const borrowPrice = borrowToken ? (borrowToken.price || await getDefiLlamaPrice(chain, borrowToken.address)) : 0;

    const supplyUsd = supplyPrice ? supplyAmount * supplyPrice : 0;
    const borrowUsd = borrowPrice ? borrowAmount * borrowPrice : 0;

    // Skip positions under $1000 supply
    if (supplyUsd < 1000 && borrowUsd < 1000) continue;

    const supplyInfo = {
      symbol: supplyToken.symbol, address: supplyToken.address,
      amount: supplyAmount, price: supplyPrice, value_usd: supplyUsd,
    };
    const borrowInfo = borrowToken && borrowAmount > 0 ? {
      symbol: borrowToken.symbol, address: borrowToken.address,
      amount: borrowAmount, price: borrowPrice, value_usd: borrowUsd,
    } : null;

    upsertFluidVaultPosition(db, wallet, chain, pos.nftId, vaultMeta, supplyInfo, borrowInfo);
    seenKeys.add(`fluid-vault:${pos.nftId.toString()}`);
    positions++;
    const netUsd = supplyUsd - borrowUsd;
    totalNetUsd += netUsd;
    const borrowStr = borrowInfo ? ` / borrow ${borrowAmount.toFixed(2)} ${borrowToken.symbol} $${(borrowUsd / 1e6).toFixed(2)}M` : '';
    console.log(`    ${chain} vault#${vaultMeta.id} nft:${pos.nftId} supply ${supplyAmount.toFixed(2)} ${supplyToken.symbol} $${(supplyUsd / 1e6).toFixed(2)}M${borrowStr} net $${(netUsd / 1e6).toFixed(2)}M`);
  }

  return { seenKeys, positions, totalNetUsd };
}

async function scanWallet(db, wallet, label, tokensByChain, vaultsByChain) {
  const allSeen = new Set();
  let total = { positions: 0, lendingUsd: 0, vaultNetUsd: 0 };
  const walletTotals = [];

  for (const chain of Object.keys(FLUID_CHAINS)) {
    const cfg = FLUID_CHAINS[chain];
    if (!cfg.alchemy) continue;

    // Fluid Lending
    const tokens = tokensByChain[chain] || [];
    if (tokens.length > 0) {
      try {
        const r = await scanLendingOnChain(db, wallet, chain, tokens);
        for (const k of r.seenKeys) allSeen.add(k);
        total.positions += r.positions;
        total.lendingUsd += r.totalUsd;
      } catch (e) { console.error(`    ${chain} lending err:`, e.message); }
    }

    // Fluid Vaults
    const vaults = vaultsByChain[chain] || {};
    if (Object.keys(vaults).length > 0) {
      try {
        const r = await scanVaultsOnChain(db, wallet, chain, vaults);
        for (const k of r.seenKeys) allSeen.add(k);
        total.positions += r.positions;
        total.vaultNetUsd += r.totalNetUsd;
      } catch (e) { console.error(`    ${chain} vault err:`, e.message); }
    }
  }

  if (total.positions > 0) {
    const totalUsd = total.lendingUsd + total.vaultNetUsd;
    console.log(`--- ${label} (${wallet.slice(0, 12)}) — ${total.positions} position${total.positions > 1 ? 's' : ''}, lending $${(total.lendingUsd / 1e6).toFixed(2)}M, vault net $${(total.vaultNetUsd / 1e6).toFixed(2)}M ---`);
  }

  const cleaned = cleanupStaleForWallet(db, wallet, allSeen);
  return { ...total, cleaned };
}

async function main() {
  const db = new Database(DB_PATH);

  // Build wallet list from DeBank recon (active chains)
  let wallets = [];
  const active = loadActiveWalletChains();
  if (active && active.length > 0) {
    const labelByWallet = new Map(loadWhaleWalletMap().map(w => [w.addr, w.label]));
    const seen = new Set();
    for (const row of active) {
      if (seen.has(row.wallet)) continue;
      seen.add(row.wallet);
      wallets.push({ addr: row.wallet, label: labelByWallet.get(row.wallet) || row.whale || 'Unknown' });
    }
  } else {
    const whales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));
    for (const [name, config] of Object.entries(whales)) {
      const ws = Array.isArray(config) ? config : (config.vaults ? Object.values(config.vaults).flat() : []);
      for (const w of ws) wallets.push({ addr: w.toLowerCase(), label: name });
    }
  }

  console.log('=== Fluid Scanner (lending + vaults) ===');
  console.log(`Scanning ${wallets.length} wallets across ${Object.keys(FLUID_CHAINS).length} chains\n`);

  // Pre-load registries for each chain (one REST call per chain)
  console.log('Loading Fluid registries...');
  const tokensByChain = {};
  const vaultsByChain = {};
  for (const chain of Object.keys(FLUID_CHAINS)) {
    const [toks, vaults] = await Promise.all([
      loadFluidLendingTokens(chain),
      loadFluidVaults(chain),
    ]);
    tokensByChain[chain] = toks;
    vaultsByChain[chain] = vaults;
    console.log(`  ${chain}: ${toks.length} fTokens, ${Object.keys(vaults).length} vaults`);
  }
  console.log('');

  let totalPositions = 0;
  let totalLendingUsd = 0;
  let totalVaultNetUsd = 0;
  let totalCleaned = 0;

  for (const w of wallets) {
    const r = await scanWallet(db, w.addr, w.label, tokensByChain, vaultsByChain);
    totalPositions += r.positions;
    totalLendingUsd += r.lendingUsd;
    totalVaultNetUsd += r.vaultNetUsd;
    totalCleaned += r.cleaned;
  }

  console.log(`\n=== Done ===`);
  console.log(`Positions: ${totalPositions}`);
  console.log(`Lending USD: $${(totalLendingUsd / 1e6).toFixed(2)}M`);
  console.log(`Vault net USD: $${(totalVaultNetUsd / 1e6).toFixed(2)}M`);
  console.log(`Stale rows cleaned: ${totalCleaned}`);
  db.close();
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { scanWallet, loadFluidLendingTokens, loadFluidVaults };
