#!/usr/bin/env node
/**
 * Build wallet token-balance recon for the active whale+chain set.
 *
 * Two discovery paths:
 *
 *   1. Alchemy Enhanced APIs (`alchemy_getTokenBalances`) for chains where
 *      Alchemy exposes that method (ETH, ARB, BASE, BSC, AVAX, MNT*, MONAD*).
 *      *MNT/MONAD need "Enhanced APIs" toggled on in the Alchemy dashboard.
 *
 *   2. dRPC + known-token `balanceOf` batch for chains where Alchemy doesn't
 *      support the enhanced method (Plasma) or where the toggle isn't active
 *      (fallback for MNT/MONAD). We iterate our local CoinGecko token registry
 *      for that chain and call `balanceOf(wallet)` in a single batched
 *      JSON-RPC request.
 *
 * Both paths emit the same output shape so downstream (token-discovery.js)
 * is unchanged.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
if (!ALCHEMY_KEY) {
  console.error('Missing ALCHEMY_API_KEY');
  process.exit(1);
}

const DRPC_KEY = process.env.DRPC_API_KEY || '';

const RECON = path.join(__dirname, '..', 'data', 'recon', 'debank-wallet-summary.json');
const REGISTRY = path.join(__dirname, '..', 'data', 'token-registry.json');
const YBS_PATH = path.join(__dirname, '..', 'data', 'stables.json');
const VAULTS_PATH = path.join(__dirname, '..', 'data', 'vaults.json');
const DEBANK_POSITIONS_PATH = path.join(__dirname, '..', 'data', 'recon', 'debank-wallet-positions.json');
const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const OUT = path.join(__dirname, '..', 'data', 'recon', 'alchemy-token-discovery.json');

// Chain configuration. `alchemy` is the enhanced endpoint (uses
// alchemy_getTokenBalances); `drpc` is the batched balanceOf fallback.
// `registryPrefix` is the chain prefix used in token-registry.json's by_address
// keys (e.g. "mnt:0x..."). Having only `drpc` configured forces that path.
const CHAINS = {
  eth:    { alchemy: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,     registryPrefix: 'eth' },
  arb:    { alchemy: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,     registryPrefix: 'arb' },
  base:   { alchemy: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,    registryPrefix: 'base' },
  bsc:    { alchemy: `https://bnb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,     registryPrefix: 'bsc' },
  avax:   { alchemy: `https://avax-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,    registryPrefix: 'avax' },
  mnt:    {
    alchemy: process.env.ALCHEMY_MNT_RPC_URL || '',
    drpc: DRPC_KEY ? `https://lb.drpc.live/mantle/${DRPC_KEY}` : '',
    registryPrefix: 'mnt',
  },
  plasma: {
    drpc: DRPC_KEY ? `https://lb.drpc.live/plasma/${DRPC_KEY}` : '',
    registryPrefix: 'plasma',
  },
  monad:  {
    alchemy: process.env.ALCHEMY_MONAD_RPC_URL || '',
    drpc: DRPC_KEY ? `https://lb.drpc.live/monad-mainnet/${DRPC_KEY}` : '',
    registryPrefix: 'monad',
  },
  sonic:  { alchemy: process.env.ALCHEMY_SONIC_RPC_URL || '', registryPrefix: 'sonic' },
  ink:    { alchemy: process.env.ALCHEMY_INK_RPC_URL || '',   registryPrefix: 'ink' },
};

// Chains marked "alchemy_getTokenBalances doesn't work here" after first error.
// Triggers dRPC fallback if configured for the chain.
const ALCHEMY_UNSUPPORTED = new Set();

async function rpcSingle(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  let body;
  try { body = await res.json(); } catch { return { result: null, error: { message: `HTTP ${res.status} non-JSON` } }; }
  if (body?.error) return { result: null, error: body.error };
  return { result: body?.result, error: null };
}

async function rpcBatch(url, batch, retryCount = 3) {
  // Retry the whole batch if ANY response is a 429 rate-limit error.
  // Alchemy's free tier caps CU/s; large augmentation batches easily trip it.
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    let body;
    try {
      body = await res.json();
    } catch {
      return [{ error: { message: `HTTP ${res.status} non-JSON` } }];
    }
    const arr = Array.isArray(body) ? body : [body];
    // Look for rate-limit errors.
    const rateLimited = arr.some(r => r?.error?.code === 429 ||
      /exceeded its compute units|rate.?limit|too many/i.test(r?.error?.message || ''));
    if (!rateLimited || attempt === retryCount) return arr;
    // Exponential backoff: 1s, 2s, 4s
    const delay = 1000 * Math.pow(2, attempt);
    await new Promise(r => setTimeout(r, delay));
  }
  return [];
}

// ─── Path 1: Alchemy enhanced API ───────────────────────────────
async function scanViaAlchemy(url, wallet) {
  const { result, error } = await rpcSingle(url, 'alchemy_getTokenBalances', [wallet, 'erc20']);
  if (error) return { tokens: null, error };
  const tokens = (result?.tokenBalances || []).filter(t =>
    t.tokenBalance && t.tokenBalance !== '0x' && !/^0x0+$/.test(t.tokenBalance)
  ).map(t => ({
    address: t.contractAddress.toLowerCase(),
    tokenBalance: t.tokenBalance,
  }));
  return { tokens, error: null };
}

// ─── Path 2: dRPC balanceOf batch ───────────────────────────────
function buildBatchForWallet(wallet, tokens) {
  const padded = wallet.slice(2).toLowerCase().padStart(64, '0');
  const data = '0x70a08231' + padded;
  return tokens.map((t, i) => ({
    jsonrpc: '2.0',
    id: i,
    method: 'eth_call',
    params: [{ to: t.addr, data }, 'latest'],
  }));
}

async function scanViaDrpc(url, wallet, tokens) {
  if (tokens.length === 0) return { tokens: [], error: null };
  const batch = buildBatchForWallet(wallet, tokens);

  // Chunk in 100 to avoid hitting batch-size limits.
  const chunks = [];
  for (let i = 0; i < batch.length; i += 100) chunks.push(batch.slice(i, i + 100));

  const results = new Array(batch.length);
  for (const chunk of chunks) {
    const responses = await rpcBatch(url, chunk);
    for (const r of responses) {
      if (r?.id != null) results[r.id] = r;
    }
  }

  const out = [];
  let rpcErr = null;
  for (let i = 0; i < tokens.length; i++) {
    const r = results[i];
    if (!r) continue;
    if (r.error) { if (!rpcErr) rpcErr = r.error; continue; }
    const hex = r.result;
    if (!hex || hex === '0x' || /^0x0+$/.test(hex)) continue;
    out.push({ address: tokens[i].addr, tokenBalance: hex });
  }
  return { tokens: out, error: rpcErr };
}

function loadTokenListForChain(registry, prefix) {
  const out = [];
  for (const [k, v] of Object.entries(registry.by_address || {})) {
    if (k.startsWith(prefix + ':')) {
      out.push({ addr: k.slice(prefix.length + 1), sym: v.symbol });
    }
  }
  return out;
}

// Curated augmentation list: YBS + vault addresses we want to force-check
// for every wallet even if Alchemy's default `alchemy_getTokenBalances`
// doesn't list them (Alchemy's curated token set misses niche yield tokens
// like stcUSD). Indexed by chain prefix.
function loadCuratedAddresses() {
  const byChain = {};

  // YBS list — stables.json
  try {
    const ybsData = JSON.parse(fs.readFileSync(YBS_PATH, 'utf8')).stables || [];
    // Map stables.json chain names → our registry prefix
    const chainMap = { 'ethereum': 'eth', 'arbitrum': 'arb', 'base': 'base',
      'plasma': 'plasma', 'mantle': 'mnt', 'monad': 'monad', 'avalanche': 'avax',
      'bsc': 'bsc', 'optimism': 'opt' };
    for (const s of ybsData) {
      const chain = chainMap[(s.chain || '').toLowerCase()];
      if (!chain) continue;
      for (const addr of (s.addresses || [])) {
        if (typeof addr === 'string' && addr.startsWith('0x')) {
          (byChain[chain] = byChain[chain] || new Set()).add(addr.toLowerCase());
        }
      }
    }
  } catch (e) { /* optional */ }

  // Vaults list — vaults.json (only entries that made it through the
  // address-validity filter in export-vaults.js)
  try {
    const vaultsData = JSON.parse(fs.readFileSync(VAULTS_PATH, 'utf8')).vaults || [];
    const chainMap = { 'eth': 'eth', 'arb': 'arb', 'base': 'base', 'avax': 'avax',
      'bsc': 'bsc', 'mantle': 'mnt', 'monad': 'monad', 'plasma': 'plasma' };
    for (const v of vaultsData) {
      const chain = chainMap[(v.chain || '').toLowerCase()];
      if (!chain || !v.address) continue;
      (byChain[chain] = byChain[chain] || new Set()).add(v.address.toLowerCase());
    }
  } catch (e) { /* optional */ }

  // DeBank-sourced pool addresses — catches Curve / LP / liquidity
  // deployments on chains that official registries don't cover (e.g.
  // Plasma Curve). We ONLY take addresses DeBank already reported for our
  // whales, not every pool on every chain — keeps the augmentation budget
  // tight (a few dozen addresses, not thousands).
  try {
    const debankData = JSON.parse(fs.readFileSync(DEBANK_POSITIONS_PATH, 'utf8')).positions || [];
    for (const p of debankData) {
      const adapter = p.raw?.pool?.adapter_id || '';
      if (!/curve|liquidity|convex|gauge/i.test(adapter)) continue;
      const poolId = p.raw?.pool?.id;
      const chain = p.chain;
      if (!poolId || !chain || !poolId.startsWith('0x')) continue;
      (byChain[chain] = byChain[chain] || new Set()).add(poolId.toLowerCase());
    }
  } catch (e) { /* optional */ }

  // Convert sets to arrays
  const out = {};
  for (const [ch, set] of Object.entries(byChain)) out[ch] = [...set];
  return out;
}

// Given a wallet's existing token set and a list of curated addresses we
// want to force-check, return the subset NOT already in the set. We batch
// balanceOf() for the missing ones via the provided RPC URL.
async function augmentWithCurated(url, wallet, existingTokens, curatedAddrs) {
  if (!url || !curatedAddrs?.length) return [];
  const have = new Set(existingTokens.map(t => t.address.toLowerCase()));
  const missing = curatedAddrs.filter(a => !have.has(a));
  if (!missing.length) return [];

  const padded = wallet.slice(2).toLowerCase().padStart(64, '0');
  const data = '0x70a08231' + padded;

  // Smaller chunks to stay under Alchemy's CU/s cap on the free tier.
  // 80 addrs * 26 CU per eth_call ≈ 2080 CU per batch; with ~30 wallets in
  // quick succession we blow through the 660 CU/s limit. Keep per-batch
  // work small and let rpcBatch handle retries.
  const chunkSize = 40;
  const found = [];
  for (let chunkStart = 0; chunkStart < missing.length; chunkStart += chunkSize) {
    const chunkMissing = missing.slice(chunkStart, chunkStart + chunkSize);
    const batch = chunkMissing.map((addr, i) => ({
      jsonrpc: '2.0', id: i, method: 'eth_call',
      params: [{ to: addr, data }, 'latest'],
    }));
    const responses = await rpcBatch(url, batch);
    const resById = {};
    for (const r of responses) if (r?.id != null) resById[r.id] = r;
    for (let i = 0; i < chunkMissing.length; i++) {
      const r = resById[i];
      if (!r || r.error) continue;
      const hex = r.result;
      if (!hex || hex === '0x' || /^0x0+$/.test(hex)) continue;
      found.push({ address: chunkMissing[i], tokenBalance: hex });
    }
  }
  return found;
}

async function main() {
  const recon = JSON.parse(fs.readFileSync(RECON, 'utf8'));
  const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));

  const wallets = [];
  const skippedChains = new Map();
  for (const w of (recon.wallets || [])) {
    for (const c of (w.chains || [])) {
      if (!c.active_for_position_scan) continue;
      const cfg = CHAINS[c.chain];
      if (!cfg || (!cfg.alchemy && !cfg.drpc)) {
        skippedChains.set(c.chain, (skippedChains.get(c.chain) || 0) + 1);
        continue;
      }
      wallets.push({ whale: w.whale, wallet: w.wallet, chain: c.chain, total_usd: c.total_usd });
    }
  }

  if (skippedChains.size) {
    console.warn('⚠️  Skipped active wallet+chain pairs (no RPC configured):');
    for (const [ch, n] of skippedChains) console.warn(`   ${ch}: ${n} wallet(s)`);
  }

  // Cache per-chain token lists for dRPC batches.
  const tokensByChain = {};
  for (const ch of Object.keys(CHAINS)) {
    tokensByChain[ch] = loadTokenListForChain(registry, CHAINS[ch].registryPrefix);
  }

  // Curated addresses (YBS + vaults) to force-check even if Alchemy's
  // default token list doesn't include them. Applies to Alchemy path only
  // — dRPC path already iterates the full registry so it catches these.
  const curatedByChain = loadCuratedAddresses();
  const curatedCount = Object.values(curatedByChain).reduce((a, v) => a + v.length, 0);
  console.log(`Curated augmentation list: ${curatedCount} addresses across ${Object.keys(curatedByChain).length} chains`);

  const out = [];
  const errors = [];
  const byChainStats = {};

  for (const w of wallets) {
    const cfg = CHAINS[w.chain];
    const stat = byChainStats[w.chain] || (byChainStats[w.chain] = { scans: 0, empty: 0, errors: 0, path: 'unknown' });
    stat.scans++;

    let tokens = null;
    let error = null;
    let path = null;

    // Try Alchemy first if available and not already marked unsupported.
    if (cfg.alchemy && !ALCHEMY_UNSUPPORTED.has(w.chain)) {
      path = 'alchemy';
      const r = await scanViaAlchemy(cfg.alchemy, w.wallet);
      if (r.error) {
        const msg = String(r.error.message || '').toLowerCase();
        if (msg.includes('unsupported method') || msg.includes('eapis not enabled') || msg.includes('is not enabled')) {
          ALCHEMY_UNSUPPORTED.add(w.chain);
          console.warn(`⚠️  ${w.chain}: alchemy disabled (${r.error.message}) — will use dRPC fallback if available`);
          // fall through to dRPC
        } else {
          error = r.error;
        }
      } else {
        tokens = r.tokens;
        // Augment with curated YBS + vault addresses that Alchemy's default
        // list may have missed (e.g. stcUSD 0x88887be4... isn't in Alchemy's
        // top-7k token set even though whales hold $5M+ of it).
        const curated = curatedByChain[w.chain];
        if (curated?.length) {
          const extra = await augmentWithCurated(cfg.alchemy, w.wallet, tokens, curated);
          if (extra.length) {
            console.log(`   + ${w.chain} ${w.wallet.slice(0, 10)} augmented with ${extra.length} curated: ${extra.map(t => t.address.slice(0, 10)).join(', ')}`);
            tokens = tokens.concat(extra);
            stat.augmented = (stat.augmented || 0) + extra.length;
          }
        }
        // Throttle between wallets to stay under Alchemy's CU/s cap.
        await new Promise(r => setTimeout(r, 120));
      }
    }

    // dRPC fallback (or primary, if no alchemy configured)
    if (tokens === null && cfg.drpc) {
      path = 'drpc';
      // Base scan list: CoinGecko registry tokens for this chain.
      // Augment with curated addresses (YBS + vaults + DeBank-sourced Curve
      // pools) so niche tokens not in CoinGecko still get probed.
      const registryList = tokensByChain[w.chain] || [];
      const curated = curatedByChain[w.chain] || [];
      const seen = new Set(registryList.map(t => t.addr.toLowerCase()));
      const mergedList = registryList.slice();
      for (const addr of curated) {
        const a = addr.toLowerCase();
        if (!seen.has(a)) { mergedList.push({ addr: a, sym: '?' }); seen.add(a); }
      }
      if (mergedList.length === 0) {
        error = { message: `no registry/curated tokens for chain ${w.chain}, dRPC scan would find nothing` };
      } else {
        const r = await scanViaDrpc(cfg.drpc, w.wallet, mergedList);
        if (r.error && !r.tokens?.length) error = r.error;
        else tokens = r.tokens || [];
      }
    }

    stat.path = path || 'skipped';

    if (error) {
      stat.errors++;
      errors.push({ chain: w.chain, wallet: w.wallet, error: error.message });
      continue;
    }

    if (!tokens) continue; // no path worked and no explicit error — just skip

    if (tokens.length === 0 && (w.total_usd || 0) > 50000) {
      stat.empty++;
    }

    out.push({
      whale: w.whale,
      wallet: w.wallet,
      chain: w.chain,
      total_usd: w.total_usd,
      tokens,
    });
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    generated_at: new Date().toISOString(),
    wallets: out,
    errors,
    alchemy_unsupported: [...ALCHEMY_UNSUPPORTED],
    stats_by_chain: byChainStats,
  }, null, 2));

  console.log(`Wrote ${OUT}`);
  console.log(`Wallet-chain scans: ${out.length}`);

  console.log('\n=== Per-chain scan summary ===');
  for (const [ch, s] of Object.entries(byChainStats)) {
    const flag = s.errors > 0 || s.empty > 0 ? '⚠️ ' : '   ';
    const aug = s.augmented ? `  augmented:${s.augmented}` : '';
    console.log(`${flag} ${ch.padEnd(10)} via ${s.path.padEnd(8)}  scans:${s.scans}  empty:${s.empty}  errors:${s.errors}${aug}`);
  }

  if (errors.length) {
    console.warn(`\n⚠️  ${errors.length} RPC errors during scan:`);
    const byMsg = {};
    for (const e of errors) byMsg[e.error] = (byMsg[e.error] || 0) + 1;
    for (const [msg, n] of Object.entries(byMsg)) console.warn(`   ${n}x: ${msg}`);
  }

  if (errors.length > 0 && errors.length === wallets.length) {
    console.error('❌ All RPC calls failed. Aborting.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
