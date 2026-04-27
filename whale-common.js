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

  document.getElementById('summaryCards').innerHTML = cardsHtml;

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

  modal.innerHTML =
    '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:600px;margin:50px auto">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">' +
      '<h3 style="margin:0">' + getFieldValue(p, protocolCol) + ' \u2014 ' + (p.supply ? p.supply.map(t => t.symbol).join('/') : (p.symbol || '')) + '</h3>' +
      '<div style="font-size:12px;color:var(--text-secondary);margin-top:4px">' + (p.source_type || 'unknown') + ' · ' + (p.normalization_status || 'unknown') + (p.exposure_class ? ' · ' + p.exposure_class : '') + '</div>' +
      '<button onclick="document.getElementById(&quot;detail-modal&quot;).style.display=&quot;none&quot;" style="background:none;border:none;color:var(--text-secondary);font-size:20px;cursor:pointer;">\u00d7</button>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">' +
      '<div><div style="color:var(--text-secondary);font-size:12px">Supply</div><div style="font-size:13px">' + (supplyDetail || '-') + '</div></div>' +
      '<div><div style="color:var(--text-secondary);font-size:12px">Borrow</div><div style="font-size:13px">' + (borrowDetail || '-') + '</div></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;text-align:center">' +
      '<div><div style="color:var(--text-secondary);font-size:12px">Base APY</div><div style="font-size:18px;font-weight:600">' + (p.apy_base || 0).toFixed(2) + '%</div></div>' +
      '<div><div style="color:var(--text-secondary);font-size:12px">Bonus Supply</div><div style="font-size:18px;font-weight:600;color:var(--accent-green)">+' + (p.bonus_supply || 0).toFixed(2) + '%</div></div>' +
      '<div><div style="color:var(--text-secondary);font-size:12px">Cost APY</div><div style="font-size:18px;font-weight:600">' + (p.apy_cost || 0).toFixed(2) + '%</div></div>' +
      '<div><div style="color:var(--text-secondary);font-size:12px">Health</div><div style="font-size:18px;font-weight:600">' + (p.health_rate ? fmtHF(p.health_rate) : '-') + '</div></div>' +
    '</div>' +
    '<div style="text-align:center;margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">' +
      '<div style="color:var(--text-secondary);font-size:12px">Net APY</div>' +
      '<div style="font-size:28px;font-weight:700;color:' + ((p.apy_net || 0) > 0 ? 'var(--accent-green)' : '#f85149') + '">' + (p.apy_net || 0).toFixed(2) + '%</div>' +
    '</div></div>';
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:1000;display:flex;align-items:start;justify-content:center;background:rgba(0,0,0,0.7)';
  modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
}

// ═══════════════════════════════════════════════════════════════
// SHARED DATA LOADING
// ═══════════════════════════════════════════════════════════════
// These are set by each page before calling whaleInit()
let WHALE_NAME = '';
let VAULT_NAME = null;  // null = all positions, string = specific vault
let WHALE_DATA = [];
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

    if (VAULT_NAME && whale.vaults && whale.vaults[VAULT_NAME]) {
      // Vault detail page — only this vault's positions
      WHALE_DATA = whale.vaults[VAULT_NAME].positions || [];
    } else {
      // Single-vault whale or overview page with all positions
      WHALE_DATA = whale.positions || [];
    }

    WHALE_DATA.forEach(p => { p.bonus_total = (p.bonus_supply || 0) + (p.bonus_borrow || 0); });
    positions = WHALE_DATA;
    renderWalletCards(whale);
    protocolCol = COLUMNS.find(c => c.key === 'protocol');
    chains = [...new Set(positions.map(p => p.chain))].sort();
    protos = [...new Set(positions.map(p => getFieldValue(p, protocolCol)))].sort();
    buildFilters();
    updateView();
  } catch (e) {
    document.querySelector('.container').innerHTML = '<div style="text-align:center;padding:80px;color:#f85149"><h2>Failed to load data</h2><p style="color:#8b949e;margin-top:8px">' + e.message + '</p></div>';
  }
}

// ═══════════════════════════════════════════════════════════════
// WALLET CARDS — debank links, green/red status, no API calls
// ═══════════════════════════════════════════════════════════════
// Build a set of wallet addresses that have positions in the current
// filtered view.  Wallets with ANY position value > 0 are "active".
function renderWalletCards(whaleData) {
  const container = document.getElementById('walletCards');
  if (!container) return;

  const allWallets = whaleData.wallets || [];
  const positions = whaleData.positions || [];

  // Deduplicate — some whales list the same address twice
  const unique = [...new Set(allWallets.map(w => w.toLowerCase()))];

  // Compute value per wallet from current positions
  const walletValue = {};
  positions.forEach(p => {
    const addr = (p.wallet || '').toLowerCase();
    walletValue[addr] = (walletValue[addr] || 0) + (p.net_usd || 0);
  });

  const THRESHOLD = 50000;

  const items = unique.map(addr => {
    const val = walletValue[addr] || 0;
    const active = val >= THRESHOLD;
    const dotColor = active ? 'var(--accent-green)' : '#f85149';
    const valStr = active ? '$' + fmtShort(val) : 'no positions';
    return '<a href="https://debank.com/profile/' + addr + '" target="_blank" '
      + 'style="display:flex;align-items:center;gap:8px;padding:8px 12px;'
      + 'text-decoration:none;color:var(--text-primary);font-size:13px;white-space:nowrap">'
      + '<span style="width:8px;height:8px;border-radius:50%;background:' + dotColor + ';flex-shrink:0"></span>'
      + '<span style="font-family:monospace">' + shortWallet(addr) + '</span>'
      + '<span style="color:var(--text-secondary);margin-left:auto">' + valStr + '</span>'
      + '</a>';
  });

  container.innerHTML = '<div style="background:var(--surface-secondary,var(--bg-secondary,#161b22));border:1px solid var(--border-default,rgba(255,255,255,0.08));border-radius:10px;overflow:hidden">'
    + '<div style="padding:10px 14px;font-size:12px;font-weight:600;color:var(--text-secondary);border-bottom:1px solid var(--border-default,rgba(255,255,255,0.08))">Wallets (' + unique.length + ')</div>'
    + '<div style="max-height:160px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.15) transparent">'
    + items.join('')
    + '</div></div>';
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
