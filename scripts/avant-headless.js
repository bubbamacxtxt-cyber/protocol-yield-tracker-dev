#!/usr/bin/env node
/**
 * Minimal headless check: evaluate whale-common.js against Avant data
 * and print any errors.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(ROOT, 'whale-common.js'), 'utf8');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));

// Minimal DOM stub
const elements = {};
const createElement = (tag) => ({
  innerHTML: '',
  style: {},
  appendChild: () => {},
  addEventListener: () => {},
  querySelectorAll: () => [],
  setAttribute: () => {},
  className: '',
  textContent: '',
});
const stubDoc = {
  getElementById: (id) => {
    if (!elements[id]) {
      elements[id] = createElement('div');
      elements[id].id = id;
    }
    return elements[id];
  },
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: () => {},
  createElement,
};
const stubWin = {
  addEventListener: () => {},
  devicePixelRatio: 1,
};

const sandbox = {
  document: stubDoc,
  window: stubWin,
  console,
  setTimeout: (fn, ms) => fn(),
  fetch: () => Promise.reject('no fetch'),
  XLSX: null,
};

try {
  vm.createContext(sandbox);
  vm.runInContext(`try { ${js} } catch(e) { console.error('JS RUNTIME ERROR:', e.message, e.stack); }`, sandbox, { timeout: 10000 });
  
  // Now call updateView with Avant data
  const avant = data.whales['Avant'];
  const src = `
    try {
      WHALE_NAME = 'Avant';
      WHALE_INFO = ${JSON.stringify(avant)};
      WHALE_DATA = ${JSON.stringify(avant.positions)};
      positions = WHALE_DATA;
      positions.forEach(p => { p.bonus_total = (p.bonus_supply || 0) + (p.bonus_borrow || 0); });
      protocolCol = null;
      chains = [...new Set(positions.map(p => p.chain))].sort();
      protos = [...new Set(positions.map(p => p.protocol_name || ''))].sort();
      updateView();
      const sec = document.getElementById('exposure-section');
      console.log('exposure-section innerHTML length:', sec ? sec.innerHTML.length : 'NULL');
      if (sec && sec.innerHTML.length > 0) {
        console.log('Has two-col:', sec.innerHTML.includes('exposure-two-col'));
        console.log('Has stats-strip:', sec.innerHTML.includes('exposure-stats-strip'));
        console.log('Has position card:', sec.innerHTML.includes('exposure-position-card'));
        console.log('Has donuts:', sec.innerHTML.includes('exp-donut-proto'));
        console.log('First 500 chars:', sec.innerHTML.slice(0, 500));
      }
    } catch(e) {
      console.error('VIEW ERROR:', e.message);
      console.error(e.stack);
    }
  `;
  vm.runInContext(src, sandbox, { timeout: 10000 });
  
  console.log('\nAll checks complete.');
} catch (err) {
  console.error('FATAL:', err.message, err.stack);
}
