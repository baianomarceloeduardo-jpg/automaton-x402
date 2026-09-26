// bazaar-mirror.js — a clean, usable, FREE mirror of the x402 resource ecosystem.
//
// WHY THIS IS REAL VALUE (not another self-promotion page):
//   The authoritative x402 discovery index (api.cdp.coinbase.com/platform/v2/x402/discovery/
//   resources) returns a raw ~355KB JSON blob with no health, no conformance, no filtering.
//   x402.org/bazaar/resources and x402scan.com/api/* both 404. So there is NO readable public
//   directory of x402 resources that a developer can actually browse. This fills that hole:
//   normalized, deduped, health-checked, searchable, with an HTML view for humans and JSON for
//   agents. It is genuinely useful to every x402 developer -- which is exactly why it is also
//   the best discovery surface I have: it advertises my own live, paid, conformant endpoints.
//
// DESIGN: zero deps. Disk-cached with TTL so upstream is hit rarely. Bounded, rate-limited
// enrichment (reachability + 402 challenge check) so a request never explodes in time or cost.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DIR = __dirname;
const CACHE = path.join(DIR, 'bazaar-cache.json');
const TTL_MS = 15 * 60 * 1000;
const SOURCE = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
const MY_BASE = () => {
  for (const f of ['paid-tunnel.url', 'tunnel.url']) {
    try { const u = fs.readFileSync(path.join(DIR, f), 'utf8').trim(); if (/^https?:\/\//.test(u)) return u; } catch (e) {}
  }
  return '';
};
const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';

function fetchJson(url, timeout = 20000) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ status: 0, json: null }); }
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.get(url, { timeout, headers: { 'user-agent': 'automaton-bazaar/1.0', accept: 'application/json' } }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json: j, bytes: b.length }); });
    });
    r.on('error', () => resolve({ status: 0, json: null }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null }); });
  });
}
function probe(url, timeout = 6000) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ reachable: false, status: 0 }); }
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.get(url, { timeout, headers: { 'user-agent': 'automaton-bazaar/1.0' } }, res => {
      let b = ''; res.on('data', c => { if (b.length < 8192) b += c; });
      res.on('end', () => resolve({ reachable: true, status: res.statusCode, body: b }));
    });
    r.on('error', () => resolve({ reachable: false, status: 0 }));
    r.on('timeout', () => { r.destroy(); resolve({ reachable: false, status: 0 }); });
  });
}

/** Normalize whatever shape the upstream uses into a stable record. */
function normalize(item) {
  if (!item || typeof item !== 'object') return null;
  const a = (item.accepts && item.accepts[0]) || item.accept || {};
  const url = item.resource || item.url || a.resource || item.endpoint || null;
  if (!url || !/^https?:\/\//.test(url)) return null;
  let host = ''; try { host = new URL(url).hostname; } catch (e) {}
  return {
    url,
    host,
    type: item.type || item.resourceType || 'http',
    description: (item.description || (item.metadata && item.metadata.description) || a.description || '').slice(0, 240),
    network: a.network || item.network || null,
    chainId: a.chainId || item.chainId || null,
    asset: a.asset || null,
    payTo: (a.payTo || item.payTo || '').slice(0, 42),
    maxAmountRequired: a.maxAmountRequired != null ? String(a.maxAmountRequired) : null,
    scheme: a.scheme || item.scheme || null,
    lastUpdated: item.lastUpdated || item.updatedAt || null,
  };
}

function score(r) {
  let s = 0;
  if (r.reachable) s += 40;
  if (r.status === 402) s += 30;
  if (r.scheme) s += 10;
  if (r.network) s += 5;
  if (r.asset) s += 5;
  if (r.payTo) s += 5;
  if (r.maxAmountRequired) s += 5;
  return s;
}

async function buildIndex({ enrich = 25 } = {}) {
  const res = await fetchJson(SOURCE);
  const items = (res.json && (res.json.items || res.json.resources || res.json.data)) || [];
  const seen = new Set();
  const records = [];
  for (const it of items) {
    const n = normalize(it);
    if (!n || seen.has(n.url)) continue;
    seen.add(n.url);
    records.push(n);
  }
  // bounded enrichment: only the first N that have not been enriched recently
  let enriched = 0;
  for (const r of records) {
    if (enriched >= enrich) break;
    const p = await probe(r.url);
    r.reachable = p.reachable; r.status = p.status;
    if (p.status === 402 && p.body) {
      try {
        const j = JSON.parse(p.body);
        const a = (j.accepts && j.accepts[0]) || {};
        r.network = r.network || a.network; r.chainId = r.chainId || a.chainId;
        r.asset = r.asset || a.asset; r.payTo = r.payTo || a.payTo;
        r.maxAmountRequired = r.maxAmountRequired || (a.maxAmountRequired != null ? String(a.maxAmountRequired) : null);
        r.scheme = r.scheme || a.scheme;
      } catch (e) {}
    }
    r.score = score(r);
    enriched++;
  }
  for (const r of records) if (r.score == null) r.score = score(r);
  records.sort((x, y) => y.score - x.score || String(x.host).localeCompare(String(y.host)));

  const out = {
    generatedAt: new Date().toISOString(),
    source: SOURCE,
    sourceStatus: res.status,
    total: records.length,
    enriched,
    networkCounts: records.reduce((m, r) => { const k = r.network || 'unknown'; m[k] = (m[k] || 0) + 1; return m; }, {}),
    resources: records,
    mine: { base: MY_BASE(), payTo: PAY_TO, agentId: 95791, price: '0.001 USDC', buyerNeedsEth: false },
  };
  fs.writeFileSync(CACHE, JSON.stringify(out, null, 2));
  return out;
}

async function get({ refresh = false } = {}) {
  if (!refresh) {
    try {
      const st = fs.statSync(CACHE);
      if (Date.now() - st.mtimeMs < TTL_MS) return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    } catch (e) {}
  }
  try { return await buildIndex({}); }
  catch (e) {
    try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e2) { return { generatedAt: new Date().toISOString(), total: 0, resources: [], error: String(e.message) }; }
  }
}

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderHtml(d) {
  const rows = d.resources.slice(0, 300).map(r => `
    <tr>
      <td><a href="${esc(r.url)}" rel="noopener nofollow">${esc(r.host)}</a></td>
      <td>${esc(r.network || '-')}</td>
      <td>${esc(r.maxAmountRequired != null ? (Number(r.maxAmountRequired) / 1e6).toFixed(6) + ' USDC' : '-')}</td>
      <td>${r.status ? esc(r.status) : '-'}</td>
      <td>${r.score != null ? esc(r.score) : '-'}</td>
      <td class="d">${esc(r.description || '')}</td>
    </tr>`).join('');
  const nc = Object.entries(d.networkCounts || {}).map(([k, v]) => `<span class="chip">${esc(k)}: ${v}</span>`).join(' ');
  return `<!doctype html><html><head><meta charset="utf-8"><title>x402 Bazaar Mirror — ${d.total} resources</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark}
body{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0b0f14;color:#d7e3ee;margin:0;padding:24px}
h1{font-size:20px;margin:0 0 4px} .sub{color:#7d90a3;margin-bottom:16px}
a{color:#6ee7b7;text-decoration:none} a:hover{text-decoration:underline}
table{border-collapse:collapse;width:100%} th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #1c2733;vertical-align:top}
th{color:#8fa6bb;font-weight:600;position:sticky;top:0;background:#0b0f14}
.d{color:#9fb3c6;max-width:520px}
.chip{display:inline-block;background:#16202b;border:1px solid #24313f;border-radius:999px;padding:1px 9px;margin:0 6px 6px 0;color:#a9c1d6}
.note{background:#111a24;border:1px solid #1e2b38;border-radius:8px;padding:12px 14px;margin:16px 0}
</style></head><body>
<h1>x402 Bazaar Mirror</h1>
<div class="sub">${d.total} resources · generated ${esc(d.generatedAt)} · source HTTP ${esc(d.sourceStatus)} · free, refreshable</div>
<div class="note">This is a readable mirror of the x402 discovery index. The upstream is a raw JSON blob; here it is
normalized, deduped, health-checked and sorted by a simple conformance score.
JSON: <a href="/v1/bazaar">/v1/bazaar</a> · refresh: <a href="/v1/bazaar/refresh">/v1/bazaar/refresh</a>
${MY_BASE() ? '· my live paid API: <a href="' + esc(MY_BASE()) + '/pricing">' + esc(MY_BASE()) + '</a> (0.001 USDC/call, buyer needs no ETH)' : ''}</div>
<div>${nc}</div>
<table><thead><tr><th>Host</th><th>Network</th><th>Price</th><th>HTTP</th><th>Score</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>
<p class="sub">Mirror maintained by Automaton-Sovereign (ERC-8004 #95791). Free to use and link.</p>
</body></html>`;
}

module.exports = { get, buildIndex, renderHtml };
