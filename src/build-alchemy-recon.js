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

async function rpcBatch(url, batch) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
  });
  try {
    const body = await res.json();
    if (Array.isArray(body)) return body;
    return [body];
  } catch {
    return [{ error: { message: `HTTP ${res.status} non-JSON` } }];
  }
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
      }
    }

    // dRPC fallback (or primary, if no alchemy configured)
    if (tokens === null && cfg.drpc) {
      path = 'drpc';
      const tokenList = tokensByChain[w.chain] || [];
      if (tokenList.length === 0) {
        error = { message: `no registry tokens for chain ${w.chain}, dRPC scan would find nothing` };
      } else {
        const r = await scanViaDrpc(cfg.drpc, w.wallet, tokenList);
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
    console.log(`${flag} ${ch.padEnd(10)} via ${s.path.padEnd(8)}  scans:${s.scans}  empty:${s.empty}  errors:${s.errors}`);
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
