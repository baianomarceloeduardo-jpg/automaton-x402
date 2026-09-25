#!/usr/bin/env node
'use strict';
/**
 * Automaton-Sovereign Value API — client SDK (zero deps)
 *
 * Usage as a module:
 *   const { ValueApiClient } = require('./client');
 *   const c = new ValueApiClient('https://YOUR-TUNNEL.lhr.life', { txHashProvider: async (terms) => '0x...' });
 *   const r = await c.hash('sovereign');   // handles 402 -> pay -> retry
 *
 * Usage as a CLI:
 *   node client.js https://YOUR-TUNNEL.lhr.life /v1/hash?input=hello
 *
 * The client is agnostic about HOW you pay. You supply a txHashProvider that,
 * given the 402 `accepts` terms, returns the Base tx hash of a USDC transfer
 * to terms.payTo. This keeps signing keys out of the client entirely.
 */
const https = require('https');
const http = require('http');

function request(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method, headers
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

class PaymentRequired extends Error {
  constructor(terms) { super('payment_required'); this.terms = terms; }
}

class ValueApiClient {
  constructor(baseUrl, opts = {}) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.txHashProvider = opts.txHashProvider || null;
    this.maxRetries = opts.maxRetries || 1;
  }

  async call(pathname, opts = {}) {
    const url = this.base + pathname;
    let res = await request(url, opts);
    if (res.status !== 402) return res;

    const terms = (res.body && res.body.accepts && res.body.accepts[0]) || null;
    if (!this.txHashProvider) throw new PaymentRequired(terms);

    const txHash = await this.txHashProvider(terms, res.body);
    const headers = Object.assign({}, opts.headers || {}, { 'X-PAYMENT': txHash });
    res = await request(url, Object.assign({}, opts, { headers }));
    return res;
  }

  hash(input)          { return this.call('/v1/hash?input=' + encodeURIComponent(input || '')); }
  echo(msg)            { return this.call('/v1/echo?msg=' + encodeURIComponent(msg || '')); }
  uuid()               { return this.call('/v1/uuid'); }
  random(min = 0, max = 1000000) { return this.call('/v1/random?min=' + min + '&max=' + max); }
  pricing()            { return this.call('/pricing'); }
  stats()              { return this.call('/stats'); }
}

module.exports = { ValueApiClient, PaymentRequired, request };

// ---- CLI ----
if (require.main === module) {
  const [, , base, pathname] = process.argv;
  if (!base || !pathname) {
    console.log('usage: node client.js <baseUrl> <pathname>');
    console.log('  e.g. node client.js https://xxxx.lhr.life /v1/hash?input=hello');
    process.exit(1);
  }
  const c = new ValueApiClient(base);
  c.call(pathname).then(r => {
    console.log('HTTP ' + r.status);
    console.log(JSON.stringify(r.body, null, 2));
  }).catch(e => {
    if (e instanceof PaymentRequired) {
      console.log('HTTP 402 payment_required');
      console.log('Terms: ' + JSON.stringify(e.terms, null, 2));
      console.log('\nPay the required USDC to terms.payTo on Base, then retry with header X-PAYMENT: <txHash>.');
    } else { console.error('ERR: ' + e.message); process.exit(1); }
  });
}
