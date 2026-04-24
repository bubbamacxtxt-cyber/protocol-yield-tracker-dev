const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');

const DEFI_LLAMA = 'https://yields.llama.fi/pools';

const POOLS = [
  { name: 'sUSDe', pool: '66985a81-9c51-46ca-9977-42b4fe7bc6df' },
  { name: 'syrupUSDT', pool: '1f4f9153-f8ce-42f1-993e-38e391cd4428' },
  { name: 'syrupUSDC', pool: 'f22d2f92-347c-4be4-89e8-5b8735853d96' },
  { name: 'OUSG', pool: '7436db9b-2872-46c8-81a2-da6baff902b7' },
  { name: 'reUSD', pool: 'cca4dedb-569c-49ab-b053-d48d8d41dfd4' },
  { name: 'reUSDe', pool: '0cac92be-caaa-4cec-8f5a-712629a588c8' },
  { name: 'apxUSD', pool: '3673122c-2d30-4636-b5e7-57ad51508043' },
  { name: 'sUSDu', pool: '7f980c43-5b87-4690-a11a-b0e8a5e37a63' },
  { name: 'apyUSD', pool: '9941f941-9574-41af-b001-6c9465b0b5e6' },
  { name: 'srUSDe', pool: '843be062-d836-43ef-9670-c78d6ecb60bf' },
  { name: 'jrNUSD', pool: '947928b7-c446-49d7-a378-392df37660f7' },
  { name: 'sNUSD', pool: 'a064d3a0-e0b0-42c2-8992-1358c950bc6d' },
  { name: 'upUSDC', pool: '6b6ddb24-adfd-449d-a21e-e029a102e318' },
  { name: 'USD3', pool: 'f8cd444e-d99f-4132-b234-fd3482bf8806' },
  { name: 'gUSDC', pool: '766b4c34-76b3-4a57-bbec-2c972ddf8b86' },
  // fUSDT / fUSDC: Fluid protocol wrappers. Owned by the Fluid scanner.
  // Per docs/TOKEN-RULES.md, protocol-specific wrappers never enter the YBS list.
  // { name: 'fUSDT', pool: '4e8cc592-c8d5-4824-8155-128ba521e903' },
  { name: 'sUSDai', pool: '712ce948-bd9e-4f4a-8916-b72c447f7578' },
  { name: 'siUSD', pool: '8fa2e60e-365a-41fc-8d50-fadde5041f94' },
  { name: 'sUSDf', pool: '0f67a08c-3f24-4a4b-963e-541f5a5c0364' },
  { name: 'USDG', pool: '8bc218ed-faf1-41e9-a636-2989e9f7e805' },
  { name: 'ynUSDx', pool: 'bc8b5474-015a-4af5-8d88-3b4b6155b56e' },
  { name: 'WOUSD', pool: '48d4d48f-7207-48e1-8884-4852098faa80' },
  { name: 'wsrUSD', pool: 'd646f32f-d5af-4e34-a29f-8ebeea6a8520' },
  { name: 'stcUSD', pool: 'bf6ca887-e357-49ec-8031-0d1a6141c455' },
  { name: 'sUSDa', pool: '282c70ef-5123-4873-a115-a96879183e4e' },
  { name: 'sfrxUSD', pool: '42523cca-14b0-44f6-95fb-4781069520a5' },
  // fUSDC: Fluid protocol wrapper. Owned by the Fluid scanner. See docs/TOKEN-RULES.md.
  // { name: 'fUSDC', pool: 'a20bf6f8-71af-49c6-a9d7-6f2abe5738c9' },
  { name: 'sUSDS', pool: 'd8c4eff5-c8a9-46fc-a888-057c4c668e72' },
  { name: 'sYUSD', pool: '392e2c0a-a086-46a3-841f-ca4d476eb5e1' },
  { name: 'dUSDC', pool: '20e45c3e-7de7-4d34-89e7-20858ecdf252' },
  { name: 'cUSDO', pool: 'b2ebf3c0-a173-4d61-959b-23405b7d4edb' },
  { name: 'alUSD', pool: '7565527d-6925-4e8d-8678-794999db45a5' },
  { name: 'sFRAX', pool: '55de30c3-bf9f-4d4e-9e0b-536a8ef5ab35' },
  { name: 'USTB', pool: '1910847a-f8b5-40ce-a1ab-1dafdded5fbb' },
  // InfiniFi Locked iUSD tranches — each tranche has its own address + APY.
  // Matched by address in token-discovery so tranches don't collide on ticker.
  { name: 'LIUSD-1W', pool: 'fef01bce-008a-43b0-85f9-5377a56411c4' },
  { name: 'LIUSD-4W', pool: 'a83398f6-9f44-4046-8e30-12bae393e54d' },
  { name: 'LIUSD-8W', pool: 'cda362c2-3822-4d0f-bc56-383bdc5ed3fc' },
  { name: 'LIUSD-13W', pool: '01def518-e633-4f6f-a497-e1e29deedd2b' },
];

// Optional token metadata for address-first matching in downstream enrichment.
// Addresses pulled from DeFiLlama underlyingTokens + known contract addresses.
// Protocol overrides: DeFiLlama labels Pendle PT/YT pools as "pendle",
// but the real issuer is the protocol that mints the token, not the DEX.
const TOKEN_META = {
  sUSDe: {
    addresses: ['0x9D39A5DE30e57443BfF2A8307A4256c8797A3497'],
    aliases: ['sUSDe'],
    protocol: 'ethena-usde',
  },
  syrupUSDT: {
    addresses: ['0x356B8D89C1E1239cbbb9dE4815c39a1474d5Ba7D'],
    aliases: ['syrupUSDT'],
    protocol: 'maple',
  },
  syrupUSDC: {
    addresses: ['0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b'],
    aliases: ['syrupUSDC'],
    protocol: 'jupiter-lend',
  },
  OUSG: {
    addresses: ['0x1b19c19393e2d034d8ff31ff34c81252fcbbee92'],
    aliases: ['OUSG'],
    protocol: 'ondo-yield-assets',
  },
  reUSD: {
    addresses: ['0x3eaa0f0f0a5d3d595ae4e4b0d27f439d01c3e7b2'],
    aliases: ['reUSD'],
    protocol: 're-protocol',
  },
  reUSDe: {
    addresses: ['0xddc0f880ff6e4e22e4b74632fbb43ce4df6ccc5a'],
    aliases: ['reUSDe'],
    protocol: 're-protocol',
  },
  apxUSD: {
    addresses: ['0x98a878b1cd98131b271883b390f68d2c90674665'],
    aliases: ['apxUSD'],
    protocol: 'apex-finance',
  },
  sUSDu: {
    addresses: ['9ckR7pPPvyPadACDTzLwK2ZAEeUJ3qGSnzPs8bVaHrSy'],
    aliases: ['sUSDu'],
    protocol: 'unitas',
  },
  apyUSD: {
    addresses: ['0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a'],
    aliases: ['apyUSD'],
    protocol: 'apex-finance',
  },
  srUSDe: {
    addresses: ['0x4c9EDD5852cd905f086C759E8383e09bff1E68B3'],
    aliases: ['srUSDe'],
    protocol: 'strata-markets',
  },
  jrNUSD: {
    addresses: ['0xE556ABa6fe6036275Ec1f87eda296BE72C811BCE'],
    aliases: ['jrNUSD'],
    protocol: 'strata-markets',
  },
  sNUSD: {
    addresses: ['0x6c65db1d88c8eda1e3debf2b2ef3d0ece8600466'],
    aliases: ['sNUSD'],
    protocol: 'nucleus',
  },
  USD3: {
    addresses: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
    aliases: ['USD3'],
    protocol: '3jane-lending',
  },
  gUSDC: {
    addresses: ['0x97c1a4ae3e0da8009aff13e3e3ee7ea5ee4afe84'],
    aliases: ['gUSDC'],
    protocol: 'gearn',
  },
  fUSDT: {
    addresses: ['0xdAC17F958D2ee523a2206206994597C13D831ec7'],
    aliases: ['fUSDT'],
    protocol: 'fluid-lending',
  },
  sUSDai: {
    addresses: ['0x46850aD61C2B7d64d08c9C754F45254596696984'],
    aliases: ['sUSDai'],
    protocol: 'usd-ai',
  },
  siUSD: {
    addresses: ['0x48f9e38f3070AD8945DFEae3FA70987722E3D89c'],
    aliases: ['siUSD'],
    protocol: 'infinifi',
  },
  'LIUSD-1W': {
    addresses: ['0x12b004719fb632f1e7c010c6f5d6009fb4258442'],
    aliases: ['liUSD-1W'],
    protocol: 'infinifi',
  },
  'LIUSD-4W': {
    addresses: ['0x66bcf6151d5558afb47c38b20663589843156078'],
    aliases: ['liUSD-4W'],
    protocol: 'infinifi',
  },
  'LIUSD-8W': {
    addresses: ['0xf68b95b7e851170c0e5123a3249dd1ca46215085'],
    aliases: ['liUSD-8W'],
    protocol: 'infinifi',
  },
  'LIUSD-13W': {
    // Address not in CoinGecko registry yet. Apply once known.
    addresses: [],
    aliases: ['liUSD-13W'],
    protocol: 'infinifi',
  },
  sUSDf: {
    addresses: ['0xFa2B947eEc368f42195f24F36d2aF29f7c24CeC2'],
    aliases: ['sUSDf'],
    protocol: 'falcon-finance',
  },
  USDG: {
    addresses: ['0xe343167631d89b6ffc58b88d6b7fb0228795491d'],
    aliases: ['USDG'],
    protocol: 'gearn',
  },
  ynUSDx: {
    addresses: ['0x3db228fe836d99ccb25ec4dfdc80ed6d2cddcb4b'],
    aliases: ['ynUSDx'],
    protocol: 'yieldnest',
  },
  WOUSD: {
    addresses: ['0x457842d6de59fa460da58bd2712532b7c27dc579'],
    aliases: ['WOUSD'],
    protocol: 'spectra-v2',
  },
  wsrUSD: {
    addresses: ['0x09D4214C03D01F49544C0448DBE3A27f768F2b34'],
    aliases: ['wsrUSD'],
    protocol: 'reservoir-protocol',
  },
  stcUSD: {
    addresses: ['0xcCcc62962d17b8914c62D74FfB843d73B2a3cccC'],
    aliases: ['stcUSD'],
    protocol: 'cap',
  },
  sUSDa: {
    addresses: ['0x118078288f681389070a9d89d6832b302216ace3'],
    aliases: ['sUSDa'],
    protocol: 'avantis',
  },
  sfrxUSD: {
    addresses: ['0xCAcd6fd266aF91b8AeD52aCCc382b4e165586E29'],
    aliases: ['sfrxUSD'],
    protocol: 'frax',
  },
  fUSDC: {
    addresses: ['0x58D97B57BB95320F9a05dC918Aef65434969c2B2'],
    aliases: ['fUSDC'],
    protocol: 'merkl',
  },
  sUSDS: {
    addresses: ['0xdC035D45d973E3EC169d2276DDab16f1e407384F'],
    aliases: ['sUSDS'],
    protocol: 'sky-lending',
  },
  sYUSD: {
    addresses: ['0xfe0ccc9942e98c963fe6b4e5194eb6e3baa4cb64'],
    aliases: ['sYUSD'],
    protocol: 'yield-protocol',
  },
  dUSDC: {
    addresses: ['0x1e33e98af620f1d563fcd3cfd3c75ace841204ef'],
    aliases: ['dUSDC'],
    protocol: 'dolomite',
  },
  cUSDO: {
    addresses: ['0x67aeeed39c1675e0df93ad8bab543b17992d433b'],
    aliases: ['cUSDO'],
    protocol: 'usdo',
  },
  alUSD: {
    addresses: [],
    aliases: ['alUSD'],
    protocol: 'lagoon',
  },
  sFRAX: {
    addresses: ['0x853d955acef822db058eb8505911ed77f175b99e'],
    aliases: ['sFRAX'],
    protocol: 'frax',
  },
  USTB: {
    addresses: ['0x43415eB6Ff9DB7E26A15b704E7A3eDCe97d31C4e'],
    aliases: ['USTB'],
    protocol: 'superstate-ustb',
  },
};


async function main() {
  console.log('Fetching DeFiLlama yields...');
  
  // Vaults fetched from alternative APIs (not in DeFiLlama YBS list)
  const AUGUST_DIGITAL_VAULTS = [
    { name: 'upGAMMAusdc', address: '0x998D7b14c123c1982404562b68edDB057b0477cB', chain: 'Ethereum' },
  ];
  
  const res = await fetch(DEFI_LLAMA);
  if (!res.ok) throw new Error(`DeFiLlama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const pools = data.data || data;
  
  const stables = [];
  
  for (const target of POOLS) {
    const pool = pools.find(p => p.pool === target.pool);
    if (pool && pool.apy != null) {
      stables.push({
        name: target.name,
        protocol: TOKEN_META[target.name]?.protocol || pool.project || 'Unknown',
        apr: pool.apy.toFixed(2) + '%',
        aprValue: pool.apy,
        apy_1d: pool.apy,
        apy_7d: null,
        apy_30d: null,
        _poolId: target.pool,
        chain: pool.chain || 'N/A',
        tvl: pool.tvlUsd >= 1e6 ? "$" + (pool.tvlUsd / 1e6).toFixed(0) + "M" : pool.tvlUsd >= 1e3 ? "$" + (pool.tvlUsd / 1e3).toFixed(0) + "K" : "N/A",
        tvlNum: pool.tvlUsd || 0,
        source: 'defillama',
        addresses: TOKEN_META[target.name]?.addresses || [],
        aliases: TOKEN_META[target.name]?.aliases || [target.name],
      });
      console.log(`  ✅ ${target.name}: ${pool.apy.toFixed(2)}% (${pool.chain}, $${(pool.tvlUsd / 1e6).toFixed(0)}M)`);
    } else {
      console.log(`  ❌ ${target.name}: pool not found or no APY`);
    }
  }
  
  // 30d: apyMean30d (real 30-day average from main pools response)
  // 7d: apy - apyPct7D (estimated 7-day-ago APY from change delta)
  for (const s of stables) {
    const pool = pools.find(p => p.pool === s._poolId);
    if (pool) {
      s.apy_30d = pool.apyMean30d || null;
      if (pool.apyPct7D != null) {
        s.apy_7d = pool.apy - pool.apyPct7D;
      }
    }
    // Keep _poolId for history tracking
  }
  
  // --- APY History Tracking ---
  const db = new Database(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS stable_apy_history (
    pool_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    apy REAL NOT NULL,
    tvl_usd REAL,
    PRIMARY KEY (pool_id, timestamp)
  )`);
  
  const insertHist = db.prepare(`INSERT OR IGNORE INTO stable_apy_history (pool_id, timestamp, apy, tvl_usd) VALUES (?, ?, ?, ?)`);
  const ts = new Date().toISOString();
  const insertMany = db.transaction((rows) => {
    for (const r of rows) insertHist.run(r.pool_id, ts, r.apy, r.tvl_usd);
  });
  const historyRows = stables.filter(s => s._poolId && s.apy_1d != null).map(s => ({
    pool_id: s._poolId,
    apy: s.apy_1d,
    tvl_usd: s.tvlNum || null,
  }));
  if (historyRows.length) insertMany(historyRows);
  
  // Compute 7d average from our own history
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const history7d = db.prepare(`
    SELECT pool_id, AVG(apy) as avg_apy, COUNT(*) as points
    FROM stable_apy_history
    WHERE timestamp >= ?
    GROUP BY pool_id
  `).all(sevenDaysAgo);
  db.close();
  
  const historyMap = new Map(history7d.map(h => [h.pool_id, { avg: h.avg_apy, points: h.points }]));
  
  for (const s of stables) {
    if (s._poolId) {
      const hist = historyMap.get(s._poolId);
      if (hist && hist.points >= 4) {  // Need at least 4 snapshots (~1 day) for 7d avg
        s.apy_7d = hist.avg;
      } else {
        s.apy_7d = null;  // Not enough history yet
      }
    }
    delete s._poolId;
  }
  
  console.log('  📊 APY history: saved ' + historyRows.length + ' snapshots, 7d avg from ' + history7d.length + ' pools');
  
  // Add August Digital vault entries (Upshift etc.)
  for (const v of AUGUST_DIGITAL_VAULTS) {
    try {
      const res = await fetch(`https://api.augustdigital.io/api/v1/tokenized_vault/${v.address}`);
      if (res.ok) {
        const data = await res.json();
        const apy30 = (data.historical_apy?.['30'] || 0) * 100;
        const apy7 = (data.historical_apy?.['7'] || 0) * 100;
        const apy1 = (data.historical_apy?.['1'] || 0) * 100;
        const tvl = data.latest_reported_tvl || 0;
        stables.push({
          name: v.name,
          protocol: 'Upshift',
          apr: apy30.toFixed(2) + '%',
          aprValue: apy30,
          apy_1d: apy1,
          apy_7d: apy7,
          apy_30d: apy30,
          chain: v.chain,
          tvl: tvl >= 1e6 ? "$" + (tvl / 1e6).toFixed(0) + "M" : tvl >= 1e3 ? "$" + (tvl / 1e3).toFixed(0) + "K" : "N/A",
          tvlNum: tvl,
          source: 'augustdigital',
        });
        console.log(`  📡 ${v.name}: 30d=${apy30.toFixed(2)}% 7d=${apy7.toFixed(2)}% 1d=${apy1.toFixed(2)}% (${v.chain})`);
      } else {
        console.log(`  ❌ ${v.name}: augustdigital API ${res.status}`);
      }
    } catch(e) {
      console.log(`  ❌ ${v.name}: ${e.message}`);
    }
  }


  const outPath = path.join(__dirname, '..', 'data', 'stables.json');
  fs.writeFileSync(outPath, JSON.stringify({
    stables,
    fetched_at: new Date().toISOString(),
  }, null, 2));
  
  console.log(`\nSaved ${stables.length} stables to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
