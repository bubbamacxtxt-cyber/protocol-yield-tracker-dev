const Database = require('better-sqlite3');
const db = new Database('/home/node/.openclaw/workspace/protocol-yield-tracker-dev/yield-tracker.db');

// Get all Reservoir positions
const positions = db.prepare(
  "SELECT p.wallet, p.protocol_name, p.position_index, pt.symbol, pt.address, pt.apy_base, pt.bonus_supply_apy, pt.amount, pt.real_name " +
  "FROM positions p JOIN position_tokens pt ON pt.position_id = p.id"
).all();

const reservoir = positions.filter(p => 
  p.wallet.startsWith('0x289c') || 
  p.wallet.startsWith('0x31ea') || 
  p.wallet.startsWith('0x99a9') ||
  p.wallet.startsWith('0x3063')
);

console.log('Reservoir positions in DB:\n');
for (const p of reservoir) {
  console.log('Wallet:', p.wallet);
  console.log('  Protocol:', p.protocol_name);
  console.log('  Symbol:', p.symbol);
  console.log('  Real name:', p.real_name);
  console.log('  Token address:', p.address);
  console.log('  Position index:', p.position_index);
  console.log('  APY base:', p.apy_base, '| bonus:', p.bonus_supply_apy);
  console.log('  Amount:', p.amount);
  console.log();
}
