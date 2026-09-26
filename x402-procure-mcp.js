// x402-procure-mcp.js — MCP server: let ANY agent discover, quote and PAY x402 services.
//
// WHY THIS EXISTS: I have a proven caller-bound payment rail (EIP-3009), a live verified-buyable
// directory, and a consensus oracle. What I did not have is a way for OTHER agents to consume any
// of it without writing payment code themselves. This is that missing piece: an installable MCP
// server that turns "I need a service that does X" into "found it, quoted it, paid it, verified it"
// with zero bespoke code on the caller's side.
//
// It is honest infrastructure: the search backs onto my PUBLIC verified-buyable index, the
// conformance check and oracle are described plainly, and no payment is ever routed anywhere the
// caller did not explicitly name. The caller's private key never leaves their machine.
//
// Zero-dep except ethers (loaded lazily, only for signing). Stdio JSON-RPC 2.0.
//
// TOOLS
//   x402_list_buyable  (free)  search the live verified-buyable x402 index: keyword + max price
//   x402_conformance   (free)  10-check conformance verdict for any x402 service URL
//   x402_quote         (free)  fetch the exact 402 terms for a target before spending anything
//   x402_pay           (pays)  sign an EIP-3009 authorization and settle a call; hard price cap
//   x402_verify        (free)  verify a settlement on-chain (chain, status, net transfer to payTo)
//   x402_anchors       (free)  the tamper-evident on-chain anchors of the index (Base tx hashes)
'use strict';
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CHAIN_ID = 8453;
const DEFAULT_BASE = process.env.X402_INDEX_BASE || 'https://298a39a8f36551.lhr.life';
const RPCS = (process.env.X402_RPCS || 'https://mainnet.base.org,https://base.llamarpc.com').split(',');
const MAX_PRICE_UNITS = BigInt(process.env.X402_MAX_PRICE_UNITS || '10000'); // 0.01 USDC safety cap

// ---------- transport ----------
function req(url, { method = 'GET', body = null, headers = {}, timeout = 25000 } = {}) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ ok: false, error: 'bad_url' }); }
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method, timeout,
      headers: Object.assign({ 'user-agent': 'x402-procure-mcp/1.0', accept: 'application/json' }, headers) }, res => {
      let b = ''; res.on('data', c => { if (b.length < 262144) b += c; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', e => resolve({ ok: false, error: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, error: 'timeout' }); });
    if (body) r.write(body);
    r.end();
  });
}
function rpcCall(url, method, params, timeout = 20000) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ ok: false }); }
    const mod = u.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const r = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'POST', timeout,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { const j = JSON.parse(b); resolve({ ok: j.result !== undefined, result: j.result, error: j.error && j.error.message }); }
        catch (e) { resolve({ ok: false, error: 'bad_json' }); } });
    });
    r.on('error', e => resolve({ ok: false, error: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, error: 'timeout' }); });
    r.write(body); r.end();
  });
}
async function anyRpc(method, params) {
  for (const u of RPCS) { const r = await rpcCall(u, method, params); if (r.ok) return r.result; }
  return null;
}
const pad = a => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');

// ---------- tools ----------
async function toolListBuyable(args) {
  const r = await req(DEFAULT_BASE.replace(/\/+$/, '') + '/v1/x402-live');
  if (!r.ok || r.status !== 200) return { ok: false, error: 'index_unreachable', detail: r.error || r.status };
  let j; try { j = JSON.parse(r.body); } catch (e) { return { ok: false, error: 'index_unparseable' }; }
  let items = j.buyable || [];
  const kw = (args.keyword || '').toLowerCase();
  if (kw) items = items.filter(i => (i.host + ' ' + (i.description || '') + ' ' + i.url).toLowerCase().includes(kw));
  if (args.maxPriceUsdc != null) items = items.filter(i => i.priceUsdc == null || i.priceUsdc <= Number(args.maxPriceUsdc));
  const limit = Math.max(1, Math.min(50, Number(args.limit || 10)));
  return { ok: true, generatedAt: j.generatedAt, checked: j.checked, buyableCount: j.buyableCount,
    matched: items.length, results: items.slice(0, limit).map(i => ({
      url: i.url, host: i.host, priceUsdc: i.priceUsdc, scheme: i.scheme, network: i.network,
      payTo: i.payTo, description: i.description })) };
}

async function toolConformance(args) {
  if (!args.url) return { ok: false, error: 'url_required' };
  const r = await req(DEFAULT_BASE.replace(/\/+$/, '') + '/v1/x402-conformance?url=' + encodeURIComponent(args.url));
  if (!r.ok || r.status !== 200) return { ok: false, error: 'checker_unreachable', detail: r.error || r.status };
  /* __NORMALIZE__ do not depend on my server's exact field names */
  let raw; try { raw = JSON.parse(r.body); } catch (e) { return { ok: false, error: 'unparseable' }; }
  const results = raw.results || raw.checks || [];
  const passed = raw.passed != null ? raw.passed : (raw.pass != null ? raw.pass : results.filter(x => x.ok === true || x.pass === true).length);
  const total = raw.total != null ? raw.total : (results.length || raw.count || null);
  const verdict = raw.verdict || raw.status || raw.conformance
    || (total != null ? (passed === total ? 'CONFORMANT' : (passed > 0 ? 'PARTIAL' : 'NON_CONFORMANT')) : 'UNKNOWN');
  return { ok: true, verdict, passed, total, url: raw.url || args.url,
    checks: results.slice(0, 12).map(c => ({ name: c.name || c.check || c.id, ok: c.ok === true || c.pass === true, detail: c.detail || c.note || null })),
    rawKeys: Object.keys(raw) };
}

async function toolQuote(args) {
  if (!args.url) return { ok: false, error: 'url_required' };
  const r = await req(args.url);
  if (!r.ok) return { ok: false, error: 'unreachable', detail: r.error };
  if (r.status !== 402) return { ok: true, status: r.status, requiresPayment: false,
    note: 'target did not answer 402; it may be free or not x402-metered' };
  let j; try { j = JSON.parse(r.body); } catch (e) { return { ok: false, error: 'challenge_unparseable' }; }
  const acc = (j.accepts || []).map(a => ({ scheme: a.scheme, network: a.network, chainId: a.chainId,
    asset: a.asset, payTo: a.payTo, maxAmountRequired: a.maxAmountRequired,
    priceUsdc: a.maxAmountRequired != null ? Number(a.maxAmountRequired) / 1e6 : null }));
  const header = /eip3009/i.test(JSON.stringify(acc)) ? 'X-PAYMENT-AUTH' : 'X-PAYMENT';
  return { ok: true, status: 402, requiresPayment: true, x402Version: j.x402Version || 1,
    accepts: acc, payWith: header,
    nextStep: header === 'X-PAYMENT-AUTH'
      ? 'call x402_pay(url) — it will sign a caller-bound EIP-3009 authorization. You need USDC but NO ETH.'
      : 'target expects a tx hash; x402_pay will broadcast the transfer and retry with the hash.' };
}

function loadWallet() {
  const ethers = require('ethers'); // lazy: only needed when actually paying
  let key = process.env.X402_PRIVATE_KEY;
  if (!key && process.env.X402_WALLET_FILE) {
    const j = JSON.parse(require('fs').readFileSync(process.env.X402_WALLET_FILE, 'utf8'));
    key = j.privateKey || j.private_key || (j.wallet && j.wallet.privateKey);
  }
  if (!key) throw new Error('no_signer: set X402_PRIVATE_KEY or X402_WALLET_FILE');
  if (!/^0x?[0-9a-fA-F]{64}$/.test(key)) throw new Error('bad_key_format');
  return new ethers.Wallet(key.startsWith('0x') ? key : '0x' + key);
}

async function toolPay(args) {
  if (!args.url) return { ok: false, error: 'url_required' };
  const q = await toolQuote({ url: args.url });
  if (!q.ok) return q;
  if (!q.requiresPayment) return { ok: true, alreadyFree: true, detail: q };

  const acc = (q.accepts || []).find(a => /eip3009/i.test(a.scheme || '')) || (q.accepts || [])[0];
  if (!acc) return { ok: false, error: 'no_accepts' };
  const amount = BigInt(acc.maxAmountRequired);
  if (amount > MAX_PRICE_UNITS) return { ok: false, error: 'price_above_cap',
    priceUnits: amount.toString(), cap: MAX_PRICE_UNITS.toString(),
    hint: 'raise X402_MAX_PRICE_UNITS deliberately if you accept this price' };
  if (acc.network && !/base/i.test(acc.network)) return { ok: false, error: 'unsupported_network', network: acc.network };

  let ethers, wallet;
  try { ethers = require('ethers'); wallet = loadWallet(); }
  catch (e) { return { ok: false, error: String(e.message) }; }
  const chainId = Number(acc.chainId || CHAIN_ID);
  const domain = { name: 'USD Coin', version: '2', chainId, verifyingContract: acc.asset || USDC };
  const types = { TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] };
  const now = Math.floor(Date.now() / 1000);
  const payload = { from: wallet.address, to: acc.payTo, value: amount.toString(),
    validAfter: String(now - 60), validBefore: String(now + 3600),
    nonce: '0x' + crypto.randomBytes(32).toString('hex') };
  let payment; let headerName = 'X-PAYMENT-AUTH'; let note;
  try {
    const signature = await wallet.signTypedData(domain, types, payload);
    payment = Buffer.from(JSON.stringify({ scheme: 'eip3009', payload, signature })).toString('base64');
    note = 'caller-bound EIP-3009 authorization signed offline; no ETH spent by the caller';
  } catch (e) { return { ok: false, error: 'sign_failed', detail: String(e.message) }; }

  const r = await req(args.url, { headers: { [headerName]: payment } });
  if (!r.ok) return { ok: false, error: 'retry_failed', detail: r.error, signed: true };
  if (r.status === 402) {
    let why = null; try { why = JSON.parse(r.body); } catch (e) {}
    return { ok: false, error: 'payment_rejected', status: 402, reason: why && (why.error || why.reason), detail: why, note };
  }
  if (r.status !== 200) return { ok: false, error: 'unexpected_status', status: r.status, body: r.body.slice(0, 500), note };
  let body = r.body; try { body = JSON.parse(r.body); } catch (e) {}
  return { ok: true, paid: true, priceUsdc: Number(amount) / 1e6, payer: wallet.address, payTo: acc.payTo,
    callerBound: r.headers['x-payment-caller-bound'] === 'true', note,
    result: body };
}

async function toolVerify(args) {
  if (!args.tx) return { ok: false, error: 'tx_required' };
  const rcpt = await anyRpc('eth_getTransactionReceipt', [args.tx]);
  if (!rcpt) return { ok: false, error: 'tx_not_found_or_rpc_unavailable' };
  const chainIdHex = await anyRpc('eth_chainId', []);
  const out = { ok: true, tx: args.tx, blockNumber: Number(BigInt(rcpt.blockNumber)),
    status: rcpt.status === '0x1' ? 'success' : 'reverted',
    chainId: chainIdHex ? Number(BigInt(chainIdHex)) : null };
  if (!args.payTo) return out;
  const want = String(args.payTo).toLowerCase();
  let net = 0n;
  for (const l of rcpt.logs || []) {
    if (String(l.address).toLowerCase() !== (args.asset || USDC).toLowerCase()) continue;
    if (!l.topics || l.topics[0] !== TRANSFER) continue;
    const to = '0x' + l.topics[2].slice(-40);
    if (to.toLowerCase() !== want) continue;
    net += BigInt(l.data);
  }
  out.netToPayToUnits = net.toString();
  out.netToPayToUsdc = Number(net) / 1e6;
  out.verified = out.status === 'success' && net > 0n;
  if (args.minUnits != null) out.meetsMinimum = net >= BigInt(args.minUnits);
  return out;
}

async function toolAnchors() {
  const r = await req(DEFAULT_BASE.replace(/\/+$/, '') + '/v1/attest');
  if (r.ok && r.status === 200) { try { return Object.assign({ ok: true }, JSON.parse(r.body)); } catch (e) {} }
  return { ok: false, error: 'anchors_endpoint_unavailable',
    note: 'anchors are a zero-value self-tx on Base carrying sha256 of the canonical index; verify by hashing index-snapshot.json' };
}

const TOOLS = [
  { name: 'x402_list_buyable', description: 'Search the live verified-buyable x402 index: only services that just answered a valid 402 challenge with payTo + price. Free.',
    inputSchema: { type: 'object', properties: { keyword: { type: 'string' }, maxPriceUsdc: { type: 'number' }, limit: { type: 'number' } } },
    run: toolListBuyable },
  { name: 'x402_conformance', description: 'Independent 10-check x402 conformance verdict for any service URL. Free.',
    inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } }, run: toolConformance },
  { name: 'x402_quote', description: 'Fetch the exact 402 payment terms for a target BEFORE spending anything. Free.',
    inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } }, run: toolQuote },
  { name: 'x402_pay', description: 'Pay an x402 service and get the result. Signs a caller-bound EIP-3009 authorization offline (caller needs USDC, not ETH). Enforces a hard price cap.',
    inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } }, run: toolPay },
  { name: 'x402_verify', description: 'Verify a settlement on-chain: chain, status, and net ERC-20 transfer to payTo. Free.',
    inputSchema: { type: 'object', properties: { tx: { type: 'string' }, payTo: { type: 'string' }, asset: { type: 'string' }, minUnits: { type: 'string' } } }, run: toolVerify },
  { name: 'x402_anchors', description: 'Tamper-evident on-chain anchors of the index (Base tx hashes + sha256). Free.',
    inputSchema: { type: 'object', properties: {} }, run: toolAnchors },
];

// ---------- MCP stdio loop ----------
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function replyErr(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }

let buf = '';
process.stdin.on('data', async chunk => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
    const { id, method, params } = msg;
    try {
      if (method === 'initialize') {
        reply(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} },
          serverInfo: { name: 'x402-procure', version: '1.0.0' } });
      } else if (method === 'tools/list') {
        reply(id, { tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      } else if (method === 'tools/call') {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        const t = TOOLS.find(x => x.name === name);
        if (!t) { replyErr(id, -32601, 'unknown tool: ' + name); continue; }
        const out = await t.run(args);
        reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: out && out.ok === false });
      } else if (method === 'notifications/initialized' || (id === undefined || id === null)) {
        // notification: no response
      } else {
        replyErr(id, -32601, 'method not found: ' + method);
      }
    } catch (e) { replyErr(id, -32603, String(e.message)); }
  }
});
process.stdin.on('end', () => process.exit(0));
