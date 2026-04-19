const db = require('better-sqlite3')('yield-tracker.db');

// Check USDe tokens
const tokens = db.prepare("SELECT pt.symbol, pt.apy_base, pt.bonus_supply_apy, pt.bonus_supply_source FROM position_tokens pt WHERE pt.symbol IN ('USDe', 'sUSDe', 'syrupUSDT', 'syrupUSDC')").all();
console.log('Tokens:', tokens);

// Check Merkl bonuses
const bonuses = db.prepare("SELECT * FROM position_tokens WHERE bonus_supply_apy IS NOT NULL").all();
console.log('\nAll bonuses:', bonuses.length);
for (const b of bonuses) {
  console.log(b.symbol, b.bonus_supply_apy, b.bonus_supply_source);
}
