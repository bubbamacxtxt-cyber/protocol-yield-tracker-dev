#!/usr/bin/env node
/**
 * Protocol Yield Tracker — Data Export (Multi-Whale)
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const https = require('https');
const OUT_PATH = path.join(__dirname, '..', 'data.json');

// Whale definitions loaded from data/whales.json
const WHALES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'whales.json'), 'utf8'));

// Fetch Euler V2 APYs from DeFiLlama
function fetchEulerAPYs() {
    return new Promise((resolve) => {
        https.get('https://yields.llama.fi/pools', { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const pools = JSON.parse(data).data;
                    const euler = pools.filter(p => p.project === 'euler-v2' && p.chain === 'Ethereum');
                    const apyBySymbol = {};
                    for (const p of euler) {
                        const sym = p.symbol?.toUpperCase();
                        if (sym && (!apyBySymbol[sym] || p.tvlUsd > apyBySymbol[sym].tvlUsd)) {
                            apyBySymbol[sym] = { apyBase: p.apyBase || 0, apyReward: p.apyReward || 0, apy: p.apy || 0, tvlUsd: p.tvlUsd };
                        }
                    }
                    resolve(apyBySymbol);
                } catch(e) { resolve({}); }
            }).on('error', () => resolve({}));
        });
    });
}

async function main() {
    const db = new Database(DB_PATH, { readonly: true });
    let eulerApys = {};
    
    // Fetch Euler APYs
    try {
        const https = require('https');
        const data = await new Promise((resolve, reject) => {
            https.get('https://yields.llama.fi/pools', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, res => {
                let d = '';
                res.on('data', chunk => d += chunk);
                res.on('end', () => resolve(d));
            }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
        });
        const pools = JSON.parse(data).data.filter(p => p.project === 'euler-v2' && p.chain === 'Ethereum');
        for (const p of pools) {
            const sym = p.symbol?.toUpperCase();
            if (sym && (!eulerApys[sym] || p.tvlUsd > eulerApys[sym].tvlUsd)) {
                eulerApys[sym] = { apyBase: p.apyBase || 0, apyReward: p.apyReward || 0, apy: p.apy || 0, tvlUsd: p.tvlUsd };
            }
        }
        console.log(`Loaded ${Object.keys(eulerApys).length} Euler APYs`);
    } catch(e) {
        console.log('Could not fetch Euler APYs:', e.message);
    }

    // Load manual positions (RWAs, off-chain, etc.)
    const manualPath = path.join(__dirname, '..', 'data', 'manual-positions.json');
    let manualPositions = {};
    if (fs.existsSync(manualPath)) {
        manualPositions = JSON.parse(fs.readFileSync(manualPath, 'utf8'));
    }

    // Load all positions with token data (including apy_base)
    const allPositions = db.prepare(`
        SELECT p.*,
            (SELECT json_group_array(json_object(
                'symbol', pt.symbol, 'real_symbol', pt.real_symbol, 'real_name', pt.real_name,
                'address', pt.address, 'amount', pt.amount, 'price_usd', pt.price_usd, 'value_usd', pt.value_usd,
                'apy_base', pt.apy_base, 'apy_base_source', pt.apy_base_source,
                'bonus_supply_apy', pt.bonus_supply_apy, 'bonus_supply_source', pt.bonus_supply_source,
                'bonus_borrow_apy', pt.bonus_borrow_apy, 'bonus_borrow_source', pt.bonus_borrow_source
            )) FROM position_tokens pt WHERE pt.position_id = p.id AND pt.role = 'supply') as supply_json,
            (SELECT json_group_array(json_object(
                'symbol', pt.symbol, 'real_symbol', pt.real_symbol, 'real_name', pt.real_name,
                'address', pt.address, 'amount', pt.amount, 'price_usd', pt.price_usd, 'value_usd', pt.value_usd,
                'apy_base', pt.apy_base, 'apy_base_source', pt.apy_base_source,
                'bonus_supply_apy', pt.bonus_supply_apy, 'bonus_supply_source', pt.bonus_supply_source,
                'bonus_borrow_apy', pt.bonus_borrow_apy, 'bonus_borrow_source', pt.bonus_borrow_source
            )) FROM position_tokens pt WHERE pt.position_id = p.id AND pt.role = 'borrow') as borrow_json,
            (SELECT json_group_array(json_object(
                'symbol', pt.symbol, 'real_symbol', pt.real_symbol,
                'amount', pt.amount, 'value_usd', pt.value_usd
            )) FROM position_tokens pt WHERE pt.position_id = p.id AND pt.role = 'reward') as reward_json
        FROM positions p
        ORDER BY p.net_usd DESC
    `).all();

    for (const p of allPositions) {
        p.supply = JSON.parse(p.supply_json || '[]');
        p.borrow = JSON.parse(p.borrow_json || '[]');
        p.rewards = JSON.parse(p.reward_json || '[]');
        delete p.supply_json;
        delete p.borrow_json;
        delete p.reward_json;

        // Normalize chain names to lowercase
        const chainMap = { 1: 'eth', 8453: 'base', 42161: 'arb', 137: 'poly', 10: 'opt', 146: 'sonic', 9745: 'plasma', 5000: 'mnt', 130: 'uni', 143: 'monad', 999: 'ink', 2741: 'abstract', 747474: 'wct', 81457: 'blast' };
        let chainStr = String(p.chain || '').toLowerCase().replace(/\.0$/, '');  // "1.0" -> "1"
        const chainNum = parseInt(chainStr);
        if (!isNaN(chainNum) && chainMap[chainNum]) {
            chainStr = chainMap[chainNum];
        }
        p.chain = chainStr;

        // Normalize position_type to strategy
        const typeToStrategy = { 'Lending': 'lend', 'supply': 'lend', 'borrow': 'borrow', 'Borrow': 'borrow' };
        p.strategy = typeToStrategy[p.position_type] || typeToStrategy[p.position_type?.toLowerCase()] || 'lend';
        
        // Enrich Euler positions with DeFiLlama APYs
        if (p.protocol_name === 'Euler' && eulerApys) {
            // Euler position_index is underlying asset address OR vault address
            // Map known addresses to symbols
            const eulerAddrMap = {
                '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
                '0x6c3ea9036406852006290770bedfcaba0e23a0e8': 'PYUSD',
                '0x8292bb45bf1ee4d140127049757c2e0ff06317ed': 'RLUSD',
                '0x00000000efe302beaa2b3e6e1b18d08d69a9012a': 'AUSD',
            };
            // Vault → underlying mapping (for scanner-created positions)
            const vaultToUnderlying = {
                '0xaf5372792a29dc6b296d6ffd4aa3386aff8f9bb2': '0x8292bb45bf1ee4d140127049757c2e0ff06317ed', // eRLUSD → RLUSD
                '0xba98fc35c9dfd69178ad5dce9fa29c64554783b5': '0x6c3ea9036406852006290770bedfcaba0e23a0e8', // ePYUSD → PYUSD
            };
            const addr = (p.position_index || '').toLowerCase();
            // Check if this is a vault address, map to underlying
            const underlyingAddr = vaultToUnderlying[addr] || addr;
            let sym = eulerAddrMap[underlyingAddr];
            if (!sym) {
                // Try supply token symbol
                sym = (p.supply?.[0]?.symbol || '').toUpperCase().replace(/^E/, '').replace(/-\d+$/, '');
            }
            if (sym && eulerApys) {
                const key = sym.toUpperCase();
                const eulerPool = eulerApys[key];
                if (eulerPool) {
                    // DeFiLlama returns percentages directly (e.g. 3.28 = 3.28%)
                    p.apy_base = eulerPool.apyBase;
                    p.bonus_supply = eulerPool.apyReward;
                }
            }
        }

        // Add YBS yield to Aave positions with yield-bearing tokens (sUSDe, syrupUSDC, etc)
        if (p.protocol_name?.includes('Aave') && p.supply?.length > 0) {
            try {
                const stablesPath2 = path.join(__dirname, '..', 'data', 'stables.json');
                if (fs.existsSync(stablesPath2)) {
                    const stablesData2 = JSON.parse(fs.readFileSync(stablesPath2, 'utf8'));
                    for (const t of p.supply) {
                        const ybsToken = (stablesData2.stables || []).find(s => s.name === t.symbol);
                        if (ybsToken && ybsToken.aprValue && t.apy_base === 0) {
                            // Add YBS yield to Aave supply APY
                            t.apy_base = ybsToken.apy_30d || ybsToken.aprValue;
                            t.apy_base_source = 'ybs:' + (ybsToken.aprValue).toFixed(2) + '%';
                        }
                    }
                    // Recalculate position APY from updated tokens
                    const supplyTokens = p.supply.filter(t => t.value_usd > 0);
                    if (supplyTokens.length > 0) {
                        let baseNum = 0, baseDen = 0;
                        for (const t of supplyTokens) {
                            if (t.apy_base != null) {
                                baseNum += t.apy_base * t.value_usd;
                                baseDen += t.value_usd;
                            }
                        }
                        if (baseDen > 0) p.apy_base = baseNum / baseDen;
                    }
                }
            } catch(e) {}
        }
        
        // Calculate asset_usd and debt_usd from supply/borrow tokens
        // If supply tokens have no value but position has asset_usd, distribute it
        const supplyValue = (p.supply || []).reduce((sum, t) => sum + (t.value_usd || 0), 0);
        if (supplyValue === 0 && p.asset_usd > 0 && p.supply?.length > 0) {
        }
        p.asset_usd = (p.supply || []).reduce((sum, t) => sum + (t.value_usd || 0), 0) || p.asset_usd || 0;
        p.debt_usd = (p.borrow || []).reduce((sum, t) => sum + (t.value_usd || 0), 0) || p.debt_usd || 0;

        // Calculate APY breakdown
        // Base APY: weighted average of supply tokens' apy_base
        let baseApyNum = 0, baseApyDen = 0;
        for (const t of p.supply) {
            if (t.apy_base != null && t.value_usd > 0) {
                baseApyNum += t.apy_base * t.value_usd;
                baseApyDen += t.value_usd;
            }
        }
        // Only set from tokens if not already set by Euler enrichment
        if (p.apy_base == null) p.apy_base = baseApyDen > 0 ? baseApyNum / baseApyDen : null;

        // Cost APY: weighted average of borrow tokens' apy_base (their supply rate = our cost)
        // For borrow positions, the cost is the borrow APY which we store as apy_base on borrow tokens
        let costApyNum = 0, costApyDen = 0;
        for (const t of p.borrow) {
            if (t.apy_base != null && t.value_usd > 0) {
                costApyNum += t.apy_base * t.value_usd;
                costApyDen += t.value_usd;
            }
        }
        p.apy_cost = costApyDen > 0 ? costApyNum / costApyDen : null;

        // Bonus APY: sum of supply bonuses and borrow bonuses from tokens
        let bonusSupplyTotal = 0, bonusBorrowTotal = 0;
        for (const t of p.supply) {
            if (t.bonus_supply_apy) bonusSupplyTotal += t.bonus_supply_apy;
            if (t.bonus_borrow_apy) bonusBorrowTotal += t.bonus_borrow_apy;
        }
        for (const t of p.borrow) {
            if (t.bonus_supply_apy) bonusSupplyTotal += t.bonus_supply_apy;
            if (t.bonus_borrow_apy) bonusBorrowTotal += t.bonus_borrow_apy;
        }
        // Only set bonus from tokens if not already set by Euler enrichment
        if (bonusSupplyTotal > 0 && p.bonus_supply == null) p.bonus_supply = bonusSupplyTotal;
        if (bonusBorrowTotal > 0 && p.bonus_borrow == null) p.bonus_borrow = bonusBorrowTotal;
        // If no bonus set yet, null
        if (p.bonus_supply == null) p.bonus_supply = null;
        if (p.bonus_borrow == null) p.bonus_borrow = null;
        
        // Net APY: accounts for leverage
        // Formula: net_apy = (supply_value × supply_apy - borrow_value × borrow_apy) / equity
        // where supply_apy already includes bonus (base + bonus)
        if (p.apy_base != null) {
            const supplyUsd = p.asset_usd || 0;
            const borrowUsd = Math.abs(p.debt_usd || 0);
            const equity = supplyUsd - borrowUsd;
            
            if (equity > 0) {
                // supply_apy = base + bonus (combined), borrow_apy = borrow cost
                const supplyApy = (p.apy_base || 0) + (p.bonus_supply || 0);
                const borrowApy = p.apy_cost || 0;
                
                const supplyYield = supplyUsd * (supplyApy / 100);
                const borrowCost = borrowUsd * (borrowApy / 100);
                
                const grossYield = supplyYield - borrowCost;
                p.apy_net = (grossYield / equity) * 100;
                p.leverage = supplyUsd / equity;
            } else {
                // Underwater or zero equity
                p.apy_net = (p.apy_base || 0) + (p.bonus_supply || 0);
                p.leverage = 1;
            }
        } else {
            p.apy_net = null;
            p.leverage = null;
        }

        // Reward APY: placeholder (would need reward token APR data)
        p.apy_reward = null;
    }

    // Deduplicate: merge positions with same wallet + chain + protocol + first supply token symbol
    // For positions with no supply tokens, use position_index as the key component
    const posMap = new Map();
    // Vault → underlying mapping for Euler dedup
    const vaultToUnderlying = {
        '0xaf5372792a29dc6b296d6ffd4aa3386aff8f9bb2': '0x8292bb45bf1ee4d140127049757c2e0ff06317ed',
        '0xba98fc35c9dfd69178ad5dce9fa29c64554783b5': '0x6c3ea9036406852006290770bedfcaba0e23a0e8',
    };
    for (const p of allPositions) {
        let supplySymbol = (p.supply?.[0]?.symbol || p.borrow?.[0]?.symbol || p.position_index || '').toLowerCase();
        // For Euler scanner positions, use underlying address as key
        if (p.protocol_id === 'euler2') {
            const addr = (p.position_index || '').toLowerCase();
            if (vaultToUnderlying[addr]) {
                supplySymbol = vaultToUnderlying[addr];
            } else if (p.supply?.[0]?.symbol) {
                // Extract base symbol from eRLUSD-7 → rlUSD
                const sym = p.supply[0].symbol.toUpperCase().replace(/^E/, '').replace(/-\d+$/, '');
                supplySymbol = sym.toLowerCase();
            }
        }
        const key = `${p.wallet}|${p.chain}|${p.protocol_id}|${supplySymbol}`;
        
        if (posMap.has(key)) {
            const existing = posMap.get(key);
            // Merge: prefer position with more data (scanner > DeBank)
            if (p.asset_usd > 0 && (existing.asset_usd === 0 || existing.asset_usd == null)) existing.asset_usd = p.asset_usd;
            if (p.debt_usd > 0 && (existing.debt_usd === 0 || existing.debt_usd == null)) existing.debt_usd = p.debt_usd;
            if (Math.abs(p.net_usd) > 0 && (existing.net_usd === 0 || existing.net_usd == null)) existing.net_usd = p.net_usd;
            if (existing.apy_base == null && p.apy_base != null) existing.apy_base = p.apy_base;
            if (existing.bonus_supply == null && p.bonus_supply != null) existing.bonus_supply = p.bonus_supply;
            if (existing.apy_net == null && p.apy_net != null) existing.apy_net = p.apy_net;
            // Prefer scanner positions (has supply tokens)
            if (p.supply?.length > 0) existing.supply = p.supply;
            if (p.borrow?.length > 0) existing.borrow = p.borrow;
            // Prefer scanner strategy
            if (p.strategy === 'lend' || p.strategy === 'borrow') existing.strategy = p.strategy;
        } else {
            posMap.set(key, p);
        }
    }
    const deduped = [...posMap.values()];

    // After merge: distribute asset_usd to supply tokens that have $0 value
    for (const p of deduped) {
        const supplyValue = (p.supply || []).reduce((sum, t) => sum + (t.value_usd || 0), 0);
        if (supplyValue === 0 && p.asset_usd > 0 && p.supply?.length > 0) {
            const perToken = p.asset_usd / p.supply.length;
            for (const t of p.supply) t.value_usd = perToken;
        }
    }

    // Filter dust positions (< $100) and fix bogus health_factor
    const filtered = deduped.filter(p => {
        // Remove dust: tiny positions (scanner artifacts or DeBank junk)
        const totalUsd = Math.abs(p.asset_usd || 0) + Math.abs(p.debt_usd || 0);
        if (totalUsd < 100) return false;
        return true;
    });
    
    // Fix bogus health_factor: DeBank returns 1e+59 for supply-only positions
    for (const p of filtered) {
        if (p.health_factor > 1000 && (!p.borrow || p.borrow.length === 0)) {
            p.health_factor = null;
        }
    }

    // Build whale data
    const whales = {};
    for (const [name, definition] of Object.entries(WHALES)) {
        // Handle both formats: simple wallet list or multi-vault
        let walletList, vaults = null;
        if (Array.isArray(definition)) {
            walletList = definition;
        } else if (definition.vaults) {
            vaults = definition.vaults;
            walletList = Object.values(vaults).flat();
        } else {
            continue;
        }

        const walletSet = new Set(walletList.map(w => w.toLowerCase()));
        const positions = filtered.filter(p => walletSet.has(p.wallet.toLowerCase()));

        // Fix Re Protocol on-chain positions
        // DeBank mislabels sUSDe as USDe and calls protocol "Ethena"
        // Re Protocol holds sUSDe as idle treasury, not as active Ethena deposit
        if (name === 'Re Protocol') {
            for (const p of positions) {
                // Relabel Ethena sUSDe holdings
                if (p.protocol_name === 'Ethena') {
                    p.strategy = 'Stake';
                    p.asset_type = 'Ethena';
                    // Fix token symbol: DeBank shows USDe but these are sUSDe holdings
                    for (const t of (p.supply || [])) {
                        if (t.symbol === 'USDe' && t.real_symbol === 'USDe') {
                            t.symbol = 'sUSDe';
                            t.real_symbol = 'sUSDe';
                        }
                    }
                    // Fix APY: sUSDe yields from Ethena staking
                    // Read from stables.json (YBS list)
                    let susdeApy = null;
                    try {
                        const stablesPath = path.join(__dirname, '..', 'data', 'stables.json');
                        if (fs.existsSync(stablesPath)) {
                            const stablesData = JSON.parse(fs.readFileSync(stablesPath, 'utf8'));
                            const susdeEntry = (stablesData.stables || []).find(s => s.name === 'sUSDe');
                            if (susdeEntry && susdeEntry.aprValue) susdeApy = susdeEntry.aprValue;
                        }
                    } catch(e) {}
                    if (susdeApy !== null) {
                        p.apy_base = susdeApy;
                        p.apy_net = susdeApy;
                        p.apy_current = susdeApy;
                    }
                }
                // Fix Curve position
                if (p.protocol_name === 'Curve') {
                    p.strategy = 'LP';
                    p.asset_type = 'Curve';
                    p.strategy = 'LP';
                }
            }
        }

        // Merge manual positions if they exist for this whale
        if (manualPositions[name]) {
            for (const mp of manualPositions[name]) {
                // Calculate apy_net for manual positions (they have apy_base but no token data)
                if (mp.apy_net == null && mp.apy_base != null) {
                    const bonusSupply = mp.apy_rewards || 0;
                    const baseYield = (mp.apy_base + bonusSupply) * (mp.asset_usd || 0);
                    const costYield = 0; // Manual positions typically have no borrow
                    mp.apy_net = mp.net_usd > 0 ? baseYield / mp.net_usd : mp.apy_base;
                }
                positions.push(mp);
            }
        }

        // If multi-vault, build vault breakdown
        let vaultData = null;
        if (vaults) {
            vaultData = {};
            for (const [vaultName, vaultWallets] of Object.entries(vaults)) {
                const vWalletSet = new Set(vaultWallets.map(w => w.toLowerCase()));
                const vPositions = positions.filter(p => vWalletSet.has(p.wallet.toLowerCase()));
                vaultData[vaultName] = {
                    name: vaultName,
                    wallets: vaultWallets,
                    total_wallets: vaultWallets.length,
                    active_wallets: [...new Set(vPositions.map(p => p.wallet))].length,
                    positions: vPositions,
                    slug: vaultName.toLowerCase().replace(/[^a-z0-9]/g, '-')
                };
            }
        }

        whales[name] = {
            name,
            wallets: walletList,
            total_wallets: walletList.length,
            active_wallets: [...new Set(positions.map(p => p.wallet))].length,
            positions,
            is_multi_vault: !!vaults,
            vaults: vaultData
        };
    }

    // Add manual-only whales (no on-chain wallets, entirely manual positions)
    for (const [name, manualWhalePositions] of Object.entries(manualPositions)) {
        if (!whales[name] && manualWhalePositions.length > 0) {
            // Calculate apy_net for manual positions
            for (const mp of manualWhalePositions) {
                if (mp.apy_net == null && mp.apy_base != null) {
                    const bonusSupply = mp.apy_rewards || 0;
                    const baseYield = (mp.apy_base + bonusSupply) * (mp.asset_usd || 0);
                    mp.apy_net = mp.net_usd > 0 ? baseYield / mp.net_usd : mp.apy_base;
                }
            }
            const uniqueWallets = [...new Set(manualWhalePositions.map(p => p.wallet))];
            whales[name] = {
                name,
                wallets: uniqueWallets,
                total_wallets: uniqueWallets.length,
                active_wallets: uniqueWallets.length,
                positions: manualWhalePositions,
                is_multi_vault: false,
                vaults: null
            };
        }
    }

    // Compute supply_tokens_display and asset_type for all positions
    // Protocol column uses asset_type (fallback protocol_name)
    // Supply Tokens column uses supply_tokens_display
    for (const w of Object.values(whales)) {
        for (const p of w.positions) {
            // Fix asset_type for manual positions that don't have it
            // Use yield_source (clean protocol name) if available
            if (p.manual && !p.asset_type && p.yield_source) {
                // Capitalize yield_source for display
                p.asset_type = p.yield_source.charAt(0).toUpperCase() + p.yield_source.slice(1);
            }

            // Compute supply_tokens_display
            if (p.manual && p.protocol_name) {
                // Check if protocol_name looks like a deal/bond ID (alphanumeric code)
                const isDealId = /^[A-Z]{2,}\d{4,}/i.test(p.protocol_name);
                if (isDealId) {
                    p.supply_tokens_display = p.protocol_name;
                } else {
                    // Manual position with readable name — show supply token symbols
                    const symbols = (p.supply || []).map(t => t.symbol).filter(Boolean);
                    p.supply_tokens_display = symbols.join(', ') || p.protocol_name;
                }
            } else {
                const symbols = (p.supply || []).map(t => t.symbol).filter(Boolean);
                p.supply_tokens_display = symbols.join(', ') || '-';
            }
        }
    }

    // Global summary
    let totalPositions = 0, totalValue = 0, totalAssets = 0, totalDebt = 0, totalWallets = 0, totalActive = 0;
    const allChains = new Set(), allProtos = new Set();

    for (const w of Object.values(whales)) {
        totalPositions += w.positions.length;
        totalWallets += w.total_wallets;
        totalActive += w.active_wallets;
        for (const p of w.positions) {
            totalValue += p.net_usd;
            totalAssets += p.asset_usd;
            totalDebt += p.debt_usd;
            allChains.add(p.chain);
            allProtos.add(p.protocol_name);
        }
    }

    const data = {
        generated_at: new Date().toISOString(),
        summary: {
            total_positions: totalPositions,
            total_value: totalValue,
            total_assets: totalAssets,
            total_debt: totalDebt,
            total_whales: Object.keys(whales).length,
            total_wallets: totalWallets,
            total_active: totalActive,
            chains: [...allChains],
            protocols: [...allProtos]
        },
        whales
    };

    fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2));

    // Save historical totals for daily/weekly change tracking
    const historyPath = path.join(__dirname, '..', 'data', 'total-history.json');
    let history = [];
    try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch(e) {}
    // Add new entry
    history.push({ date: data.generated_at, total: Math.round(totalValue) });
    // Deduplicate: keep only the last entry per day
    const byDay = new Map();
    for (const entry of history) {
      const day = entry.date.slice(0, 10); // YYYY-MM-DD
      byDay.set(day, entry); // last one wins
    }
    history = [...byDay.values()];
    // Keep last 30 days
    history = history.slice(-30);
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
    console.log(`Exported ${totalPositions} positions across ${Object.keys(whales).length} whales`);

    for (const [name, w] of Object.entries(whales)) {
        console.log(`  ${name}: ${w.positions.length} positions, ${w.active_wallets}/${w.total_wallets} wallets active`);
    }

    db.close();
}

main().catch(console.error);
