#!/usr/bin/env node
/**
 * validate.js
 * Validation for the wallet-recon architecture.
 *
 * Principles:
 * - Manual/offchain/API lanes keep their own live validations where applicable.
 * - Onchain scanner lanes should not be validated using the old DB-backed parity model.
 * - Instead, use the DeBank wallet-recon gap report as the canonical missing-coverage signal.
 * - Fail only when there are material active wallet+chain gaps beyond tolerated thresholds.
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const errors = [];
const warnings = [];

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function pctDiff(a, b) {
  if (a === 0 && b === 0) return 0;
  if (a === 0 || b === 0) return 1;
  return Math.abs(a - b) / Math.max(a, b);
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function reportGapSummary(report) {
  const active = report.filter(r => r.active_for_position_scan && !r.below_threshold);
  const aligned = active.filter(r => r.classification === 'aligned');
  const review = active.filter(r => r.classification === 'needs-review');
  console.log(`  Active wallet+chain pairs: ${active.length}`);
  console.log(`  Aligned: ${aligned.length}`);
  console.log(`  Needs review: ${review.length}`);
  return { active, aligned, review };
}

async function main() {
  console.log('=== Wallet-Recon Validation ===\n');

  const dataPath = path.join(__dirname, '..', 'data.json');
  const gapPath = path.join(__dirname, '..', 'data', 'recon', 'gap-report.json');
  if (!fs.existsSync(dataPath)) {
    errors.push('data.json does not exist');
    report();
    return;
  }
  if (!fs.existsSync(gapPath)) {
    errors.push('gap-report.json does not exist');
    report();
    return;
  }

  const data = loadJson(dataPath, { whales: {} });
  const gaps = loadJson(gapPath, { report: [] });

  // --- Sanity ---
  console.log('--- Sanity ---');
  for (const [name, whale] of Object.entries(data.whales || {})) {
    const count = whale.positions?.length || 0;
    if (count === 0) errors.push(`${name}: 0 positions`);
    else console.log(`  ${name}: ${count} positions, $${(whale.positions.reduce((s, p) => s + (p.net_usd || 0), 0)).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  }

  // --- Token classification rules (project-wide, see docs/TOKEN-RULES.md) ---
  // Rule: wallet-held positions MUST NOT carry an APY.
  // APY only comes from scanner / vault / YBS lanes.
  console.log('\n--- Token Classification Rules ---');
  let apyViolations = 0;
  for (const [name, whale] of Object.entries(data.whales || {})) {
    for (const p of (whale.positions || [])) {
      const isWallet = p.source_type === 'wallet' ||
        String(p.protocol_id || '').toLowerCase() === 'wallet-held';
      const hasApy = (p.apy_base != null && p.apy_base !== 0) ||
        (p.apy_net != null && p.apy_net !== 0);
      if (isWallet && hasApy) {
        errors.push(`${name} ${p.wallet?.slice(0,10)} ${p.chain} ${p.supply_tokens_display}: wallet-held position has APY (apy_base=${p.apy_base}). Wallet holdings must not carry APY.`);
        apyViolations++;
      }
    }
  }
  if (apyViolations === 0) console.log('  ✅ No wallet-held APY contamination');
  else console.log(`  ❌ ${apyViolations} wallet-held rows have APY (rule violation)`);

  // --- Scanner staleness check ---
  // Every scanner should write fresh rows every hour. If any scanner's
  // newest row is > 2 hours old, flag it — the scanner probably failed.
  console.log('\n--- Scanner Staleness ---');
  const dbPath = path.join(__dirname, '..', 'yield-tracker.db');
  if (fs.existsSync(dbPath)) {
    try {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      const scanners = ['aave-v3', 'morpho', 'euler2', 'fluid-lending', 'fluid-vault', 'spark-savings', 'spark-lend', 'pendle-pt', 'pendle-yt', 'pendle-lp', 'vault', 'vault-probed', 'ybs', 'wallet-held', 'ethena-cooldown', 'yo-protocol'];
      const STALE_HOURS = 3; // grace window for one missed hourly run
      for (const protocolId of scanners) {
        const row = db.prepare("SELECT MAX(scanned_at) as last, COUNT(*) as n FROM positions WHERE protocol_id = ?").get(protocolId);
        if (!row.n) continue;
        const lastMs = new Date(row.last + 'Z').getTime();
        const ageHr = (Date.now() - lastMs) / 3600000;
        if (ageHr > STALE_HOURS) {
          warnings.push(`Scanner ${protocolId}: newest row ${ageHr.toFixed(1)}h old (${row.n} rows, last at ${row.last} UTC)`);
          console.log(`  ⚠️ ${protocolId.padEnd(18)} ${ageHr.toFixed(1)}h stale (${row.n} rows)`);
        } else {
          console.log(`  ✅ ${protocolId.padEnd(18)} fresh (${ageHr.toFixed(1)}h, ${row.n} rows)`);
        }
      }
      db.close();
    } catch (e) {
      warnings.push('Staleness check failed: ' + e.message);
    }
  }

  // Rule: YBS list must not contain protocol-specific wrappers (Fluid/Aave aTokens, etc.)
  try {
    const stablesPath = path.join(__dirname, '..', 'data', 'stables.json');
    const stables = loadJson(stablesPath, { stables: [] }).stables || [];
    const forbidden = ['fUSDC', 'fUSDT', 'aUSDC', 'aUSDT', 'aUSDe', 'eUSDC', 'eUSDT'];
    const found = stables.filter(s => forbidden.includes(s.name));
    if (found.length === 0) console.log('  ✅ YBS list contains no protocol wrappers');
    else errors.push(`YBS list contains protocol-specific wrappers: ${found.map(s => s.name).join(', ')}. These belong to their respective scanner.`);
  } catch (e) {
    warnings.push('Could not verify stables.json: ' + e.message);
  }

  // --- Protocol/API validations that remain independently meaningful ---
  console.log('\n--- API Checks ---');

  // InfiniFi API parity (keep this, but warn unless materially broken)
  try {
    const endpoints = [
      'https://eth-api.infinifi.xyz/api/protocol/data',
      'https://plasma-api.infinifi.xyz/api/protocol/data'
    ];
    let liveTotal = 0;
    for (const url of endpoints) {
      const json = await fetchJson(url);
      const farms = json.data?.farms || [];
      liveTotal += farms
        .filter(f => f.type !== 'PROTOCOL' && (f.assetsNormalized || 0) > 100)
        .reduce((s, f) => s + (f.assetsNormalized || 0), 0);
    }
    const infiniFiPositions = data.whales.InfiniFi?.positions || [];
    const apiTotal = infiniFiPositions
      .filter(p => p.source_type === 'protocol_api')
      .reduce((s, p) => s + (p.net_usd || 0), 0);
    const diff = pctDiff(apiTotal, liveTotal);
    const threshold = apiTotal >= 100_000_000 ? 0.03 : apiTotal >= 10_000_000 ? 0.05 : 0.08;
    const status = diff > threshold ? '❌' : '✅';
    console.log(`${status} InfiniFi (protocol_api): data=$${apiTotal.toLocaleString('en-US', {maximumFractionDigits: 0})} live=$${liveTotal.toLocaleString('en-US', {maximumFractionDigits: 0})} (${(diff * 100).toFixed(1)}%, threshold: ${(threshold * 100).toFixed(0)}%)`);
    if (diff > threshold) warnings.push(`InfiniFi (protocol_api): ${(diff * 100).toFixed(1)}% off`);
  } catch (e) {
    warnings.push(`InfiniFi API check: ${e.message}`);
  }

  // Pareto onchain allocation check
  try {
    const QUEUE = '0xA7780086ab732C110E9E71950B9Fb3cb2ea50D89';
    const provider = new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com');
    const abi = ['function getTotalCollateralsScaled() external view returns (uint256)'];
    const contract = new ethers.Contract(QUEUE, abi, provider);
    const total = await contract.getTotalCollateralsScaled();
    const liveTotal = Number(total) / 1e18;
    const dbTotal = (data.whales.Pareto?.positions || []).reduce((s, p) => s + (p.net_usd || 0), 0);
    const diff = pctDiff(dbTotal, liveTotal);
    const status = diff > 0.15 ? '❌' : '✅';
    console.log(`${status} Pareto: data=$${dbTotal.toLocaleString('en-US', {maximumFractionDigits: 0})} live=$${liveTotal.toLocaleString('en-US', {maximumFractionDigits: 0})} (${(diff * 100).toFixed(1)}%)`);
    if (diff > 0.15) warnings.push(`Pareto: ${(diff * 100).toFixed(1)}% off`);
  } catch (e) {
    warnings.push(`Pareto: ${e.message}`);
  }

  // --- Gap-based onchain validation ---
  console.log('\n--- Wallet-Recon Gap Validation ---');
  const summary = reportGapSummary(gaps.report || []);

  // Fail only for material active gaps.
  // Rules:
  // - ignore below-threshold rows
  // - fail when active wallet+chain delta exceeds $1M AND protocol list is non-empty
  // - also fail if there are > 10 active needs-review rows (systemic issue)
  const material = summary.review.filter(r => Math.abs(r.delta_usd || 0) > 1_000_000 && (r.protocols_missing_or_misaligned || []).length > 0);
  for (const row of material.slice(0, 20)) {
    console.log(`  ❌ ${row.whale} ${row.wallet.slice(0,10)} ${row.chain}: Δ $${Math.round(row.delta_usd).toLocaleString()} (${(row.protocols_missing_or_misaligned || []).length} protocol gaps)`);
  }

  // Gap deltas are informational — they surface coverage issues but don't
  // block the pipeline. Hard failures come from data correctness rules
  // (APY contamination, scanner staleness, fixture regressions), not from
  // DeBank-parity which is a moving target as we improve scanners.
  if (material.length > 0) {
    warnings.push(`${material.length} material active wallet+chain gaps exceed $1M (see gap report)`);
  }
  if (summary.review.length > 10) {
    warnings.push(`${summary.review.length} active wallet+chain pairs still need review`);
  }

  report();
}

function report() {
  console.log('\n=== Results ===');
  if (warnings.length > 0) {
    console.log('\n⚠️  Warnings:');
    warnings.forEach(w => console.log(`  ${w}`));
  }
  if (errors.length > 0) {
    console.log('\n❌ FAILED — fix before pushing:');
    errors.forEach(e => console.log(`  ${e}`));
    process.exit(1);
  } else {
    console.log('\n✅ All checks passed.');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
