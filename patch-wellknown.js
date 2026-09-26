// patch-wellknown.js — make paid-api.js serve the standard discovery routes.
//
// THE GAP IT CLOSES: my durable ERC-8004 identity URI is live, but a crawler that only knows my
// BASE URL gets 404 for /.well-known/agent-card.json. Discovery must work from the base alone.
//
// METHOD: PREPEND an overlay (not append). createServer() is called at module load, so the
// monkey-patch must be installed BEFORE the rest of the file runs. The wrapper is shape-agnostic:
// it intercepts the well-known paths and otherwise delegates to the original handler, whether the
// original passed `(req,res)` or `(options, req,res)`.
//
// Idempotent: if the marker is already present it does nothing.
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const TARGET = path.join(DIR, 'paid-api.js');
const MARKER = '/* __WELLKNOWN_OVERLAY__ */';

const OVERLAY = MARKER + `
(function () {
  const fs = require('fs');
  const path = require('path');
  const ROOT = __dirname;
  const _http = require('http');
  const _orig = _http.createServer.bind(_http);

  function readJson(name) {
    try { return fs.readFileSync(path.join(ROOT, name), 'utf8'); } catch (e) { return null; }
  }
  function liveBase() {
    for (const f of ['paid-tunnel.url', 'tunnel.url']) {
      try { const u = fs.readFileSync(path.join(ROOT, f), 'utf8').trim(); if (/^https?:\\/\\//.test(u)) return u; } catch (e) {}
    }
    return 'http://127.0.0.1:' + (process.env.PORT || 8081);
  }
  const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
  const USDC  = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

  function tryWellKnown(req, res) {
    let p; try { p = new URL(req.url, 'http://x').pathname; } catch (e) { p = req.url; }
    const J = (code, obj) => { const b = Buffer.from(JSON.stringify(obj, null, 2));
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' }); res.end(b); };

    if (p === '/.well-known/agent-card.json' || p === '/agent-card.json') {
      const raw = readJson('agent-card.json');
      if (!raw) return null;
      const b = Buffer.from(raw);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'access-control-allow-origin': '*' });
      res.end(b); return true;
    }

    if (p === '/.well-known/x402' || p === '/.well-known/x402.json') {
      const base = liveBase();
      J(200, { x402Version: 1, seller: PAY_TO, name: 'Automaton-Sovereign Paid API', network: 'base', chainId: 8453,
        asset: USDC, assetSymbol: 'USDC', maxAmountRequired: '1000', payTo: PAY_TO,
        accepts: [{ scheme: 'eip3009', network: 'base',
          extra: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
          asset: USDC, payTo: PAY_TO, maxAmountRequired: '1000', maxTimeoutSeconds: 600,
          resource: base + '/paid/uuid', description: 'Caller-bound USDC utility; buyer needs no ETH; nonce consumed on-chain.',
          mimeType: 'application/json', header: 'X-PAYMENT-AUTH' }],
        free: [base + '/health', base + '/pricing', base + '/ledger'],
        paid: ['/paid/hash', '/paid/uuid', '/paid/time', '/paid/hashchain'].map(x => base + x) });
      return true;
    }

    if (p === '/.well-known/ai-plugin.json') {
      const base = liveBase();
      J(200, { schema_version: 'v1', name_for_human: 'Automaton-Sovereign Paid API',
        name_for_model: 'automaton_sovereign', description_for_model: 'x402-metered compute utilities on Base. Paid calls require an EIP-712 EIP-3009 authorization in X-PAYMENT-AUTH.',
        auth: { type: 'none' }, api: { type: 'openapi', url: base + '/openapi.json' } });
      return true;
    }
    return false;
  }

  _http.createServer = function () {
    const args = Array.prototype.slice.call(arguments);
    const handlers = args.filter(a => typeof a === 'function');
    const rest = args.filter(a => typeof a !== 'function');
    return _orig.apply(_http, rest.concat([function (req, res) {
      try { if (tryWellKnown(req, res)) return; } catch (e) {}
      for (const h of handlers) { try { return h(req, res); } catch (e) {} }
      res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"no_handler"}');
    }]));
  };
})();
`;

let src = fs.readFileSync(TARGET, 'utf8');
if (src.indexOf(MARKER) !== -1) {
  console.log('[patch] overlay already present (idempotent no-op)');
  process.exit(0);
}
fs.writeFileSync(path.join(DIR, 'paid-api.js.bak-wellknown'), src);
fs.writeFileSync(TARGET, OVERLAY + '\n' + src);
console.log('[patch] prepended well-known overlay to paid-api.js (' + src.length + ' -> ' + (OVERLAY.length + src.length + 1) + ' bytes)');
console.log('[patch] backup: paid-api.js.bak-wellknown');
