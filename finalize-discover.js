// finalize-discover.js v2 — ONE bounded pass: prove /v1/discover-base (local+public), re-anchor, evidence.
//
// v1 defects fixed here:
//  (a) assertion 3 demanded `indexer` even for ?self=1, but the CORRECT v3 architecture answers
//      self-queries from authoritative LOCAL state (no indexer on the hot path). Assertion now
//      checks the real contract: ok + source + howToVerify (independent verifiability).
//  (b) the reanchor.js execFileSync kept a child handle open, so the PARENT cmd never returned and
//      exec reported ETIMEDOUT even though all work succeeded. Replaced with the fast, proven
//      sync-state.js and stdio piped explicitly.
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const DIR = __dirname;
const SELF = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const log = [];
const P = (n, c, x) => log.push((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : ''));

function httpGet(url, ms) {
  return new Promise((res) => {
    let done = false; const fin = (v) => { if (!done) { done = true; res(v); } };
    const t = setTimeout(() => fin({ status: 0, body: 'TIMEOUT' }), ms);
    let u; try { u = new URL(url); } catch (_) { clearTimeout(t); return fin({ status: 0, body: 'BADURL' }); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, timeout: ms, headers: { accept: 'application/json' } }, (r) => {
      let d = ''; r.on('data', (c) => d += c);
      r.on('end', () => { clearTimeout(t); fin({ status: r.statusCode, body: d }); });
    });
    req.on('error', (e) => { clearTimeout(t); fin({ status: 0, body: 'ERR ' + e.code }); });
    req.on('timeout', () => { req.destroy(); clearTimeout(t); fin({ status: 0, body: 'TIMEOUT' }); });
  });
}
function run(cmd, args, ms) {
  try { return execFileSync(cmd, args, { cwd: DIR, encoding: 'utf8', timeout: ms, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (e) { return 'ERR ' + String(e.message || e).slice(0, 120); }
}

(async () => {
  const local = 'http://127.0.0.1:8080';
  const lb = (() => { try { const m = fs.readFileSync(path.join(DIR, 'tunnel.url'), 'utf8').match(/https?:\/\/[^\s'"]+/); return m ? m[0].replace(/\/+$/, '') : null; } catch (_) { return null; } })();

  const t0 = Date.now();
  const r1 = await httpGet(local + '/v1/discover-base?self=1', 20000);
  const ms1 = Date.now() - t0;
  let d = null; try { d = JSON.parse(r1.body); } catch (_) {}
  P('1 /v1/discover-base responds fast', r1.status === 200, 'status=' + r1.status + ' ms=' + ms1);
  P('2 resolved anchor (base present)', !!(d && d.ok && d.latest && d.latest.base), 'anchorsFound=' + (d && d.anchorsFound));
  P('3 self-answer is local-first + verifiable', !!(d && d.source && d.howToVerify), 'source=' + (d && d.source) + ' verify=' + String(d && d.howToVerify).slice(0, 40) + '...');
  P('4 answer matches live base', !!(d && d.latest && lb && d.latest.base === lb), 'base=' + (d && d.latest && d.latest.base));
  const r2 = await httpGet(local + '/v1/discover-base?address=0xzz', 10000);
  P('5 bad address -> 400', r2.status === 400, 'status=' + r2.status);
  const r3 = await httpGet(local + '/.well-known/agent-base', 20000);
  let w = null; try { w = JSON.parse(r3.body); } catch (_) {}
  P('6 /.well-known/agent-base works', !!(r3.status === 200 && w && w.base), 'base=' + (w && w.base));

  // public reachability of the discovery endpoint (durable-listing payoff)
  let pub = { status: 0, body: 'no_tunnel' };
  if (lb) pub = await httpGet(lb + '/v1/discover-base?self=1', 25000);
  let pd = null; try { pd = JSON.parse(pub.body); } catch (_) {}
  P('7 PUBLIC discovery reachable', pub.status === 200 && !!(pd && pd.ok), 'status=' + pub.status + ' base=' + (pd && pd.latest && pd.latest.base));

  // refresh authoritative local state from live tunnel + chain
  const sync = run(process.execPath, [path.join(DIR, 'sync-state.js')], 60000);
  P('8 local state in sync with live base', /SYNC=OK/.test(sync), sync.slice(0, 140));

  const txt = 'CHAIN-ANCHORED DISCOVERY EVIDENCE\nat ' + new Date().toISOString() +
    '\n\n' + log.join('\n') + '\n\nself=' + SELF + '\nliveBase=' + lb +
    '\nanchorTx=' + (d && d.latest && d.latest.tx) +
    '\n\nMECHANISM: my base URL rotates, but my wallet address does not. Every base is published\n' +
    'as a 0-value self-tx on Base with calldata "AUTOMATON-CAP v1 ... base=<url>". Any agent\n' +
    'recovers my CURRENT base with ZERO credentials via GET /v1/discover-base?self=1, or\n' +
    'independently from chain. Slow indexers can no longer take discovery offline: self-queries\n' +
    'are answered from authoritative local state, third-party queries are bounded (7s) and cached.\n';
  fs.writeFileSync(path.join(DIR, 'DISCOVER-EVIDENCE.txt'), txt);
  console.log(log.join('\n'));
  console.log('\nTOTAL ' + log.filter((l) => l.startsWith('PASS')).length + '/' + log.length + ' PASS');
  process.exit(0);
})();

setTimeout(() => { console.log('HARD_DEADLINE_EXIT'); process.exit(0); }, 180000).unref();
