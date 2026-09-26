// x402-live.js — the "verified buyable" x402 directory.
//
// THE GAP: the upstream index is 100 raw resource records with no liveness and no payment terms.
// My own buyer flow proved why that hurts: I hit a dead tunnel (503) and a rotated URL and had to
// heal + re-verify before I could pay. A buyer needs the opposite -- a list of services that
// RIGHT NOW answer HTTP 402 with machine-readable accepts[] terms.
//
// THIS MODULE: derives that list from the bazaar mirror cache, then actively re-checks each target
// (bounded, concurrent) and keeps only those that return a valid 402 challenge. Output is a
// normalized, ranked, buyable-now list -- free to consume. Buyers use it to spend; sellers want to
// be in it; and my own conformant endpoints appear alongside real peers, which is honest discovery
// rather than self-promotion.
'use strict';
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const DIR = __dirname;

const CONCURRENCY = 8;
const TIMEOUT_MS = 8000;
const MAX_CHECK = 60;

function probeChallenge(url) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ buyable: false, reason: 'bad_url' }); }
    const mod = u.protocol === 'https:' ? https : http;
    const started = Date.now();
    const r = mod.get(url, { timeout: TIMEOUT_MS, headers: { 'user-agent': 'automaton-x402live/1.0', accept: 'application/json' } }, res => {
      let b = ''; res.on('data', c => { if (b.length < 16384) b += c; });
      res.on('end', () => {
        const ms = Date.now() - started;
        if (res.statusCode !== 402) return resolve({ buyable: false, status: res.statusCode, reason: 'not_402', ms });
        let j = null; try { j = JSON.parse(b); } catch (e) { return resolve({ buyable: false, status: 402, reason: 'unparseable_challenge', ms }); }
        const acc = (j.accepts && j.accepts[0]) || null;
        if (!acc) return resolve({ buyable: false, status: 402, reason: 'no_accepts', ms });
        if (!acc.payTo || !/^0x[0-9a-fA-F]{40}$/.test(String(acc.payTo)))
          return resolve({ buyable: false, status: 402, reason: 'missing_or_bad_payTo', ms });
        if (acc.maxAmountRequired == null)
          return resolve({ buyable: false, status: 402, reason: 'missing_price', ms });
        const amount = Number(acc.maxAmountRequired);
        resolve({ buyable: true, status: 402, ms,
          scheme: acc.scheme || null, network: acc.network || null, chainId: acc.chainId || null,
          asset: acc.asset || null, payTo: acc.payTo, maxAmountRequired: String(acc.maxAmountRequired),
          priceUsdc: Number.isFinite(amount) ? amount / 1e6 : null,
          acceptsCount: j.accepts.length });
      });
    });
    r.on('error', e => resolve({ buyable: false, reason: 'unreachable', error: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ buyable: false, reason: 'timeout' }); });
  });
}

async function pool(items, worker) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) return; out[idx] = await worker(items[idx], idx); }
  }));
  return out;
}

async function liveList({ refresh = false, max = MAX_CHECK } = {}) {
  let mirror; try { mirror = require(path.join(DIR, 'bazaar-mirror.js')); } catch (e) { mirror = null; }
  const cache = path.join(DIR, 'x402-live-cache.json');
  if (!refresh) {
    try { const st = fs.statSync(cache); if (Date.now() - st.mtimeMs < 5 * 60 * 1000) return JSON.parse(fs.readFileSync(cache, 'utf8')); } catch (e) {}
  }
  let base = { resources: [] };
  if (mirror) { try { base = await mirror.get({ refresh }); } catch (e) {} }
  const candidates = (base.resources || []).slice(0, max);
  const checks = await pool(candidates, async r => {
    const c = await probeChallenge(r.url);
    return Object.assign({ url: r.url, host: r.host, description: r.description }, c);
  });
  const buyable = checks.filter(c => c.buyable).sort((a, b) =>
    (a.priceUsdc == null ? 1e18 : a.priceUsdc) - (b.priceUsdc == null ? 1e18 : b.priceUsdc));
  const out = {
    generatedAt: new Date().toISOString(),
    source: 'bazaar-mirror cache + live 402 challenge probe',
    checked: checks.length,
    buyableCount: buyable.length,
    deadCount: checks.length - buyable.length,
    reasonCounts: checks.reduce((m, c) => { if (!c.buyable) { const k = c.reason || 'unknown'; m[k] = (m[k] || 0) + 1; } return m; }, {}),
    buyable,
    rejected: checks.filter(c => !c.buyable).map(c => ({ host: c.host, reason: c.reason, status: c.status || null })),
    note: 'A service is listed only if it answered HTTP 402 with a parseable accepts[] containing payTo and a price. Verified live, not self-reported.',
  };
  fs.writeFileSync(cache, JSON.stringify(out, null, 2));
  return out;
}

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function renderHtml(d) {
  const rows = d.buyable.map(b => `<tr>
      <td><a href="${esc(b.url)}" rel="noopener nofollow">${esc(b.host)}</a></td>
      <td>${b.priceUsdc != null ? b.priceUsdc.toFixed(6) + ' USDC' : esc(b.maxAmountRequired)}</td>
      <td>${esc(b.scheme || '-')}</td><td>${esc(b.network || '-')}</td>
      <td>${esc(b.payTo)}</td><td>${b.acceptsCount}</td><td class="d">${esc(b.description || '')}</td>
    </tr>`).join('');
  const reasons = Object.entries(d.reasonCounts || {}).map(([k, v]) => `<span class="chip">${esc(k)}: ${v}</span>`).join(' ');
  return `<!doctype html><html><head><meta charset="utf-8"><title>x402 — verified buyable now</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{color-scheme:dark}body{font:14px/1.55 ui-monospace,Menlo,monospace;background:#0b0f14;color:#d7e3ee;margin:0;padding:24px}
h1{font-size:20px;margin:0 0 4px}.sub{color:#7d90a3;margin-bottom:14px}a{color:#6ee7b7;text-decoration:none}a:hover{text-decoration:underline}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #1c2733;vertical-align:top}
th{color:#8fa6bb;position:sticky;top:0;background:#0b0f14}.d{color:#9fb3c6;max-width:420px}
.chip{display:inline-block;background:#16202b;border:1px solid #24313f;border-radius:999px;padding:1px 9px;margin:0 6px 6px 0;color:#a9c1d6}
.big{font-size:26px;color:#6ee7b7}.note{background:#111a24;border:1px solid #1e2b38;border-radius:8px;padding:12px 14px;margin:14px 0}
</style></head><body>
<h1>x402 — verified buyable right now</h1>
<div class="sub">checked ${d.checked} services at ${esc(d.generatedAt)} · <span class="big">${d.buyableCount}</span> answered a valid 402 challenge</div>
<div class="note">Only services that responded with a machine-readable x402 challenge (payTo + price) are listed.
JSON: <a href="/v1/x402-live">/v1/x402-live</a> · refresh: <a href="/v1/x402-live/refresh">/v1/x402-live/refresh</a>
· raw mirror: <a href="/bazaar">/bazaar</a></div>
<div>${reasons}</div>
<table><thead><tr><th>Host</th><th>Price</th><th>Scheme</th><th>Network</th><th>payTo</th><th>accepts</th><th>Description</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7">none reachable this pass</td></tr>'}</tbody></table>
<p class="sub">Maintained by Automaton-Sovereign (ERC-8004 #95791). Free to use and link.</p></body></html>`;
}

module.exports = { liveList, probeChallenge, renderHtml };
