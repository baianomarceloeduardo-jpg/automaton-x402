// x402-index.js v1.1.0 - the public x402 Service Index.
// Continuously benchmarks public x402 services with my own x402-conformance checker,
// keeps history, and serves an objective leaderboard. Free to read; drives traffic.
'use strict';
const fs = require('fs');
const path = require('path');

const STORE = path.join(__dirname, 'x402-index.json');
const MAX_HISTORY = 12;

// Curated seed: known x402/payment service endpoints. The directory (directory.js) is the
// primary source; this guarantees the index is never empty and always includes MY service.
const SEED = [
  'http://127.0.0.1:8080/',
  'https://x402.org/facilitator',
  'https://facilitator.x402.rs/',
  'https://api.x402.dev/'
];

function dir() { try { return require('./directory.js'); } catch (e) { return null; } }
function conf() { try { return require('./x402-conformance.js'); } catch (e) { return null; } }
function base() { try { return 'http://127.0.0.1:' + (process.env.PORT || 8080); } catch (e) { return ''; } }

function load() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); }
  catch (e) { return { version: '1.1.0', runs: 0, lastRun: null, count: 0, services: {} }; }
}
function save(s) { try { fs.writeFileSync(STORE, JSON.stringify(s, null, 2)); } catch (e) {} }

// Extract candidate URLs from whatever shape directory.build() returns.
function extractUrls(d) {
  if (!d) return [];
  const out = [];
  const push = v => { if (typeof v === 'string' && /^https?:\/\//i.test(v)) out.push(v); };
  const pool = [].concat(d.services || [], d.entries || [], d.results || [], d.servers || [], Array.isArray(d) ? d : []);
  for (const s of pool) {
    if (typeof s === 'string') { push(s); continue; }
    if (!s || typeof s !== 'object') continue;
    ['endpoint', 'url', 'base', 'x402', 'resource', 'serviceUrl', 'homepage', 'target'].forEach(k => push(s[k]));
    if (s.server && s.server.url) push(s.server.url);
    if (s.remotes && Array.isArray(s.remotes)) s.remotes.forEach(r => push(r && r.url));
  }
  return out;
}

function scoreOf(r) {
  if (!r || !r.reachable) return 0;
  const total = r.total || 0, passed = r.passed || 0;
  const base = total > 0 ? Math.round((passed / total) * 90) : 0;
  const bonus = r.verdict === 'CONFORMANT' ? 10 : r.verdict === 'PARTIAL' ? 5 : 0;
  return Math.min(100, base + bonus);
}

async function run(opts) {
  opts = opts || {};
  const state = load();
  const C = conf();
  if (!C) { state.error = 'conformance_module_missing'; save(state); return state; }

  let urls = [];
  const D = dir();
  if (D && typeof D.build === 'function') {
    try { const d = await D.build({ deep: false }); urls = extractUrls(d); }
    catch (e) { state.dirError = 'directory_failed: ' + e.message; }
  }
  urls = [...new Set(SEED.concat(urls))].slice(0, 60);

  const limit = opts.concurrency || 6;
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const url = urls[i++];
      let r;
      try {
        const c = await C.run(url);
        r = { reachable: c.reachable !== false, passed: c.passed || 0, total: c.total || 0, verdict: c.verdict || 'UNKNOWN' };
      } catch (e) { r = { reachable: false, passed: 0, total: 0, verdict: 'ERROR', error: String(e.message || e).slice(0, 160) }; }
      r.score = scoreOf(r); r.at = new Date().toISOString();
      const prev = state.services[url] || { history: [] };
      prev.last = r; prev.score = r.score;
      prev.history = (prev.history || []).concat([{ at: r.at, score: r.score, verdict: r.verdict, reachable: r.reachable }]).slice(-MAX_HISTORY);
      prev.trend = (function (h) { if (h.length < 2) return 'flat'; const a = h[h.length - 2].score, b = h[h.length - 1].score; return b > a ? 'up' : b < a ? 'down' : 'flat'; })(prev.history);
      state.services[url] = prev;
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, urls.length || 1) }, worker));

  state.version = '1.1.0';
  state.runs = (state.runs || 0) + 1;
  state.lastRun = new Date().toISOString();
  state.count = Object.keys(state.services).length;
  save(state);
  return state;
}

function leaderboard(state) {
  const s = state || load();
  return Object.entries(s.services || {}).map(function (e) {
    const url = e[0], v = e[1];
    return { url, score: v.score || 0, verdict: (v.last && v.last.verdict) || 'UNKNOWN', reachable: !!(v.last && v.last.reachable), trend: v.trend || 'flat', passed: (v.last && v.last.passed) || 0, total: (v.last && v.last.total) || 0 };
  }).sort(function (a, b) { return b.score - a.score || a.url.localeCompare(b.url); });
}

function render(state) {
  const s = state || load();
  const rows = leaderboard(s);
  const esc = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tr = rows.map(r => '<tr><td>' + esc(r.url) + '</td><td class="n">' + r.score + '</td><td>' + esc(r.verdict) +
    '</td><td>' + (r.reachable ? '\u2713' : '\u2717') + '</td><td>' + esc(r.trend) + '</td><td class="n">' + r.passed + '/' + r.total + '</td></tr>').join('');
  return '<!doctype html><html><head><meta charset="utf-8"><title>x402 Service Index</title>' +
    '<meta name="description" content="Objective, continuously-updated benchmark of public x402 payment services, scored by conformance to the x402 spec.">' +
    '<style>body{font:15px/1.5 system-ui,Segoe UI,sans-serif;max-width:1000px;margin:40px auto;padding:0 16px;color:#111}' +
    'h1{margin:0 0 4px}.muted{color:#666}.n{text-align:right;font-variant-numeric:tabular-nums}' +
    'table{border-collapse:collapse;width:100%;margin:18px 0}th,td{border-bottom:1px solid #eee;padding:7px 9px;text-align:left;font-size:14px}' +
    'th{background:#fafafa}code{background:#f4f4f4;padding:2px 5px;border-radius:4px}a{color:#0645ad}</style></head><body>' +
    '<h1>x402 Service Index</h1>' +
    '<p class="muted">Objective benchmark of public x402 payment services, scored by spec conformance. Runs=' + (s.runs || 0) + ' &middot; last=' + esc(s.lastRun || 'never') + ' &middot; services=' + (s.count || 0) + '</p>' +
    '<p>Machine-readable: <a href="/v1/index">/v1/index</a> &middot; check any service: <a href="/v1/x402-conformance">/v1/x402-conformance?url=...</a> &middot; embed a badge: <code>/badge.svg?url=...</code></p>' +
    '<table><thead><tr><th>Service</th><th class="n">Score</th><th>Verdict</th><th>Up</th><th>Trend</th><th class="n">Checks</th></tr></thead><tbody>' + tr + '</tbody></table>' +
    '<p class="muted">Free and open. Maintained by Automaton-Sovereign; the metered API at <a href="/pricing">/pricing</a> pays for it.</p>' +
    '</body></html>';
}

module.exports = { run, load, save, leaderboard, render, scoreOf, extractUrls, SEED };
