#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const DATA_JSON = path.join(__dirname, '..', 'data.json');
const DEBANK_RECON = path.join(__dirname, '..', 'data', 'recon', 'debank-wallet-summary.json');
const OUT = path.join(__dirname, '..', 'data', 'recon', 'gap-report.json');

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

const data = loadJson(DATA_JSON, { whales: {} });
const debank = loadJson(DEBANK_RECON, { wallets: [] });

// Build modeled totals by wallet+chain+protocol from exported pages
const modeledByWalletChain = new Map();
const modeledByWalletChainProtocol = new Map();
for (const [whale, group] of Object.entries(data.whales || {})) {
  for (const p of (group.positions || [])) {
    const wallet = String(p.wallet || '').toLowerCase();
    const chain = String(p.chain || '').toLowerCase();
    const proto = String(p.protocol_canonical || p.protocol_name || p.protocol_id || '').toLowerCase();
    const usd = Number(p.net_usd || 0);
    const k1 = `${wallet}|${chain}`;
    const k2 = `${wallet}|${chain}|${proto}`;
    modeledByWalletChain.set(k1, (modeledByWalletChain.get(k1) || 0) + usd);
    modeledByWalletChainProtocol.set(k2, (modeledByWalletChainProtocol.get(k2) || 0) + usd);
  }
}

const report = [];
for (const w of (debank.wallets || [])) {
  const wallet = String(w.wallet || '').toLowerCase();
  for (const chainInfo of (w.chains || [])) {
    const chain = String(chainInfo.chain || '').toLowerCase();
    const debankUsd = Number(chainInfo.total_usd || 0);
    const modeledUsd = modeledByWalletChain.get(`${wallet}|${chain}`) || 0;
    const deltaUsd = debankUsd - modeledUsd;
    const protocols = [];
    for (const proto of (chainInfo.protocols || [])) {
      const pkey = String(proto.protocol_canonical || proto.protocol_id || proto.protocol_name || '').toLowerCase();
      const debankProtoUsd = Number(proto.net_usd || proto.total_usd || 0);
      const modeledProtoUsd = modeledByWalletChainProtocol.get(`${wallet}|${chain}|${pkey}`) || 0;
      const protoDelta = debankProtoUsd - modeledProtoUsd;
      if (Math.abs(protoDelta) > 100) {
        protocols.push({
          protocol: pkey,
          debank_usd: debankProtoUsd,
          modeled_usd: modeledProtoUsd,
          delta_usd: protoDelta
        });
      }
    }
    // Reduce noisy false positives:
    // - ignore inactive wallet+chain pairs under threshold
    // - ignore tiny DeBank traces / dust protocol mismatches
    // - keep only meaningful deltas
    const activeForScan = !!chainInfo.active_for_position_scan;
    const filteredProtocols = protocols
      .filter(p => Math.abs(p.delta_usd) > 5000)
      .filter(p => !(String(p.protocol || '').includes('merkl') && Math.abs(p.delta_usd) < 50000))
      .filter(p => !(String(p.protocol || '').includes('ethena') && debankUsd < 100000))
      .filter(p => !(String(p.protocol || '').includes('curve') && Math.abs(p.delta_usd) < 10000));

    const classification = !activeForScan
      ? 'below-threshold'
      : Math.abs(deltaUsd) < 5000 && filteredProtocols.length === 0
        ? 'aligned'
        : 'needs-review';

    report.push({
      wallet,
      whale: w.whale || null,
      chain,
      debank_usd: debankUsd,
      modeled_usd: modeledUsd,
      delta_usd: deltaUsd,
      active_for_position_scan: activeForScan,
      scan_threshold_usd: chainInfo.scan_threshold_usd || 50000,
      below_threshold: !activeForScan,
      classification,
      protocols_missing_or_misaligned: filteredProtocols.sort((a, b) => Math.abs(b.delta_usd) - Math.abs(a.delta_usd))
    });
  }
}

ensureDir(OUT);
fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), report }, null, 2));
console.log(`Wrote ${OUT}`);
console.log(`Wallet-chain checks: ${report.length}`);
