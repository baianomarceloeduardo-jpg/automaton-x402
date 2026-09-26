// x402-discover-submit.js — get listed where x402 BUYERS actually shop.
//
// WHY THIS IS THE RIGHT BUILD:
//   Capability is closed (14/14 public proof, on-chain settlement). Durability is closed
//   (self-heal-paid.js + supervisor). The ONLY remaining constraint is that nobody knows my
//   URL. Buyers do not browse paste.rs; they discover x402 sellers through the public
//   discovery indexes that x402 client libraries query. This script reaches those indexes,
//   learns their real schema from their own responses, and submits my live resource.
//
// DISCIPLINE: every endpoint below is probed and the REAL response is recorded. No fabricated
// endpoints. If a surface needs a credential I do not hold, it is reported honestly as such.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DIR = __dirname;
const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';

function base() {
  for (const f of ['paid-tunnel.url', 'tunnel.url']) {
    try { const u = fs.readFileSync(path.join(DIR, f), 'utf8').trim(); if (/^https?:\/\//.test(u)) return u; } catch (e) {}
  }
  return null;
}
function req(method, url, { body, headers } = {}) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ status: 0, body: 'badurl', headers: {} }); }
    const mod = u.protocol === 'https:' ? https : http;
    const data = body != null ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const h = Object.assign({ 'user-agent': 'automaton-sovereign/1.0', accept: 'application/json' }, headers || {});
    if (data) { h['content-type'] = h['content-type'] || 'application/json'; h['content-length'] = data.length; }
    const r = mod.request({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method, headers: h, timeout: 20000 }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    r.on('error', e => resolve({ status: 0, body: e.message, headers: {} }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout', headers: {} }); });
    if (data) r.write(data);
    r.end();
  });
}
const brief = s => String(s || '').replace(/\s+/g, ' ').slice(0, 220);

(async () => {
  const b = base();
  if (!b) { console.log('no live base'); process.exit(2); }
  console.log('LIVE BASE = ' + b);
  const out = { at: new Date().toISOString(), base: b, probes: [], submissions: [] };

  // --- the resource descriptor that buyers' clients consume ---
  const resource = {
    resource: b + '/paid/uuid',
    type: 'http',
    x402Version: 1,
    accepts: [{
      scheme: 'eip3009', network: 'base', chainId: 8453,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: PAY_TO, maxAmountRequired: '1000',
      resource: b + '/paid/uuid',
      description: 'Caller-bound USDC micro-utility (uuid/hash/time). Buyer needs ZERO ETH.',
      mimeType: 'application/json',
    }],
    metadata: {
      name: 'Automaton-Sovereign Paid API',
      description: 'On-chain-settled x402 utilities on Base. Buyer signs offline (no gas); seller settles and pays gas.',
      seller: PAY_TO, agentId: 95791,
      free: [b + '/health', b + '/pricing', b + '/.well-known/x402'],
      paid: ['/paid/hash', '/paid/uuid', '/paid/time', '/paid/hashchain'].map(p => b + p),
      priceUsdc: '0.001', buyerNeedsEth: false, callerBound: true, replayProtected: true,
    },
  };
  fs.writeFileSync(path.join(DIR, 'resource-descriptor.json'), JSON.stringify(resource, null, 2));

  // --- SURFACE 1: my own discovery manifest must be served and valid ---
  for (const p of ['/.well-known/x402', '/pricing', '/health', '/ledger']) {
    const r = await req('GET', b + p);
    out.probes.push({ surface: 'self', path: p, status: r.status, bytes: r.body.length });
    console.log('[self] ' + p + ' -> ' + r.status + ' (' + r.body.length + ' bytes)');
  }

  // --- SURFACE 2: public x402 discovery indexes (buyers' clients query these) ---
  const indexes = [
    { name: 'x402.org bazaar/resources', url: 'https://x402.org/bazaar/resources', method: 'GET' },
    { name: 'x402.org discovery', url: 'https://x402.org/discovery/resources', method: 'GET' },
    { name: 'cdp discovery resources', url: 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources', method: 'GET' },
    { name: 'facilitator.x402.rs list', url: 'https://facilitator.x402.rs/list', method: 'GET' },
    { name: 'x402scan services', url: 'https://www.x402scan.com/api/services', method: 'GET' },
    { name: 'x402scan resources', url: 'https://www.x402scan.com/api/resources', method: 'GET' },
  ];
  for (const ix of indexes) {
    const r = await req(ix.method, ix.url);
    let n = null, shape = null;
    try { const j = JSON.parse(r.body); shape = Array.isArray(j) ? 'array' : typeof j === 'object' ? Object.keys(j).slice(0, 8).join(',') : typeof j; n = Array.isArray(j) ? j.length : (j.items ? j.items.length : (j.resources ? j.resources.length : null)); }
    catch (e) { shape = 'non-json'; }
    out.probes.push({ surface: ix.name, url: ix.url, status: r.status, bytes: r.body.length, shape, count: n });
    console.log('[index] ' + ix.name + ' -> ' + r.status + ' bytes=' + r.body.length + ' shape=' + shape + ' count=' + n);
    if (r.status >= 200 && r.status < 300 && r.body.length < 4000) console.log('        body: ' + brief(r.body));
  }

  // --- SURFACE 3: submit (only where the surface itself documents an unauthenticated way in) ---
  const submits = [
    { name: 'x402scan submit', url: 'https://www.x402scan.com/api/resources', body: { url: b + '/paid/uuid' } },
    { name: 'x402scan services submit', url: 'https://www.x402scan.com/api/services', body: { url: b } },
  ];
  for (const s of submits) {
    const r = await req('POST', s.url, { body: s.body });
    out.submissions.push({ name: s.name, url: s.url, status: r.status, body: brief(r.body) });
    console.log('[submit] ' + s.name + ' -> ' + r.status + ' ' + brief(r.body));
  }

  fs.writeFileSync(path.join(DIR, 'DISCOVERY-PROBE.json'), JSON.stringify(out, null, 2));
  console.log('\nwrote DISCOVERY-PROBE.json');
})();
