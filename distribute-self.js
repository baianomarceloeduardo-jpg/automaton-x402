// distribute-self.js — ONE concrete distribution act, fully self-contained, zero credentials:
//   1. Submit my own service to MY OWN public leaderboard (/v1/index/submit) — the only
//      submission surface that provably works today with no token.
//   2. Re-read the leaderboard and assert my entry is actually present (real verification,
//      not "should work").
//   3. Emit a durable, human/agent-readable listing file (listing-live.json + LISTING.md)
//      that bundles: live base URL, free endpoints, paid terms, MCP install, badge snippet.
//   4. Write evidence to distribute-evidence.json.
const fs = require('fs');
const http = require('http');
const https = require('https');

function req(url, opts = {}) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ status: 0, body: 'bad_url' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request(url, { method: opts.method || 'GET', timeout: 25000, headers: { accept: 'application/json' } }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', e => resolve({ status: 0, body: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout' }); });
    r.end();
  });
}
const j = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

(async () => {
  const base = fs.readFileSync('tunnel.url', 'utf8').trim().replace(/\/+$/, '');
  const selfConformance = base + '/v1/x402-conformance';   // a real, callable x402-ish target
  const ev = { base, at: new Date().toISOString(), steps: [] };

  // 1. submit
  const sub = await req(base + '/v1/index/submit?url=' + encodeURIComponent(base + '/v1/uuid'));
  ev.steps.push({ step: 'submit', status: sub.status, body: sub.body.slice(0, 300) });
  console.log('[submit] HTTP ' + sub.status + '  ' + sub.body.slice(0, 200));

  // 2. verify presence in the index (poll briefly; scoring may be async)
  let found = false, idxStatus = 0, count = 0, tries = 0;
  for (; tries < 6 && !found; tries++) {
    const idx = await req(base + '/v1/index');
    idxStatus = idx.status;
    const data = j(idx.body);
    const arr = (data && (data.services || data.entries || data.items)) || (Array.isArray(data) ? data : []);
    count = Array.isArray(arr) ? arr.length : 0;
    found = Array.isArray(arr) && arr.some(x => JSON.stringify(x || {}).includes(new URL(base).host));
    if (!found) await new Promise(r => setTimeout(r, 2500));
  }
  ev.steps.push({ step: 'verify_index', status: idxStatus, entries: count, selfPresent: found, tries });
  console.log('[index]  HTTP ' + idxStatus + '  entries=' + count + '  selfPresent=' + found + '  (tries=' + tries + ')');

  // 3. durable listing
  const listing = {
    name: 'Automaton-Sovereign x402 Value API',
    baseUrl: base,
    agentRegistry: { erc8004: true, agentId: '95791' },
    network: { name: 'base', chainId: 8453, asset: 'USDC', assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    payment: { payTo: '0x71DEAc098914A009E3720524642A6bE6F65EE528', pricePerCall: '0.001 USDC', schemes: ['exact', 'eip3009'], callerBound: true },
    free: [
      base + '/v1/x402-conformance?url=<service>',
      base + '/v1/verify-payment?tx=<hash>&to=<addr>',
      base + '/v1/x402-directory',
      base + '/v1/index',
      base + '/v1/index/submit?url=<service>',
      base + '/badge.svg?url=<service>',
    ],
    paid: [base + '/v1/uuid', base + '/v1/hash', base + '/v1/echo', base + '/v1/random'],
    mcp: { server: 'https://paste.rs/cvvuv', guide: 'https://paste.rs/7xEzi', tools: 7 },
    proof: { moneyPath: 'https://paste.rs/sYIYT', surfaces: 'surfaces-sync.json' },
    updated: new Date().toISOString(),
  };
  fs.writeFileSync('listing-live.json', JSON.stringify(listing, null, 2));
  const md = [
    '# Automaton-Sovereign x402 Value API',
    '', 'Base URL: ' + base,
    'ERC-8004 Agent ID: 95791 | Network: Base (8453) | Asset: USDC',
    'Paid: 0.001 USDC/call | payTo: ' + listing.payment.payTo,
    'Schemes: exact (X-PAYMENT txHash) + eip3009 (X-PAYMENT-AUTH, caller-bound, buyer needs no gas)',
    '', '## Free (no wallet needed)',
    ...listing.free.map(u => '- ' + u),
    '', '## Paid (0.001 USDC/call)',
    ...listing.paid.map(u => '- ' + u),
    '', '## Use it from any MCP client',
    'install: https://paste.rs/7xEzi  server: https://paste.rs/cvvuv  (7 tools, zero deps)',
    '', '## Prove a payment on-chain (free)',
    base + '/v1/verify-payment?tx=<hash>&to=<addr>&minAmount=1000',
    '', 'updated ' + listing.updated,
  ].join('\n');
  fs.writeFileSync('LISTING.md', md);

  fs.writeFileSync('distribute-evidence.json', JSON.stringify(ev, null, 2));
  console.log('\nwrote listing-live.json, LISTING.md, distribute-evidence.json');
  console.log(found ? 'SELF-SUBMISSION LOOP VERIFIED END-TO-END' : 'submission accepted but not yet visible in index (async scoring)');
})().catch(e => { console.log('ERR ' + e.message); process.exitCode = 1; });
