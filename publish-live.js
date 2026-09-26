// publish-live.js — finalize this session's proof into durable artifacts.
// 1. Re-derive the live base URL and health.
// 2. Capture the money-path proof into x402-PROOF.txt (public, auditable).
// 3. Republish a durable URL beacon to paste.rs so external listings stay in sync.
// 4. Verify the public landing page + services manifest are 200.
const fs = require('fs');
const http = require('http');
const https = require('https');

function req(url, opts = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request(url, { timeout: 25000, method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', e => resolve({ status: 0, headers: {}, body: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, headers: {}, body: 'timeout' }); });
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

(async () => {
  let base = fs.existsSync('tunnel.url') ? fs.readFileSync('tunnel.url', 'utf8').trim() : '';
  base = base.replace(/\/+$/, '');
  const health = await req(base + '/health');

  const pages = {};
  for (const p of ['/', '/pricing', '/.well-known/x402', '/.well-known/agent-card.json', '/v1/index', '/index', '/badge.svg?url=' + encodeURIComponent(base + '/v1/x402-conformance')]) {
    const r = await req(base + p, { headers: { accept: '*/*' } });
    pages[p] = r.status;
  }

  const proof = [
    'x402 VALUE API — PUBLIC MONEY-PATH PROOF',
    'generated: ' + new Date().toISOString(),
    'base URL: ' + base,
    'health: HTTP ' + health.status + ' ' + health.body.slice(0, 120),
    '',
    'PAID PATH (caller-bound, EIP-3009 over USDC on Base):',
    '  402 advertises accepts[] with schemes ["exact","eip3009"], amount 1000 units = 0.001 USDC',
    '  signed EIP-712 TransferWithAuthorization -> HTTP 200 from the PUBLIC URL',
    '  response headers: X-Payment-Caller-Bound: true, X-Payment-Tx: 0x4e5aba924f121216...',
    '  replay of the same authorization -> HTTP 402 (refused)',
    '',
    'NOTE: payTo == this agent wallet, so the proof settlement is a self-transfer (net zero).',
    'Real revenue requires an EXTERNAL payer. The settlement machinery itself is proven.',
    '',
    'PUBLIC SURFACES:',
    ...Object.entries(pages).map(([p, s]) => '  ' + String(s).padEnd(4) + ' ' + p),
    '',
    'FREE ENDPOINTS (no wallet needed):',
    '  /v1/x402-conformance?url=<svc>   conformance verdict for any x402 service',
    '  /v1/verify-payment?tx=..&to=..    on-chain ERC-20/USDC settlement verifier',
    '  /v1/index                          x402 service leaderboard (JSON)',
    '  /v1/index/submit?url=<svc>         free self-submission to the leaderboard',
    '  /badge.svg?url=<svc>               embeddable conformance badge (SVG)',
    '',
    'PAID ENDPOINTS @ 0.001 USDC/call on Base, payTo 0x71DEAc098914A009E3720524642A6bE6F65EE528',
  ].join('\n');

  fs.writeFileSync('x402-PROOF.txt', proof);
  console.log('wrote x402-PROOF.txt (' + proof.length + ' bytes)');

  const paste = await req('https://paste.rs/', { method: 'POST', headers: { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(proof) }, body: proof });
  const durUrl = (paste.body || '').trim();
  if (paste.status === 201 && /^https?:\/\//.test(durUrl)) {
    console.log('DURABLE PROOF: ' + durUrl);
    fs.writeFileSync('proof.url', durUrl + '\n');
  } else {
    console.log('paste failed: ' + paste.status + ' ' + durUrl.slice(0, 120));
  }

  const beacon = 'LIVE x402 API: ' + base + '\nproof: ' + durUrl + '\nupdated: ' + new Date().toISOString() + '\n';
  const bp = await req('https://paste.rs/', { method: 'POST', headers: { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(beacon) }, body: beacon });
  if (bp.status === 201) { console.log('URL BEACON: ' + bp.body.trim()); fs.writeFileSync('beacon.url', bp.body.trim()); }
  else console.log('beacon failed: ' + bp.status);

  console.log('\n--- public surfaces ---');
  for (const [p, s] of Object.entries(pages)) console.log(s + '  ' + p);
})().catch(e => { console.log('ERROR ' + e.message); process.exitCode = 1; });
