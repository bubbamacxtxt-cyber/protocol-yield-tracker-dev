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
const PROTOCOL_REGISTRY_PATH = path.join(__dirname, '..', 'data', 'protocol-registry.json');

function loadProtocolRegistry() {
    try {
        return JSON.parse(fs.readFileSync(PROTOCOL_REGISTRY_PATH, 'utf8')).protocols || {};
    } catch {
        return {};
    }
}

function applyProtocolRegistry(position, registry) {
    const p = position;
    const pid = String(p.protocol_id || '').toLowerCase();
    const pname = String(p.protocol_name || '');
    for (const [key, entry] of Object.entries(registry || {})) {
        if ((entry.aliases || []).includes(pid) || (entry.name_aliases || []).includes(pname)) {
            p.protocol_canonical = key;
            p.protocol_display = entry.display_name || p.protocol_name;
            p.protocol_category = entry.category || null;
            if (entry.canonical_id) p.protocol_id = entry.canonical_id;
            if (entry.display_name) p.protocol_name = entry.display_name;

            // Normalize certain protocol display names that still arrive through legacy rows.
            if (key === 'cap') p.protocol_name = 'Cap';
            if (key === 'infinifi') p.protocol_name = 'InfiniFi';
            if (key === 'pendle' && p.pendle_status === 'fallback') p.protocol_name = 'Pendle Fallback';
            return p;
        }
    }
    p.protocol_canonical = pid || String(pname || '').toLowerCase().replace(/\s+/g, '-');
    p.protocol_display = p.protocol_name;
    p.protocol_category = null;
    if (p.protocol_canonical === 'capapp') p.protocol_name = 'Cap';
    if (p.protocol_canonical === 'infinifixyz') p.protocol_name = 'InfiniFi';
    if (p.protocol_canonical === 'pendle' && p.pendle_status === 'fallback') p.protocol_name = 'Pendle Fallback';
    return p;
}

function finalizeSourceMeta(position) {
    const p = position;
    if (!p.source_priority) {
        if (p.source_type === 'scanner') p.source_priority = 100;
        else if (p.source_type === 'protocol_api') p.source_priority = 80;
        else if (p.source_type === 'manual') p.source_priority = 70;
        else if (p.source_type === 'wallet') p.source_priority = 60;
        else if (p.source_type === 'debank' || p.source_type === 'fallback') p.source_priority = 40;
        else p.source_priority = 50;
    }
    if (!p.confidence) {
        if (p.pendle_status === 'fallback') p.confidence = 'low';
        else if (p.source_type === 'scanner') p.confidence = 'high';
        else if (p.source_type === 'protocol_api') p.confidence = 'high';
        else if (p.source_type === 'manual') p.confidence = 'medium';
        else if (p.source_type === 'wallet') p.confidence = 'high';
        else p.confidence = 'medium';
    }
    if (!p.normalization_status) {
        if (p.pendle_status === 'fallback') p.normalization_status = 'unresolved';
        else p.normalization_status = 'canonical';
    }
    if (!p.exposure_class) {
        if (p.pendle_status === 'fallback') p.exposure_class = 'bundled_protocol_fallback';
        else if (p.wallet === 'off-chain') p.exposure_class = 'manual_offchain';
        else if (p.source_type === 'wallet' || String(p.protocol_id || '').toLowerCase() === 'wallet-held') p.exposure_class = 'wallet_holding';
        else p.exposure_class = 'direct_position';
    }
    return p;
}

function promoteCanonicalYieldRows(position, stables, vaults) {
    const p = position;
    const pid = String(p.protocol_id || '').toLowerCase();
    const pname = String(p.protocol_name || '').toLowerCase();
    const assetType = String(p.asset_type || '').toLowerCase();
    const supplyText = String(p.supply_tokens_display || '').toLowerCase();

    if (p.pendle_status === 'fallback' || pid === 'pendle2' || pid === 'arb_pendle2' || pid === 'plasma_pendle2') return p;

    const stableMatch = findYbsToken(stables || [], p.supply?.[0]?.symbol || p.supply_tokens_display, p.supply?.[0]?.address);
    const vaultMatch = (vaults || []).find(v => {
        const addr = String(v.address || '').toLowerCase();
        return addr && (p.supply || []).some(t => String(t.address || '').toLowerCase() === addr);
    });

    const ybsByProtocol = (stables || []).find(s => {
        const proto = String(s.protocol || '').toLowerCase();
        return (pid && proto.includes(pid)) || (pname && proto.includes(pname));
    });
    const vaultByProtocol = (vaults || []).find(v => {
        const proto = String(v.protocol || '').toLowerCase();
        return proto && ((pid && proto.includes(pid)) || (pname && proto.includes(pname)));
    });

    const matchedStable = stableMatch || ybsByProtocol || null;
    const matchedVault = vaultMatch || vaultByProtocol || null;

    const looksLikeYbsCanonical = pid === 'ethena' || pid === 'sky' || pid === 'infinifixyz' || pid === 'capapp'
        || pname.includes('ethena') || pname.includes('sky') || pname.includes('infinifi') || pname === 'cap'
        || assetType.includes('ethena') || assetType.includes('sky')
        || supplyText.includes('susde') || supplyText.includes('susds') || supplyText.includes('siusd') || supplyText.includes('stcusd');

    const looksLikeVaultCanonical = pid === 'upshift' || pname.includes('upshift') || supplyText.includes('upgammausdc');

    if (matchedStable && looksLikeYbsCanonical) {
        p.source_type = 'protocol_api';
        p.source_name = stableMatch ? 'ybs-list' : 'canonical-yield-registry';
        p.confidence = 'high';
        p.normalization_status = 'canonical';
        if (String(matchedStable.protocol || '').includes('infinifi')) p.exposure_class = 'indirect_strategy_exposure';
        else p.exposure_class = 'yield_bearing_stable';

        const apy = matchedStable.apy_30d ?? matchedStable.aprValue ?? matchedStable.apy_7d ?? matchedStable.apy_1d;
        if (apy != null && (p.apy_base == null || p.apy_base === 0)) {
            p.apy_base = apy;
            p.apy_base_source = stableMatch ? `ybs:${matchedStable.name}` : `canonical-yield-registry:${matchedStable.name || matchedStable.protocol}`;
        }
        return p;
    }

    if (matchedVault && looksLikeVaultCanonical) {
        p.source_type = 'protocol_api';
        p.source_name = vaultMatch ? 'vault-registry' : 'canonical-vault-registry';
        p.confidence = 'high';
        p.normalization_status = 'canonical';
        p.exposure_class = 'vault_position';

        const apy = matchedVault.apy_30d ?? matchedVault.apy_7d ?? matchedVault.apy_1d;
        if (apy != null && (p.apy_base == null || p.apy_base === 0)) {
            p.apy_base = apy;
            p.apy_base_source = vaultMatch ? `vault:${matchedVault.symbol || matchedVault.name}` : `canonical-vault-registry:${matchedVault.symbol || matchedVault.name || matchedVault.protocol}`;
        }
        return p;
    }

    return p;
}

function normalizeSourceMeta(position) {
    const p = position;
    if (p.wallet === 'off-chain') {
        p.discovery_type = p.discovery_type || 'offchain';
        p.source_type = p.source_type || (p.manual ? 'manual' : 'protocol_api');
    } else {
        p.discovery_type = p.discovery_type || 'onchain';
    }

    if (!p.source_type) {
        const protocol = String(p.protocol_name || '').toLowerCase();
        const protocolId = String(p.protocol_id || '').toLowerCase();
        if (protocolId === 'wallet-held' || protocol === 'wallet') {
            p.source_type = 'wallet';
        } else if (protocol.includes('aave') || protocol.includes('morpho') || protocol.includes('euler') || protocol.includes('fluid') || protocolId.includes('aave') || protocolId.includes('morpho') || protocolId.includes('euler') || protocolId.includes('fluid')) {
            p.source_type = 'scanner';
        } else {
            p.source_type = 'debank';
        }
    }

    if (!p.source_name) {
        if (p.source_type === 'scanner') {
            const protocol = String(p.protocol_name || '').toLowerCase();
            if (protocol.includes('aave')) p.source_name = 'aave-scanner';
            else if (protocol.includes('morpho')) p.source_name = 'morpho-scanner';
            else if (protocol.includes('euler')) p.source_name = 'euler-scanner';
            else if (protocol.includes('fluid')) p.source_name = 'fluid-scanner';
            else p.source_name = 'scanner';
        } else if (p.source_type === 'debank') {
            p.source_name = 'fetch';
        } else if (p.source_type === 'manual') {
            p.source_name = 'manual';
        } else if (p.source_type === 'wallet') {
            p.source_name = 'wallet-scan';
        } else if (p.source_type === 'protocol_api') {
            p.source_name = 'protocol_api';
        }
    }

    return p;
}

function findYbsToken(stables, symbol, address) {
    const addr = String(address || '').toLowerCase();
    if (addr) {
        const byAddress = (stables || []).find(s => (s.addresses || []).some(a => String(a).toLowerCase() === addr));
        if (byAddress) return byAddress;
    }
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return null;
    return (stables || []).find(s => {
        if (String(s.name || '').toUpperCase() === sym) return true;
        return (s.aliases || []).some(a => String(a || '').toUpperCase() === sym);
    }) || null;
}

function normalizeTokenCluster(tokens = []) {
    return (tokens || [])
        .map(t => ({
            symbol: String(t?.symbol || '').toLowerCase(),
            address: String(t?.address || '').toLowerCase(),
            value: Math.round(Number(t?.value_usd || 0))
        }))
        .sort((a, b) => {
            if (a.address !== b.address) return a.address.localeCompare(b.address);
            if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
            return a.value - b.value;
        })
        .map(t => `${t.symbol}:${t.address}:${t.value}`)
        .join('|');
}

function clusterKey(position) {
    // For manual/protocol_api positions, include the position name/deal ID to avoid collapsing
    // distinct investments (e.g., Anzen bonds, Pareto funds, InfiniFi strategies)
    const isManualOrApi = ['manual', 'protocol_api'].includes(String(position.source_type || '').toLowerCase());
    const nameSuffix = isManualOrApi ? '|' + String(position.protocol_name || position.position_index || '').toLowerCase() : '';
    return [
        String(position.wallet || '').toLowerCase(),
        String(position.chain || '').toLowerCase(),
        String(position.protocol_canonical || position.protocol_id || position.protocol_name || '').toLowerCase(),
        normalizeTokenCluster(position.supply || []),
        normalizeTokenCluster(position.borrow || []),
    ].join('||') + nameSuffix;
}

function sourceRank(position) {
    const sourceType = String(position.source_type || '').toLowerCase();
    if (sourceType === 'scanner') return 500;
    if (sourceType === 'protocol_api') return 400;
    if (sourceType === 'manual') return 300;
    if (sourceType === 'wallet') return 200;
    if (sourceType === 'debank' || sourceType === 'fallback') return 100;
    return Number(position.source_priority || 0);
}

function mergePreferredRow(best, candidate) {
    const keep = { ...best };
    if ((keep.apy_base == null || keep.apy_base === 0) && candidate.apy_base != null) keep.apy_base = candidate.apy_base;
    if ((keep.apy_cost == null || keep.apy_cost === 0) && candidate.apy_cost != null) keep.apy_cost = candidate.apy_cost;
    if ((keep.health_rate == null || keep.health_rate === 0) && candidate.health_rate != null) keep.health_rate = candidate.health_rate;
    if ((!keep.rewards || keep.rewards.length === 0) && candidate.rewards?.length) keep.rewards = candidate.rewards;
    if ((!keep.supply || keep.supply.length === 0) && candidate.supply?.length) keep.supply = candidate.supply;
    if ((!keep.borrow || keep.borrow.length === 0) && candidate.borrow?.length) keep.borrow = candidate.borrow;
    return keep;
}

function dedupCanonicalClusters(positions) {
    const byKey = new Map();
    for (const p of positions) {
        const key = clusterKey(p);
        const existing = byKey.get(key);
        if (!existing) {
            byKey.set(key, p);
            continue;
        }
        const existingRank = sourceRank(existing);
        const nextRank = sourceRank(p);
        if (nextRank > existingRank) {
            byKey.set(key, mergePreferredRow(p, existing));
        } else {
            byKey.set(key, mergePreferredRow(existing, p));
        }
    }
    return [...byKey.values()];
}

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
    const protocolRegistry = loadProtocolRegistry();
    const ybsPath = path.join(__dirname, '..', 'data', 'stables.json');
    const ybsData = fs.existsSync(ybsPath) ? JSON.parse(fs.readFileSync(ybsPath, 'utf8')) : { stables: [] };
    const stables = ybsData.stables || [];
    const vaultsPath = path.join(__dirname, '..', 'data', 'vaults.json');
    const vaultsData = fs.existsSync(vaultsPath) ? JSON.parse(fs.readFileSync(vaultsPath, 'utf8')) : { vaults: [] };
    const vaults = Array.isArray(vaultsData) ? vaultsData : (vaultsData.vaults || []);
    
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

        // Reconstruct synthetic supply token for positions with asset_usd but no token rows
        // Only for issuer/protocol-native positions (Ethena, Sky, Cap) where DeBank didn't insert tokens
        const isIssuerPosition = ['Ethena', 'Sky', 'Cap', 'infinifiUSD', 'sGHO', 'sUSDS', 'stcUSD'].includes(p.protocol_name);
        if (isIssuerPosition && p.asset_usd > 0 && p.supply.length === 0) {
            const syntheticSymbol = p.protocol_name === 'Ethena' ? 'USDe'
                : p.protocol_name === 'Sky' ? 'sUSDS'
                : p.protocol_name === 'Cap' ? 'stcUSD'
                : p.yield_source || p.protocol_name;
            p.supply = [{
                symbol: syntheticSymbol,
                address: p.position_index || '',
                amount: null,
                price_usd: null,
                value_usd: p.asset_usd,
                apy_base: null,
                apy_base_source: null,
                bonus_supply_apy: null,
                bonus_supply_source: null,
                bonus_borrow_apy: null,
                bonus_borrow_source: null
            }];
        }

        normalizeSourceMeta(p);
        applyProtocolRegistry(p, protocolRegistry);
        finalizeSourceMeta(p);

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
                        const ybsToken = findYbsToken(stablesData2.stables || [], t.symbol, t.address);
                        if (ybsToken && ybsToken.aprValue && t.apy_base === 0) {
                            // Add YBS yield to Aave supply APY using address-first matching
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

    // Suppress legacy DeBank-heavy rows when scanner-owned protocol rows exist for the same wallet+chain+protocol family.
    // This is critical while old fetch.js onchain rows still coexist with scanner-native rows.
    const scannerCoveredFamilies = new Set(
        allPositions
            .filter(p => p.source_type === 'scanner')
            .map(p => {
                const wallet = String(p.wallet || '').toLowerCase();
                const chain = String(p.chain || '').toLowerCase();
                const family = String(p.protocol_canonical || p.protocol_name || p.protocol_id || '').toLowerCase();
                return `${wallet}|${chain}|${family}`;
            })
    );

    const filteredPositions = allPositions.filter(p => {
        const wallet = String(p.wallet || '').toLowerCase();
        const chain = String(p.chain || '').toLowerCase();
        const family = String(p.protocol_canonical || p.protocol_name || p.protocol_id || '').toLowerCase();
        const key = `${wallet}|${chain}|${family}`;
        const isLegacyDebank = p.source_type === 'debank' || p.source_name === 'fetch';
        const isScannerOwnedFamily = ['aave', 'morpho', 'euler', 'spark', 'pendle'].includes(family);
        if (isLegacyDebank && isScannerOwnedFamily && scannerCoveredFamilies.has(key)) return false;
        return true;
    });

    // Deduplicate: merge positions with same wallet + chain + protocol + first supply token symbol.
    // Special handling: Aave lend+borrow slices for the same wallet/chain/market should collapse into one row.
    const posMap = new Map();
    // Vault → underlying mapping for Euler dedup
    const vaultToUnderlying = {
        '0xaf5372792a29dc6b296d6ffd4aa3386aff8f9bb2': '0x8292bb45bf1ee4d140127049757c2e0ff06317ed',
        '0xba98fc35c9dfd69178ad5dce9fa29c64554783b5': '0x6c3ea9036406852006290770bedfcaba0e23a0e8',
    };
    for (const p of filteredPositions) {
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
        const isAave = String(p.protocol_name || '').includes('Aave');
        const aaveBorrowOnly = isAave && (!p.supply || p.supply.length === 0) && (p.borrow && p.borrow.length > 0);
        const aaveMergeKey = isAave && !aaveBorrowOnly && String(p.position_index || '').trim()
            ? `${String(p.wallet || '').toLowerCase()}|${p.chain}|${p.protocol_id}|${String(p.position_index || '').toLowerCase()}`
            : null;
        
        // Morpho borrow-only fragments should merge with their collateral supply row on same wallet+chain
        const isMorpho = String(p.protocol_name || '').toLowerCase() === 'morpho' || String(p.protocol_id || '').toLowerCase() === 'morpho';
        const morphoBorrowOnly = isMorpho && (!p.supply || p.supply.length === 0 || p.asset_usd === 0) && (p.borrow && p.borrow.length > 0);
        const morphoMergeKey = isMorpho && !morphoBorrowOnly && String(p.position_index || '').trim()
            ? `${String(p.wallet || '').toLowerCase()}|${p.chain}|morpho|${String(p.position_index || '').toLowerCase()}`
            : null;
        
        const key = aaveMergeKey || morphoMergeKey || `${String(p.wallet || '').toLowerCase()}|${p.chain}|${p.protocol_id}|${supplySymbol}`;
        
        if (posMap.has(key)) {
            const existing = posMap.get(key);
            // Merge: prefer row with more complete economic state
            if ((p.asset_usd || 0) > 0 && ((existing.asset_usd || 0) === 0 || existing.asset_usd == null)) existing.asset_usd = p.asset_usd;
            if ((p.debt_usd || 0) > 0 && ((existing.debt_usd || 0) === 0 || existing.debt_usd == null)) existing.debt_usd = p.debt_usd;
            if (Math.abs(p.net_usd || 0) > Math.abs(existing.net_usd || 0)) existing.net_usd = p.net_usd;
            if (existing.apy_base == null && p.apy_base != null) existing.apy_base = p.apy_base;
            if (existing.bonus_supply == null && p.bonus_supply != null) existing.bonus_supply = p.bonus_supply;
            if (existing.apy_net == null && p.apy_net != null) existing.apy_net = p.apy_net;
            if (existing.apy_cost == null && p.apy_cost != null) existing.apy_cost = p.apy_cost;
            if (existing.health_rate == null && p.health_rate != null && p.health_rate < 1000) existing.health_rate = p.health_rate;

            const mergeTokens = (target, incoming) => {
                const out = [...(target || [])];
                for (const t of (incoming || [])) {
                    const tk = `${String(t.address || '').toLowerCase()}|${String(t.symbol || '').toLowerCase()}`;
                    if (!out.some(x => `${String(x.address || '').toLowerCase()}|${String(x.symbol || '').toLowerCase()}` === tk)) out.push(t);
                }
                return out;
            };
            existing.supply = mergeTokens(existing.supply, p.supply);
            existing.borrow = mergeTokens(existing.borrow, p.borrow);
            existing.rewards = mergeTokens(existing.rewards, p.rewards);

            // Strategy: if there is any borrow leg, keep row as lend (not separate borrow row) but preserve borrow tokens.
            if (String(p.protocol_name || '').toLowerCase() === 'pendle' && String(p.strategy || '').startsWith('pendle-')) {
                existing.strategy = p.strategy;
            } else if ((existing.borrow && existing.borrow.length > 0) || (p.borrow && p.borrow.length > 0)) {
                existing.strategy = 'lend';
            } else if (p.strategy) {
                existing.strategy = p.strategy;
            }
        } else {
            posMap.set(key, p);
        }
    }
    const deduped = [...posMap.values()];

    // After merge: recalculate asset_usd, apy_base, bonus, apy_net from merged tokens
    for (const p of deduped) {
        const supplyValue = (p.supply || []).reduce((sum, t) => sum + (t.value_usd || 0), 0);
        const borrowValue = (p.borrow || []).reduce((sum, t) => sum + (t.value_usd || 0), 0);
        if (supplyValue > 0) p.asset_usd = supplyValue;
        if (borrowValue > 0) p.debt_usd = borrowValue;
        // If supply tokens have $0 value but position has asset_usd, distribute it
        if (supplyValue === 0 && p.asset_usd > 0 && p.supply?.length > 0) {
            const perToken = p.asset_usd / p.supply.length;
            for (const t of p.supply) t.value_usd = perToken;
        }
        
        // Recalculate apy_base from merged supply tokens
        const supplyTokens = (p.supply || []).filter(t => t.value_usd > 0 && t.apy_base != null);
        if (supplyTokens.length > 0) {
            let baseNum = 0, baseDen = 0;
            for (const t of supplyTokens) {
                baseNum += t.apy_base * t.value_usd;
                baseDen += t.value_usd;
            }
            if (baseDen > 0) p.apy_base = baseNum / baseDen;
        }
        
        // Recalculate apy_cost from merged borrow tokens
        const borrowTokens = (p.borrow || []).filter(t => t.value_usd > 0 && t.apy_base != null);
        if (borrowTokens.length > 0) {
            let costNum = 0, costDen = 0;
            for (const t of borrowTokens) {
                costNum += t.apy_base * t.value_usd;
                costDen += t.value_usd;
            }
            if (costDen > 0) p.apy_cost = costNum / costDen;
        }
        
        // Recalculate bonus from merged tokens
        let bonusTotal = 0;
        for (const t of (p.supply || [])) {
            if (t.bonus_supply_apy) bonusTotal += t.bonus_supply_apy;
        }
        if (bonusTotal > 0) p.bonus_supply = bonusTotal;
        
        // Recalculate apy_net with leverage formula
        if (p.asset_usd > 0 && p.debt_usd > 0 && p.apy_base != null) {
            const supplyUsd = p.asset_usd;
            const borrowUsd = Math.abs(p.debt_usd);
            const equity = supplyUsd - borrowUsd;
            if (equity > 0) {
                const supplyApy = (p.apy_base || 0) + (p.bonus_supply || 0);
                const borrowApy = p.apy_cost || 15; // default borrow cost
                const supplyYield = supplyUsd * (supplyApy / 100);
                const borrowCost = borrowUsd * (borrowApy / 100);
                p.apy_net = ((supplyYield - borrowCost) / equity) * 100;
                p.leverage = supplyUsd / equity;
            } else {
                p.apy_net = (p.apy_base || 0) + (p.bonus_supply || 0);
                p.leverage = 1;
            }
        }
    }

    // Filter dust positions (< $100), clean token fragments, and fix bogus health/health_factor values
    const filtered = deduped.filter(p => {
        const totalUsd = Math.abs(p.asset_usd || 0) + Math.abs(p.debt_usd || 0);
        if (totalUsd < 50) return false;
        return true;
    });
    
    for (const p of filtered) {
        // Drop tiny token fragments inside otherwise valid combined rows.
        const dropDustTokens = (tokens = [], totalUsd = 0) => {
            return tokens.filter(t => {
                const v = Math.abs(Number(t.value_usd || 0));
                if (v === 0) return false;
                if (v < 1) return false;
                if (totalUsd > 0 && v / totalUsd < 0.001) return false; // <0.1% of row
                return true;
            });
        };
        p.supply = dropDustTokens(p.supply || [], Math.abs(p.asset_usd || 0));
        p.borrow = dropDustTokens(p.borrow || [], Math.abs(p.debt_usd || 0));

        // Recompute display-side supply/debt after token dust cleanup where meaningful.
        const supplyAfter = (p.supply || []).reduce((sum, t) => sum + (t.value_usd || 0), 0);
        const borrowAfter = (p.borrow || []).reduce((sum, t) => sum + (t.value_usd || 0), 0);
        if (supplyAfter > 0) p.asset_usd = supplyAfter;
        if (borrowAfter > 0) p.debt_usd = borrowAfter;
        if (p.asset_usd > 0 || p.debt_usd > 0) p.net_usd = p.asset_usd - p.debt_usd;
        // Normalize to health_rate only
        if (p.health_rate == null && p.health_factor != null) p.health_rate = p.health_factor;

        // Bogus giant health for supply-only rows
        if (p.health_rate > 1000 && (!p.borrow || p.borrow.length === 0)) {
            p.health_rate = null;
        }

        // If there is borrow exposure and no health value, suppress fake leftover huge/null artifacts only.
        if (p.health_rate != null && p.health_rate > 1000) {
            p.health_rate = null;
        }

        // Borrow rows should not survive separately for Aave after merge; if they do, keep only rows with either supply or borrow+health context.
        if (String(p.protocol_name || '').includes('Aave') && (!p.supply || p.supply.length === 0) && (!p.borrow || p.borrow.length === 0)) {
            p._drop = true;
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
        const positions = filtered.filter(p => !p._drop && walletSet.has(p.wallet.toLowerCase()));
        const dedupedBySignature = dedupCanonicalClusters(positions);

        // No entity-level chain suppression here.
        // Only remove rows when they are structurally duplicate/fragment/enrichment leakage,
        // not because we guessed a chain should be out-of-scope.

        // Remove standalone canonical issued-asset rows when a scanner-owned venue row already exists
        // for the same wallet+chain and the issued asset is just part of that venue exposure.
        const scannerContext = new Set(
            dedupedBySignature
                .filter(p => p.source_type === 'scanner')
                .map(p => `${String(p.wallet || '').toLowerCase()}|${String(p.chain || '').toLowerCase()}`)
        );
        const cleanedPositions = dedupedBySignature.filter(p => !p._drop).filter(p => {
            const walletChain = `${String(p.wallet || '').toLowerCase()}|${String(p.chain || '').toLowerCase()}`;
            const scannerRowsSameWalletChain = dedupedBySignature.filter(x => `${String(x.wallet || '').toLowerCase()}|${String(x.chain || '').toLowerCase()}` === walletChain && (x.source_type === 'scanner' || String(x.source_name || '') === 'aave-scanner' || String(x.source_name || '') === 'morpho-scanner' || String(x.source_name || '') === 'euler-scanner' || String(x.source_name || '') === 'pendle-portfolio' || String(x.source_name || '') === 'pendle-balanceof'));
            const scannerContextForSuppression = scannerRowsSameWalletChain.filter(x => (x.asset_usd || 0) > 0 || (x.debt_usd || 0) > 0);
            const isCanonicalYieldRow = p.source_type === 'protocol_api'
                && (p.exposure_class === 'yield_bearing_stable' || p.exposure_class === 'vault_position');
            const isStandaloneCanonicalYield = isCanonicalYieldRow && (
                    !p.supply || p.supply.length === 0 || p.supply_tokens_display === '-'
                    || (p.supply || []).every(t => !t || !t.address)
                    || (!p.position_index || /^0x[0-9a-f]{40}$/i.test(String(p.position_index || '')))
                );
            if (isStandaloneCanonicalYield && scannerContextForSuppression.length > 0) return false;

            // NOTE: Ethena rows are NOT suppressed here. A direct USDe holding (Ethena issuer)
            // is a separate economic position from Aave collateral. Both should appear.
            // The generic dedup (clusterKey) will catch true duplicates.

            if (isCanonicalYieldRow) {
                const pAddr = String(p.position_index || '').toLowerCase();
                const scannerSameToken = scannerContextForSuppression.some(x => {
                    const tokenAddrs = [...(x.supply || []), ...(x.borrow || [])].map(t => String(t.address || '').toLowerCase()).filter(Boolean);
                    return pAddr && tokenAddrs.includes(pAddr);
                });
                if (scannerSameToken) return false;

                const issuedSymbols = ['susde','susds','siusd','stcusd','syrupusdt','syrupusdc','usde'];
                const scannerHasIssuedAsset = scannerContextForSuppression.some(x =>
                    [...(x.supply || []), ...(x.borrow || [])]
                      .some(t => issuedSymbols.includes(String(t.symbol || '').toLowerCase()))
                );
                if (scannerHasIssuedAsset) return false;

                // Explicit Ethena suppression: if the same wallet+chain already has scanner-owned Aave exposure
                // carrying USDe/sUSDe, then the standalone Ethena issuer row is enrichment only, not exposure.
                const isEthenaIssuerRow = String(p.protocol_id || '').toLowerCase() === 'ethena';
                if (isEthenaIssuerRow) {
                    const aaveHasUsde = scannerContextForSuppression.some(x =>
                        String(x.protocol_name || '') === 'Aave V3' &&
                        [...(x.supply || []), ...(x.borrow || [])].some(t => ['usde','susde'].includes(String(t.symbol || '').toLowerCase()))
                    );
                    if (aaveHasUsde) return false;
                }
            }

            // Suppress pure borrow-only scanner fragments when a richer scanner row exists on same wallet+chain+protocol.
            const isBorrowOnlyScanner = p.source_type === 'scanner'
                && (!p.supply || p.supply.length === 0 || p.supply_tokens_display === '-')
                && (p.borrow && p.borrow.length > 0);
            if (isBorrowOnlyScanner) {
                const hasRicher = scannerRowsSameWalletChain.some(x =>
                    String(x.protocol_name || '') === String(p.protocol_name || '')
                    && x !== p
                    && (x.asset_usd || 0) > 0
                );
                // Also suppress scanner borrow-only rows when they are really incomplete venue fragments.
                const looksLikeMorphoBorrowResidue = String(p.protocol_name || '') === 'Morpho' && (p.borrow || []).length > 0 && (!p.supply || p.supply.length === 0);
                const looksLikeAaveBorrowResidue = String(p.protocol_name || '') === 'Aave V3' && (p.borrow || []).length > 0 && (!p.supply || p.supply.length === 0);
                if (looksLikeMorphoBorrowResidue || looksLikeAaveBorrowResidue) return false;

                if (hasRicher) return false;
            }
            // Suppress legacy DeBank venue rows for scanner-owned protocol families on the same wallet+chain.
            const isLegacyVenueRow = (p.source_type === 'debank' || p.source_name === 'fetch')
                && ['aave', 'morpho', 'euler', 'spark', 'pendle'].includes(String(p.protocol_canonical || p.protocol_name || p.protocol_id || '').toLowerCase());
            if (isLegacyVenueRow && scannerContextForSuppression.length > 0) {
                const sameFamilyScanner = scannerContextForSuppression.some(x =>
                    String(x.protocol_canonical || x.protocol_name || x.protocol_id || '').toLowerCase() === String(p.protocol_canonical || p.protocol_name || p.protocol_id || '').toLowerCase()
                );
                if (sameFamilyScanner) return false;
            }

            const isWalletLikeRow = String(p.protocol_id || '').toLowerCase() === 'wallet-held'
                || String(p.protocol_name || '').toLowerCase() === 'wallet'
                || String(p.source_type || '').toLowerCase() === 'wallet';
            if (isWalletLikeRow && scannerContextForSuppression.length > 0) {
                const heldAddrs = (p.supply || []).map(t => String(t.address || '').toLowerCase()).filter(Boolean);
                const heldSyms = (p.supply || []).map(t => String(t.symbol || '').toLowerCase()).filter(Boolean);
                const overlapsScanner = scannerContextForSuppression.some(x => {
                    const tokens = [...(x.supply || []), ...(x.borrow || [])];
                    const tokenAddrs = tokens.map(t => String(t.address || '').toLowerCase()).filter(Boolean);
                    const tokenSyms = tokens.map(t => String(t.symbol || '').toLowerCase()).filter(Boolean);
                    return heldAddrs.some(a => tokenAddrs.includes(a)) || heldSyms.some(s => tokenSyms.includes(s));
                });
                if (overlapsScanner) return false;
            }

            return true;
        });

        // Important rule: whale page entity identity must not overwrite row-level exposure venue.
        // Keep row protocol_name/protocol_canonical as the actual deployed venue (e.g. Morpho, Aave, etc.).
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
                            const susdeEntry = findYbsToken(stablesData.stables || [], 'sUSDe', '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497');
                            if (susdeEntry && susdeEntry.aprValue) susdeApy = susdeEntry.aprValue;
                        }
                    } catch(e) {}
                    if (susdeApy !== null) {
                        p.apy_base = susdeApy;
                        // Don't overwrite apy_net if bonus was already applied
                        if (p.bonus_supply == null) p.apy_net = susdeApy;
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
                // Backfill source metadata for older manual-positions.json entries
                if (!mp.source_type) {
                    if (name === 'InfiniFi') {
                        mp.manual = false;
                        mp.source_type = 'protocol_api';
                        mp.source_name = 'fetch-infinifi';
                        mp.discovery_type = 'onchain';
                    } else if (name === 'Pareto') {
                        mp.manual = false;
                        mp.source_type = 'protocol_api';
                        mp.source_name = 'fetch-pareto';
                        mp.discovery_type = 'mixed';
                    } else if (name === 'Anzen') {
                        mp.manual = true;
                        mp.source_type = 'manual';
                        mp.source_name = 'fetch-anzen';
                        mp.discovery_type = 'offchain';
                    } else if (name === 'Re Protocol' && mp.wallet === 'off-chain') {
                        mp.manual = true;
                        mp.source_type = 'manual';
                        mp.source_name = 'fetch-re';
                        mp.discovery_type = 'offchain';
                    }
                }
                // Calculate apy_net for manual positions (they have apy_base but no token data)
                if (mp.apy_net == null && mp.apy_base != null) {
                    const bonusSupply = mp.apy_rewards || 0;
                    const baseYield = (mp.apy_base + bonusSupply) * (mp.asset_usd || 0);
                    const costYield = 0; // Manual positions typically have no borrow
                    mp.apy_net = mp.net_usd > 0 ? baseYield / mp.net_usd : mp.apy_base;
                }
                normalizeSourceMeta(mp);
                if (mp.spark_exposure_type === 'indirect_strategy') {
                    mp.strategy = mp.strategy || 'spark-strategy-indirect';
                    mp.yield_source = 'spark';
                }
                cleanedPositions.push(mp);
            }
        }

        // If multi-vault, build vault breakdown
        let vaultData = null;
        if (vaults) {
            vaultData = {};
            for (const [vaultName, vaultWallets] of Object.entries(vaults)) {
                const vWalletSet = new Set(vaultWallets.map(w => w.toLowerCase()));
                const vPositions = cleanedPositions.filter(p => vWalletSet.has(p.wallet.toLowerCase()));
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
            active_wallets: [...new Set(cleanedPositions.map(p => p.wallet))].length,
            positions: cleanedPositions,
            is_multi_vault: !!vaults,
            vaults: vaultData
        };
    }

    // Add manual-only whales (no on-chain wallets, entirely manual positions)
    for (const [name, manualWhalePositions] of Object.entries(manualPositions)) {
        if (!whales[name] && manualWhalePositions.length > 0) {
            // Calculate apy_net for manual positions and backfill source metadata
            for (const mp of manualWhalePositions) {
                if (!mp.source_type) {
                    if (name === 'Pareto') {
                        mp.manual = false;
                        mp.source_type = 'protocol_api';
                        mp.source_name = 'fetch-pareto';
                        mp.discovery_type = 'mixed';
                    } else if (name === 'Anzen') {
                        mp.manual = true;
                        mp.source_type = 'manual';
                        mp.source_name = 'fetch-anzen';
                        mp.discovery_type = 'offchain';
                    } else if (name === 'Re Protocol' && mp.wallet === 'off-chain') {
                        mp.manual = true;
                        mp.source_type = 'manual';
                        mp.source_name = 'fetch-re';
                        mp.discovery_type = 'offchain';
                    }
                }
                if (mp.apy_net == null && mp.apy_base != null) {
                    const bonusSupply = mp.apy_rewards || 0;
                    const baseYield = (mp.apy_base + bonusSupply) * (mp.asset_usd || 0);
                    mp.apy_net = mp.net_usd > 0 ? baseYield / mp.net_usd : mp.apy_base;
                }
                normalizeSourceMeta(mp);
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

            // Compute borrow_tokens_display
            const borrowSymbols = (p.borrow || []).map(t => t.symbol).filter(Boolean);
            p.borrow_tokens_display = borrowSymbols.join(', ') || '-';

            // Ensure protocol field is populated for frontend display
            p.protocol = p.protocol_name || p.protocol_id || p.protocol_canonical || p.protocol_display || '-';

            // Pendle V1: keep direct scanner rows and unresolved fallback rows clearly separated.
            const pid = String(p.protocol_id || '').toLowerCase();
            if (pid === 'pendle-pt' || pid === 'pendle-yt' || pid === 'pendle-lp') {
                p.pendle_status = 'direct';
                p.strategy = p.strategy || pid;
            } else if (pid === 'pendle2' || pid === 'arb_pendle2' || pid === 'plasma_pendle2') {
                p.pendle_status = 'fallback';
                p.source_type = 'fallback';
                p.protocol_name = 'Pendle Fallback';
                if (!p.asset_type) p.asset_type = 'Pendle Fallback';
            }
            promoteCanonicalYieldRows(p, stables, vaults);
            finalizeSourceMeta(p);
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
