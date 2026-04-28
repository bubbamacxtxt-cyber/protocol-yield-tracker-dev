// ═══════════════════════════════════════════════════════════════
// WHALE-COMMON.JS — shared rendering engine for all whale pages
// Single source of truth for COLUMNS, CARDS, formatters, renderers
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// SINGLE SOURCE OF TRUTH — columns define field mappings
// Table and cards both derive from this config
// ═══════════════════════════════════════════════════════════════
const COLUMNS = [
  { key: 'wallet',     label: 'Wallet',        field: 'wallet',          render: v => '<a href="https://debank.com/profile/' + v + '" target="_blank" style="color:var(--accent-blue);text-decoration:none">' + shortWallet(v) + '</a>', sortable: true },
  { key: 'chain',      label: 'Chain',         field: 'chain',           render: v => (v || '').toUpperCase() },
  { key: 'protocol',   label: 'Protocol',      field: 'protocol_name' },
  { key: 'strategy',   label: 'Strategy',      field: 'strategy',        render: (v, p) => strategyBadge(v, p) },
  { key: 'supply',     label: 'Supply Tokens', field: 'supply_tokens_display' },
  { key: 'borrow',     label: 'Borrow Tokens', field: 'borrow',          render: v => (v || []).map(t => t.symbol).filter(Boolean).join(', ') || '-' },
  { key: 'supply_usd', label: 'Supply USD',    field: 'asset_usd',       format: 'usd_short', align: 'right' },
  { key: 'borrow_usd', label: 'Borrow USD',    field: 'debt_usd',        format: 'usd_short', align: 'right' },
  { key: 'net_usd',    label: 'Net USD',       field: 'net_usd',         format: 'usd_short', align: 'right', bold: true, color: 'green' },
  { key: 'base_apy',   label: 'Base APY',      field: 'apy_base',        format: 'pct', align: 'right' },
  { key: 'bonus_apy',  label: 'Bonus APY',     field: 'bonus_total',     format: 'bonus', align: 'right', color: 'green' },
  { key: 'cost_apy',   label: 'Cost APY',      field: 'apy_cost',        format: 'pct', align: 'right' },
  { key: 'net_apy',    label: 'Net APY',       field: 'apy_net',         format: 'pct', align: 'right', bold: true, color_dynamic: true },
  { key: 'health',     label: 'Health Factor',  field: 'health_rate',     render: v => v ? fmtHF(v) : '-', compute_class: p => hfClass(p.health_rate), align: 'right' },
];

// Cards derive from same field keys as COLUMNS
const CARDS = [
  { label: 'Total Value', field: 'net_usd',    aggregate: 'sum',     format: 'usd_short', color: 'green', subtitle: d => d.length + ' positions' },
  { label: 'Net APY',     field: 'apy_net',    aggregate: 'wavg',    weight: 'asset_usd', format: 'pct', color: 'blue', subtitle: () => 'weighted avg' },
  { label: 'Health Factor', field: 'health_rate', aggregate: 'avg', filter: p => p.health_rate > 0 && p.health_rate < 1000, format: 'num', render_class: v => hfClass(v), color: 'purple', subtitle: d => { const valid = d.filter(p => p.health_rate > 0 && p.health_rate < 1000); const avg = valid.length ? valid.reduce((s,p) => s + p.health_rate, 0) / valid.length : 0; return avg >= 1.1 ? 'Safe' : '⚠️ Below 1.1'; } },
];

// ═══════════════════════════════════════════════════════════════
// FIELD RESOLUTION — shared by table AND cards
// ═══════════════════════════════════════════════════════════════
function getFieldValue(position, col) {
  if (col.compute) return col.compute(position);
  const val = position[col.field];
  if ((val === undefined || val === null) && col.fallback) return position[col.fallback];
  return val;
}

function resolveFieldKey(key) {
  return COLUMNS.find(c => c.key === key);
}

// ═══════════════════════════════════════════════════════════════
// FORMATTERS
// ═══════════════════════════════════════════════════════════════
function fmt(n) {
  if (n === null || n === undefined) return '-';
  return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtShort(n) {
  if (n === null || n === undefined) return '-';
  if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(2);
}

function formatValue(val, format, render, row) {
  if (render) return render(val, row);
  switch (format) {
    case 'usd_short': return fmtShort(val);
    case 'usd': return fmt(val);
    case 'pct': return val != null ? val.toFixed(2) + '%' : '-';
    case 'bonus': return val > 0 ? '+' + val.toFixed(2) + '%' : '';
    case 'num': return val != null ? val.toFixed(2) : '-';
    default: return val ?? '-';
  }
}

function fmtHF(n) {
  if (!n) return "-";
  return Number(n).toExponential(3).split("e")[0];
}

function hfClass(hf) {
  if (!hf || hf === 0) return '';
  if (hf >= 1.5) return 'hf-safe';
  if (hf >= 1.1) return 'hf-warn';
  return 'hf-danger';
}

function strategyBadge(s, p) {
  const label = s || '';
  const cls = { Loop: 'badge-loop', Lend: 'badge-lend', Farm: 'badge-farm', Stake: 'badge-stake', LP: 'badge-lp', rwa: 'badge-stake' }[label] || 'badge-illiquid';
  let html = label ? '<span class="badge ' + cls + '">' + label + '</span>' : '-';
  if (p && p.source_type === 'fallback') {
    html += ' <span class="badge badge-illiquid">Fallback</span>';
  } else if (p && p.source_type === 'protocol_api') {
    html += ' <span class="badge badge-liquid">Canonical</span>';
  } else if (p && p.source_type === 'scanner') {
    html += ' <span class="badge badge-loop">Direct</span>';
  }
  return html;
}

function shortWallet(addr) {
  if (!addr) return '-';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

// ═══════════════════════════════════════════════════════════════
// RENDER TABLE — driven entirely by COLUMNS config
// ═══════════════════════════════════════════════════════════════
function renderTable(data) {
  const header = document.getElementById('tableHeader');
  header.innerHTML = COLUMNS.map(c => '<th>' + c.label + '</th>').join('');

  const body = document.getElementById('positionsBody');
  if (data.length === 0) {
    body.innerHTML = '<tr><td colspan="' + COLUMNS.length + '" style="text-align:center;padding:40px;color:var(--text-secondary)">No positions match your filters</td></tr>';
    return;
  }

  body.innerHTML = data.map(p => {
    const cells = COLUMNS.map(c => {
      const val = getFieldValue(p, c);
      const display = formatValue(val, c.format, c.render, p);
      const style = [];
      if (c.bold) style.push('font-weight:600');
      if (c.color === 'green') style.push('color:var(--accent-green)');
      if (c.color === 'blue') style.push('color:var(--accent-blue)');
      if (c.color_dynamic) {
        const nc = val > 0 ? 'var(--accent-green)' : val < 0 ? '#f85149' : 'var(--text-secondary)';
        style.push('color:' + nc);
      }
      if (c.compute_class) style.push(c.compute_class(p));
      const align = c.align === 'right' ? 'text-align:right' : '';
      var allStyles = [...style]; if (align) allStyles.push(align);
  return '<td style="' + allStyles.join(';') + '">' + display + '</td>';
    }).join('');

    const detailData = JSON.stringify(p).replace(/"/g, '&quot;').replace(/</g, '\u003c');
    return '<tr onclick="showDetail(' + detailData + ')" style="cursor:pointer">' + cells + '</tr>';
  }).join('');
}

// ═══════════════════════════════════════════════════════════════
// RENDER CARDS — derived from same field keys as COLUMNS
// ═══════════════════════════════════════════════════════════════
function renderCards(data) {
  const cardsHtml = CARDS.map(card => {
    let value, subtitle, topEntry = null;
    if (card.aggregate === 'custom') {
      value = card.fn(data);
      subtitle = card.subtitle(data);
    } else if (card.aggregate === 'sum') {
      value = data.reduce((s, p) => s + (p[card.field] || 0), 0);
      subtitle = card.subtitle(data);
    } else if (card.aggregate === 'wavg') {
      const wf = card.weight;
      const tw = data.reduce((s, p) => s + (p[wf] || 0), 0);
      value = tw > 0 ? data.reduce((s, p) => s + ((p[card.field] || 0) * (p[wf] || 0)), 0) / tw : 0;
      subtitle = card.subtitle(data);
    } else if (card.aggregate === 'avg') {
      const filtered = card.filter ? data.filter(card.filter) : data;
      value = filtered.length > 0 ? filtered.reduce((s, p) => s + (p[card.field] || 0), 0) / filtered.length : 0;
      subtitle = card.subtitle(filtered.length > 0 ? filtered : data);
    } else if (card.aggregate === 'count_unique') {
      value = new Set(data.map(p => p[card.field])).size;
      subtitle = card.subtitle(data);
    } else if (card.aggregate === 'top') {
      const col = resolveFieldKey(card.field);
      const grouped = new Map();
      data.forEach(p => {
        const k = getFieldValue(p, col);
        grouped.set(k, (grouped.get(k) || 0) + (p[card.sort_field] || 0));
      });
      const sorted = [...grouped.entries()].sort((a, b) => b[1] - a[1]);
      topEntry = sorted[0];
      value = topEntry ? (card.render ? card.render(topEntry[0]) : topEntry[0]) : '-';
      subtitle = card.subtitle(data, topEntry ? { key: topEntry[0], sum: topEntry[1] } : null);
    }

    let display;
    if (card.aggregate === 'top' && topEntry) {
      display = value;
    } else {
      display = formatValue(value, card.format, card.render);
    }

    const renderClass = card.render_class ? card.render_class(value) : '';
    const colorClass = card.color ? ' ' + card.color : '';
    const sub = typeof subtitle === 'function' ? subtitle(data) : subtitle;

    return '<div class="card">' +
      '<div class="card-label">' + card.label + '</div>' +
      '<div class="card-value' + colorClass + ' ' + renderClass + '">' + display + '</div>' +
      '<div class="card-sub">' + (sub || '') + '</div>' +
    '</div>';
  }).join('');

  // Render wallet card as an additional .card in the grid
  let walletCardHtml = '';
  const whale = WHALE_INFO;
  if (whale && whale.wallets && whale.wallets.length) {
    const allWallets = whale.wallets;
    const unique = [...new Set(allWallets.map(w => w.toLowerCase()))];
    const walletValue = {};
    (whale.positions||[]).forEach(p => {
      const addr = (p.wallet||'').toLowerCase();
      walletValue[addr] = (walletValue[addr]||0) + (p.net_usd||0);
    });
    const THRESHOLD = 50000;
    const sorted = [...unique].sort((a,b) => {
      const av = walletValue[a]||0, bv = walletValue[b]||0;
      return (bv >= THRESHOLD) - (av >= THRESHOLD) || bv - av;
    });
    const activeCount = sorted.filter(a => (walletValue[a]||0) >= THRESHOLD).length;
    const items = sorted.map(addr => {
      const val = walletValue[addr]||0;
      const active = val >= THRESHOLD;
      const color = active ? 'var(--accent-green)' : '#f85149';
      return '<a href="https://debank.com/profile/'+addr+'" target="_blank" style="'
        +'display:flex;align-items:center;gap:6px;padding:6px 0;text-decoration:none;font-size:13px;">'
        +'<span style="width:8px;height:8px;border-radius:50%;background:'+color+';flex-shrink:0"></span>'
        +'<span style="color:var(--text-primary);font-family:monospace">'+shortWallet(addr)+'</span>'
        +'<span style="color:var(--text-secondary);margin-left:auto;font-size:12px">'+(active?'$'+fmtShort(val):'—')+'</span>'
        +'</a>';
    }).join('');
    walletCardHtml = '<div class="card">'
      +'<div class="card-label">Wallets</div>'
      +'<div class="card-value green">'+activeCount+'<span style="font-size:14px;font-weight:400;color:var(--text-secondary);margin-left:6px">/ '+unique.length+'</span></div>'
      +'<div class="card-sub" style="max-height:80px;overflow-y:auto;margin-top:8px;display:flex;flex-direction:column;gap:2px">'
      +items
      +'</div></div>';
  }
  document.getElementById('summaryCards').innerHTML = cardsHtml + walletCardHtml;

  const grouped = new Map();
  data.forEach(p => {
    const k = getFieldValue(p, protocolCol);
    const existing = grouped.get(k) || { count: 0, value: 0 };
    grouped.set(k, { count: existing.count + 1, value: existing.value + (p.net_usd || 0) });
  });
  const protoHtml = [...grouped.entries()].map(([name, { count, value }]) =>
    '<div class="proto-chip"><strong>' + name + '</strong> ' + count + ' pos · ' + fmtShort(value) + '</div>'
  ).join('');
  document.getElementById('protoSummary').innerHTML = protoHtml;
}

// ═══════════════════════════════════════════════════════════════
// FILTERS
// ═══════════════════════════════════════════════════════════════
function buildFilters() {
  const chainEl = document.getElementById('chainFilter');
  const protoEl = document.getElementById('protoFilter');
  chains.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c.toUpperCase();
    chainEl.appendChild(opt);
  });
  protos.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p; opt.textContent = p;
    protoEl.appendChild(opt);
  });
}

function filterPositions() {
  const chain = document.getElementById('chainFilter').value;
  const proto = document.getElementById('protoFilter').value;
  const search = document.getElementById('searchFilter').value.toLowerCase().trim();

  let data = positions;
  if (chain !== 'all') data = data.filter(p => p.chain === chain);
  if (proto !== 'all') data = data.filter(p => getFieldValue(p, protocolCol) === proto);
  if (search) {
    data = data.filter(p =>
      (p.wallet || '').toLowerCase().includes(search) ||
      String(getFieldValue(p, protocolCol) || '').toLowerCase().includes(search) ||
      (p.protocol_name || '').toLowerCase().includes(search) ||
      (p.borrow || []).some(t => (t.symbol || '').toLowerCase().includes(search)) ||
      (p.strategy || '').toLowerCase().includes(search)
    );
  }

  const hasPositiveAaveContext = new Set(
    data
      .filter(p => String(getFieldValue(p, protocolCol) || '').includes('Aave') && (p.asset_usd || 0) > 0)
      .map(p => `${String(p.wallet || '').toLowerCase()}|${p.chain}`)
  );

  data = data.filter(p => {
    const isAave = String(getFieldValue(p, protocolCol) || '').includes('Aave');
    const borrowOnly = (p.asset_usd || 0) === 0 && (p.debt_usd || 0) > 0 && (!p.supply || p.supply.length === 0 || p.supply_tokens_display === '-');
    if (isAave && borrowOnly && hasPositiveAaveContext.has(`${String(p.wallet || '').toLowerCase()}|${p.chain}`)) return false;
    return true;
  });

  return data.sort((a, b) => (b.net_usd || 0) - (a.net_usd || 0));
}

function updateView() {
  const data = filterPositions();
  renderCards(data);
  renderTable(data);
  renderExposureSection(WHALE_INFO, data);
}

// ═══════════════════════════════════════════════════════════════
// XLSX EXPORT
// ═══════════════════════════════════════════════════════════════
function downloadXLSX() {
  const rows = positions.map(p => ({
    Wallet: p.wallet,
    Chain: p.chain,
    Protocol: getFieldValue(p, protocolCol),
    Strategy: p.strategy,
    SupplyTokens: (p.supply || []).map(t => t.symbol).join(', '),
    BorrowTokens: (p.borrow || []).map(t => t.symbol).join(', '),
    SupplyUSD: p.asset_usd,
    BorrowUSD: p.debt_usd,
    NetUSD: p.net_usd,
    BaseAPY: p.apy_base,
    BonusSupply: p.bonus_supply,
    BonusBorrow: p.bonus_borrow,
    CostAPY: p.apy_cost,
    NetAPY: p.apy_net,
    HealthFactor: p.health_rate,
    ScanTime: p.scanned_at,
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Positions');
  ws['!cols'] = [
    { wch: 44 }, { wch: 10 }, { wch: 20 }, { wch: 10 },
    { wch: 40 }, { wch: 40 },
    { wch: 16 }, { wch: 16 }, { wch: 16 },
    { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
    { wch: 22 },
  ];
  XLSX.writeFile(wb, (WHALE_NAME || 'whale').toLowerCase().replace(/\s+/g, '-') + '_positions.xlsx');
}

// ═══════════════════════════════════════════════════════════════
// DETAIL MODAL
// ═══════════════════════════════════════════════════════════════
function showDetail(p) {
  const modal = document.getElementById('detail-modal');
  if (!modal) return;

  let supplyDetail = (p.supply || []).map(t => {
    let info = t.symbol + ': ' + (t.apy_base || 0).toFixed(2) + '% base';
    if (t.bonus_supply_apy) info += ' + ' + (t.bonus_supply_apy).toFixed(2) + '%';
    return info;
  }).join('<br>');

  let borrowDetail = (p.borrow || []).map(t => {
    let info = t.symbol + ': ' + (t.apy_base || 0).toFixed(2) + '% cost';
    if (t.bonus_borrow_apy) info += ' \u2212 ' + (t.bonus_borrow_apy).toFixed(2) + '%';
    return info;
  }).join('<br>');

  // Leverage display — useful for vault positions with supply + borrow
  const supplyUsd = p.asset_usd || 0;
  const debtUsd = p.debt_usd || 0;
  const equity = supplyUsd - debtUsd;
  const lev = (supplyUsd > 0 && debtUsd > 0 && equity > 0) ? (supplyUsd / equity).toFixed(2) + 'x' : '-';
  const leverageNum = supplyUsd > 0 && equity > 0 ? supplyUsd / equity : 0;
  const hf = p.health_rate ? fmtHF(p.health_rate) : '-';
  const isLeveraged = supplyUsd > 0 && debtUsd > 0 && equity > 0;
  const baseApy = p.apy_base || 0;
  const bonusApy = p.bonus_supply || 0;
  const costApy = p.apy_cost || 0;
  const netApy = p.apy_net || 0;
  // For leveraged positions: show spread & leverage breakdown above APYs
  const leverageBreakdown = isLeveraged
    ? '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center;padding:10px 14px;background:rgba(79,172,254,0.1);border-radius:8px;margin-bottom:16px;font-size:12px">'
      + '<div><div style="color:var(--text-secondary)">Supply $</div><div style="font-weight:600">' + fmtShort(supplyUsd) + '</div></div>'
      + '<div><div style="color:var(--text-secondary)">Borrow $</div><div style="font-weight:600">' + fmtShort(debtUsd) + '</div></div>'
      + '<div><div style="color:var(--text-secondary)">Leverage</div><div style="font-weight:600">' + lev + '</div></div>'
      + '<div><div style="color:var(--text-secondary)">Sup APY</div><div style="font-weight:600">' + (baseApy + bonusApy).toFixed(2) + '%</div></div>'
      + '<div><div style="color:var(--text-secondary)">Bor APY</div><div style="font-weight:600">' + costApy.toFixed(2) + '%</div></div>'
      + '<div><div style="color:var(--text-secondary)">Spread</div><div style="font-weight:600">' + ((baseApy + bonusApy) - costApy).toFixed(2) + '%</div></div>'
      + '<div style="grid-column:1/-1;color:var(--text-secondary);font-size:11px">' + (baseApy + bonusApy).toFixed(2) + '% × ' + lev + ' − ' + costApy.toFixed(2) + '% × ' + (leverageNum - 1).toFixed(2) + ' = <b>' + netApy.toFixed(2) + '% net</b></div>'
      + '</div>'
    : '';

  modal.innerHTML =
    '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:600px;margin:50px auto">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">' +
      '<h3 style="margin:0">' + getFieldValue(p, protocolCol) + ' \u2014 ' + (p.supply ? p.supply.map(t => t.symbol).join('/') : (p.symbol || '')) + '</h3>' +
      '<div style="font-size:12px;color:var(--text-secondary);margin-top:4px">' + (p.source_type || 'unknown') + ' \u00b7 ' + (p.normalization_status || 'unknown') + (p.exposure_class ? ' \u00b7 ' + p.exposure_class : '') + '</div>' +
      '<button onclick="document.getElementById(&quot;detail-modal&quot;).style.display=&quot;none&quot;" style="background:none;border:none;color:var(--text-secondary);font-size:20px;cursor:pointer;">\u00d7</button>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">' +
      '<div><div style="color:var(--text-secondary);font-size:12px">Supply tokens</div><div style="font-size:13px">' + (supplyDetail || '-') + '</div></div>' +
      '<div><div style="color:var(--text-secondary);font-size:12px">Borrow tokens</div><div style="font-size:13px">' + (borrowDetail || '-') + '</div></div>' +
    '</div>' +
    leverageBreakdown +
    '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;text-align:center;margin-bottom:16px">' +
      '<div><div style="color:var(--text-secondary);font-size:12px">Base APY</div><div style="font-size:18px;font-weight:600">' + baseApy.toFixed(2) + '%</div></div>' +
      '<div><div style="color:var(--text-secondary);font-size:12px">Bonus Supply</div><div style="font-size:18px;font-weight:600;color:var(--accent-green)">+' + bonusApy.toFixed(2) + '%</div></div>' +
      '<div><div style="color:var(--text-secondary);font-size:12px">Cost APY</div><div style="font-size:18px;font-weight:600">' + costApy.toFixed(2) + '%</div></div>' +
      '<div><div style="color:var(--text-secondary);font-size:12px">Health</div><div style="font-size:18px;font-weight:600">' + hf + '</div></div>' +
    '</div>' +
    '<div style="text-align:center;margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">' +
      '<div style="color:var(--text-secondary);font-size:12px">Net APY</div>' +
      '<div style="font-size:28px;font-weight:700;color:' + (netApy > 0 ? 'var(--accent-green)' : '#f85149') + '">' + netApy.toFixed(2) + '%</div>' +
    '</div>' +
    '</div>';
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:1000;display:flex;align-items:start;justify-content:center;background:rgba(0,0,0,0.7)';
  modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
}

function fmtUsd(v) {
  if (v == null) return '-';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
  return '$' + Math.round(v);
}

// ═══════════════════════════════════════════════════════════════
// TOKEN LABEL NORMALISATION (de-dup USDe/USDE etc. on donuts)
// ═══════════════════════════════════════════════════════════════
const TOKEN_ALIAS_MAP = {
  'usde': 'USDe',     // Aave vs DeFiLlama casing
  'usdtb': 'USDTB',
  'xaut0': 'XAUt0',
  'wmnt': 'MNT',
  'fbtc': 'FBTC',
  'cbeth': 'cbETH',
  'wbtc': 'WBTC',
  'weth': 'WETH',
  'wsteth': 'wstETH',
  'weeth': 'weETH',
};
function normaliseTokenLabel(label) {
  const key = String(label || '').toLowerCase().trim();
  return TOKEN_ALIAS_MAP[key] || label;
}

// ═══════════════════════════════════════════════════════════════
// EXPOSURE SECTION (per-whale, per-position lookthrough)
// Driven by w.exposure_rollup + p.exposure_tree from src/exposure/.
// ═══════════════════════════════════════════════════════════════
const EXPOSURE_PALETTE = [
  '#4facfe', '#00f2fe', '#4ade80', '#a371f7',
  '#d29922', '#f093fb', '#58a6ff', '#43e97b',
  '#f85149', '#bc8cff', '#5a9eda', '#22d3ee',
];

// When a sub-vault page is active (VAULT_NAME set), recompute the exposure
// rollup from that vault's positions so donuts reflect only the visible
// vault, not the whole whale. Overview pages keep the pre-computed whale
// rollup from data.json.
function computeExposureRollupFromPositions(positions) {
  const byProto = new Map();
  const byToken = new Map();
  const byMarket = new Map();
  // ── Token name normalisation (de-dup USDe/USDE, XAUt/XAUt0, etc.) ──
  const canonicalTokenName = (() => {
    const map = {
      'usde': 'USDe',
      'usdtb': 'USDTB',
      'xaut0': 'XAUt0',
      'xaut': 'XAUt',
      'wmnt': 'MNT',
      'fbtc': 'FBTC',
      'cbeth': 'cbETH',
      'wbtc': 'WBTC',
      'weth': 'WETH',
      'wsteth': 'wstETH',
      'weeth': 'weETH',
    };
    return label => {
      const key = label.toLowerCase();
      return map[key] || label;
    };
  })();

  const add = (map, label, usd) => {
    if (!label || !usd) return;
    const key = normaliseTokenLabel(label);
    map.set(key, (map.get(key) || 0) + usd);
  };
  for (const p of positions) {
    const tree = p.exposure_tree || [];
    for (const row of tree) {
      // Leaves only — no parent sums.
      const hasChildren = tree.some(r => r.parent_id === row.id);
      if (hasChildren) continue;
      const label = row.asset_symbol || row.venue || '(unknown)';
      const usd = Number(row.usd || 0);
      add(byToken, label, usd);
      const proto = row.venue || row.adapter || '(unknown)';
      add(byProto, proto, usd);
      const market = row.venue_address
        ? (row.venue || '(market)')
        : (row.venue || '(unknown)');
      add(byMarket, market, usd);
    }
  }
  const toRows = m => [...m.entries()].map(([label, usd]) => ({ label, usd })).sort((a, b) => b.usd - a.usd);
  return {
    by_protocol: toRows(byProto),
    by_token: toRows(byToken),
    by_market: toRows(byMarket),
  };
}

function renderExposureSection(whale, filteredPositions) {
  const section = document.getElementById('exposure-section');
  if (!section) return;

  const isVaultPage = typeof VAULT_NAME !== 'undefined' && VAULT_NAME;
  const positionsPool = (whale?.positions || []).filter(p => (p.exposure_tree || []).length > 0);

  // Scope: vault pages use the vault's positions; overview pages use all whale positions.
  const positions = isVaultPage && whale?.vaults?.[VAULT_NAME]
    ? (whale.vaults[VAULT_NAME].positions || []).filter(p => (p.exposure_tree || []).length > 0)
    : positionsPool;

  const rollup = isVaultPage
    ? computeExposureRollupFromPositions(positions)
    : (whale?.exposure_rollup || computeExposureRollupFromPositions(positionsPool));

  if (!rollup || positions.length === 0) {
    section.innerHTML = '<div class="exposure-empty">No exposure decomposition available yet. Next pipeline run will populate this.</div>';
    return;
  }

  // Total decomposed across leaves (sum of pct_of_parent at depth 1)
  const totalUsd = (rollup.by_token || []).reduce((s, t) => s + (t.usd || 0), 0);
  const totalPositionsUsd = positions.reduce((s, p) => s + (p.net_usd || 0), 0);
  const proRataPct = totalPositionsUsd > 0 ? (totalUsd / totalPositionsUsd) * 100 : 0;
  const asOf = (positions[0]?.exposure_tree || []).find(r => r.as_of)?.as_of;

  section.innerHTML = [
    '<div class="exposure-section-header">',
      '<div>',
        '<div class="tag"><span class="dot"></span> secondary-risk lookthrough</div>',
        '<h2>Final market exposure</h2>',
      '</div>',
      '<div class="meta">', asOf ? ('as of ' + new Date(asOf).toLocaleString()) : ('decomposed ' + fmtUsd(totalUsd) + ' / ' + fmtUsd(totalPositionsUsd)), ' · ', proRataPct.toFixed(1), '%</div>',
    '</div>',
    renderExposureDonuts(rollup),
    renderExposurePositions(positions, filteredPositions),
  ].join('');

  // Draw canvases after insertion
  requestAnimationFrame(() => {
    drawDonut('exp-donut-proto',  rollup.by_protocol  || [], 'label', 'usd');
    drawDonut('exp-donut-token',  rollup.by_token     || [], 'label', 'usd');
    drawDonut('exp-donut-market', rollup.by_market    || [], 'label', 'usd');
  });
}

function renderExposureDonuts(rollup) {
  const card = (id, title, tooltip, rows) => {
    const top = rows.slice(0, 8);
    const total = rows.reduce((s, r) => s + (r.usd || 0), 0);
    const tooltipText = `${title} — ${fmtUsd(total)} across ${rows.length} item${rows.length === 1 ? '' : 's'}. ${tooltip}`;
    const legend = top.length ? top.map((r, i) => {
      const color = EXPOSURE_PALETTE[i % EXPOSURE_PALETTE.length];
      const pct = total > 0 ? (r.usd / total * 100) : 0;
      return (
        '<div class="exposure-donut-legend-row">' +
          '<span class="exposure-donut-legend-swatch" style="background:' + color + '"></span>' +
          '<span class="exposure-donut-legend-label" title="' + escapeHtml(r.label) + '">' + escapeHtml(r.label) + '</span>' +
          '<span class="exposure-donut-legend-usd">' + fmtUsd(r.usd) + '</span>' +
          '<span class="exposure-donut-legend-pct">' + pct.toFixed(1) + '%</span>' +
        '</div>'
      );
    }).join('') : '<div class="exposure-donut-legend-row" style="color:var(--text-secondary);grid-column:1/-1">No data available at this level</div>';
    return (
      '<div class="exposure-donut-card" title="' + escapeHtml(tooltipText) + '">' +
        '<div class="exposure-donut-title">' + title + '</div>' +
        '<div class="exposure-donut-canvas-wrap"><canvas id="' + id + '" width="200" height="200" title="' + escapeHtml(tooltipText) + '"></canvas></div>' +
        '<div class="exposure-donut-legend">' + legend + '</div>' +
      '</div>'
    );
  };
  return (
    '<div class="exposure-donuts">' +
      card('exp-donut-proto',  'by protocol', 'Which protocols the whale holds assets in.',                rollup.by_protocol || []) +
      card('exp-donut-token',  'by token',    'Final underlying assets after recursion through each leg.', rollup.by_token || []) +
      card('exp-donut-market', 'by market',   'Which specific pools / vaults / markets the whale is in.',  rollup.by_market || []) +
    '</div>'
  );
}

function renderExposurePositions(positions, filteredPositions) {
  // Only show exposure cards for positions visible in current filter.
  const visibleIds = new Set((filteredPositions || []).map(p => p.id));
  const show = positions.filter(p => !visibleIds.size || visibleIds.has(p.id));
  if (!show.length) {
    return '<div class="exposure-empty">No positions match current filter.</div>';
  }

  const totalWhaleUsd = positions.reduce((s, p) => s + (p.net_usd || 0), 0);

  const cards = show
    .sort((a, b) => (b.net_usd || 0) - (a.net_usd || 0))
    .map(p => renderPositionExposureCard(p, totalWhaleUsd))
    .filter(Boolean)
    .join('');

  return '<div class="exposure-positions-grid">' + cards + '</div>';
}

// Strategy badge colour classes (reuse table badges from whale-common.css)
function strategyBadgeClass(strat) {
  const s = String(strat || '').toLowerCase();
  if (s === 'loop') return 'badge-loop';
  if (s === 'stake') return 'badge-stake';
  if (s === 'farm') return 'badge-farm';
  if (s === 'lp') return 'badge-lp';
  if (s === 'hold' || s === 'wallet') return 'badge-stake';
  if (s === 'rwa') return 'badge-illiquid';
  return 'badge-lend';
}

function renderPositionExposureCard(p, totalWhaleUsd) {
  const tree = p.exposure_tree || [];
  if (!tree.length) return '';
  const root = tree.find(r => r.depth === 0) || tree[0];
  const leaves = tree.filter(r => r.parent_id === root.id);

  const confClass = 'exposure-conf-' + (root.confidence || 'low');
  const pctOfWhale = totalWhaleUsd > 0 ? (p.net_usd / totalWhaleUsd * 100) : 0;

  // Pool/vault contract address for on-chain verification. Uses chain-specific
  // explorer. Address comes from the decomposition tree root (venue_address)
  // which the adapter set to the pool contract (Aave pool, Morpho vault, Curve
  // LP, Spark pool, etc.).
  const poolAddr = root.venue_address || '';
  const explorerForChain = (chain) => ({
    eth: 'https://etherscan.io',
    base: 'https://basescan.org',
    arb: 'https://arbiscan.io',
    opt: 'https://optimistic.etherscan.io',
    poly: 'https://polygonscan.com',
    bsc: 'https://bscscan.com',
    mnt: 'https://mantlescan.xyz',
    plasma: 'https://plasmascan.to',
    sonic: 'https://sonicscan.org',
    ink: 'https://explorer.inkonchain.com',
    monad: 'https://monadexplorer.com',
    avalanche: 'https://snowtrace.io',
    uni: 'https://unichain.blockscout.com',
    scroll: 'https://scrollscan.com',
  }[chain] || 'https://etherscan.io');
  const poolExplorerUrl = poolAddr && poolAddr.startsWith('0x')
    ? explorerForChain(p.chain) + '/address/' + poolAddr
    : null;
  const poolAddrShort = poolAddr && poolAddr.startsWith('0x')
    ? poolAddr.slice(0, 6).toLowerCase() + '…' + poolAddr.slice(-4)
    : '';
  const poolAddrRow = poolExplorerUrl
    ? '<div class="exposure-position-pool" style="font-size:11px;color:var(--text-secondary);margin-top:2px;font-family:monospace">pool <a href="' + poolExplorerUrl + '" target="_blank" rel="noopener" style="color:var(--accent-blue);text-decoration:none" title="' + escapeHtml(poolAddr) + '">' + poolAddrShort + ' ↗</a></div>'
    : '';

  // Pull pool metadata from root evidence (promoted by adapters in this
  // redesign so the UI doesn't have to guess).
  let ev = {};
  try {
    // exposure_tree was built from DB rows whose evidence was parsed into an
    // object by export.js. If it's a string we parse it here too.
    const rawEv = root.evidence;
    ev = typeof rawEv === 'string' ? JSON.parse(rawEv) : (rawEv || {});
  } catch {}

  const layout = ev.layout || 'lending_pool';
  const strategy = ev.strategy || p.strategy || 'lend';
  const poolTvl = Number(ev.pool_tvl_usd || 0);
  const poolBorrow = Number(ev.pool_total_borrow_usd || 0);
  const poolAvailable = Number(ev.pool_available_usd ?? Math.max(0, poolTvl - poolBorrow));
  const poolUtil = Number(ev.pool_utilization || 0);
  const walletAddr = ev.wallet || p.wallet || '';

  // Two-column leg layout for shared lending pools (Aave, Spark, Fluid,
  // Euler clusters). MetaMorpho vaults get a dedicated allocation view.
  // Everything else gets a single-column breakdown.
  const legSource = leaves.length ? leaves : [root];
  const legsSorted = legSource
    .filter(r => (r.usd || 0) > 0)
    .sort((a, b) => (b.usd || 0) - (a.usd || 0));

  const twoCol = ['lending_pool', 'cluster'].includes(layout);
  const allocationView = layout === 'metamorpho_vault';
  const isolatedView = layout === 'isolated_market';

  const collatLegs = [];
  const borrowLegs = [];
  const miscLegs = [];
  for (const leg of legsSorted) {
    let legEv = {};
    try { legEv = typeof leg.evidence === 'string' ? JSON.parse(leg.evidence) : (leg.evidence || {}); } catch {}
    const isCol = legEv.is_collateral === true;
    const isBor = legEv.is_borrowable === true;
    if (twoCol) {
      if (isCol) collatLegs.push({ leg, legEv });
      else if (isBor) borrowLegs.push({ leg, legEv });
      else miscLegs.push({ leg, legEv });
    } else {
      miscLegs.push({ leg, legEv });
    }
  }

  function renderLegRow({ leg, legEv }, mode) {
    const pct = leg.pct_of_parent != null ? leg.pct_of_parent : (p.net_usd > 0 ? (leg.usd / p.net_usd * 100) : 0);
    const barW = Math.max(1, Math.min(100, pct));
    const barClass = (leg.kind === 'opaque_offchain' || leg.kind === 'unknown') ? 'opaque' : '';
    const kindClass = 'kind-' + leg.kind;
    const label = leg.asset_symbol || leg.venue || '?';
    const addr = leg.asset_address || leg.venue_address || '';
    const addrHtml = addr && addr.startsWith('0x')
      ? ' <a href="https://etherscan.io/address/' + addr + '" target="_blank" rel="noopener" style="color:var(--accent-blue);text-decoration:none;font-size:11px" title="View on Etherscan">[chain↗]</a>'
      : '';
    const poolUsd = Number(legEv.pool_reserve_total_supply_usd || 0);
    const availUsd = Number(legEv.pool_reserve_available_usd || legEv.pool_reserve_available || 0);

    if (mode === 'collateral') {
      return (
        '<div class="exposure-leg-row ' + kindClass + '" title="' + escapeHtml(label) + ' · pool $' + fmtUsd(poolUsd) + '">' +
          '<div class="leg-label">' + escapeHtml(label) + '</div>' +
          '<div class="leg-pool-usd">' + (poolUsd > 0 ? fmtUsd(poolUsd) : '—') + '</div>' +
          '<div class="leg-pct">' + pct.toFixed(1) + '%</div>' +
          '<div class="exposure-leg-bar"><div class="exposure-leg-bar-fill ' + barClass + '" style="width:' + barW.toFixed(1) + '%"></div></div>' +
        '</div>'
      );
    }
    if (mode === 'borrowable') {
      const utilPct = poolUsd > 0 ? Math.max(0, Math.min(100, (1 - (availUsd / poolUsd)) * 100)) : 0;
      return (
        '<div class="exposure-leg-row ' + kindClass + '" title="' + escapeHtml(label) + ' · pool $' + fmtUsd(poolUsd) + ' · avail $' + fmtUsd(availUsd) + '">' +
          '<div class="leg-label">' + escapeHtml(label) + '</div>' +
          '<div class="leg-pool-usd">' + (poolUsd > 0 ? fmtUsd(poolUsd) : '—') + '</div>' +
          '<div class="leg-avail-usd">' + (availUsd > 0 ? fmtUsd(availUsd) : '—') + '</div>' +
          '<div class="leg-pct">' + utilPct.toFixed(0) + '%</div>' +
          '<div class="exposure-leg-bar"><div class="exposure-leg-bar-fill ' + barClass + '" style="width:' + utilPct.toFixed(1) + '%"></div></div>' +
        '</div>'
      );
    }
    // misc / single-column
    return (
      '<div class="exposure-leg-row ' + kindClass + '" title="' + escapeHtml(label) + '">' +
        '<div class="leg-label">' + escapeHtml(label) + '</div>' +
        '<div class="leg-usd">' + fmtUsd(leg.usd) + '</div>' +
        '<div class="leg-pct">' + pct.toFixed(1) + '%</div>' +
        '<div class="exposure-leg-bar"><div class="exposure-leg-bar-fill ' + barClass + '" style="width:' + barW.toFixed(1) + '%"></div></div>' +
      '</div>'
    );
  }

  // Build the body. Allocation view (Morpho) / two-column / single-column.
  let bodyHtml;
  if (allocationView) {
    const rows = legsSorted.map(leg => {
      let legEv = {};
      try { legEv = typeof leg.evidence === 'string' ? JSON.parse(leg.evidence) : (leg.evidence || {}); } catch {}
      const pct = leg.pct_of_parent != null ? leg.pct_of_parent : (p.net_usd > 0 ? (leg.usd / p.net_usd * 100) : 0);
      const barW = Math.max(1, Math.min(100, pct));
      const marketSupply = Number(legEv.pool_reserve_total_supply_usd || 0);
      const marketBorrow = Number(legEv.pool_reserve_total_borrow_usd || 0);
      const util = Number(legEv.market_utilization || (marketSupply > 0 ? marketBorrow / marketSupply : 0));
      const isIdle = legEv.is_idle === true;
      const label = leg.asset_symbol || leg.venue || '?';
      const kindClass = 'kind-' + leg.kind;
      const tooltip = isIdle
        ? `${label} · idle vault liquidity (not deployed)`
        : `${label} · market $${fmtUsd(marketSupply)} supply / $${fmtUsd(marketBorrow)} borrowed`;
      return (
        '<div class="exposure-leg-row ' + kindClass + '" title="' + escapeHtml(tooltip) + '">' +
          '<div class="leg-label">' + escapeHtml(label) + '</div>' +
          '<div class="leg-usd">' + fmtUsd(leg.usd) + '</div>' +
          '<div class="leg-pool-usd">' + (marketBorrow > 0 ? fmtUsd(marketBorrow) : (isIdle ? '— idle —' : '—')) + '</div>' +
          '<div class="leg-pct">' + (util > 0 ? (util * 100).toFixed(0) + '%' : '—') + '</div>' +
          '<div class="exposure-leg-bar"><div class="exposure-leg-bar-fill" style="width:' + barW.toFixed(1) + '%"></div></div>' +
        '</div>'
      );
    }).join('');
    const v2Note = ev.has_per_market_state === false
      ? '<div class="exposure-leg-empty" style="padding:6px 12px;text-align:left">Morpho V2 vault — per-market borrow state not indexed yet; showing supply-side only.</div>'
      : '';
    bodyHtml = (
      '<div class="exposure-single-col">' +
        '<div class="exposure-col-title">ALLOCATED MARKETS</div>' +
        '<div class="exposure-col-header exposure-col-header-allocation">' +
          '<span>Collateral / Loan</span><span>Your exposure</span><span>Market borrowed</span><span>Util</span>' +
        '</div>' +
        '<div class="exposure-col-scroll">' + (rows || '<div class="exposure-leg-empty">No allocations</div>') + v2Note + '</div>' +
      '</div>'
    );
  } else if (isolatedView) {
    // Morpho Blue isolated market: one collateral leg + one loan leg.
    // The collateral leg is the user's posted collateral (from children).
    // The loan leg is derived from root evidence (pool_total_borrow_usd).
    // We show both in a two-column layout: Collateral / Borrowed asset.
    const colLeg = legsSorted[0] || root;
    let colEv = {};
    try { colEv = typeof colLeg.evidence === 'string' ? JSON.parse(colLeg.evidence) : (colLeg.evidence || {}); } catch {}
    const collateralPool = Number(colEv.pool_reserve_total_supply_usd || ev.pool_collateral_usd || 0);
    const poolBorrow = Number(ev.pool_total_borrow_usd || 0);
    const poolSupply = Number(ev.pool_tvl_usd || 0);
    const poolAvail = Math.max(0, poolSupply - poolBorrow);
    const loanSym = ev.loan_symbol || '?';
    const colSym = ev.collateral_symbol || colLeg.asset_symbol || '?';
    const userBorrow = Number(ev.user_borrowed_usd || 0);
    const util = ev.pool_utilization || (poolSupply > 0 ? poolBorrow / poolSupply : 0);

    bodyHtml = (
      '<div class="exposure-two-col">' +
        '<div class="exposure-col">' +
          '<div class="exposure-col-title">COLLATERAL (WHAT YOU POSTED)</div>' +
          '<div class="exposure-col-header exposure-col-header-collateral">' +
            '<span>Asset</span><span>Pool $</span><span>% of pool</span>' +
          '</div>' +
          '<div class="exposure-col-scroll">' +
            '<div class="exposure-leg-row kind-primary_asset">' +
              '<div class="leg-label">' + escapeHtml(colSym) + '</div>' +
              '<div class="leg-pool-usd">' + fmtUsd(collateralPool) + '</div>' +
              '<div class="leg-pct">100%</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="exposure-col">' +
          '<div class="exposure-col-title">BORROWED (WHAT THEY OWE)</div>' +
          '<div class="exposure-col-header exposure-col-header-borrow">' +
            '<span>Asset</span><span>Pool $</span><span>Avail</span><span>Util</span>' +
          '</div>' +
          '<div class="exposure-col-scroll">' +
            '<div class="exposure-leg-row">' +
              '<div class="leg-label">' + escapeHtml(loanSym) + '</div>' +
              '<div class="leg-pool-usd">' + fmtUsd(poolBorrow) + '</div>' +
              '<div class="leg-avail-usd">' + fmtUsd(poolAvail) + '</div>' +
              '<div class="leg-pct">' + (util * 100).toFixed(0) + '%</div>' +
            '</div>' +
            (userBorrow > 0 ? '<div class="exposure-leg-row kind-market_exposure">' +
              '<div class="leg-label" style="color:var(--accent-orange)">Your borrow</div>' +
              '<div class="leg-usd" style="color:#f85149">' + fmtUsd(userBorrow) + '</div>' +
            '</div>' : '') +
          '</div>' +
        '</div>' +
      '</div>'
    );
  } else if (twoCol) {
    const collatHtml = collatLegs.length
      ? collatLegs.map(x => renderLegRow(x, 'collateral')).join('')
      : '<div class="exposure-leg-empty">No collateral assets</div>';
    const borrowHtml = borrowLegs.length
      ? borrowLegs.map(x => renderLegRow(x, 'borrowable')).join('')
      : '<div class="exposure-leg-empty">No borrowable liquidity</div>';
    bodyHtml = (
      '<div class="exposure-two-col">' +
        '<div class="exposure-col">' +
          '<div class="exposure-col-title">COLLATERAL ASSETS</div>' +
          '<div class="exposure-col-header exposure-col-header-collateral">' +
            '<span>Asset</span><span>Pool $</span><span>% of pool</span>' +
          '</div>' +
          '<div class="exposure-col-scroll">' + collatHtml + '</div>' +
        '</div>' +
        '<div class="exposure-col">' +
          '<div class="exposure-col-title">BORROWABLE LIQUIDITY</div>' +
          '<div class="exposure-col-header exposure-col-header-borrow">' +
            '<span>Asset</span><span>Pool $</span><span>Avail</span><span>Util</span>' +
          '</div>' +
          '<div class="exposure-col-scroll">' + borrowHtml + '</div>' +
        '</div>' +
      '</div>'
    );
  } else {
    const rows = (miscLegs.length ? miscLegs : legsSorted.map(l => ({ leg: l, legEv: {} })))
      .map(x => renderLegRow(x, 'misc')).join('');
    bodyHtml = (
      '<div class="exposure-single-col">' +
        '<div class="exposure-col-title">' + legs_title(root).toUpperCase() + '</div>' +
        '<div class="exposure-col-header exposure-col-header-single">' +
          '<span>Asset</span><span>Your exposure</span><span>% of position</span>' +
        '</div>' +
        '<div class="exposure-col-scroll">' + rows + '</div>' +
      '</div>'
    );
  }

  const chain = p.chain || '';
  const adapter = root.adapter || '?';
  const source = root.source || '?';
  const asOf = root.as_of ? new Date(root.as_of).toLocaleString() : '';
  const stratClass = strategyBadgeClass(strategy);
  const isolatedBadge = isolatedView ? '<span class="badge badge-illiquid" title="isolated Morpho Blue market — one collateral, one loan, no pooled risk across assets">isolated</span>' : '';
  const walletShort = walletAddr && walletAddr.startsWith('0x')
    ? (walletAddr.slice(0, 6) + '…' + walletAddr.slice(-4))
    : walletAddr;

  const venue = root.venue || p.protocol_name;
  const headerName = venue && venue !== p.protocol_name ? venue : (p.supply_tokens_display || p.protocol_name);

  return (
    '<div class="exposure-position-card">' +
      '<div class="exposure-position-head">' +
        '<div class="exposure-position-proto-row">' +
          '<span class="exposure-position-proto">' + escapeHtml(p.protocol_name || '') + '</span>' +
          '<span class="badge ' + stratClass + '" title="strategy">' + escapeHtml(strategy) + '</span>' +
          isolatedBadge +
          '<span class="exposure-conf-badge ' + confClass + '" title="confidence">' + (root.confidence || 'low') + '</span>' +
        '</div>' +
        '<div class="exposure-position-name">' +
          '<span>' + escapeHtml(headerName) + '</span>' +
          (chain ? '<span class="exposure-position-chain">' + escapeHtml(chain) + '</span>' : '') +
        '</div>' +
        (walletShort ? '<div class="exposure-position-wallet" title="' + escapeHtml(walletAddr) + '">wallet ' + escapeHtml(walletShort) + '</div>' : '') +
        poolAddrRow +
      '</div>' +
      '<div class="exposure-stats-strip">' +
        '<div class="exposure-stat"><div class="exposure-stat-label">Whale exposure</div><div class="exposure-stat-value money">' + fmtUsd(p.net_usd) + '</div><div class="exposure-stat-sub">' + pctOfWhale.toFixed(1) + '% of whale</div></div>' +
        '<div class="exposure-stat"><div class="exposure-stat-label">Pool TVL</div><div class="exposure-stat-value">' + (poolTvl > 0 ? fmtUsd(poolTvl) : '—') + '</div><div class="exposure-stat-sub">' + (poolTvl > 0 ? ('net ' + fmtUsd(poolAvailable)) : '') + '</div></div>' +
        '<div class="exposure-stat"><div class="exposure-stat-label">Total borrowed</div><div class="exposure-stat-value">' + (poolBorrow > 0 ? fmtUsd(poolBorrow) : '—') + '</div><div class="exposure-stat-sub">' + (poolUtil > 0 ? ((poolUtil * 100).toFixed(1) + '% util') : '') + '</div></div>' +
      '</div>' +
      '<div class="exposure-position-body">' + bodyHtml + '</div>' +
      '<div class="exposure-position-footer">' +
        '<span>Protocol: <b>' + escapeHtml(p.protocol_name || '?') + '</b></span>' +
        '<span>Market: <b>' + escapeHtml(venue) + '</b></span>' +
        '<span>Chain: <b>' + escapeHtml(chain) + '</b></span>' +
        '<span class="exposure-position-footer-meta">' + escapeHtml(adapter) + ' · ' + escapeHtml(source) + (asOf ? (' · ' + asOf) : '') + '</span>' +
      '</div>' +
    '</div>'
  );
}

function legs_title(root) {
  if (!root) return 'final market exposure';
  if (root.kind === 'opaque_offchain') return 'denomination · opaque counterparty';
  if (root.kind === 'unknown') return 'undecomposed';
  if (root.kind === 'ybs_strategy') return 'protocol backing composition';
  if (root.kind === 'lp_underlying') return 'LP underlying tokens';
  if (root.kind === 'pendle_underlying') return 'pendle underlying';
  return 'final market exposure';
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// ═══════════════════════════════════════════════════════════════
// DONUT (vanilla canvas — no Chart.js dep to avoid page weight)
// ═══════════════════════════════════════════════════════════════
function drawDonut(canvasId, rows, labelKey, usdKey) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssSize = 180;
  canvas.width = cssSize * dpr;
  canvas.height = cssSize * dpr;
  canvas.style.width = cssSize + 'px';
  canvas.style.height = cssSize + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssSize, cssSize);

  const cx = cssSize / 2, cy = cssSize / 2;
  const outerR = cssSize / 2 - 6;
  const innerR = outerR * 0.62;

  const total = rows.reduce((s, r) => s + (r[usdKey] || 0), 0);
  if (total <= 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(48, 54, 61, 0.4)';
    ctx.fill();
    return;
  }

  // Only the top 8 slices are drawn, so divide by the displayed sum (not
  // the full total) so the donut forms a complete circle without gaps.
  const visible = rows.slice(0, 8).filter(r => (r[usdKey] || 0) > 0);
  const visibleSum = visible.reduce((s, r) => s + (r[usdKey] || 0), 0);

  let start = -Math.PI / 2;
  visible.forEach((r, i) => {
    const val = r[usdKey] || 0;
    const angle = visibleSum > 0 ? (val / visibleSum) * Math.PI * 2 : 0;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, outerR, start, start + angle);
    ctx.closePath();
    ctx.fillStyle = EXPOSURE_PALETTE[i % EXPOSURE_PALETTE.length];
    ctx.fill();
    start += angle;
  });

  // Donut hole
  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
  ctx.fillStyle = '#1c2128';
  ctx.fill();

  // Center label: total USD
  ctx.fillStyle = '#c9d1d9';
  ctx.font = '600 9px "Space Grotesk", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('TOTAL', cx, cy - 10);
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 14px "JetBrains Mono", monospace';
  ctx.fillText(fmtUsd(total), cx, cy + 6);
}

// ═══════════════════════════════════════════════════════════════
// SHARED DATA LOADING
// ═══════════════════════════════════════════════════════════════
// These are set by each page before calling whaleInit()
let WHALE_NAME = '';
let VAULT_NAME = null;  // null = all positions, string = specific vault
let WHALE_DATA = [];
let WHALE_INFO = null;  // full whale object from data.json (for wallet card)
let positions = [];
let protocolCol = null;
let chains = [];
let protos = [];

async function loadData() {
  try {
    const res = await fetch((typeof DATA_PATH !== 'undefined' ? DATA_PATH : '') + 'data.json?t=' + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const whale = data.whales[WHALE_NAME];
    if (!whale) throw new Error('Whale ' + WHALE_NAME + ' not found');
    WHALE_INFO = whale;

    if (VAULT_NAME && whale.vaults && whale.vaults[VAULT_NAME]) {
      // Vault detail page — only this vault's positions
      WHALE_DATA = whale.vaults[VAULT_NAME].positions || [];
    } else {
      // Single-vault whale or overview page with all positions
      WHALE_DATA = whale.positions || [];
    }

    WHALE_DATA.forEach(p => { p.bonus_total = (p.bonus_supply || 0) + (p.bonus_borrow || 0); });
    positions = WHALE_DATA;

    protocolCol = COLUMNS.find(c => c.key === 'protocol');
    chains = [...new Set(positions.map(p => p.chain))].sort();
    protos = [...new Set(positions.map(p => getFieldValue(p, protocolCol)))].sort();
    buildFilters();
    updateView();
  } catch (e) {
    document.querySelector('.container').innerHTML = '<div style="text-align:center;padding:80px;color:#f85149"><h2>Failed to load data</h2><p style="color:#8b949e;margin-top:8px">' + e.message + '</p></div>';
  }
}

// Call this from each page's DOMContentLoaded
function whaleInit() {
  loadData();
  ['chainFilter', 'protoFilter', 'searchFilter'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', updateView);
      el.addEventListener('change', updateView);
    }
  });
}
