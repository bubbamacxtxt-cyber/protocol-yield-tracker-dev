#!/usr/bin/env node
/**
 * Exposure coverage audit.
 *
 * Writes data/exposure-audit.json with:
 *   - per-confidence decomposed value
 *   - stale YBS feeds (cache age > 72h)
 *   - unknown positions (kind='unknown' rows)
 *   - adapter_health snapshot
 *
 * Called from free-scans-hourly after build-exposure and referenced by
 * audit.html.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'yield-tracker.db');
const OUT_PATH = path.join(__dirname, '..', 'data', 'exposure-audit.json');

function run() {
  const db = new Database(DB_PATH, { readonly: false });

  // Total tracked value = sum of positions that *should* have been decomposed
  // (net_usd >= 50000, matches build-exposure.js filter). We then compare to
  // the sum of depth-0 decomposition rows below.
  const totalRow = db.prepare('SELECT COUNT(*) as n, SUM(net_usd) as t FROM positions WHERE net_usd >= 50000').get();
  const totalValue = Number(totalRow.t || 0);
  const totalCount = Number(totalRow.n || 0);

  // Positions that have a decomposition but fall outside the filter (e.g. got
  // decomposed in an older run) should not inflate coverage. We cap
  // decomposedValue at totalValue for display, but keep raw number available.


  // Decomposed: depth 0 rows (one per position, root of its tree).
  const rootRows = db.prepare(`
    SELECT e.position_id, e.kind, e.confidence, e.adapter, e.usd,
           p.protocol_name, p.net_usd
    FROM exposure_decomposition e
    JOIN positions p ON p.id = e.position_id
    WHERE e.depth = 0
  `).all();

  const byConfidence = { high: 0, medium: 0, low: 0 };
  let decomposedValue = 0;
  let opaqueValue = 0;
  let unknownValue = 0;
  const unknownPositions = [];

  const positionRootKind = new Map();
  for (const r of rootRows) {
    if (!positionRootKind.has(r.position_id)) {
      positionRootKind.set(r.position_id, { kind: r.kind, confidence: r.confidence, adapter: r.adapter, protocol: r.protocol_name, usd: r.net_usd });
    } else {
      const prev = positionRootKind.get(r.position_id);
      prev.usd = Math.max(prev.usd, r.net_usd);
    }
    decomposedValue += r.usd;
    byConfidence[r.confidence] = (byConfidence[r.confidence] || 0) + r.usd;
    if (r.kind === 'opaque_offchain') opaqueValue += r.usd;
    if (r.kind === 'unknown') {
      unknownValue += r.usd;
      unknownPositions.push({ position_id: r.position_id, protocol: r.protocol_name, usd: r.net_usd });
    }
  }

  // Only count root-row USD up to the position's own net_usd; this prevents
  // adapters that emit >100% of root (e.g. secondary-risk lens where pro-rata
  // can exceed 100% of asset for leveraged positions) from inflating coverage.
  const positionsDecomposedRow = db.prepare(`
    SELECT COUNT(DISTINCT e.position_id) as n,
           SUM(p.net_usd) as t
    FROM exposure_decomposition e
    JOIN positions p ON p.id = e.position_id
    WHERE e.depth = 0 AND p.net_usd >= 50000
  `).get();
  const positionsDecomposedCount = Number(positionsDecomposedRow.n || 0);
  const positionsDecomposedValue = Number(positionsDecomposedRow.t || 0);
  const coveragePct = totalValue > 0 ? Math.min(100, (positionsDecomposedValue / totalValue) * 100) : 0;

  // YBS staleness
  const ybsCache = db.prepare('SELECT token_address, chain, fetched_at FROM ybs_backing_cache').all();
  const staleYbs = ybsCache.filter(r => {
    const age = Date.now() - new Date(r.fetched_at).getTime();
    return age > 72 * 3600 * 1000;
  }).map(r => ({
    token_address: r.token_address,
    chain: r.chain,
    last_fresh: r.fetched_at,
    age_hours: Math.round((Date.now() - new Date(r.fetched_at).getTime()) / 3600000),
  }));

  // Adapter health snapshot. Decorate each row with a derived
  // `status` field so the audit UI can distinguish transient historical
  // errors (last_success > last_error) from currently-failing adapters.
  const healthRows = db.prepare(`
    SELECT adapter, last_run, last_success, last_error, last_error_msg,
           positions_handled, errors, runs
    FROM adapter_health
    ORDER BY adapter
  `).all();
  const health = healthRows.map(h => {
    const lastSuccess = h.last_success ? new Date(h.last_success).getTime() : 0;
    const lastError = h.last_error ? new Date(h.last_error).getTime() : 0;
    let status;
    if (!h.last_run) status = 'never_run';
    else if (!lastError) status = 'healthy';
    else if (lastSuccess > lastError) status = 'recovered';
    else status = 'failing';
    return { ...h, status };
  });

  // Per-adapter decomposed value (from root rows)
  const byAdapter = {};
  for (const r of rootRows) {
    if (!byAdapter[r.adapter]) byAdapter[r.adapter] = { value: 0, positions: 0, high: 0, medium: 0, low: 0 };
    byAdapter[r.adapter].value += r.usd;
    byAdapter[r.adapter].positions += 1;
    byAdapter[r.adapter][r.confidence] = (byAdapter[r.adapter][r.confidence] || 0) + r.usd;
  }

  // Top 20 systemic final-asset exposures (deepest leaves — asset_symbol populated)
  const topExposures = db.prepare(`
    SELECT asset_symbol, asset_address, chain, SUM(usd) as total_usd, COUNT(*) as row_count
    FROM exposure_decomposition
    WHERE asset_symbol IS NOT NULL AND kind IN ('primary_asset', 'market_exposure', 'lp_underlying', 'pendle_underlying', 'ybs_strategy')
    GROUP BY asset_symbol, chain
    ORDER BY total_usd DESC
    LIMIT 20
  `).all();

  const audit = {
    generated_at: new Date().toISOString(),
    total_value: totalValue,
    total_positions: totalCount,
    positions_decomposed: positionsDecomposedCount,
    positions_missing_decomposition: Math.max(0, totalCount - positionsDecomposedCount),
    decomposed_value: positionsDecomposedValue,
    decomposition_rows_usd: decomposedValue,
    coverage_pct: Number(coveragePct.toFixed(2)),
    opaque_offchain_value: opaqueValue,
    unknown_value: unknownValue,
    by_confidence: byConfidence,
    by_adapter: byAdapter,
    unknown_positions: unknownPositions,
    stale_ybs_feeds: staleYbs,
    adapter_health: health,
    top_systemic_exposures: topExposures,
    acceptance: {
      coverage_pass: coveragePct >= 99.5,
      no_large_unknowns: unknownPositions.filter(u => u.usd > 50000).length === 0,
      no_stale_ybs: staleYbs.length === 0,
    },
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(audit, null, 2));
  console.log(`[audit] coverage=${audit.coverage_pct}% decomposed=$${(decomposedValue/1e6).toFixed(1)}M / total=$${(totalValue/1e6).toFixed(1)}M`);
  console.log(`[audit] opaque=$${(opaqueValue/1e6).toFixed(1)}M unknown=$${(unknownValue/1e6).toFixed(1)}M stale_ybs=${staleYbs.length}`);
  console.log(`[audit] written to ${OUT_PATH}`);

  db.close();

  // Hard fail if coverage gate broken (used by CI)
  const strict = process.argv.includes('--strict');
  if (strict) {
    if (!audit.acceptance.coverage_pass) {
      console.error(`[audit] FAIL: coverage ${audit.coverage_pct}% < 99.5%`);
      process.exit(2);
    }
    if (!audit.acceptance.no_large_unknowns) {
      console.error(`[audit] FAIL: ${audit.unknown_positions.length} unknown positions, largest $${Math.max(...audit.unknown_positions.map(u=>u.usd))}`);
      process.exit(2);
    }
  }
  return audit;
}

if (require.main === module) {
  try { run(); } catch (err) { console.error(err); process.exit(1); }
}

module.exports = { run };
