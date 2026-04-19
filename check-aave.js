const db = require('better-sqlite3')('yield-tracker.db');

const wallet = '0x3063c5907faa10c01b242181aa689beb23d2bd65';

const pos = db.prepare("SELECT id, chain, net_usd, asset_usd FROM positions WHERE wallet = ? AND protocol_name LIKE '%Aave%' AND chain IN ('plasma', 'mnt')").all(wallet);
console.log('Positions:', pos);

for (const p of pos) {
  const tokens = db.prepare('SELECT * FROM position_tokens WHERE position_id = ?').all(p.id);
  console.log('Tokens for pos', p.id, ':', tokens);
  const market = db.prepare('SELECT * FROM position_markets WHERE position_id = ?').all(p.id);
  console.log('Market for pos', p.id, ':', market);
}
