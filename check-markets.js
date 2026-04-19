const db = require('better-sqlite3')('yield-tracker.db');

// Find ALL USDe Aave positions with their wallets
const pos = db.prepare(`
  SELECT substr(p.wallet, 1, 10) as wallet, p.chain, pt.symbol, pt.apy_base, pt.bonus_supply_apy, pm.market_name
  FROM position_tokens pt
  JOIN positions p ON pt.position_id = p.id
  LEFT JOIN position_markets pm ON pm.position_id = p.id
  WHERE pt.symbol IN ('USDe', 'sUSDe') AND p.protocol_name LIKE '%Aave%'
  ORDER BY p.wallet, p.chain
`).all();
console.log('ALL USDe Aave positions:');
for (const p of pos) {
  console.log(p.wallet, p.chain, p.symbol, 'market:', p.market_name, 'bonus:', p.bonus_supply_apy);
}
