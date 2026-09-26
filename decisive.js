// decisive.js - answer the two questions that decide my next 24h:
//  Q1: what is the actual cheapest registrable TLD, and can 3.8023 USDC buy a domain?
//  Q2: is there any BASE MAINNET facilitator that settle EIP-3009 gas-free?
const https = require('https');
const osir = require('./osir-domain.js');

function get(url) {
  return new Promise(r => {
    const u = new URL(url);
    const req = https.request({ host: u.hostname, path: u.pathname + u.search, method: 'GET', timeout: 12000, headers: { 'user-agent': 'automaton-sovereign/1.0', accept: '*/*' } }, s => {
      let b = ''; s.on('data', c => b += c);
      s.on('end', () => r({ url, status: s.statusCode, len: b.length, body: b }));
    });
    req.on('error', e => r({ url, status: 0, body: 'ERR ' + e.message }));
    req.on('timeout', () => { req.destroy(); r({ url, status: 0, body: 'TIMEOUT' }); });
    req.end();
  });
}
function post(url, bodyObj) {
  return new Promise(r => {
    const u = new URL(url);
    const data = JSON.stringify(bodyObj);
    const req = https.request({ host: u.hostname, path: u.pathname, method: 'POST', timeout: 15000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'user-agent': 'automaton-sovereign/1.0' } }, s => {
      let b = ''; s.on('data', c => b += c);
      s.on('end', () => r({ url, status: s.statusCode, body: b }));
    });
    req.on('error', e => r({ url, status: 0, body: 'ERR ' + e.message }));
    req.on('timeout', () => { req.destroy(); r({ url, status: 0, body: 'TIMEOUT' }); });
    req.write(data); req.end();
  });
}

(async () => {
  console.log('===== Q1: CHEAPEST TLDs, and can 3.8023 USDC buy one =====');
  const t = await osir.tlds();
  const exts = (t.result && t.result.extensions) || [];
  const priced = exts.map(e => ({ ext: e.extension, reg: parseFloat(e.registrationPrice), ren: parseFloat(e.renewalPrice), pr: !!e.hasPremium, re: !!e.hasRestrictions }))
    .filter(e => isFinite(e.reg) && e.reg > 0).sort((a, b) => a.reg - b.reg);
  console.log('catalog size = ' + priced.length);
  console.log('--- cheapest 20 by registration price ---');
  priced.slice(0, 20).forEach(e => console.log('  $' + e.reg.toFixed(2).padStart(8) + '  renew $' + e.ren.toFixed(2).padStart(8) + '  ' + e.ext.padEnd(14) + (e.pr ? 'PREMIUM ' : '') + (e.re ? 'RESTRICTED' : '')));
  const under = priced.filter(e => e.reg <= 3.8023);
  console.log('under 3.8023 USDC = ' + under.length);
  const usable = priced.filter(e => e.reg <= 3.8023 && !e.pr && !e.re);
  console.log('under 3.8023 AND not premium AND not restricted = ' + usable.length);
  usable.slice(0, 12).forEach(e => console.log('  BUYABLE $' + e.reg.toFixed(2).padStart(7) + '  ' + e.ext));

  console.log('\n===== Q2: BASE MAINNET facilitators (gas-free settling) =====');
  const cands = [
    'https://x402.org/facilitator/supported',
    'https://facilitator.payai.network/supported',
    'https://api.cdp.coinbase.com/platform/v2/x402/supported',
    'https://x402.coinbase.com/supported',
    'https://facilitator.thirdweb.com/supported',
    'https://x402.dexter.cash/supported',
    'https://facilitator.x402.rs/supported',
    'https://x402.merit.systems/supported',
    'https://mainnet.base.org',
  ];
  for (const c of cands) {
    const r = await get(c);
    let note = '';
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.body);
        const kinds = j.kinds || j.networks || j.schemes || [];
        note = ' KINDS=' + JSON.stringify(kinds).slice(0, 260);
      } catch (e) { note = ' (non-json ' + r.body.slice(0, 80).replace(/\n/g, ' ') + ')'; }
    }
    console.log(r.status + ' ' + String(r.len).padStart(7) + ' ' + c + note);
  }

  // Does an arbitrary mainnet facilitator even advertise it? Probe a well-known public one for /settle existence.
  console.log('\n--- POST probe to likely mainnet facilitators (expect 400/404, tells us it EXISTS) ---');
  const fakeReq = { paymentPayload: { x402Version: 2, scheme: 'exact', network: 'eip155:8453', payload: {} }, paymentRequirements: { scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '1000', payTo: '0x71DEAc098914A009E3720524642A6bE6F65EE528', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' } };
  for (const c of ['https://facilitator.payai.network/settle', 'https://x402.org/facilitator/settle']) {
    const r = await post(c, fakeReq);
    console.log(c + ' -> ' + r.status + ' ' + r.body.slice(0, 240).replace(/\n/g, ' '));
  }

  console.log('\n===== Q3: Conway topup pricing (what my 3.8023 USDC can/cannot buy) =====');
  for (const c of ['https://conway.tech', 'https://api.conway.tech']) {
    const r = await get(c);
    console.log(r.status + ' ' + c + ' len=' + r.len);
  }
})().catch(e => console.log('FATAL ' + e.message + '\n' + e.stack));
