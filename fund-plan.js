// fund-plan.js - given 3.8023 USDC and 0 ETH, find the cheapest durable domain
// and test whether outbound x402 payment is even possible without gas.
const https = require('https');
const osir = require('./osir-domain.js');

function probe(url, opts = {}) {
  return new Promise(r => {
    const u = new URL(url);
    const req = https.request({ host: u.hostname, path: u.pathname + u.search, method: opts.method || 'GET', headers: { 'user-agent': 'automaton-sovereign/1.0', accept: 'application/json,*/*' }, timeout: 15000 }, s => {
      let b = ''; s.on('data', c => b += c);
      s.on('end', () => r({ url, status: s.statusCode, len: b.length, ct: s.headers['content-type'] || '', body: b.slice(0, 300) }));
    });
    req.on('error', e => r({ url, status: 0, body: 'ERR ' + e.message }));
    req.on('timeout', () => { req.destroy(); r({ url, status: 0, body: 'TIMEOUT' }); });
    req.end();
  });
}

(async () => {
  const USDC = 3.8023;
  console.log('=== BUDGET: ' + USDC + ' USDC, 0 ETH (no gas) ===\n');

  console.log('=== 1) CHEAPEST TLDs (from my own live catalog) ===');
  const t = await osir.tlds();
  const exts = (t.result && t.result.extensions) || [];
  const priced = exts.map(e => ({
    ext: e.extension,
    reg: parseFloat(e.registrationPrice),
    ren: parseFloat(e.renewalPrice),
    premium: !!e.hasPremium,
    restricted: !!e.hasRestrictions,
    type: e.extensionType,
  })).filter(e => isFinite(e.reg) && e.reg > 0);
  priced.sort((a, b) => a.reg - b.reg);
  console.log('total=' + priced.length);
  const affordable = priced.filter(e => e.reg < USDC - 0.35); // keep a little USDC buffer
  console.log('AFFORDABLE (reg < ' + (USDC - 0.35).toFixed(2) + ' USDC): ' + affordable.length);
  for (const e of affordable.slice(0, 25)) {
    console.log('  $' + e.reg.toFixed(2).padStart(7) + '  ren $' + e.ren.toFixed(2).padStart(7) + '  ' + e.ext.padEnd(12) + (e.premium ? 'PREMIUM ' : '        ') + (e.restricted ? 'RESTRICTED' : ''));
  }

  console.log('\n=== 2) AVAILABILITY of a few good names on cheap TLDs ===');
  const candidates = [];
  for (const e of affordable.slice(0, 12)) {
    candidates.push('automatonsovereign' + e.ext);
    candidates.push('automaton' + e.ext);
  }
  const results = [];
  for (const c of candidates) {
    const r = await osir.check(c);
    if (r.ok && r.result && r.result.available) results.push({ name: c, price: r.result.price });
  }
  results.sort((a, b) => a.price - b.price);
  console.log('available=' + results.length + ' of ' + candidates.length);
  for (const r of results.slice(0, 15)) console.log('  $' + String(r.price).padStart(7) + '  ' + r.name);

  console.log('\n=== 3) CAN I PAY WITH 0 ETH? facilitator + x402 endpoints ===');
  const probes = [
    'https://x402.org/facilitator/verify',
    'https://x402.org/facilitator/supported',
    'https://facilitator.x402.org/supported',
    'https://x402.org',
  ];
  for (const p of probes) console.log(JSON.stringify(await probe(p)));

  console.log('\n=== 4) MY OWN SERVICE accepts[] (what a buyer sees) ===');
  const base = require('fs').readFileSync('tunnel.url', 'utf8').trim();
  console.log(JSON.stringify(await probe(base + '/pricing')));
})().catch(e => console.log('FATAL ' + e.message));
