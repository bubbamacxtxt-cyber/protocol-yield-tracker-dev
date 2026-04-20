#!/usr/bin/env node
/**
 * Protocol Yield Tracker — DeBank Cloud Fetcher v3
 * Optimized: chain caching, balance pre-filter, CoinGecko token resolution
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');

const DEBANK_API = 'https://pro-openapi.debank.com';
const DEBANK_KEY = process.env.DEBANK_API_KEY;
const MIN_NET_USD = 50000;

// CoinGecko chain mapping
const CG_CHAINS = {
    eth: 'ethereum', arb: 'arbitrum-one', base: 'base', matic: 'polygon-pos',
    bsc: 'binance-smart-chain', avax: 'avalanche', op: 'optimistic-ethereum',
    mnt: 'mantle', plasma: 'plasma', ink: 'ink', xdai: 'xdai',
    mobm: 'moonbeam', scrl: 'scroll', bera: 'berachain', flr: 'flare',
    blast: 'blast', hyper: 'hyperevm', monad: 'monad'
};

function loadWallets() {
    const file = path.join(__dirname, '..', 'data', 'wallets.json');
    if (!fs.existsSync(file)) { console.error('Missing data/wallets.json'); process.exit(1); }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

let DEBANK_AVAILABLE = true;

async function api(endpoint, retries = 2) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30000);
            const res = await fetch(`${DEBANK_API}${endpoint}`, {
                headers: { 'Accept': 'application/json', 'AccessKey': DEBANK_KEY },
                signal: controller.signal
            });
            clearTimeout(timeout);
            if (res.status === 429 || res.status >= 500) {
                const retryAfter = res.headers.get('retry-after') || 5;
                console.warn(`DeBank ${res.status}, retrying in ${retryAfter}s...`);
                await new Promise(r => setTimeout(r, retryAfter * 1000 * attempt));
                continue;
            }
            if (!res.ok) throw new Error(`DeBank ${res.status}: ${await res.text()}`);
            return res.json();
        } catch (err) {
            if (attempt === retries) {
                if (err.name === 'AbortError') console.error('DeBank request timed out');
                else console.error(`DeBank error: ${err.message}`);
                DEBANK_AVAILABLE = false;
                return null;
            }
        }
    }
}

// --- Database ---
function initDB(dbPath) {
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE IF NOT EXISTS wallet_chains (
            address TEXT NOT NULL,
            chain TEXT NOT NULL,
            discovered_at TEXT DEFAULT (datetime('now')),
            refreshed_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (address, chain)
        );
        CREATE TABLE IF NOT EXISTS positions (
            id INTEGER PRIMARY KEY,
            wallet TEXT NOT NULL,
            chain TEXT NOT NULL,
            protocol_id TEXT NOT NULL,
            protocol_name TEXT,
            position_type TEXT,
            strategy TEXT,
            yield_source TEXT,
            health_rate REAL,
            net_usd REAL,
            asset_usd REAL,
            debt_usd REAL,
            position_index TEXT,
            debank_updated_at TEXT,
            scanned_at TEXT DEFAULT (datetime('now')),
            UNIQUE(wallet, chain, protocol_id, position_index)
        );
        CREATE TABLE IF NOT EXISTS position_tokens (
            id INTEGER PRIMARY KEY,
            position_id INTEGER REFERENCES positions(id),
            role TEXT NOT NULL, -- supply, borrow, reward
            symbol TEXT,
            real_symbol TEXT, -- from CoinGecko (fixes DeBank mislabels)
            real_name TEXT, -- from CoinGecko
            cg_id TEXT, -- CoinGecko ID
            address TEXT,
            amount REAL,
            price_usd REAL,
            value_usd REAL
        );
        CREATE TABLE IF NOT EXISTS token_registry (
            address TEXT NOT NULL,
            chain TEXT NOT NULL,
            symbol TEXT,
            real_symbol TEXT,
            real_name TEXT,
            cg_id TEXT,
            cg_price_usd REAL,
            source TEXT,
            last_checked TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (address, chain)
        );
    `);
    return db;
}

// --- Get Wallet Chains (always fresh, no caching) ---
async function getWalletChains(wallet) {
    try {
        const chains = await api(`/v1/user/used_chain_list?id=${wallet}`);
        return chains.map(c => c.id);
    } catch {
        return [];
    }
}

// --- Balance Pre-Filter ---
async function getChainBalance(wallet, chain) {
    try {
        const data = await api(`/v1/user/chain_balance?id=${wallet}&chain_id=${chain}`);
        return data.usd_value || 0;
    } catch { return 0; }
}

// --- CoinGecko Token Resolution (fallback for unknowns) ---
let cgCalls = 0; // module-level counter

async function resolveToken(chain, address, symbol) {
    const cgChain = CG_CHAINS[chain];
    if (!cgChain || !address || address.length < 10) return null;

    try {
        const res = await fetch(
            `https://api.coingecko.com/api/v3/coins/${cgChain}/contract/${address.toLowerCase()}`,
            { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) }
        );
        if (!res.ok) return null;
        const data = await res.json();
        return {
            cg_id: data.id,
            real_symbol: data.symbol?.toUpperCase(),
            real_name: data.name,
            cg_price_usd: data.market_data?.current_price?.usd || null
        };
    } catch { return null; }
}

// Look up token in registry. If not found, try CoinGecko and add to registry.
async function lookupToken(db, chain, address, symbol) {
    if (!address || address.length < 10) return null;

    // Check registry first
    const cached = db.prepare(
        'SELECT * FROM token_registry WHERE address = ? AND chain = ?'
    ).get(address.toLowerCase(), chain);
    if (cached) return cached;

    // Also check symbol-level match
    if (symbol) {
        const symMatch = db.prepare(
            "SELECT * FROM token_registry WHERE address = ? AND chain = 'global'"
        ).get(`sym:${symbol.toUpperCase()}`);
        if (symMatch) return symMatch;
    }

    // Unknown — ask CoinGecko
    cgCalls++;
    console.log(`    CoinGecko: ${symbol || address.slice(0,10)} (${chain})`);
    await new Promise(r => setTimeout(r, 3000)); // CoinGecko free tier: ~20/min
    const resolved = await resolveToken(chain, address, symbol);
    if (resolved) {
        // Add to registry
        db.prepare(`
            INSERT OR REPLACE INTO token_registry (address, chain, symbol, real_symbol, real_name, cg_id, cg_price_usd, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'coingecko')
        `).run(address.toLowerCase(), chain, symbol, resolved.real_symbol, resolved.real_name, resolved.cg_id, resolved.cg_price_usd);
        return {
            address: address.toLowerCase(), chain,
            symbol: symbol, real_symbol: resolved.real_symbol,
            real_name: resolved.real_name, cg_id: resolved.cg_id,
            cg_price_usd: resolved.cg_price_usd, source: 'coingecko'
        };
    }

    // CoinGecko failed too — use DeBank's symbol as-is
    return { address: address.toLowerCase(), chain, symbol, real_symbol: symbol, real_name: symbol, cg_id: null, source: 'debank' };
}

// --- Strategy Classification ---
function classifyStrategy(item, supplyUsd, borrowUsd, healthRate, protocolName) {
    const MONEY_MARKETS = ['aave', 'morpho', 'euler', 'spark', 'compound', 'fluid', 'venus'];
    const isMoneyMarket = MONEY_MARKETS.some(mm => (protocolName || '').toLowerCase().includes(mm));

    const type = item.name || '';
    if (type === 'Lending' || isMoneyMarket) {
        return borrowUsd > 0 ? 'loop' : 'lend';
    }
    if (type === 'Farming' || type === 'Leveraged Farming') return 'farm';
    if (type === 'Staked' || type === 'Locked') return 'stake';
    if (type === 'Liquidity Pool') return 'lp';
    return type.toLowerCase().replace(/ /g, '_') || 'unknown';
}

function getDisplayType(item, protocolName) {
    const MONEY_MARKETS = ['aave', 'morpho', 'euler', 'spark', 'compound', 'fluid', 'venus'];
    const isMoneyMarket = MONEY_MARKETS.some(mm => (protocolName || '').toLowerCase().includes(mm));
    if (isMoneyMarket) return 'Lending';
    return item.name || '?';
}

// Yield source = protocol name from DeBank (Ethena, Maple, Aave V3, etc.)
// No hardcoded token matching needed — DeBank identifies the protocol

// --- Main Scan ---
async function scanAll() {
    if (!DEBANK_KEY) { console.error('Missing DEBANK_API_KEY'); process.exit(1); }

    console.log('=== Protocol Yield Tracker v3 ===\n');
    cgCalls = 0;

    // Verify DeBank is available
    try {
        const unitsBefore = await api('/v1/account/units');
        if (unitsBefore) {
            console.log(`Units: ${unitsBefore.balance?.toLocaleString()}\n`);
        } else {
            console.error('DeBank API unavailable - skipping DeBank scan');
            console.error('Aave/Morpho/Euler scanners will still run separately');
        }
    } catch (err) {
        console.error('DeBank connectivity check failed:', err.message);
    }

    const db = initDB(path.join(__dirname, '..', 'yield-tracker.db'));

    const wallets = loadWallets();
    console.log(`Loaded ${wallets.length} wallets\n`);

    // Phase 1: Discover chains (cached)
    console.log('Phase 1: Discovering chains (cached)...\n');
    let chainDiscoveries = 0;
    const walletChains = {};
    for (const w of wallets) {
        const chains = await getWalletChains(w.address);
        walletChains[w.address] = chains;
        if (chains.length > 0) {
            console.log(`  ${w.address.slice(0,10)}...: ${chains.length} chains`);
        }
        await new Promise(r => setTimeout(r, 50));
    }
    console.log(`  (chain data cached in DB — refreshes monthly)\n`);

    // Phase 2: Balance pre-filter
    console.log('Phase 2: Balance pre-filtering...\n');
    const walletChainPairs = [];
    for (const [addr, chains] of Object.entries(walletChains)) {
        for (const chain of chains) {
            const balance = await getChainBalance(addr, chain);
            if (balance >= MIN_NET_USD) {
                walletChainPairs.push({ wallet: addr, chain, balance });
            }
            await new Promise(r => setTimeout(r, 50));
        }
    }
    console.log(`  ${walletChainPairs.length} wallet×chain pairs above $${(MIN_NET_USD/1000).toFixed(0)}K threshold\n`);

    // Phase 3: Full position scan
    console.log('Phase 3: Scanning positions...\n');
    const positions = [];
    let calls = 0;
    const scanStart = db.prepare("SELECT datetime('now') as t").get().t;

    for (const { wallet, chain } of walletChainPairs) {
        const short = wallet.slice(0, 10) + '...' + wallet.slice(-4);
        try {
            const data = await api(`/v1/user/complex_protocol_list?id=${wallet}&chain_id=${chain}`);
            calls++;

            if (!Array.isArray(data)) continue;

            for (const protocol of data) {
                for (const item of protocol.portfolio_item_list || []) {
                    const stats = item.stats || {};
                    const netUsd = stats.net_usd_value || 0;
                    if (netUsd < MIN_NET_USD) continue;

                    const detail = item.detail || {};
                    const assetTokens = item.asset_token_list || [];
                    const healthRate = detail.health_rate || null;

                    // Build supply/borrow from asset_token_list
                    const supplyTokens = [];
                    const borrowTokens = [];
                    for (const t of assetTokens) {
                        const amount = Math.abs(t.amount || 0);
                        const price = t.price || 0;
                        const addr = (t.id || '').toLowerCase();

                        // Lookup in registry, fallback to CoinGecko for unknowns
                        const resolved = await lookupToken(db, chain, addr, t.symbol);

                        const token = {
                            symbol: t.symbol || '?',
                            real_symbol: resolved?.real_symbol || t.symbol || '?',
                            real_name: resolved?.real_name || t.name || '?',
                            cg_id: resolved?.cg_id || null,
                            address: addr,
                            amount,
                            price,
                            cg_price: resolved?.cg_price_usd || null,
                            usd: amount * price,
                            source: resolved?.source || 'debank'
                        };

                        if ((t.amount || 0) > 0) supplyTokens.push(token);
                        else borrowTokens.push(token);
                    }

                    // Reward tokens
                    const rewardTokens = [];
                    for (const rt of (detail.reward_token_list || [])) {
                        const addr = (rt.id || '').toLowerCase();
                        const resolved = addr.length > 10 ? await lookupToken(db, chain, addr, rt.symbol) : null;
                        await new Promise(r => setTimeout(r, 100)); // Rate limit CoinGecko if needed
                        rewardTokens.push({
                            symbol: rt.symbol || '?',
                            real_symbol: resolved?.real_symbol || rt.symbol || '?',
                            cg_id: resolved?.cg_id || null,
                            amount: rt.amount || 0,
                            usd: rt.amount * (rt.price || 0)
                        });
                    }

                    const supplyUsd = supplyTokens.reduce((s, t) => s + t.usd, 0);
                    const borrowUsd = borrowTokens.reduce((s, t) => s + t.usd, 0);
                    const strategy = classifyStrategy(item, supplyUsd, borrowUsd, healthRate, protocol.name);
                    const displayType = getDisplayType(item, protocol.name);
                    const yieldSource = protocol.name || '?';

                    // Generate stable position_index from sorted supply token addresses
                    const stableIndex = supplyTokens
                        .map(t => t.address)
                        .filter(a => a && a.length > 10)
                        .sort()
                        .join(',') || `${wallet}_${chain}_${protocol.id}`;

                    // For Morpho: check if position_index looks like a market ID (hex hash)
                    let morphoMarketId = null;
                    if (protocol.id === 'morpho' && item.position_index) {
                      const idx = item.position_index;
                      // Morpho market IDs are 64-char hex strings
                      if (/^0x[0-9a-f]{64}$/i.test(idx)) {
                        morphoMarketId = idx;
                      } else if (/^[0-9a-f]{64}$/i.test(idx)) {
                        morphoMarketId = '0x' + idx;
                      }
                    }

                    // Save to DB
                    const posStmt = db.prepare(`
                        INSERT INTO positions (wallet, chain, protocol_id, protocol_name, position_type,
                            strategy, yield_source, health_rate, net_usd, asset_usd, debt_usd,
                            position_index, debank_updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(wallet, chain, protocol_id, position_index)
                        DO UPDATE SET
                            strategy=excluded.strategy, yield_source=excluded.yield_source,
                            health_rate=excluded.health_rate, net_usd=excluded.net_usd,
                            asset_usd=excluded.asset_usd, debt_usd=excluded.debt_usd,
                            scanned_at=datetime('now')
                    `);

                    const result = posStmt.run(
                        wallet, chain, protocol.id || '?', protocol.name || '?',
                        displayType, strategy, yieldSource,
                        healthRate ? Math.round(healthRate * 1000) / 1000 : null,
                        Math.round(netUsd * 100) / 100,
                        Math.round(supplyUsd * 100) / 100,
                        Math.round(borrowUsd * 100) / 100,
                        stableIndex,
                        item.update_at ? new Date(item.update_at * 1000).toISOString() : null
                    );

                    const posId = result.lastInsertRowid;

                    // Save Morpho market ID if captured from DeBank
                    if (morphoMarketId) {
                      try {
                        db.prepare(`
                          INSERT OR REPLACE INTO position_markets (position_id, protocol, chain, market_id, market_name, underlying_token, source)
                          VALUES (?, ?, ?, ?, ?, ?, ?)
                        `).run(posId, 'Morpho', chain, morphoMarketId, null, supplyTokens[0]?.address || null, 'debank-scan');
                      } catch (e) {}
                    }

                    // Save tokens (wrapped in try-catch for FK safety)
                    const tokStmt = db.prepare(`
                        INSERT INTO position_tokens (position_id, role, symbol, real_symbol, real_name, cg_id, address, amount, price_usd, value_usd)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `);
                    try {
                      const saveTokens = db.transaction((tokens, role) => {
                          for (const t of tokens) {
                              tokStmt.run(posId, role, t.symbol, t.real_symbol, t.real_name, t.cg_id, t.address, t.amount, t.price, t.usd);
                          }
                      });
                      saveTokens(supplyTokens, 'supply');
                      saveTokens(borrowTokens, 'borrow');
                      saveTokens(rewardTokens, 'reward');
                      
                      // Morpho fix: if debt_usd > 0 but no borrow tokens, query Morpho API
                      if (protocol.id === 'morpho' && borrowUsd > 0 && borrowTokens.length === 0 && stableIndex) {
                        const chainIdMap = { eth: 1, arb: 42161, base: 8453, mnt: 5000, plasma: 9745, sonic: 146, bsc: 56, op: 10 };
                        const morphoChainId = chainIdMap[chain] || 1;
                        try {
                          const mquery = JSON.stringify({ query: '{ marketById(marketId: "' + stableIndex + '", chainId: ' + morphoChainId + ') { loanAsset { symbol address } } }' });
                          const mres = await new Promise((res, rej) => {
                            const req = require('https').request({ hostname: 'api.morpho.org', path: '/graphql', method: 'POST', headers: { 'Content-Type': 'application/json' } }, r => {
                              let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch(e) { rej(e); } });
                            });
                            req.on('error', rej);
                            req.write(mquery);
                            req.end();
                          });
                          const loanSymbol = mres?.data?.marketById?.loanAsset?.symbol;
                          if (loanSymbol) {
                            tokStmt.run(posId, 'borrow', loanSymbol, loanSymbol, loanSymbol, null, null, 0, 0, borrowUsd);
                            console.log(`    Fixed Morpho: added borrow token ${loanSymbol} ($${(borrowUsd/1e6).toFixed(1)}M)`);
                          }
                        } catch (e) {
                          console.log(`    WARN: Morpho market lookup failed: ${e.message}`);
                        }
                      }
                    } catch (e) {
                      console.log(`    WARN: Token insert failed for posId ${posId}: ${e.message}`);
                    }

                    positions.push({
                        wallet, chain,
                        protocol: protocol.name || '?',
                        type: item.name || '?',
                        strategy,
                        yield_source: yieldSource,
                        health_rate: healthRate,
                        net_usd: Math.round(netUsd * 100) / 100,
                        supply: supplyTokens.map(t => `${t.real_symbol}(${t.amount.toLocaleString(undefined,{maximumFractionDigits:0})}=$${(t.usd/1e6).toFixed(1)}M)`),
                        borrow: borrowTokens.map(t => `${t.real_symbol}(${t.amount.toLocaleString(undefined,{maximumFractionDigits:0})}=$${(t.usd/1e6).toFixed(1)}M)`)
                    });
                }
            }
            await new Promise(r => setTimeout(r, 100));
        } catch (e) {
            calls++;
            console.error(`    ERROR ${wallet.slice(0,8)} ${chain}: ${e.message}`);
        }
    }

    // Save scan results
    const output = { positions, api_calls: calls, coingecko_calls: cgCalls, scanned_at: new Date().toISOString() };
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'debank-scan.json'), JSON.stringify(output, null, 2));

    // Clean up old positions (only after successful scan)
    // Must delete position_tokens first (foreign key constraint)
    const oldIds = db.prepare('SELECT id FROM positions WHERE scanned_at < ?').all(scanStart).map(r => r.id);
    if (oldIds.length > 0) {
      const idPlaceholders = oldIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM position_tokens WHERE position_id IN (${idPlaceholders})`).run(...oldIds);
      const deleted = db.prepare('DELETE FROM positions WHERE scanned_at < ?').run(scanStart).changes;
      console.log(`Cleaned ${deleted} old position entries (${oldIds.length} IDs, tokens deleted first)\n`);
    } else {
      console.log('No old positions to clean\n');
    }

    // Summary
    printSummary(positions);

    const unitsAfter = await api('/v1/account/units');
    const used = unitsBefore.balance - unitsAfter.balance;
    console.log(`\nUnits used: ${used} (remaining: ${unitsAfter.balance.toLocaleString()})`);
    console.log(`Cost: $${(used / 1000000 * 200).toFixed(2)}`);
    console.log(`CoinGecko lookups: ${cgCalls} (${cgCalls === 0 ? 'all tokens in registry' : 'new tokens discovered'})`);
    console.log(`\nDone. Saved to yield-tracker.db + data/debank-scan.json`);

    db.close();
}

function printSummary(positions) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`FOUND ${positions.length} positions >$${(MIN_NET_USD/1000).toFixed(0)}K`);
    console.log(`${'='.repeat(60)}\n`);

    const byProto = {};
    for (const p of positions) {
        if (!byProto[p.protocol]) byProto[p.protocol] = { count: 0, total: 0 };
        byProto[p.protocol].count++;
        byProto[p.protocol].total += p.net_usd;
    }
    console.log('BY PROTOCOL:');
    for (const [proto, info] of Object.entries(byProto).sort((a, b) => b[1].total - a[1].total)) {
        console.log(`  ${proto.padEnd(25)} ${info.count.toString().padStart(3)} positions  $${(info.total / 1e6).toFixed(1)}M`);
    }

    console.log('\nALL POSITIONS:');
    for (const p of positions.sort((a, b) => b.net_usd - a.net_usd)) {
        const w = p.wallet.slice(0, 6) + '...' + p.wallet.slice(-4);
        const hf = p.health_rate ? ` HF:${p.health_rate}` : '';
        console.log(`  ${w} | ${p.protocol.padEnd(15)} | ${p.chain.padEnd(8)} | ${p.type.padEnd(10)} ${p.strategy.padEnd(8)} | ${p.supply.join('+')} → ${p.borrow.join('+')}${hf}`);
    }
}

scanAll().catch(console.error);
