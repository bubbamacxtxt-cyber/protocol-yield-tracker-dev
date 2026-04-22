#!/usr/bin/env node
/**
 * Fluid Scanner
 *
 * Scans tracked wallets for positions in:
 *   - Fluid Lending (fTokens: fUSDC, fUSDT, fGHO, fwstETH, fWETH, fEURC, fARB, fUSDtb, fUSDe, fUSDT0)
 *   - Fluid Vaults (leveraged loops: supply X, borrow Y)
 *
 * Data sources:
 *   - Fluid REST API:  https://api.fluid.instadapp.io/v2/lending/{chainId}/tokens
 *     → gives every fToken per chain with `address`, `asset`, `convertToAssets`,
 *       `supplyRate`, `rewardsRate`
 *   - Alchemy RPC: balanceOf(wallet) on each fToken to find holders
 *
 * Fluid vault positions (leveraged supply+borrow) are NOT covered by the
 * public REST API. For now we only scan the ERC-4626 fToken lending side.
 * Vault leverage positions will need a subgraph or direct contract reads
 * in a follow-up.
 *
 * Per docs/TOKEN-RULES.md: Fluid is a protocol scanner. Its output is
 * authoritative for Fluid positions. Protocol-specific wrappers (fUSDC etc)
 * belong here, not in YBS or vault lists.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { fetchJSON } = require('./fetch-helper');
const { loadActiveWalletChains, loadWhaleWalletMap } = require('./recon-helpers');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;

const FLUID_CHAINS = {
  eth:    { chainId: 1,     alchemy: 'https://eth-mainnet.g.alchemy.com/v2/' },
  base:   { chainId: 8453,  alchemy: 'https://base-mainnet.g.alchemy.com/v2/' },
  arb:    { chainId: 42161, alchemy: 'https://arb-mainnet.g.alchemy.com/v2/' },
  plasma: { chainId: 9745,  alchemy: `${process.env.ALCHEMY_PLASMA_RPC_URL || ''}` },
};

const DL_CHAIN = { eth: 'ethereum', base: 'base', arb: 'arbitrum', plasma: 'plasma' };

// ───────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────

let _lastRpcAt = 0;
async function _rpcThrottle() {
  const wait = 150 - (Date.now() - _lastRpcAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastRpcAt = Date.now();
}

async function alchemy(method, params, chain) {
  const cfg = FLUID_CHAINS[chain];
  if (!cfg?.alchemy || !ALCHEMY_KEY) return null;
  await _rpcThrottle();
  const url = cfg.alchemy.includes(ALCHEMY_KEY) ? cfg.alchemy : `${cfg.alchemy}${ALCHEMY_KEY}`;
  const res = await fetchJSON(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }, 3);
  return res?.result;
}

async function balanceOf(chain, token, wallet) {
  const padded = wallet.replace(/^0x/, '').padStart(64, '0').toLowerCase();
  const result = await alchemy('eth_call', [{ to: token, data: '0x70a08231' + padded }, 'latest'], chain);
  if (!result || result === '0x') return 0n;
  try { return BigInt(result); } catch { return 0n; }
}

async function getDefiLlamaPrice(chain, address) {
  try {
    const dlChain = DL_CHAIN[chain] || chain;
    const url = `https://coins.llama.fi/prices/current/${dlChain}:${address.toLowerCase()}`;
    const data = await fetchJSON(url, {}, 2);
    const key = `${dlChain}:${address.toLowerCase()}`;
    return data?.coins?.[key]?.price || null;
  } catch (e) {
    return null;
  }
}

// ───────────────────────────────────────────────────────
// Fluid REST: fToken registry per chain
// ───────────────────────────────────────────────────────

async function loadFluidTokens(chain) {
  const cfg = FLUID_CHAINS[chain];
  if (!cfg?.chainId) return [];
  try {
    const data = await fetchJSON(`https://api.fluid.instadapp.io/v2/lending/${cfg.chainId}/tokens`, {}, 2);
    const items = data?.data || [];
    return items.map(t => {
      const price = t.asset?.price ? Number(t.asset.price) : null;
      // Fluid API returns rates in basis points (1% = 100bps).
      // supplyRate 570 = 5.70% APY.
      const supplyRateBps = t.supplyRate != null ? Number(t.supplyRate) : null;
      const rewardsRateBps = t.rewardsRate != null ? Number(t.rewardsRate) : null;
      return {
        address: String(t.address || '').toLowerCase(),
        symbol: t.symbol || 'fToken',
        decimals: t.decimals || 18,
        asset: String(t.assetAddress || t.asset?.address || '').toLowerCase(),
        assetSymbol: t.asset?.symbol || '?',
        assetDecimals: t.asset?.decimals || 18,
        assetPrice: price,
        convertToAssets: t.convertToAssets ? String(t.convertToAssets) : null,
        supplyApy: supplyRateBps != null ? supplyRateBps / 100 : null, // bps → %
        rewardsApy: rewardsRateBps != null && rewardsRateBps > 0 ? rewardsRateBps / 100 : null,
      };
    });
  } catch (e) {
    console.log(`  ${chain} Fluid tokens failed:`, e.message);
    return [];
  }
}

// ───────────────────────────────────────────────────────
// ERC-4626 convertToAssets for a specific share amount
// ───────────────────────────────────────────────────────

async function convertToAssets(chain, vault, shares) {
  if (shares === 0n) return 0n;
  const selector = '0x07a2d13a';
  const padded = shares.toString(16).padStart(64, '0');
  const result = await alchemy('eth_call', [{ to: vault, data: selector + padded }, 'latest'], chain);
  if (!result || result === '0x') return shares;
  try { return BigInt(result); } catch { return shares; }
}

// ───────────────────────────────────────────────────────
// DB writer
// ───────────────────────────────────────────────────────

function upsertFluidPosition(db, wallet, chain, token, supplyInfo) {
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

function cleanupStaleForWallet(db, wallet, seenKeys) {
  const existing = db.prepare(`
    SELECT id, position_index FROM positions
    WHERE lower(wallet) = ? AND protocol_id = 'fluid-lending'
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
// Main scan
// ───────────────────────────────────────────────────────

async function scanWalletOnChain(db, wallet, label, chain, fluidTokens) {
  const seenKeys = new Set();
  let positions = 0;
  let totalUsd = 0;

  for (const token of fluidTokens) {
    const shares = await balanceOf(chain, token.address, wallet);
    if (shares === 0n) continue;

    // Convert shares → underlying assets (on-chain ERC-4626 call)
    const underlyingRaw = await convertToAssets(chain, token.address, shares);
    const amount = Number(underlyingRaw) / Math.pow(10, token.assetDecimals);

    // Price via Fluid's reported asset price, fallback to DeFiLlama
    const price = token.assetPrice || await getDefiLlamaPrice(chain, token.asset);
    const valueUsd = price ? amount * price : 0;

    if (valueUsd < 1000) continue; // skip dust

    upsertFluidPosition(db, wallet, chain, token, { amount, price, value_usd: valueUsd });
    seenKeys.add(`fluid-lending:${token.address}`);
    positions++;
    totalUsd += valueUsd;
    console.log(`  ${chain} ${token.symbol.padEnd(10)} (${token.assetSymbol.padEnd(7)}) $${(valueUsd / 1e6).toFixed(2)}M  APY ${(token.supplyApy || 0).toFixed(2)}%${token.rewardsApy ? ` + ${token.rewardsApy.toFixed(2)}% rewards` : ''}`);
  }

  return { positions, totalUsd, seenKeys };
}

async function main() {
  const db = new Database(DB_PATH);

  // Build wallet list
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

  console.log('=== Fluid Scanner ===');
  console.log(`Scanning ${wallets.length} wallets across ${Object.keys(FLUID_CHAINS).length} chains\n`);

  // Pre-load fToken registry per chain
  console.log('Loading Fluid token registry...');
  const tokensByChain = {};
  for (const chain of Object.keys(FLUID_CHAINS)) {
    const toks = await loadFluidTokens(chain);
    tokensByChain[chain] = toks;
    console.log(`  ${chain}: ${toks.length} fTokens (${toks.map(t => t.symbol).join(', ')})`);
  }
  console.log('');

  let totalPositions = 0;
  let totalUsd = 0;
  let totalCleaned = 0;

  for (const w of wallets) {
    const allSeen = new Set();
    let walletTotal = 0;
    let walletPositions = 0;
    for (const chain of Object.keys(FLUID_CHAINS)) {
      const tokens = tokensByChain[chain];
      if (!tokens.length) continue;
      const cfg = FLUID_CHAINS[chain];
      if (!cfg.alchemy || !ALCHEMY_KEY) continue; // no RPC for chain
      try {
        const r = await scanWalletOnChain(db, w.addr, w.label, chain, tokens);
        for (const k of r.seenKeys) allSeen.add(k);
        walletPositions += r.positions;
        walletTotal += r.totalUsd;
      } catch (e) {
        console.error(`  ${chain} failed for ${w.addr.slice(0, 12)}:`, e.message);
      }
    }
    if (walletPositions > 0) {
      console.log(`--- ${w.label} (${w.addr.slice(0, 12)}) — ${walletPositions} position${walletPositions > 1 ? 's' : ''}, $${(walletTotal / 1e6).toFixed(2)}M ---`);
    }
    totalCleaned += cleanupStaleForWallet(db, w.addr, allSeen);
    totalPositions += walletPositions;
    totalUsd += walletTotal;
  }

  console.log(`\n=== Done ===`);
  console.log(`Positions: ${totalPositions}`);
  console.log(`Total USD: $${(totalUsd / 1e6).toFixed(2)}M`);
  console.log(`Stale rows cleaned: ${totalCleaned}`);
  db.close();
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { scanWalletOnChain, loadFluidTokens };
