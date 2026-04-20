#!/usr/bin/env node
const data = require('/home/node/.openclaw/workspace/protocol-yield-tracker-dev/data.json');
const issues = [], warnings = [];

console.log('=== Full Audit ===\n');

// 1. Whale coverage
console.log('--- Whale Coverage ---');
for (const [name, whale] of Object.entries(data.whales)) {
  const count = whale.positions?.length || 0;
  const total = whale.positions?.reduce((s, p) => s + (p.net_usd || 0), 0) || 0;
  if (count === 0) issues.push(`${name}: 0 positions`);
  console.log(count === 0 ? `  ❌ ${name}: 0 positions` : `  ✅ ${name}: ${count} positions, $${(total/1e6).toFixed(0)}M`);
}

// 2. Merkl bonus - verify leverage APY matches formula
console.log('\n--- Merkl Bonuses ---');
let bonusCount = 0;
for (const [name, whale] of Object.entries(data.whales)) {
  for (const p of whale.positions) {
    if (p.bonus_supply == null) continue;
    bonusCount++;
    if (p.leverage > 1.1 && p.debt_usd > 0 && p.asset_usd > 0) {
      const supplyApy = (p.apy_base || 0) + p.bonus_supply;
      const borrowApy = p.apy_cost || 15;
      const equity = p.asset_usd - p.debt_usd;
      if (equity > 0) {
        const expected = ((p.asset_usd * supplyApy/100 - p.debt_usd * borrowApy/100) / equity) * 100;
        if (Math.abs(p.apy_net - expected) > 1) {
          issues.push(`${name}: APY calc error. Expected ${expected.toFixed(1)}%, got ${p.apy_net?.toFixed(1)}%`);
        }
      }
    }
  }
}
console.log(`  ${bonusCount} positions with Merkl bonuses`);

// 3. sUSDe - no bonus
console.log('\n--- sUSDe Check ---');
let ok = true;
for (const [name, whale] of Object.entries(data.whales)) {
  for (const p of whale.positions) {
    for (const t of (p.supply || [])) {
      if (t.symbol?.includes('sUSDe') && t.bonus_supply_apy != null) {
        issues.push(`${name}: sUSDe has bonus`); ok = false;
      }
    }
  }
}
if (ok) console.log('  ✅ No sUSDe bonuses');

// Total TVL
let totalTVL = 0;
for (const w of Object.values(data.whales)) totalTVL += w.positions.reduce((s, p) => s + (p.net_usd || 0), 0);
console.log(`\n--- Total TVL: $${(totalTVL/1e6).toFixed(0)}M ---`);

console.log(`\n=== Summary: ${issues.length} issues, ${warnings.length} warnings ===`);
if (issues.length) { console.log('\n❌ ISSUES:'); issues.forEach(i => console.log(`  - ${i}`)); }
else console.log('\n✅ No issues found');
