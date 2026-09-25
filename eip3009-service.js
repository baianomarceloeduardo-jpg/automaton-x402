// eip3009-service.js - CALLER-BOUND paid API. The proper x402 money path.
//
// Why this exists: a raw on-chain txHash is a bearer credential (anyone can redeem it).
// EIP-3009 fixes this -- the buyer SIGNS an authorization, the nonce is consumed on-chain,
// and the signer is cryptographically bound to the payment. This service verifies that
// authorization and serves paid resources without ever trusting an unauthenticated hash.
//
// Run:  node eip3009-service.js        (default port 8081)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeEip3009, USDC_BASE, BASE_CHAIN_ID } = require('./eip3009.js');

const PORT = Number(process.env.EIP3009_PORT || 8081);
const PAY_TO = process.env.PAY_TO || '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const PRICE_UNITS = 1000n;          // 0.001 USDC
const PRICE_USDC = '0.001';
const RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const LEDGER = path.join(__dirname, 'eip3009-ledger.jsonl');
const NONCE_STORE = path.join(__dirname, 'eip3009-nonces.jsonl');

// ---- nonce store: belt-and-braces on top of on-chain state (fail-closed semantics) ----
const usedNonces = new Map();
try {
  for (const l of fs.readFileSync(NONCE_STORE, 'utf8').split('\n')) {
    if (!l.trim()) continue; try { const r = JSON.parse(l); usedNonces.set(r.nonce, r); } catch (e) {}
  }
} catch (e) {}
function claimNonce(nonce, meta) {
  const n = String(nonce).toLowerCase();
  if (usedNonces.has(n)) return false;
  const rec = { nonce: n, at: new Date().toISOString(), meta: meta || null };
  usedNonces.set(n, rec);
  try { fs.appendFileSync(NONCE_STORE, JSON.stringify(rec) + '\n'); } catch (e) {}
  return true;
}
function record(entry) { try { fs.appendFileSync(LEDGER, JSON.stringify(entry) + '\n'); } catch (e) {} }

// ---- minimal JSON-RPC (for authorizationState) ----
function rpcCall(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const __u = new URL(RPC_URL); const __lib = __u.protocol === 'https:' ? require('https') : http; const r = __lib.request(RPC_URL, { method: 'POST', timeout: 15000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { const j = JSON.parse(d); j.error ? reject(new Error(j.error.message || 'rpc_error')) : resolve(j.result); } catch (e) { reject(new Error('bad_rpc_json')); } }); });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('rpc_timeout')); });
    r.write(body); r.end();
  });
}
const provider = {
  call: async (tx) => {
    const cid = await rpcCall('eth_chainId', []);
    if (String(cid).toLowerCase() !== '0x2105') throw new Error('wrong_chain');
    return rpcCall('eth_call', [tx, 'latest']);
  }
};

const e9 = makeEip3009(provider, null);

// ---- paid resources ----
function resource(pathname) {
  if (pathname === '/v1/paid/echo') return { kind: 'echo' };
  if (pathname === '/v1/paid/uuid') return { kind: 'uuid' };
  if (pathname === '/v1/paid/time') return { kind: 'time' };
  if (pathname === '/v1/paid/hash') return { kind: 'hash' };
  return null;
}

function accepts(resourceUrl) {
  return [ e9.challenge(PAY_TO, PRICE_UNITS, resourceUrl) ];
}

function challenge402(res, resourceUrl, reason) {
  const body = {
    x402Version: 1,
    error: reason || 'payment_required',
    scheme: 'eip3009',
    accepts: accepts(resourceUrl),
    note: 'CALLER-BOUND payment. Sign an EIP-712 TransferWithAuthorization for USD Coin on Base; send it base64-encoded in the X-PAYMENT-AUTH header. Alternatively use the legacy txHash scheme (X-PAYMENT) which is a bearer credential and is NOT caller-binding.'
  };
  res.writeHead(402, { 'content-type': 'application/json', 'x-402-scheme': 'eip3009' });
  res.end(JSON.stringify(body, null, 2));
}

function freeJson(res, obj, code) { res.writeHead(code || 200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj, null, 2)); }

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let d = '', n = 0;
    req.on('data', c => { n += c.length; if (n > (limit || 8192)) { reject(new Error('body_too_large')); req.destroy(); } else d += c; });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-payment-auth,x-payment', 'access-control-allow-methods': 'GET,POST,OPTIONS' }); return res.end(); }

  try {
    if (p === '/health') return freeJson(res, { ok: true, service: 'eip3009-value-api', scheme: 'eip3009', payTo: PAY_TO, priceUsdc: PRICE_USDC, network: 'base', chainId: BASE_CHAIN_ID, asset: USDC_BASE, settled: usedNonces.size });

    if (p === '/pricing' || p === '/.well-known/x402') {
      const r = u.searchParams.get('resource') || 'http://localhost:' + PORT + '/v1/paid/uuid';
      return freeJson(res, {
        x402Version: 1, payTo: PAY_TO, network: 'base', chainId: BASE_CHAIN_ID, asset: USDC_BASE,
        assetSymbol: 'USDC', priceUsdc: PRICE_USDC, priceBaseUnits: PRICE_UNITS.toString(),
        schemes: ['eip3009', 'txhash(bearer, deprecated)'],
        paymentHeader: 'X-PAYMENT-AUTH (base64 EIP-3009 envelope)',
        accepts: accepts(r)
      });
    }

    // FREE: verify any EIP-3009 authorization envelope. No wallet, no payment.
    if (p === '/v1/verify-authorization') {
      let env, raw = '';
      if (req.method === 'POST') { raw = await readBody(req); try { env = JSON.parse(raw); } catch (e) { return freeJson(res, { ok: false, reason: 'invalid_json' }, 400); } }
      else { const b = u.searchParams.get('payload'); if (!b) return freeJson(res, { ok: false, reason: 'missing_payload_query_or_post_body', hint: 'POST the envelope JSON, or GET ?payload=<base64 json>' }, 400); try { env = JSON.parse(Buffer.from(b, 'base64').toString('utf8')); } catch (e) { return freeJson(res, { ok: false, reason: 'invalid_base64_payload' }, 400); } }
      const v = await e9.verifyAuthorization(env, { payTo: PAY_TO, minUnits: PRICE_UNITS, requireUnused: false });
      const local = v.ok ? usedNonces.has(String(v.nonce).toLowerCase()) : false;
      return freeJson(res, Object.assign({}, v, { localNonceSeen: local, checkedAt: new Date().toISOString() }));
    }

    const r = resource(p);
    if (r) {
      const hdr = req.headers['x-payment-auth'];
      const legacy = req.headers['x-payment'];
      if (!hdr && !legacy) return challenge402(res, 'http://localhost:' + PORT + p, 'payment_required');
      if (!hdr && legacy) return challenge402(res, 'http://localhost:' + PORT + p, 'bearer_scheme_not_supported_here_use_x_payment_auth');

      let env;
      try { env = JSON.parse(Buffer.from(String(hdr), 'base64').toString('utf8')); } catch (e) { return challenge402(res, 'http://localhost:' + PORT + p, 'payment_header_not_base64_json'); }

      const v = await e9.verifyAuthorization(env, { payTo: PAY_TO, minUnits: PRICE_UNITS, requireUnused: true });
      if (!v.ok) { record({ at: new Date().toISOString(), path: p, ok: false, reason: v.reason }); return challenge402(res, 'http://localhost:' + PORT + p, v.reason); }

      // replay guard at the HTTP layer (second line of defence after the on-chain nonce)
      if (!claimNonce(v.nonce, { from: v.from, path: p, value: v.value })) {
        record({ at: new Date().toISOString(), path: p, ok: false, reason: 'nonce_replayed_local' });
        return challenge402(res, 'http://localhost:' + PORT + p, 'nonce_replayed_local');
      }

      const result = (() => {
        if (r.kind === 'echo') return { echo: true };
        if (r.kind === 'uuid') return { uuid: require('crypto').randomUUID() };
        if (r.kind === 'time') return { unix: Math.floor(Date.now() / 1000), iso: new Date().toISOString() };
        if (r.kind === 'hash') return { sha256: require('crypto').createHash('sha256').update(String(Date.now())).digest('hex') };
      })();
      record({ at: new Date().toISOString(), path: p, ok: true, from: v.from, value: v.value, nonce: v.nonce });
      res.writeHead(200, { 'content-type': 'application/json', 'X-Payment-Scheme': 'eip3009', 'X-Payment-Payer': v.from, 'X-Payment-Value': v.value, 'X-Payment-Caller-Bound': 'true', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify(Object.assign({ ok: true, paid: true, callerBound: true, payer: v.from }, result), null, 2));
    }

    // free HTML landing
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>EIP-3009 Caller-Bound Value API</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 18px;color:#111}code{background:#f4f4f5;padding:2px 5px;border-radius:4px}pre{background:#f8f8fa;padding:12px;border-radius:8px;overflow:auto}</style></head><body>
<h1>EIP-3009 Caller-Bound Value API</h1>
<p><b>Scheme:</b> <code>eip3009</code> &middot; <b>Network:</b> Base (chainId ${BASE_CHAIN_ID}) &middot; <b>Price:</b> ${PRICE_USDC} USDC/call &middot; <b>payTo:</b> <code>${PAY_TO}</code></p>
<p>Unlike a raw tx-hash payment (a <i>bearer</i> credential anyone can redeem), this endpoint requires a <b>signed authorization</b> that cryptographically binds the payer. Replay is impossible: the nonce is consumed on-chain.</p>
<h2>Free endpoints (no payment)</h2>
<pre>GET  /health
GET  /pricing
POST /v1/verify-authorization   (check any authorization envelope)</pre>
<h2>Paid endpoints (${PRICE_USDC} USDC)</h2>
<pre>POST /v1/paid/echo   /v1/paid/uuid   /v1/paid/time   /v1/paid/hash
Header: X-PAYMENT-AUTH: base64(JSON envelope)</pre>
<h2>Envelope</h2>
<pre>{"payload":{"from":"0x..","to":"${PAY_TO}","value":"1000","validAfter":0,"validBefore":&lt;unix+600&gt;,"nonce":"0x"+"..64hex"},"signature":"0x..130hex"}</pre>
<p>Signature = EIP-712 typed data <code>TransferWithAuthorization</code>, domain <code>{name:"USD Coin",version:"2",chainId:8453,verifyingContract:"${USDC_BASE}"}</code>.</p>
<h2>Client</h2>
<pre>node eip3009-client.js /v1/paid/uuid     # signs offline, prints the envelope + curl</pre>
<p>Ledger: <code>${path.basename(LEDGER)}</code> (append-only). Nonces settled: ${usedNonces.size}.</p>
</body></html>`);
  } catch (e) {
    freeJson(res, { ok: false, reason: 'server_error', detail: String(e.message).slice(0, 120) }, 500);
  }
});

server.listen(PORT, () => {
  console.log('eip3009-value-api listening on ' + PORT + '  payTo=' + PAY_TO + '  price=' + PRICE_USDC + ' USDC');
  console.log('free:  /health  /pricing  /v1/verify-authorization');
  console.log('paid:  /v1/paid/{echo,uuid,time,hash}  header X-PAYMENT-AUTH');
});
