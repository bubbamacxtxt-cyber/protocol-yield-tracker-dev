#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const OUT_PATH = path.join(__dirname, '..', 'data', 'source-audit.json');
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'protocol-registry.json');

function loadRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')).protocols || {};
  } catch {
    return {};
  }
}

function classifySource(row) {
  const pid = String(row.protocol_id || '').toLowerCase();
  const pname = String(row.protocol_name || '').toLowerCase();
  const wallet = String(row.wallet || '').toLowerCase();

  if (wallet === 'off-chain') return { source_type: 'manual', confidence: 'medium', normalization_status: 'canonical' };
  if (pid === 'pendle-pt' || pid === 'pendle-yt' || pid === 'pendle-lp') return { source_type: 'scanner', confidence: 'high', normalization_status: 'canonical' };
  if (pid === 'pendle2' || pid === 'arb_pendle2' || pid === 'plasma_pendle2') return { source_type: 'fallback', confidence: 'low', normalization_status: 'unresolved' };
  if (pname.includes('aave') || pname.includes('morpho') || pname.includes('euler') || pname.includes('fluid') || pid.includes('aave') || pid.includes('morpho') || pid.includes('euler') || pid.includes('fluid')) {
    return { source_type: 'scanner', confidence: 'high', normalization_status: 'canonical' };
  }
  return { source_type: 'fallback', confidence: 'medium', normalization_status: 'partial' };
}

function canonicalProtocolKey(row, registry) {
  const pid = String(row.protocol_id || '').toLowerCase();
  const pname = String(row.protocol_name || '');
  for (const [key, entry] of Object.entries(registry)) {
    if ((entry.aliases || []).includes(pid)) return key;
    if ((entry.name_aliases || []).includes(pname)) return key;
  }
  return pid || String(pname || '').toLowerCase().replace(/\s+/g, '-');
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const registry = loadRegistry();
  const rows = db.prepare('SELECT wallet, chain, protocol_id, protocol_name, net_usd, asset_usd, debt_usd FROM positions').all();

  const bySource = {};
  const byProtocol = {};
  const byProtocolSource = {};
  let unresolvedFallbackUsd = 0;
  let unresolvedFallbackPositions = 0;

  for (const row of rows) {
    const meta = classifySource(row);
    const protocolKey = canonicalProtocolKey(row, registry);
    const usd = Number(row.net_usd || 0);

    bySource[meta.source_type] ||= { positions: 0, net_usd: 0 };
    bySource[meta.source_type].positions += 1;
    bySource[meta.source_type].net_usd += usd;

    byProtocol[protocolKey] ||= { positions: 0, net_usd: 0 };
    byProtocol[protocolKey].positions += 1;
    byProtocol[protocolKey].net_usd += usd;

    const psKey = `${protocolKey}:${meta.source_type}`;
    byProtocolSource[psKey] ||= { protocol: protocolKey, source_type: meta.source_type, positions: 0, net_usd: 0, normalization_status: meta.normalization_status };
    byProtocolSource[psKey].positions += 1;
    byProtocolSource[psKey].net_usd += usd;

    if (meta.source_type === 'fallback' && meta.normalization_status === 'unresolved') {
      unresolvedFallbackUsd += usd;
      unresolvedFallbackPositions += 1;
    }
  }

  const data = {
    generated_at: new Date().toISOString(),
    summary: {
      total_positions: rows.length,
      unresolved_fallback_positions: unresolvedFallbackPositions,
      unresolved_fallback_usd: unresolvedFallbackUsd
    },
    by_source_type: bySource,
    by_protocol: byProtocol,
    by_protocol_source: Object.values(byProtocolSource).sort((a, b) => b.net_usd - a.net_usd)
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2));
  console.log(`Wrote ${OUT_PATH}`);
  console.log(JSON.stringify(data.summary, null, 2));
  db.close();
}

main();
