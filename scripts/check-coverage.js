#!/usr/bin/env node
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'yield-tracker.db'));
const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'recon', 'debank-wallet-summary.json'), 'utf8'));
const whales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));

const allWallets = new Map();
for (const [name, cfg] of Object.entries(whales)) {
  const ws = Array.isArray(cfg) ? cfg : (cfg.vaults ? Object.values(cfg.vaults).flat() : []);
  for (const w of ws) allWallets.set(w.toLowerCase(), name);
}

const debankByWallet = {};
for (const w of s.wallets) {
  let t = 0;
  for (const c of (w.chains || [])) t += c.total_usd || 0;
  debankByWallet[w.wallet.toLowerCase()] = t;
}

const ourByWallet = {};
const rows = db.prepare('SELECT lower(wallet) as w, SUM(net_usd) as n FROM positions GROUP BY lower(wallet)').all();
for (const r of rows) ourByWallet[r.w] = r.n || 0;

const byWhale = {};
for (const [w, whale] of allWallets) {
  const d = debankByWallet[w] || 0;
  const o = ourByWallet[w] || 0;
  if (!byWhale[whale]) byWhale[whale] = { d: 0, o: 0 };
  byWhale[whale].d += d;
  byWhale[whale].o += o;
}

console.log('Whale         | DeBank    | Ours      | Delta     | %');
console.log('-'.repeat(70));
let tD = 0, tO = 0;
for (const [name, v] of Object.entries(byWhale).sort((a, b) => b[1].d - a[1].d)) {
  tD += v.d; tO += v.o;
  const pct = v.d > 0 ? (v.o / v.d * 100).toFixed(0) : '-';
  console.log('  ' + name.padEnd(13), '$' + (v.d / 1e6).toFixed(2).padStart(7) + 'M', '$' + (v.o / 1e6).toFixed(2).padStart(7) + 'M', '$' + ((v.o - v.d) / 1e6).toFixed(2).padStart(7) + 'M', pct + '%');
}
console.log('-'.repeat(70));
console.log('  TOTAL        $' + (tD / 1e6).toFixed(2).padStart(7) + 'M  $' + (tO / 1e6).toFixed(2).padStart(7) + 'M  $' + ((tO - tD) / 1e6).toFixed(2).padStart(7) + 'M  ' + (tO / tD * 100).toFixed(0) + '%');
db.close();
