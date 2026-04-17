const db = require('better-sqlite3')('yield-tracker.db');

// Check Aave positions with tokens
const withTokens = db.prepare(`
  SELECT p.id, p.wallet, p.chain, COUNT(pt.id) as token_count
  FROM positions p
  JOIN position_tokens pt ON pt.position_id = p.id
  WHERE p.protocol_name LIKE '%Aave%'
  GROUP BY p.id
`).all();

console.log('Aave positions with tokens:', withTokens.length);
for (const r of withTokens) {
  console.log(r.wallet.slice(0,10), r.chain, r.token_count, 'tokens');
}
