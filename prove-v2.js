// prove-v2.js — DETERMINISTIC proof that the x402 v2 overlay works, over real HTTP.
// The live-server test was confounded by free-trial state (routes returned 200, not 402).
// This spins a minimal v1-402 server WITH the overlay and asserts the v2 wire format exactly.
// Same class of lesson as Session 2: test the mechanism in isolation, not through state.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ov = require(path.join(__dirname, 'x402v2-overlay.js'));
ov.install(http);

const PAYTO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const V1 = { x402Version: 1, error: 'payment_required', accepts: [{
  scheme: 'eip3009', network: 'base', asset: ov.USDC, payTo: PAYTO, maxAmountRequired: '1000',
  resource: 'http://x/v1/echo', description: 'echo' }] };

const srv = http.createServer((req, res) => {
  res.writeHead(402, { 'content-type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(V1)) });
  res.end(JSON.stringify(V1));
});

const get = port => new Promise(resolve => {
  const r = http.request({ host: '127.0.0.1', port, path: '/v1/echo', method: 'GET', timeout: 4000 }, res => {
    let b = ''; res.on('data', c => b += c);
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
  });
  r.on('error', e => resolve({ status: 0, error: String(e.message) }));
  r.end();
});

(async () => {
  const PORT = 8123;
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
  const res = await get(PORT);
  const R = [];
  const check = (n, ok, d) => { R.push({ n, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? '  -- ' + d : '')); };

  check('HTTP 402 returned', res.status === 402, 'status=' + res.status);
  let j = null; try { j = JSON.parse(res.body); } catch (e) {}
  check('body parses as JSON (no truncation)', !!j, 'bytes=' + Buffer.byteLength(res.body || ''));
  if (j) {
    check('x402Version == 2', j.x402Version === 2, 'got ' + j.x402Version);
    check('supportedVersions includes 1 and 2', String(j.supportedVersions) === '1,2');
    const a = (j.accepts || [])[0] || {};
    check('network == eip155:8453 (CAIP-2)', a.network === ov.CAIP2, 'got ' + a.network);
    check('networkV1 preserved for legacy buyers', a.networkV1 === 'base', 'got ' + a.networkV1);
    check('amount present and == maxAmountRequired', a.amount === '1000' && a.maxAmountRequired === '1000');
    check('currency set to USDC', a.currency === ov.USDC);
    check('recipient mirrors payTo', a.recipient === PAYTO);
    check('extra.credentialTypes == authorization', String(a.extra && a.extra.credentialTypes) === 'authorization');
    check('extra name/version = USD Coin / 2', a.extra.name === 'USD Coin' && a.extra.version === '2');
    check('payment_rails emitted', Array.isArray(j.payment_rails) && j.payment_rails[0].chain === ov.CAIP2);
    check('legacy v1 mirror emitted', j.legacy && j.legacy.x402Version === 1 && j.legacy.accepts[0].network === 'base');
    check('content-length matches actual body', Number(res.headers['content-length']) === Buffer.byteLength(res.body), 'cl=' + res.headers['content-length'] + ' actual=' + Buffer.byteLength(res.body));
  }
  check('PAYMENT-REQUIRED header present', !!res.headers['payment-required']);
  if (res.headers['payment-required']) {
    let dec = null; try { dec = JSON.parse(Buffer.from(res.headers['payment-required'], 'base64').toString()); } catch (e) {}
    check('PAYMENT-REQUIRED decodes to the same v2 challenge', !!dec && dec.x402Version === 2 && dec.accepts[0].network === ov.CAIP2);
  }
  check('X-402-Version header == 2', res.headers['x-402-version'] === '2');
  check('CORS expose-headers set', String(res.headers['access-control-expose-headers'] || '').indexOf('PAYMENT-REQUIRED') !== -1);

  const passed = R.filter(r => r.ok).length;
  console.log('\n=== ' + passed + '/' + R.length + ' PASS ===');
  fs.writeFileSync(path.join(__dirname, 'prove-v2-results.json'),
    JSON.stringify({ at: new Date().toISOString(), passed, total: R.length, results: R }, null, 2));
  srv.close();
  process.exit(passed === R.length ? 0 : 1);
})().catch(e => { console.log('FATAL ' + e.message); process.exit(2); });
