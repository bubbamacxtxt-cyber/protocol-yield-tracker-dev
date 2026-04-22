#!/usr/bin/env node
/**
 * Euler v2 Scanner (sub-account aware)
 *
 * Euler v2 uses a sub-account model: an owner has 256 sub-accounts derived
 * as (mainWallet XOR lastByte) for lastByte in 0x00..0xff. ALL real
 * leveraged positions live in sub-accounts, not in the main wallet address.
 *
 * Flow:
 *   1. For each tracked wallet, query the Goldsky subgraph by addressPrefix
 *      (first 38 hex chars = 19 bytes). This returns every (account, vault)
 *      pair the subgraph ever saw for any sub-account.
 *   2. For each (account, vault) pair, call balanceOf(account) and
 *      debtOf(account) directly on-chain to get LIVE values.
 *   3. Convert vault shares to underlying via ERC-4626 convertToAssets().
 *   4. Price underlying via DeFiLlama.
 *   5. Group all (account, vault) rows under the owner wallet so each
 *      sub-account's supply/debt pair becomes one position row.
 *
 * Per docs/TOKEN-RULES.md: Euler is a protocol scanner. Its output is the
 * authoritative source for Euler positions. No case-by-case patches.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { fetchJSON } = require('./fetch-helper');
const { loadActiveWalletChains, loadWhaleWalletMap } = require('./recon-helpers');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;

const EULER_CHAINS = {
  eth: {
    chainId: 1,
    alchemy: 'https://eth-mainnet.g.alchemy.com/v2/',
    subgraph: 'https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-simple-mainnet/latest/gn',
  },
  base: {
    chainId: 8453,
    alchemy: 'https://base-mainnet.g.alchemy.com/v2/',
    subgraph: 'https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-simple-base/latest/gn',
  },
  arb: {
    chainId: 42161,
    alchemy: 'https://arb-mainnet.g.alchemy.com/v2/',
    subgraph: 'https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-simple-arbitrum/latest/gn',
  },
  bsc: {
    chainId: 56,
    alchemy: 'https://bnb-mainnet.g.alchemy.com/v2/',
    subgraph: 'https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-simple-bsc/latest/gn',
  },
  uni: {
    chainId: 130,
    subgraph: 'https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-simple-unichain/latest/gn',
  },
  monad: {
    chainId: 143,
    alchemy: 'https://monad-mainnet.g.alchemy.com/v2/',
    subgraph: 'https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs/euler-simple-monad/latest/gn',
  },
  sonic: {
    chainId: 146,
    alchemy: 'https://sonic-mainnet.g.alchemy.com/v2/',
  },
  plasma: {
    chainId: 9745,
  },
};

const DL_CHAIN = {
  eth: 'ethereum', base: 'base', arb: 'arbitrum', sonic: 'sonic',
  bsc: 'bsc', monad: 'monad', uni: 'unichain', plasma: 'plasma',
};

// ───────────────────────────────────────────────────────
// RPC / subgraph helpers
// ───────────────────────────────────────────────────────

let _lastRpcAt = 0;
async function _rpcThrottle() {
  const gap = 150;
  const wait = gap - (Date.now() - _lastRpcAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastRpcAt = Date.now();
}

async function alchemy(method, params, chain) {
  const cfg = EULER_CHAINS[chain];
  if (!cfg?.alchemy || !ALCHEMY_KEY) return null;
  await _rpcThrottle();
  const res = await fetchJSON(`${cfg.alchemy}${ALCHEMY_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }, 3);
  return res?.result;
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
// Subgraph: enumerate sub-account (account, vault) pairs
// ───────────────────────────────────────────────────────

async function getSubgraphSubAccountPairs(chain, mainWallet) {
  const cfg = EULER_CHAINS[chain];
  if (!cfg?.subgraph) return [];

  // addressPrefix is the first 19 bytes (38 hex chars) of the address.
  // We slice '0x' + first 38 hex = 40 chars total.
  const prefix = mainWallet.toLowerCase().slice(0, 40);

  const query = `{
    trackingVaultBalances(where: { addressPrefix: "${prefix}" }, first: 500) {
      vault account balance debt
    }
  }`;

  try {
    const res = await fetchJSON(cfg.subgraph, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    }, 2);
    const rows = res?.data?.trackingVaultBalances || [];
    // Deduplicate to unique (account, vault) pairs (subgraph can repeat events)
    const uniq = new Map();
    for (const r of rows) {
      const key = `${r.account.toLowerCase()}|${r.vault.toLowerCase()}`;
      uniq.set(key, { account: r.account.toLowerCase(), vault: r.vault.toLowerCase() });
    }
    return Array.from(uniq.values());
  } catch (e) {
    console.error(`  Subgraph ${chain} failed:`, e.message);
    return [];
  }
}

// ───────────────────────────────────────────────────────
// Vault metadata (from Euler indexer, paginated)
// ───────────────────────────────────────────────────────

const _vaultMetaCache = {};

async function loadVaultMeta(chain) {
  if (_vaultMetaCache[chain]) return _vaultMetaCache[chain];
  const cfg = EULER_CHAINS[chain];
  if (!cfg?.chainId) return {};

  const map = {};
  for (let page = 1; page <= 30; page++) {
    const data = await fetchJSON(`https://indexer.euler.finance/v2/vault/list?chainId=${cfg.chainId}&page=${page}`, {}, 2);
    const items = data?.items || [];
    if (!items.length) break;
    for (const v of items) {
      const addr = String(v.vault || '').toLowerCase();
      if (!addr) continue;
      map[addr] = {
        vault: addr,
        symbol: v.vaultSymbol || v.assetSymbol || `e${addr.slice(2, 8)}`,
        asset: String(v.asset || '').toLowerCase(),
        assetSymbol: v.assetSymbol || 'Unknown',
        vaultDecimals: v.vaultDecimals || 18,
        assetDecimals: v.assetDecimals || 18,
        supplyApy: typeof v.supplyApy?.totalApy === 'number' ? v.supplyApy.totalApy :
                   (typeof v.supplyApy === 'number' ? v.supplyApy * 100 : null),
        borrowApy: typeof v.borrowApy?.totalApy === 'number' ? v.borrowApy.totalApy :
                   (typeof v.borrowApy === 'number' ? v.borrowApy * 100 : null),
      };
    }
    if (items.length < 50) break;
  }
  _vaultMetaCache[chain] = map;
  console.log(`  Euler ${chain}: ${Object.keys(map).length} vaults indexed`);
  return map;
}

// ───────────────────────────────────────────────────────
// Live RPC reads: balanceOf, debtOf, convertToAssets
// ───────────────────────────────────────────────────────

async function balanceOf(chain, vault, account) {
  const selector = '0x70a08231';
  const padded = account.replace(/^0x/, '').padStart(64, '0').toLowerCase();
  const result = await alchemy('eth_call', [{ to: vault, data: selector + padded }, 'latest'], chain);
  if (!result || result === '0x') return 0n;
  try { return BigInt(result); } catch { return 0n; }
}

// Euler EVault uses `debtOf(account)` — function selector 0xd283e75f
async function debtOf(chain, vault, account) {
  const selector = '0xd283e75f';
  const padded = account.replace(/^0x/, '').padStart(64, '0').toLowerCase();
  const result = await alchemy('eth_call', [{ to: vault, data: selector + padded }, 'latest'], chain);
  if (!result || result === '0x') return 0n;
  try { return BigInt(result); } catch { return 0n; }
}

async function convertToAssets(chain, vault, shares) {
  if (shares === 0n) return 0n;
  const selector = '0x07a2d13a';
  const padded = shares.toString(16).padStart(64, '0');
  const result = await alchemy('eth_call', [{ to: vault, data: selector + padded }, 'latest'], chain);
  if (!result || result === '0x') return shares;
  try { return BigInt(result); } catch { return shares; }
}

// ───────────────────────────────────────────────────────
// DB writers (one row per sub-account × vault)
// ───────────────────────────────────────────────────────

function upsertEulerPosition(db, owner, chain, subAccount, vault, supplyInfo, debtInfo) {
  // Position index: sub-account + vault address
  const positionIndex = `${subAccount.toLowerCase()}|${vault.vault}`;
  const supplyUsd = Number(supplyInfo?.value_usd || 0);
  const debtUsd = Number(debtInfo?.value_usd || 0);
  const netUsd = supplyUsd - debtUsd;

  const existing = db.prepare(`
    SELECT id FROM positions
    WHERE lower(wallet) = ? AND chain = ? AND protocol_id = 'euler2' AND position_index = ?
  `).get(owner.toLowerCase(), chain, positionIndex);

  let positionId;
  if (existing) {
    positionId = existing.id;
    db.prepare('DELETE FROM position_tokens WHERE position_id = ?').run(positionId);
    db.prepare('DELETE FROM position_markets WHERE position_id = ?').run(positionId);
    db.prepare(`
      UPDATE positions
      SET protocol_id = 'euler2', protocol_name = 'Euler',
          position_type = ?, strategy = ?,
          net_usd = ?, asset_usd = ?, debt_usd = ?,
          scanned_at = datetime('now')
      WHERE id = ?
    `).run(
      debtUsd > 0 ? 'Lending' : 'Lending',
      debtUsd > 0 ? 'lend-borrow' : 'lend',
      netUsd, supplyUsd, debtUsd, positionId
    );
  } else {
    const result = db.prepare(`
      INSERT INTO positions (
        wallet, chain, protocol_id, protocol_name, position_type, strategy,
        net_usd, asset_usd, debt_usd, position_index, scanned_at
      ) VALUES (?, ?, 'euler2', 'Euler', 'Lending', ?, ?, ?, ?, ?, datetime('now'))
    `).run(owner.toLowerCase(), chain, debtUsd > 0 ? 'lend-borrow' : 'lend', netUsd, supplyUsd, debtUsd, positionIndex);
    positionId = result.lastInsertRowid;
  }

  if (supplyInfo) {
    db.prepare(`
      INSERT INTO position_tokens (position_id, role, symbol, address, amount, price_usd, value_usd, apy_base)
      VALUES (?, 'supply', ?, ?, ?, ?, ?, ?)
    `).run(
      positionId, vault.symbol, vault.asset,
      supplyInfo.amount, supplyInfo.price, supplyUsd,
      vault.supplyApy != null ? Number(vault.supplyApy) : 0
    );
  }
  if (debtInfo) {
    db.prepare(`
      INSERT INTO position_tokens (position_id, role, symbol, address, amount, price_usd, value_usd, apy_base)
      VALUES (?, 'borrow', ?, ?, ?, ?, ?, ?)
    `).run(
      positionId, vault.symbol, vault.asset,
      debtInfo.amount, debtInfo.price, debtUsd,
      vault.borrowApy != null ? Number(vault.borrowApy) : 0
    );
  }

  return positionId;
}

function cleanupStaleForWallet(db, owner, seenKeys, runStartIso) {
  // Any existing Euler row for this owner that we DIDN'T refresh this run must go.
  const existing = db.prepare(`
    SELECT id, position_index FROM positions
    WHERE lower(wallet) = ? AND protocol_id = 'euler2'
  `).all(owner.toLowerCase());

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

async function scanWalletOnChain(db, ownerWallet, ownerLabel, chain) {
  const cfg = EULER_CHAINS[chain];
  if (!cfg) return { positions: 0, netUsd: 0 };

  // 1. Get all (sub-account, vault) pairs ever seen for any sub-account of this owner
  const pairs = await getSubgraphSubAccountPairs(chain, ownerWallet);
  if (pairs.length === 0) return { positions: 0, netUsd: 0 };

  // 2. Load vault metadata for this chain
  const vaultMeta = await loadVaultMeta(chain);

  // 3. For each pair, read live balanceOf + debtOf
  let positionsWritten = 0;
  let totalNetUsd = 0;
  const seenKeys = new Set();

  for (const pair of pairs) {
    const vault = vaultMeta[pair.vault];
    if (!vault) continue;

    const shares = await balanceOf(chain, pair.vault, pair.account);
    const debt = await debtOf(chain, pair.vault, pair.account);
    if (shares === 0n && debt === 0n) continue;

    let supplyInfo = null;
    let debtInfo = null;
    const price = vault.asset ? await getDefiLlamaPrice(chain, vault.asset) : null;

    if (shares > 0n) {
      const underlyingRaw = await convertToAssets(chain, pair.vault, shares);
      const amount = Number(underlyingRaw) / Math.pow(10, vault.assetDecimals);
      const valueUsd = price ? amount * price : 0;
      supplyInfo = { amount, price, value_usd: valueUsd };
    }
    if (debt > 0n) {
      const amount = Number(debt) / Math.pow(10, vault.assetDecimals);
      const valueUsd = price ? amount * price : 0;
      debtInfo = { amount, price, value_usd: valueUsd };
    }

    upsertEulerPosition(db, ownerWallet, chain, pair.account, vault, supplyInfo, debtInfo);
    const positionIndex = `${pair.account.toLowerCase()}|${pair.vault}`;
    seenKeys.add(positionIndex);
    positionsWritten++;

    const supplyStr = supplyInfo && supplyInfo.value_usd > 0 ? `+$${(supplyInfo.value_usd / 1e6).toFixed(2)}M` : '';
    const debtStr = debtInfo && debtInfo.value_usd > 0 ? ` -$${(debtInfo.value_usd / 1e6).toFixed(2)}M` : '';
    const subLabel = pair.account.slice(-4);
    console.log(`  ${chain} sub:${subLabel} ${vault.symbol.padEnd(18)} (${vault.assetSymbol}) ${supplyStr}${debtStr}`);
    totalNetUsd += (supplyInfo?.value_usd || 0) - (debtInfo?.value_usd || 0);
  }

  return { positions: positionsWritten, netUsd: totalNetUsd, seenKeys };
}

async function main() {
  const db = new Database(DB_PATH);
  const runStartIso = new Date(Date.now() - 5000).toISOString().slice(0, 19).replace('T', ' ');

  // Build wallet list from DeBank recon (only wallets with any Euler hint or active chain)
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

  console.log('=== Euler v2 Scanner (sub-account aware) ===');
  console.log(`Scanning ${wallets.length} owner wallets across ${Object.keys(EULER_CHAINS).length} chains\n`);

  let totalPositions = 0;
  let totalNetUsd = 0;
  let totalCleaned = 0;

  for (const w of wallets) {
    console.log(`--- ${w.label} (${w.addr.slice(0, 12)}) ---`);
    const allSeenKeys = new Set();
    let found = 0;
    for (const chain of Object.keys(EULER_CHAINS)) {
      try {
        const result = await scanWalletOnChain(db, w.addr, w.label, chain);
        found += result.positions;
        totalNetUsd += result.netUsd || 0;
        for (const k of (result.seenKeys || [])) allSeenKeys.add(k);
      } catch (e) {
        console.error(`  ${chain} failed:`, e.message);
      }
    }
    totalPositions += found;
    totalCleaned += cleanupStaleForWallet(db, w.addr, allSeenKeys, runStartIso);
    if (found === 0) console.log(`  (no positions)`);
  }

  console.log(`\n=== Done ===`);
  console.log(`Positions written: ${totalPositions}`);
  console.log(`Total net USD: $${(totalNetUsd / 1e6).toFixed(2)}M`);
  console.log(`Stale rows cleaned: ${totalCleaned}`);
  db.close();
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { scanWalletOnChain };
