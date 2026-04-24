#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { fetchJSON } = require('./fetch-helper');

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
if (!ALCHEMY_KEY) {
  console.error('Missing ALCHEMY_API_KEY');
  process.exit(1);
}

const RECON = path.join(__dirname, '..', 'data', 'recon', 'debank-wallet-summary.json');
const OUT = path.join(__dirname, '..', 'data', 'recon', 'alchemy-token-discovery.json');

// Alchemy-supported chains. `alchemy_getTokenBalances` requires "Enhanced APIs"
// to be enabled for each network in the Alchemy dashboard.
//
// Chains where Enhanced APIs are unsupported (e.g. Plasma) cannot be scanned
// via this method — use a different provider (dRPC / Goldsky) for those.
const RPCS = {
  eth: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  arb: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  base: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  bsc: `https://bnb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  avax: `https://avax-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  mnt: process.env.ALCHEMY_MNT_RPC_URL || '',
  plasma: process.env.ALCHEMY_PLASMA_RPC_URL || '',
  monad: process.env.ALCHEMY_MONAD_RPC_URL || '',
  sonic: process.env.ALCHEMY_SONIC_RPC_URL || '',
  ink: process.env.ALCHEMY_INK_RPC_URL || '',
};

// Chains where Alchemy simply does not support alchemy_getTokenBalances.
// We still skip them here (no call made), but track them for reporting.
const UNSUPPORTED = new Set(); // populated dynamically on first "Unsupported method"

async function rpc(url, method, params) {
  if (!url) return { result: null, error: null };
  try {
    // Use raw fetch so we can read JSON-RPC error bodies even on HTTP 4xx.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    let body;
    try {
      body = await res.json();
    } catch (e) {
      return { result: null, error: { message: `HTTP ${res.status} non-JSON body` } };
    }
    if (body?.error) return { result: null, error: body.error };
    return { result: body?.result || null, error: null };
  } catch (e) {
    return { result: null, error: { message: e.message } };
  }
}

async function main() {
  const recon = JSON.parse(fs.readFileSync(RECON, 'utf8'));
  const wallets = [];
  const skippedChains = new Map(); // chain -> count
  for (const w of (recon.wallets || [])) {
    for (const c of (w.chains || [])) {
      if (!c.active_for_position_scan) continue;
      if (!RPCS[c.chain]) {
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

  const out = [];
  const errors = []; // {chain, wallet, error}
  const byChainStats = {}; // chain -> { scans, empty, errors }

  for (const w of wallets) {
    if (UNSUPPORTED.has(w.chain)) continue; // skip chains we've already confirmed don't support this method

    const { result, error } = await rpc(RPCS[w.chain], 'alchemy_getTokenBalances', [w.wallet, 'erc20']);

    const stat = byChainStats[w.chain] || (byChainStats[w.chain] = { scans: 0, empty: 0, errors: 0 });
    stat.scans++;

    if (error) {
      stat.errors++;
      errors.push({ chain: w.chain, wallet: w.wallet, error: error.message });
      // If the whole chain isn't supported, stop hammering it.
      const msg = String(error.message || '').toLowerCase();
      if (msg.includes('unsupported method') || msg.includes('eapis not enabled') || msg.includes('is not enabled')) {
        UNSUPPORTED.add(w.chain);
        console.warn(`⚠️  ${w.chain}: ${error.message}  (skipping remaining wallets on this chain)`);
      }
      continue;
    }

    const tokenBalances = (result?.tokenBalances || []).filter(t =>
      t.tokenBalance && t.tokenBalance !== '0x' && !/^0x0+$/.test(t.tokenBalance)
    );
    if (tokenBalances.length === 0 && (w.total_usd || 0) > 50000) {
      stat.empty++;
    }
    out.push({
      whale: w.whale,
      wallet: w.wallet,
      chain: w.chain,
      total_usd: w.total_usd,
      tokens: tokenBalances.map(t => ({ address: t.contractAddress.toLowerCase(), tokenBalance: t.tokenBalance })),
    });
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    generated_at: new Date().toISOString(),
    wallets: out,
    errors,
    unsupported_chains: [...UNSUPPORTED],
    stats_by_chain: byChainStats,
  }, null, 2));

  console.log(`Wrote ${OUT}`);
  console.log(`Wallet-chain scans: ${out.length}`);

  // Per-chain summary
  console.log('\n=== Per-chain scan summary ===');
  for (const [ch, s] of Object.entries(byChainStats)) {
    const flag = s.errors > 0 || s.empty > 0 ? '⚠️ ' : '   ';
    console.log(`${flag} ${ch.padEnd(10)} scans:${s.scans}  empty:${s.empty}  errors:${s.errors}`);
  }

  if (errors.length) {
    console.warn(`\n⚠️  ${errors.length} RPC errors during scan:`);
    const byMsg = {};
    for (const e of errors) byMsg[e.error] = (byMsg[e.error] || 0) + 1;
    for (const [msg, n] of Object.entries(byMsg)) console.warn(`   ${n}x: ${msg}`);
  }

  // Fail the job if ALL wallets returned errors — clearer signal than silent 0-tokens.
  if (errors.length > 0 && errors.length === wallets.length) {
    console.error('❌ All RPC calls failed. Aborting.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
