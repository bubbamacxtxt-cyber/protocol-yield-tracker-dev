#!/usr/bin/env node
/**
 * Repair all whale HTML pages for the unified exposure system.
 *
 * For regular whale pages (anzen, avant, infinifi, pareto, re-protocol,
 * reservoir, yousd, yuzu):
 *   - Replace the legacy <section id="lookthrough-section"> block with a
 *     clean <section id="exposure-section"> placed ABOVE the positions
 *     table (matching Vercel reference layout).
 *   - Remove the broken duplicate <div id="detail-modal"> pattern.
 *
 * For vault-hub pages (makina, midas, superform, upshift):
 *   - Same section rename; hub pages keep the section below the vault grid
 *     since they aggregate multiple vaults.
 *
 * Idempotent: re-running produces no changes after the first run.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REGULAR_WHALES = [
  'anzen', 'avant', 'infinifi', 'pareto', 're-protocol', 'reservoir', 'yousd', 'yuzu',
];
const HUB_WHALES = ['makina', 'midas', 'superform', 'upshift'];

function transformRegular(html) {
  let changed = false;
  // 1. Strip the legacy lookthrough-section block (including broken modal pair that followed)
  const legacyRe = /<\/table>\s*<\/div>\s*<section id="lookthrough-section"[\s\S]*?<\/section>\s*<\/div>\s*<div id="detail-modal">\s*<div id="detail-modal"><\/div>/m;
  if (legacyRe.test(html)) {
    html = html.replace(legacyRe, '</table>\n  </div>\n</div>\n<div id="detail-modal"></div>');
    changed = true;
  } else {
    // If a cleaner already ran and left just the section, still strip it:
    const simpleRe = /<section id="lookthrough-section"[\s\S]*?<\/section>/m;
    if (simpleRe.test(html)) {
      html = html.replace(simpleRe, '');
      changed = true;
    }
  }

  // 2. Insert exposure-section BEFORE the table (above <div class="filters">)
  //    Only if not already present.
  if (!/id="exposure-section"/.test(html)) {
    const anchor = /(<div class="cards" id="summaryCards"><\/div>\s*<div class="proto-summary" id="protoSummary"><\/div>)/;
    // Place exposure section AFTER the table-wrap (below positions table)
    const tableEnd = /(\s*<\/div>\s*)(<div id="detail-modal">)/;
    if (tableEnd.test(html)) {
      html = html.replace(tableEnd, `$1  <section id="exposure-section"></section>\n$2`);
      changed = true;
    }
  }

  // 3. Ensure there's exactly one detail-modal div just before </body>
  //    The regex in step 1 already canonicalised this, but if we only ran
  //    the simpleRe branch we might have left a duplicate. Normalise.
  html = html.replace(/<div id="detail-modal">\s*<div id="detail-modal"><\/div>/g, '<div id="detail-modal"></div>');

  // 4. Bump cache-busting query strings so clients pull fresh CSS/JS
  const stamp = '202604272200';
  html = html.replace(/whale-common\.css\?v=[^"]+/g, `whale-common.css?v=${stamp}`);
  html = html.replace(/whale-common\.js\?v=[^"]+/g, `whale-common.js?v=${stamp}`);

  return { html, changed };
}

function transformHub(html) {
  // For hub pages we keep section below the vault grid but rename id + drop old content.
  let changed = false;
  const legacyRe = /<section id="lookthrough-section"[\s\S]*?<\/section>/m;
  if (legacyRe.test(html)) {
    html = html.replace(legacyRe, '<section id="exposure-section" style="max-width:1200px;margin:40px auto;padding:0 24px;"></section>');
    changed = true;
  } else if (!/id="exposure-section"/.test(html)) {
    // If neither present, append before </body>
    html = html.replace(/<\/body>/, '<section id="exposure-section" style="max-width:1200px;margin:40px auto;padding:0 24px;"></section>\n</body>');
    changed = true;
  }

  const stamp = '202604272200';
  html = html.replace(/whale-common\.css\?v=[^"]+/g, `whale-common.css?v=${stamp}`);
  html = html.replace(/whale-common\.js\?v=[^"]+/g, `whale-common.js?v=${stamp}`);

  return { html, changed };
}

function process(files, transform) {
  for (const name of files) {
    const fp = path.join(ROOT, name + '.html');
    if (!fs.existsSync(fp)) { console.log(`  skip (missing): ${name}`); continue; }
    const before = fs.readFileSync(fp, 'utf8');
    const { html, changed } = transform(before);
    if (changed || html !== before) {
      fs.writeFileSync(fp, html);
      console.log(`  updated: ${name}.html`);
    } else {
      console.log(`  no-op:   ${name}.html`);
    }
  }
}

console.log('Regular whale pages:');
process(REGULAR_WHALES, transformRegular);
console.log('\nVault-hub pages:');
process(HUB_WHALES, transformHub);
console.log('\nDone.');
