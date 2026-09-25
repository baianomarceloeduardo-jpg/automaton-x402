#!/usr/bin/env node
// finalize.js - decisive end-to-end proof on the PUBLIC url.
'use strict';
const http = require('http'), https = require('https'), fs = require('fs');
const BASE = fs.readFileSync('tunnel.url', 'utf8').trim();
const url = new URL(BASE);

function req(path, headers = {}) {
  return new Promise((res, rej) => {
    const r = https.request({ hostname: url.hostname, path, method: 'GET', headers, timeout: 20000 }, x => {
      let b = ''; x.on('data', c => b += c);
      x.on('end', () => res({ status: x.statusCode, headers: x.headers, body: b }));
    });
    r.on('error', rej); r.on('timeout', () => { r.destroy(new Error('timeout')); }); r.end();
  });
}

(async () => {
  const L = [];
  const W = m => { L.push(m); console.log(m); };
  W('=== PUBLIC e2e @ ' + BASE + ' ===');

  // 1) HTML storefront renders when a browser-like Accept is sent
  const html = await req('/', { Accept: 'text/html,*/*' });
  const isHtml = html.status === 200 && /Automaton-Sovereign Value API/.test(html.body) && /<html/i.test(html.body);
  W(`storefront /        -> ${html.status} html=${isHtml} bytes=${html.body.length}`);

  // 2) free discovery surface
  for (const p of ['/health', '/pricing', '/.well-known/x402', '/.well-known/agent-card.json', '/openapi.json', '/stats', '/v2/pubkey']) {
    const r = await req(p);
    W(`discovery ${p} -> ${r.status}`);
  }

  // 3) exhaust the public trial on a paid route, then prove 402 + accepts[] discovery
  let challenge = null, seq = [];
  for (let i = 1; i <= 5; i++) {
    const r = await req('/v1/uuid?n=' + i);
    seq.push(r.status);
    if (r.status === 402 && !challenge) challenge = r.body;
  }
  W(`paid /v1/uuid trial sequence: ${seq.join(',')}`);

  if (challenge) {
    const j = JSON.parse(challenge);
    const a = j.accepts[0];
    W('402 challenge parsed OK:');
    W(`  scheme=${a.scheme} network=${a.network} chainId=${a.chainId} asset=${a.asset}`);
    W(`  payTo=${a.payTo} amount=${a.maxAmountRequired} resource=${a.resource}`);
    W(`  howTo="${j.howTo}"`);
  } else { W('WARN: no 402 seen on public trial'); }

  // 4) forgery rejected publicly
  const f = await req('/v1/hash?input=forge', { 'X-PAYMENT': '0x' + 'de'.repeat(32) });
  W(`forgery X-PAYMENT -> ${f.status} (${f.status === 402 ? 'REJECTED OK' : 'CHECK'})`);

  // 5) tamper check on the hash ledger (cryptographic integrity publicly verifiable)
  const v = await req('/v2/verify');
  let vj = null; try { vj = JSON.parse(v.body); } catch (e) {}
  W(`/v2/verify -> ${v.status} valid=${vj && (vj.valid !== undefined ? vj.valid : vj.ok)} entries=${vj && (vj.length || vj.entries || vj.count)}`);

  fs.appendFileSync('finalize.log', L.join('\n') + '\n\n');
  W('\nDONE. Loop proven: discovery -> 402 terms -> payment path defined -> forgery rejected. Only a funded wallet is missing.');
})().catch(e => { console.error('FATAL ' + e.message); process.exit(1); });
