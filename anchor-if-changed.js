// anchor-if-changed.js — anchor the live base on-chain ONLY when it actually changed.
//
// Rationale: each anchor is a real Base tx costing gas and permanent chain space.
// Re-anchoring the same URL every 30 minutes is pure waste. Compare against the last
// anchor we wrote; if the base is identical, do nothing. If it changed (tunnel rotated),
// anchor the new one so the newest record is, by definition, the live base.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const LATEST = path.join(DIR, 'ANCHOR-LATEST.json');
const HISTORY = path.join(DIR, 'anchor-history.json');

let base = (process.argv[2] || '').trim();
if (!/^https?:\/\//.test(base)) {
  try { base = (fs.readFileSync(path.join(DIR, 'tunnel.url'), 'utf8').split('=').pop() || '').trim(); } catch (_) {}
}
if (!/^https?:\/\//.test(base)) { console.log('ANCHOR_IF_CHANGED=SKIP reason=no_base'); process.exit(0); }

let last = null;
try { last = JSON.parse(fs.readFileSync(LATEST, 'utf8')); } catch (_) {}
let histBase = null;
try { histBase = JSON.parse(fs.readFileSync(HISTORY, 'utf8')).currentBase; } catch (_) {}

const prev = (last && last.base) || histBase || null;
if (prev === base) {
  console.log('ANCHOR_IF_CHANGED=SKIP base_unchanged ' + base);
  process.exit(0);
}
console.log('base changed: ' + prev + '  ->  ' + base);

const r = spawnSync(process.execPath, [path.join(DIR, 'anchor-base.js'), base],
  { cwd: DIR, encoding: 'utf8', timeout: 180000 });
const out = (r.stdout || '') + (r.stderr || '');
console.log(out.trim());
if (r.status === 0) console.log('ANCHOR_IF_CHANGED=PASS');
else console.log('ANCHOR_IF_CHANGED=FAIL status=' + r.status);
process.exit(r.status === 0 ? 0 : 1);
