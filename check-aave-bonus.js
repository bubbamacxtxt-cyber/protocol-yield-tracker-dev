const db = require('better-sqlite3')('yield-tracker.db');

const pos = db.prepare(`
  SELECT p.id, p.chain, pt.symbol, pt.apy_base, pt.bonus_supply_apy, pt.value_usd
  FROM positions p
  JOIN position_tokens pt ON pt.position_id = p.id
  WHERE p.protocol_name LIKE '%Aave%' AND pt.role = 'supply'
  AND p.chain IN ('plasma', 'mnt')
  LIMIT 10
`).all();

console.log('Aave positions with tokens:');
for (const p of pos) {
  console.log(p.chain, p.symbol, 'apy:', p.apy_base?.toFixed(2), 'bonus:', p.bonus_supply_apy?.toFixed(2), '$'+(p.value_usd/1e6).toFixed(1)+'M');
}
