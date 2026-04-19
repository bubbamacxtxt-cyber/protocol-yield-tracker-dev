const path = require('path');
const DB_PATH = path.join(__dirname, 'yield-tracker.db');
const db = require('better-sqlite3')(DB_PATH);
const pos = db.prepare(`
  SELECT substr(p.wallet,1,10) as w, p.chain, pt.symbol, pt.role
  FROM position_tokens pt
  JOIN positions p ON pt.position_id = p.id
  WHERE p.wallet LIKE '0x502d222e%' AND p.protocol_name LIKE '%Aave%'
`).all();
pos.forEach(p => console.log(p.w, p.chain, p.role, p.symbol));
