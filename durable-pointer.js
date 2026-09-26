// durable-pointer.js — a STABLE, UPDATABLE public URL that always names my live base.
//
// THE STRUCTURAL PROBLEM IT SOLVES:
//   My ERC-8004 identity resolves to an agent card whose baseUrl rotates with the tunnel.
//   Every rotation makes the on-chain record stale, which is a broken promise to any agent
//   that discovers and pays me. Rewriting the card each time is a treadmill.
//
// THE FIX: publish the live base into an append/update-capable public store that hands back
//   a STABLE id. The card (and the on-chain URI) can then reference ONE url that never
//   changes, while the CONTENT is updated in place on each self-heal cycle.
//
// Adapters (tried in order, first success wins):
//   kvdb.io    — PUT /<bucket>/<key> updates a fixed url
//   jsonblob   — POST creates, PUT /<id> updates in place
// Both are keyless. Round-trip is VERIFIED (write, read back, compare) before we trust it.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const DIR = __dirname;
const STATE = path.join(DIR, 'durable-pointer.json');

function request(method, url, body, headers) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ status: 0, error: 'bad_url' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const h = Object.assign({ 'user-agent': 'automaton-durable-pointer/1.0' }, headers || {});
    if (body != null) h['content-length'] = Buffer.byteLength(body);
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

function loadState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return {}; } }
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n'); }

// ---- kvdb.io ----------------------------------------------------------------
async function kvdbWrite(payload, state) {
  let bucket = state.kvdbBucket;
  if (!bucket) {
    const created = await request('POST', 'https://kvdb.io/', '');
    if (created.status !== 200 && created.status !== 201) return { ok: false, err: 'kvdb_create_' + created.status };
    bucket = (created.body || '').trim();
    if (!/^[A-Za-z0-9]{20,}$/.test(bucket)) return { ok: false, err: 'kvdb_bad_bucket' };
    state.kvdbBucket = bucket;
  }
  const url = 'https://kvdb.io/' + bucket + '/current';
  const put = await request('PUT', url, payload, { 'content-type': 'application/json' });
  if (put.status !== 200) return { ok: false, err: 'kvdb_put_' + put.status };
  const [readUrl] = await Promise.all([request('GET', url)]);
  if (readUrl.status !== 200) return { ok: false, err: 'kvdb_get_' + readUrl.status };
  const ok = readUrl.body.trim() === payload.trim();
  return { ok, url, err: ok ? null : 'kvdb_roundtrip_mismatch' };
}

// ---- jsonblob ---------------------------------------------------------------
async function jsonblobWrite(payload, state) {
  let url = state.jsonblobUrl;
  if (!url) {
    const created = await request('POST', 'https://jsonblob.com/api/jsonBlob', payload,
      { 'content-type': 'application/json' });
    if (created.status !== 201) return { ok: false, err: 'blob_create_' + created.status };
    url = created.headers && created.headers.location;
    if (!url) return { ok: false, err: 'blob_no_location' };
    state.jsonblobUrl = url;
  } else {
    const put = await request('PUT', url, payload, { 'content-type': 'application/json' });
    if (put.status !== 200 && put.status !== 204) return { ok: false, err: 'blob_put_' + put.status };
  }
  const read = await request('GET', url);
  if (read.status !== 200) return { ok: false, err: 'blob_get_' + read.status };
  // jsonblob may normalise whitespace/key order — compare parsed structures.
  let same = false;
  try { same = JSON.stringify(JSON.parse(read.body)) === JSON.stringify(JSON.parse(payload)); }
  catch (_) { same = read.body.trim() === payload.trim(); }
  return { ok: same, url, err: same ? null : 'blob_roundtrip_mismatch' };
}

(async () => {
  let base = (process.argv[2] || '').trim();
  if (!/^https?:\/\//.test(base)) {
    try { base = (fs.readFileSync(path.join(DIR, 'tunnel.url'), 'utf8').split('=').pop() || '').trim(); } catch (_) {}
  }
  if (!/^https?:\/\//.test(base)) { console.log('DURABLE_POINTER=FAIL reason=no_base'); process.exit(2); }

  const live = await request('GET', base + '/health');
  if (live.status !== 200) { console.log('DURABLE_POINTER=FAIL reason=base_not_live'); process.exit(3); }

  const state = loadState();
  const payload = JSON.stringify({
    schema: 'automaton-durable-pointer/v1',
    agent: 'Automaton-Sovereign',
    erc8004AgentId: 95791,
    address: '0x71DEAc098914A009E3720524642A6bE6F65EE528',
    chain: 'base', chainId: 8453, asset: 'USDC',
    liveBase: base,
    updatedAt: new Date().toISOString(),
    revision: crypto.randomBytes(4).toString('hex'),
    free: {
      health: base + '/health', pricing: base + '/pricing',
      discovery: base + '/.well-known/x402', clientKit: base + '/x402-v2-kit.js',
      leaderboard: base + '/index', verifyPayment: base + '/v1/verify-payment',
      badge: base + '/badge.svg?url=<target>'
    },
    paid: [base + '/v1/hash', base + '/v1/echo', base + '/v1/uuid', base + '/v2/oracle/base'],
    price: '0.001 USDC per call', payTo: '0x71DEAc098914A009E3720524642A6bE6F65EE528',
    note: 'This URL is STABLE. liveBase inside it rotates; this pointer is updated in place.'
  }, null, 2);

  const results = [];
  for (const [name, fn] of [['kvdb', kvdbWrite], ['jsonblob', jsonblobWrite]]) {
    const r = await fn(payload, state);
    results.push(name + '=' + (r.ok ? 'OK' : 'FAIL') + (r.err ? '(' + r.err + ')' : ''));
    if (r.ok) {
      state.stableUrl = r.url;
      state.provider = name;
      state.updatedAt = new Date().toISOString();
      state.liveBase = base;
      saveState(state);
      console.log('attempts: ' + results.join(' '));
      console.log('STABLE_URL=' + r.url);
      console.log('DURABLE_POINTER=PASS provider=' + name);
      return;
    }
  }
  saveState(state);
  console.log('attempts: ' + results.join(' '));
  console.log('DURABLE_POINTER=FAIL');
  process.exit(4);
})();
