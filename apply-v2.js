// apply-v2.js — install the x402 v2 overlay into server.js, then PROVE it live over real HTTP.
// Reversible: deletes/re-adds a single require line; backup kept as server.js.bak10.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const DIR = __dirname;
const F = path.join(DIR, 'server.js');
const MARK = '__X402V2_OVERLAY__';
const LINE = "/* " + MARK + " */ require('./x402v2-overlay.js').install(require('http'));";

function sh(cmd, args, opts) {
  return new Promise(res => {
    const p = spawn(cmd, args, Object.assign({ cwd: DIR }, opts || {}));
    let o = '', e = '';
    p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d);
    p.on('close', c => res({ code: c, out: o, err: e }));
    p.on('error', err => res({ code: -1, out: '', err: String(err) }));
  });
}

function get(port, p, tries) {
  return new Promise(resolve => {
    const attempt = n => {
      const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', timeout: 3000 }, res => {
        let b = ''; res.on('data', c => b += c);
        res.on('end', () => {
          if (res.statusCode === 402 || n >= tries) return resolve({ status: res.statusCode, headers: res.headers, body: b });
          setTimeout(() => attempt(n + 1), 250);
        });
      });
      r.on('error', () => n >= tries ? resolve({ status: 0, body: '' }) : setTimeout(() => attempt(n + 1), 400));
      r.on('timeout', () => { r.destroy(); attempt(n + 1); });
      r.end();
    };
    attempt(1);
  });
}

(async () => {
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  -- ' + detail : '')); };

  // --- unit proof of the transform ---
  const ov = require(path.join(DIR, 'x402v2-overlay.js'));
  const v1 = { x402Version: 1, accepts: [{ scheme: 'eip3009', network: 'base', asset: ov.USDC,
    payTo: '0x71DEAc098914A009E3720524642A6bE6F65EE528', maxAmountRequired: '1000' }] };
  const up = ov.upgradeChallenge(v1);
  check('unit: x402Version -> 2', up.x402Version === 2);
  check('unit: network -> eip155:8453', up.accepts[0].network === ov.CAIP2, up.accepts[0].network);
  check('unit: amount mirrors maxAmountRequired', up.accepts[0].amount === '1000');
  check('unit: v1 fields preserved (maxAmountRequired)', up.accepts[0].maxAmountRequired === '1000');
  check('unit: extra.credentialTypes authorization', String(up.accepts[0].extra.credentialTypes) === 'authorization');
  check('unit: legacy mirror for v1-only buyers', up.legacy && up.legacy.x402Version === 1);
  check('unit: payment_rails emitted', Array.isArray(up.payment_rails) && up.payment_rails.length === 1);

  // --- install into server.js ---
  let s = fs.readFileSync(F, 'utf8');
  if (!fs.existsSync(F + '.bak10')) fs.writeFileSync(F + '.bak10', s);
  // always strip then re-add so this script is idempotent
  s = s.split('\n').filter(l => l.indexOf(MARK) === -1).join('\n');
  s = LINE + '\n' + s;
  fs.writeFileSync(F, s);
  check('installed overlay require line', fs.readFileSync(F, 'utf8').indexOf(MARK) !== -1);

  const syn = await sh('node', ['--check', F]);
  check('syntax OK after overlay', syn.code === 0, syn.err.slice(0, 200));
  if (syn.code !== 0) { console.log('ABORT: syntax broken'); process.exit(1); }

  // --- live HTTP proof ---
  const PORT = 8099;
  const proc = spawn('node', [F], { cwd: DIR, env: Object.assign({}, process.env, { PORT: String(PORT) }) });
  let perr = ''; proc.stderr.on('data', d => perr += d);
  await new Promise(r => setTimeout(r, 2500));

  let live = { status: 0 };
  for (const p of ['/v1/hash', '/v1/echo', '/v1/random', '/']) {
    live = await get(PORT, p, 4);
    if (live.status === 402) { console.log('live 402 obtained from ' + p); break; }
  }
  check('live: server returned a 402 challenge', live.status === 402, 'status=' + live.status + ' ' + perr.slice(0, 150));
  if (live.status === 402) {
    let j = null; try { j = JSON.parse(live.body); } catch (e) {}
    check('live: body is JSON', !!j);
    if (j) {
      check('live: x402Version == 2', j.x402Version === 2, 'got ' + j.x402Version);
      const a = (j.accepts || [])[0] || {};
      check('live: network == eip155:8453', a.network === ov.CAIP2, 'got ' + a.network);
      check('live: amount present', a.amount != null, 'amount=' + a.amount);
      check('live: extra.credentialTypes authorization', String(a.extra && a.extra.credentialTypes) === 'authorization');
      check('live: payment_rails present', Array.isArray(j.payment_rails));
    }
    const hdr = live.headers['payment-required'] || '';
    check('live: PAYMENT-REQUIRED header present', !!hdr, hdr ? hdr.slice(0, 40) + '...' : 'missing');
    check('live: X-402-Version header == 2', live.headers['x-402-version'] === '2');
  }

  try { proc.kill(); } catch (e) {}

  const passed = results.filter(r => r.ok).length;
  console.log('\n=== ' + passed + '/' + results.length + ' PASS ===');
  fs.writeFileSync(path.join(DIR, 'apply-v2-results.json'),
    JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results }, null, 2));
})().catch(e => { console.log('FATAL ' + e.message); process.exit(2); });
