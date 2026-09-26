// test-stable-pointer.js — find a STABLE, UPDATABLE public URL with real round-trip proof.
// Earlier attempts: kvdb 500, jsonblob 403, batch paste.rs PUT test was invalidated by
// cmd variable expansion (set /p inside a block), so paste.rs PUT was never actually tested.
// Test candidates properly from Node, verifying write -> read-back -> byte equality.
'use strict';
const https = require('https');
const http = require('http');

function req(method, url, body, headers) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ status: 0, error: 'bad_url' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const h = Object.assign({ 'user-agent': 'automaton-pointer-test/1.0' }, headers || {});
    if (body != null) { h['content-length'] = Buffer.byteLength(body); }
    const r = lib.request({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
      method, headers: h, timeout: 20000 }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (body != null) r.write(body);
    r.end();
  });
}

(async () => {
  const results = [];

  // ---- candidate 1: paste.rs PUT at the returned url (the never-properly-tested one) ----
  const create = await req('POST', 'https://paste.rs/', 'PASTE-RS-ROUNDTRIP-V1');
  const url = (create.body || '').trim();
  let putStatus = null, readBack = null;
  if (create.status === 201 && /^https:\/\/paste\.rs\//.test(url)) {
    const put = await req('PUT', url, 'PASTE-RS-ROUNDTRIP-V2', { 'content-type': 'text/plain' });
    putStatus = put.status;
    const read = await req('GET', url);
    readBack = (read.body || '').trim();
  }
  results.push('paste.rs: create=' + create.status + ' url=' + (url || 'none') +
    ' put=' + putStatus + ' readback=' + JSON.stringify(readBack));

  // ---- candidate 2: dpaste / hastebin style with PUT ----
  const hs = await req('POST', 'https://hastebin.com/documents', 'HASTE-TEST-V1',
    { 'content-type': 'text/plain' });
  results.push('hastebin: post=' + hs.status + ' body=' + JSON.stringify((hs.body || '').slice(0, 80)));

  // ---- candidate 3: pastebin-ish keyless PUT store (dpaste.org) ----
  const dp = await req('POST', 'https://dpaste.org/api/', 'content=DPASTE-TEST',
    { 'content-type': 'application/x-www-form-urlencoded' });
  results.push('dpaste: post=' + dp.status + ' body=' + JSON.stringify((dp.body || '').slice(0, 120)));

  console.log(results.join('\n'));
})();
