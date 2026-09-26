// probe-once.js — bounded, self-terminating. Guarantees exit so exec never hangs.
'use strict';
const https = require('https');
const RPC = 'https://mainnet.base.org';
const SELF = '0x71DEAc098914A009E3720524642A6bE6F65EE528';

function jget(url, ms) {
  return new Promise((res) => {
    let done = false; const fin = (v) => { if (!done) { done = true; res(v); } };
    let u; try { u = new URL(url); } catch (_) { return fin(null); }
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, timeout: ms,
      headers: { accept: 'application/json', 'user-agent': 'probe/1' } }, (r) => {
      let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { fin(JSON.parse(d)); } catch (_) { fin(d); } });
    });
    req.on('error', () => fin(null));
    req.on('timeout', () => { req.destroy(); fin(null); });
  });
}

(async () => {
  const out = { at: new Date().toISOString() };

  // A) local server listening?
  out.localHealth = await jget('http://127.0.0.1:8080/health', 5000) ? 'JSON' : (await new Promise((r) => {
    const http = require('http');
    const req = http.get({ host: '127.0.0.1', port: 8080, path: '/health', timeout: 5000 }, (x) => {
      let d = ''; x.on('data', (c) => d += c); x.on('end', () => r('HTTP' + x.statusCode + ' ' + d.slice(0, 120)));
    });
    req.on('error', (e) => r('ERR ' + e.code));
    req.on('timeout', () => { req.destroy(); r('TIMEOUT'); });
  }));

  // B) blockscout reachable + returns tx list for my address?
  const bs = await jget('https://base.blockscout.com/api/v2/addresses/' + SELF + '/transactions', 9000);
  out.blockscout = bs ? (Array.isArray(bs.items) ? 'items=' + bs.items.length : 'shape=' + Object.keys(bs).slice(0, 4).join(',')) : 'UNREACHABLE';

  // C) find my anchor tx directly via a plain RPC on a known recent block range is expensive;
  //    instead confirm the anchor we already sent is retrievable by hash (fast path).
  const txh = '0xa4befcc25a8974b3cefd7d03664fd925d79a578d92d332f27f87ae14fcc09a39';
  const t = await jget(RPC + '/x', 1); // placeholder to warm nothing
  out.rpcDirect = 'n/a';

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})();

// hard deadline: never let a stray socket hold the process
setTimeout(() => { console.log('HARD_DEADLINE_EXIT'); process.exit(0); }, 20000).unref();
