#!/usr/bin/env node
/**
 * Pendle v1 scanner
 *
 * API-first discovery for:
 * - PT holdings
 * - YT holdings
 * - Pendle LP holdings
 *
 * Uses Pendle market API for registry/economics and Alchemy token balances for wallet discovery.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { fetchJSON } = require('./fetch-helper');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;

const PENDLE_CHAINS = {
  eth: { chainId: 1, alchemy: 'https://eth-mainnet.g.alchemy.com/v2/' },
  arb: { chainId: 42161, alchemy: 'https://arb-mainnet.g.alchemy.com/v2/' },
  base: { chainId: 8453, alchemy: 'https://base-mainnet.g.alchemy.com/v2/' },
  plasma: { chainId: 9745, alchemy: null },
};

async function alchemy(method, params, chain) {
  const cfg = PENDLE_CHAINS[chain];
  if (!cfg?.alchemy || !ALCHEMY_KEY) return null;
  const res = await fetchJSON(`${cfg.alchemy}${ALCHEMY_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }, 1);
  return res?.result;
}

async function getBalances(wallet, chain) {
  const result = await alchemy('alchemy_getTokenBalances', [wallet], chain);
  return result?.tokenBalances || [];
}

async function fetchPendleMarketsByChain(chain, chainId) {
  const all = [];
  let skip = 0;
  const limit = 100;

  while (true) {
    const data = await fetchJSON(`https://api-v2.pendle.finance/core/v1/${chainId}/markets?is_expired=false&limit=${limit}&skip=${skip}`, {}, 2);
    const results = data?.results || [];
    if (!results.length) break;
    all.push(...results);
    if (results.length < limit) break;
    skip += limit;
  }

  console.log(`  Pendle ${chain}: ${all.length} active markets`);
  return all;
}

async function buildPendleRegistry() {
  const byChain = {};

  for (const [chain, cfg] of Object.entries(PENDLE_CHAINS)) {
    try {
      const markets = await fetchPendleMarketsByChain(chain, cfg.chainId);
      const pt = {};
      const yt = {};
      const lp = {};

      for (const m of markets) {
        const meta = {
          marketAddress: String(m.address || '').toLowerCase(),
          chain,
          chainId: cfg.chainId,
          expiry: m.expiry || null,
          pt: m.pt || null,
          yt: m.yt || null,
          sy: m.sy || null,
          underlying: m.underlyingAsset || null,
          details: m.details || {},
          symbol: m.symbol || 'PENDLE-LPT',
        };

        if (m.pt?.address) pt[String(m.pt.address).toLowerCase()] = meta;
        if (m.yt?.address) yt[String(m.yt.address).toLowerCase()] = meta;
        if (m.address) lp[String(m.address).toLowerCase()] = meta;
      }

      byChain[chain] = { pt, yt, lp };
    } catch (e) {
      console.log(`  Pendle ${chain}: ${e.message}`);
      byChain[chain] = null;
    }
  }

  return byChain;
}

function daysToExpiry(expiry) {
  if (!expiry) return null;
  const ms = new Date(expiry).getTime() - Date.now();
  return Math.max(0, ms / 86400000);
}

function upsertPosition(db, pos) {
  const walletLc = pos.wallet.toLowerCase();
  const existing = db.prepare(`
    SELECT id FROM positions
    WHERE lower(wallet) = ? AND chain = ? AND protocol_id = ? AND position_index = ?
  `).get(walletLc, pos.chain, pos.protocol_id, pos.position_index);

  let positionId;
  if (existing) {
    positionId = existing.id;
    db.prepare('DELETE FROM position_tokens WHERE position_id = ?').run(positionId);
    db.prepare(`
      UPDATE positions
      SET protocol_name = ?, position_type = ?, strategy = ?, yield_source = ?,
          net_usd = ?, asset_usd = ?, debt_usd = 0, scanned_at = datetime('now')
      WHERE id = ?
    `).run(pos.protocol_name, pos.position_type, pos.strategy, pos.yield_source, pos.net_usd, pos.asset_usd, positionId);
  } else {
    const result = db.prepare(`
      INSERT INTO positions (
        wallet, chain, protocol_id, protocol_name, position_type, strategy, yield_source,
        net_usd, asset_usd, debt_usd, position_index, scanned_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))
    `).run(walletLc, pos.chain, pos.protocol_id, pos.protocol_name, pos.position_type, pos.strategy, pos.yield_source, pos.net_usd, pos.asset_usd, pos.position_index);
    positionId = result.lastInsertRowid;
  }

  db.prepare(`
    INSERT INTO position_tokens (position_id, role, symbol, address, amount, price_usd, value_usd, apy_base, apy_base_source)
    VALUES (?, 'supply', ?, ?, ?, ?, ?, ?, 'pendle')
  `).run(positionId, pos.symbol, pos.token_address, pos.amount, pos.price_usd, pos.value_usd, pos.apy_base);
}

function makePosition(wallet, label, meta, tokenType, tokenAddress, amountRaw) {
  const token = meta[tokenType];
  const decimals = token?.decimals ?? 18;
  const amount = Number(BigInt(amountRaw)) / (10 ** decimals);
  const priceUsd = Number(token?.price?.usd || (tokenType === 'lp' ? meta.details?.price?.usd : 0) || 0);
  const valueUsd = amount * priceUsd;
  const dte = daysToExpiry(meta.expiry);

  if (tokenType === 'pt') {
    return {
      wallet,
      label,
      chain: meta.chain,
      chainId: meta.chainId,
      protocol_id: 'pendle-pt',
      protocol_name: 'Pendle',
      position_type: 'supply',
      strategy: 'pendle-pt',
      yield_source: 'pendle',
      position_index: `${meta.marketAddress}:pt:${tokenAddress}`,
      token_address: tokenAddress,
      symbol: token?.symbol || 'PT',
      amount,
      price_usd: priceUsd,
      value_usd: valueUsd,
      net_usd: valueUsd,
      asset_usd: valueUsd,
      apy_base: Number(meta.details?.impliedApy || 0) * 100,
      expiry: meta.expiry,
      days_to_expiry: dte,
    };
  }

  if (tokenType === 'yt') {
    return {
      wallet,
      label,
      chain: meta.chain,
      chainId: meta.chainId,
      protocol_id: 'pendle-yt',
      protocol_name: 'Pendle',
      position_type: 'supply',
      strategy: 'pendle-yt',
      yield_source: 'pendle',
      position_index: `${meta.marketAddress}:yt:${tokenAddress}`,
      token_address: tokenAddress,
      symbol: token?.symbol || 'YT',
      amount,
      price_usd: priceUsd,
      value_usd: valueUsd,
      net_usd: valueUsd,
      asset_usd: valueUsd,
      apy_base: Number(meta.details?.ytFloatingApy || 0) * 100,
      expiry: meta.expiry,
      days_to_expiry: dte,
    };
  }

  return {
    wallet,
    label,
    chain: meta.chain,
    chainId: meta.chainId,
    protocol_id: 'pendle-lp',
    protocol_name: 'Pendle',
    position_type: 'supply',
    strategy: 'pendle-lp',
    yield_source: 'pendle',
    position_index: `${meta.marketAddress}:lp`,
    token_address: tokenAddress,
    symbol: meta.symbol || 'PENDLE-LPT',
    amount,
    price_usd: priceUsd,
    value_usd: valueUsd,
    net_usd: valueUsd,
    asset_usd: valueUsd,
    apy_base: Number(meta.details?.aggregatedApy || meta.details?.impliedApy || 0) * 100,
    expiry: meta.expiry,
    days_to_expiry: dte,
  };
}

async function scanWallet(db, wallet, label, registry) {
  console.log(`\n--- ${label} (${wallet.slice(0, 12)}) ---`);
  const found = [];

  for (const [chain, maps] of Object.entries(registry)) {
    if (!maps) continue;
    const balances = await getBalances(wallet, chain);
    if (!balances.length) continue;

    for (const bal of balances) {
      const amountHex = bal.tokenBalance;
      if (!amountHex || amountHex === '0x0' || amountHex === '0x00') continue;
      const addr = String(bal.contractAddress || '').toLowerCase();

      if (maps.pt[addr]) {
        const pos = makePosition(wallet, label, maps.pt[addr], 'pt', addr, amountHex);
        found.push(pos);
        console.log(`  ${chain} PT ${pos.symbol} $${pos.value_usd.toFixed(2)}`);
      } else if (maps.yt[addr]) {
        const pos = makePosition(wallet, label, maps.yt[addr], 'yt', addr, amountHex);
        found.push(pos);
        console.log(`  ${chain} YT ${pos.symbol} $${pos.value_usd.toFixed(2)}`);
      } else if (maps.lp[addr]) {
        const pos = makePosition(wallet, label, maps.lp[addr], 'lp', addr, amountHex);
        found.push(pos);
        console.log(`  ${chain} LP ${pos.symbol} $${pos.value_usd.toFixed(2)}`);
      }
    }
  }

  const tx = db.transaction(() => {
    for (const pos of found) upsertPosition(db, pos);
  });
  tx();

  if (!found.length) console.log('  No Pendle positions');
  return found;
}

async function main() {
  const db = new Database(DB_PATH);
  const whales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));
  const walletMap = [];

  for (const [name, config] of Object.entries(whales)) {
    const wallets = Array.isArray(config)
      ? config
      : (config.vaults ? Object.values(config.vaults).flat() : []);
    for (const w of wallets) walletMap.push({ addr: w.toLowerCase(), label: name });
  }

  console.log('=== Pendle v1 Scanner ===');
  console.log('Loading Pendle market registry...');
  const registry = await buildPendleRegistry();
  console.log(`Scanning ${walletMap.length} wallets`);

  let total = 0;
  for (const w of walletMap) {
    const found = await scanWallet(db, w.addr, w.label, registry);
    total += found.length;
  }

  console.log(`\n=== Done: ${total} Pendle positions ===`);
  db.close();
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { buildPendleRegistry, scanWallet };
