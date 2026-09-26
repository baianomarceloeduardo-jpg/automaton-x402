// prove-gasfree-live.js — boots the patched server on an ISOLATED port and proves
// the new gas-free routes over real HTTP. Uses PORT=8099 so the live tunnel is untouched.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 8099;
let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('  PASS ' + n + (e ? ' :: ' + e : '')); } else { fail++; console.log('  FAIL ' + n + (e ? ' :: ' + e : '')); } };

function get(p) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET', timeout: 90000 }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', e => resolve({ status: 0, body: 'ERR ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'TIMEOUT' }); });
    req.end();
  });
}
const j = s => { try { return JSON.parse(s); } catch (e) { return null; } };
const sleep = ms => new Promise(s => setTimeout(s, ms));

(async () => {
  console.log('=== gas-free checkout LIVE PROOF (isolated port ' + PORT + ') ===');
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  srv.stdout.on('data', d => out += d);
  srv.stderr.on('data', d => out += d);

  // wait for readiness
  let up = false;
  for (let i = 0; i < 30; i++) { await sleep(1000); const h = await get('/health'); if (h.status === 200) { up = true; break; } }
  t('1 patched server boots with overlay', up, up ? 'health 200' : out.slice(0, 300));

  if (up) {
    t('2 overlay attach logged', /gasfree-overlay/.test(out), (out.match(/\[gasfree-overlay\][^\n]*/) || [''])[0]);

    const q = await get('/v1/gasfree-quote?amount=0.001');
    const qj = j(q.body);
    t('3 GET /v1/gasfree-quote -> 200 JSON', q.status === 200 && !!qj, 'status=' + q.status);
    t('4 quote says payer needs 0 ETH', !!(qj && qj.payerNeedsEth === '0' && qj.gasFree === true));
    t('5 quote carries network base + USDC asset',
      !!(qj && qj.requirements && qj.requirements.network === 'base' && qj.requirements.asset === '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'));
    t('6 quote carries EIP-712 domain extra {name,version}',
      !!(qj && qj.requirements && qj.requirements.extra && qj.requirements.extra.name === 'USD Coin' && qj.requirements.extra.version === '2'));
    t('7 quote includes a live facilitator', !!(qj && /^https:\/\//.test(qj.facilitator || '')));
    t('8 quote documents the missing-domain gotcha',
      !!(qj && (qj.howTo || []).join(' ').includes('invalid_exact_evm_missing_eip712_domain')));

    const vbad = await get('/v1/gasfree-verify?tx=nothex');
    t('9 /v1/gasfree-verify rejects malformed tx', vbad.status === 400 && (j(vbad.body) || {}).reason === 'malformed_tx_hash');

    const vrec = await get('/v1/gasfree-verify?to=0x71DEAc098914A009E3720524642A6bE6F65EE528&min=1000');
    t('10 /v1/gasfree-verify requires a tx', vrec.status === 400, 'status=' + vrec.status);

    const vok = await get('/v1/gasfree-verify?tx=0x485003cb2a6b4b539d13be19c5465e313d85e3cb222c23b873a7ed76db48a53d&to=0x71DEAc098914A009E3720524642A6bE6F65EE528&min=1000&confirmations=1');
    const vokj = j(vok.body);
    console.log('     verify => ' + JSON.stringify(vokj));
    t('11 /v1/gasfree-verify accepts a real settlement', vok.status === 200 && !!(vokj && vokj.ok === true),
      JSON.stringify(vokj && (vokj.reason || { netUnits: vokj.netUnits })));

    const vwrong = await get('/v1/gasfree-verify?tx=0x485003cb2a6b4b539d13be19c5465e313d85e3cb222c23b873a7ed76db48a53d&to=0x000000000000000000000000000000000000dEaD&min=1000');
    t('12 /v1/gasfree-verify rejects wrong recipient', vwrong.status === 402, (j(vwrong.body) || {}).reason);

    const mod = await get('/v1/gasfree-module');
    t('13 GET /v1/gasfree-module serves JS', mod.status === 200 && /javascript/.test(mod.headers['content-type'] || '') && mod.body.length > 5000, mod.body.length + ' bytes');

    const html = await get('/gasfree');
    t('14 GET /gasfree serves HTML landing', html.status === 200 && /text\/html/.test(html.headers['content-type'] || '') && /Gas-free USDC checkout/.test(html.body), html.body.length + ' bytes');

    t('15 pre-existing routes still work (no regression)', (await get('/pricing')).status === 200 && (await get('/health')).status === 200);
  }

  srv.kill();
  await sleep(800);
  console.log('\n=== ' + pass + ' passed / ' + fail + ' failed ===');
  process.exitCode = fail ? 1 : 0;
})();
