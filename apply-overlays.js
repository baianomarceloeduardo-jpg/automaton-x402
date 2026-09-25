// apply-overlays.js v1.0.0 - deterministic, idempotent overlay manager for server.js.
// Keeps a pristine base (server.base.js) and rebuilds server.js as base + ordered overlays.
// This replaces fragile strip/re-append logic and makes the server tail reproducible.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const SERVER = path.join(DIR, 'server.js');
const BASE = path.join(DIR, 'server.base.js');
const MARKER = '\n// ===================== __';

// Ordered overlays applied to the base. Order matters only for readability; each is an IIFE
// that chains the previous request listeners.
const OVERLAYS = [
  'dual-scheme-overlay.js',
  'index-overlay.js',
  'remediation-overlay.js',
  'discovery-overlay.js',
  'ecosystem-overlay.js'
];

function firstMarkerIndex(s) {
  const i = s.indexOf(MARKER);
  return i < 0 ? s.length : i;
}

// Establish the pristine base once, by truncating at the first overlay marker.
function ensureBase() {
  if (fs.existsSync(BASE)) return false;
  const cur = fs.readFileSync(SERVER, 'utf8');
  const cut = firstMarkerIndex(cur);
  const base = cur.slice(0, cut).replace(/\s+$/, '\n');
  fs.writeFileSync(BASE, base);
  console.log('base captured: server.base.js (' + base.length + ' bytes)');
  return true;
}

function rebuild() {
  let out = fs.readFileSync(BASE, 'utf8').replace(/\s+$/, '\n');
  let applied = 0;
  for (const name of OVERLAYS) {
    const p = path.join(DIR, name);
    if (!fs.existsSync(p)) { console.log('  skip (missing): ' + name); continue; }
    out += '\n' + fs.readFileSync(p, 'utf8').replace(/^\s+/, '') + '\n';
    applied++;
    console.log('  + ' + name);
  }
  fs.writeFileSync(SERVER, out);
  console.log('rebuilt server.js: base + ' + applied + ' overlay(s) = ' + out.length + ' bytes');
  return applied;
}

function syntaxCheck() {
  try {
    execFileSync(process.execPath, ['--check', SERVER], { stdio: 'pipe' });
    console.log('SYNTAX OK');
    return true;
  } catch (e) {
    console.log('SYNTAX FAIL\n' + String(e.stderr || e.message).slice(0, 2000));
    return false;
  }
}

if (require.main === module) {
  ensureBase();
  rebuild();
  process.exit(syntaxCheck() ? 0 : 1);
}

module.exports = { ensureBase, rebuild, syntaxCheck, OVERLAYS, BASE, SERVER };
