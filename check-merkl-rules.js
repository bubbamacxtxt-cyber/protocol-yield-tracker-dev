const db = require('better-sqlite3')('yield-tracker.db');

// Check all wallets with USDe positions and their borrows
const wallets = ['0xc468315a', '0x0fe15b65', '0x502d222e', '0x68e7e729', '0xd6c75704', '0x6f64630a', '0xcf0a12cb', '0xb6cbe8b1'];

for (const w of wallets) {
  const tokens = db.prepare(`
    SELECT p.chain, pt.symbol, pt.role
    FROM position_tokens pt
    JOIN positions p ON pt.position_id = p.id
    WHERE p.wallet LIKE ? AND p.protocol_name LIKE '%Aave%'
  `).all(w + '%');
  
  const supplies = tokens.filter(t => t.role === 'supply').map(t => t.symbol);
  const borrows = tokens.filter(t => t.role === 'borrow').map(t => t.symbol);
  const hasUSDe = supplies.includes('USDe') || supplies.includes('sUSDe');
  const hasBorrow = borrows.some(b => b.includes('USDC') || b.includes('USDT'));
  
  if (hasUSDe) {
    console.log(w, 'supply:', supplies.join(','), 'borrow:', borrows.join(','), 'hasBorrow:', hasBorrow);
  }
}
