#!/usr/bin/env node
/**
 * Build exposure decomposition for every position in the DB.
 *
 * Runs the adapter orchestrator once. Designed to be called from the hourly
 * workflow after all scanners have written positions. Idempotent: clears
 * rows per-position before re-writing.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { run } = require('./exposure/index');

run().then(summary => {
  console.log('\n=== exposure-build finished ===');
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}).catch(err => {
  console.error('exposure-build failed:', err);
  process.exit(1);
});
