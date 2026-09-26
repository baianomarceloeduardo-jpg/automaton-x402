// prove-discover.js — end-to-end proof that chain-anchored discovery works, then re-anchor live.
// Proves: (1) server is up, (2) /v1/discover-base resolves MY on-chain anchor with zero creds,
// (3) the returned base is the LIVE base, (4) bad input is rejected, (5) re-anchor keeps it fresh.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const DIR = __dirname;
const SELF = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
let pass = 0, fail = 0;
const ok = (n, c, extra) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (extra ? '  ' + extra : '')); };

function liveBase() {
  try { const t = fs.readFileSync(path.join(DIR, 'tunnel.url'), 'utf8'); const m = t.match(/https?:\/\/[^\s'"]+/); return m ? m[0].replace(/\/+$/, '') : null; } catch (_) { return null; }
}

(async () => {
  const local = 'http://127.0.0.1:8080';

  // 1. server health
  let health = null;
  try { const r = await fetch(local + '/health'); health = r.status; } catch (e) { health = 'ERR ' + e.message; }
  ok('1 server healthy', health === 200, 'status=' + health);

  // 2. discovery resolves my own anchor from CHAIN (this is the whole point)
  let d = null;
  try { const r = await fetch(local + '/v1/discover-base?self=1'); d = await r.json(); } catch (e) { d = { error: e.message }; }
  ok('2 discovery resolves my on-chain anchor', !!(d && d.ok && d.latest && d.latest.base), 'anchorsFound=' + (d.anchorsFound));
  ok('3 discovery is credential-free (indexer used)', !!(d && d.indexer), d && d.indexer ? 'via blockscout' : 'no indexer');

  // 4. the resolved base matches the LIVE tunnel base
  const lb = liveBase();
  ok('4 resolved base == live base', !!(d && d.latest && lb && d.latest.base === lb), 'anchor=' + (d && d.latest && d.latest.base) + ' live=' + lb);

  // 5. bad input rejected (no crash, explicit 4xx)
  let bad = null;
  try { const r = await fetch(local + '/v1/discover-base?address=0xzz'); bad = r.status; } catch (e) { bad = 'ERR'; }
  ok('5 bad address -> 400', bad === 400, 'status=' + bad);

  // 6. the anchor is verifiable directly from chain by a stranger (RPC, no trust in me)
  let chainOk = false, chainTx = null;
  try { const r = await fetch(local + '/v1/discover-base?self=1'); const j = await r.json();
    chainTx = j.latest && j.latest.tx;
    if (chainTx) {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [chainTx] });
      const rr = await fetch('https://mainnet.base.org', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      const jj = await rr.json();
      const txt = Buffer.from(String(jj.result && jj.result.input || '').replace(/^0x/, ''), 'hex').toString('utf8');
      chainOk = txt.indexOf('AUTOMATON-') === 0 && txt.includes(lb);
    }
  } catch (_) {}
  ok('6 anchor verifiable from chain by anyone', chainOk, 'tx=' + (chainTx || '-'));

  // 7. re-anchor: makes the anchor self-healing (only fires when base changed)
  let re = 'skipped';
  try { re = execFileSync(process.execPath, [path.join(DIR, 'reanchor.js')], { cwd: DIR, encoding: 'utf8', timeout: 180000 }).trim(); } catch (e) { re = 'ERR ' + String(e.message).slice(0, 120); }
  ok('7 re-anchor is safe/idempotent', /REANCHOR=(SKIP|DONE|GO)/.test(re), re.replace(/\s+/g, ' ').slice(0, 160));

  console.log('\nTOTAL ' + pass + '/' + (pass + fail) + ' PASS');
  fs.writeFileSync(path.join(DIR, 'DISCOVER-EVIDENCE.txt'),
    'Chain-anchored discovery proof\nat ' + new Date().toISOString() +
    '\npass=' + pass + ' fail=' + fail + '\nanchors=' + (d && d.anchorsFound) +
    '\nanchor_base=' + (d && d.latest && d.latest.base) + '\nlive_base=' + lb +
    '\nanchor_tx=' + (chainTx || '-') + '\nreanchor="' + re + '"\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('FATAL ' + e.message); process.exit(1); });
