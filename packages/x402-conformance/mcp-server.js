#!/usr/bin/env node
'use strict';
/**
 * Automaton-Sovereign Value API — MCP server (stdio transport, zero deps, JSON-RPC 2.0)
 *
 * Exposes the x402-paid Value API as native MCP tools so any MCP-capable agent
 * can call it directly. Paid tools forward the caller's X-PAYMENT tx hash;
 * free tools need nothing.
 *
 * Also exposes the local x402 conformance linter (index.js) as a free tool.
 *
 * Config via env:
 *   VALUE_API_BASE      base URL of the API (default https://api.automaton-sovereign.workers.dev)
 *   VALUE_API_PAYMENT   default X-PAYMENT tx hash to attach to paid calls (optional)
 *
 * Usage (Claude Desktop / Cursor MCP config):
 *   { "mcpServers": { "automaton-x402": { "command": "npx",
 *       "args": ["-y", "@celorodrigues/x402-conformance", "--mcp"] } } }
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const PKG = require('./package.json');
const linter = require('./index.js');
const simulator = require('./tx-simulator.js');

const BASE = (process.env.VALUE_API_BASE || 'https://api.automaton-sovereign.workers.dev').replace(/\/+$/, '');
const PAYMENT = process.env.VALUE_API_PAYMENT || '';

function httpJson(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'http:' ? http : https;
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const h = Object.assign({ 'Accept': 'application/json', 'User-Agent': 'automaton-mcp/1.0' }, headers || {});
    if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, method, headers: h }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        let parsed = null; try { parsed = JSON.parse(d); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed !== null ? parsed : d });
      });
    });
    req.on('error', reject); req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

const TOOLS = [
  { name: 'x402_conformance_check', description: 'FREE, runs locally. Lint any x402 paid endpoint for protocol conformance: HTTP 402 challenge, x402Version, accepts[] (exact scheme), Base network and addresses, EIP-712 domain, and rejection of malformed, forged, expired, underpaid and wrong-recipient EIP-3009 payments. Returns verdict, grade and per-check results.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Full URL of the x402-protected endpoint to check.' } }, required: ['url'] } },
  { name: 'simulate_base_transaction', description: 'FREE, runs locally against Base Mainnet RPC. Dry-run a transaction before sending it: eth_call + eth_estimateGas at the latest block. Predicts whether it will revert and decodes the reason (Error(string), Panic(uint256) codes, custom-error selector, or node rejection such as insufficient funds). Returns { ok, willRevert, revertReason, estimatedGas, returnData }.',
    inputSchema: { type: 'object', properties: { to: { type: 'string', description: 'Target contract or recipient address on Base (0x...).' }, data: { type: 'string', description: 'Calldata as 0x-hex (default 0x for a plain ETH transfer).' }, value: { type: 'string', description: 'ETH value in wei, decimal or 0x-hex (default 0).' }, from: { type: 'string', description: 'Optional sender address; needed for balance/allowance-dependent calls.' } }, required: ['to'] } },
  { name: 'security_scan', description: 'PAID 0.001 USDC/call, or free trial (3/day/IP). Base token safety analysis: honeypot detection, mint traps, selfdestruct/delegatecall, proxy and tax risks from contract bytecode, with a risk score and signed verdict. On 402, pay the accepts[] terms then retry with the payment tx hash.',
    inputSchema: { type: 'object', properties: { address: { type: 'string', description: 'Token or contract address on Base (0x...).' }, payment: { type: 'string', description: 'Optional X-PAYMENT base tx hash of the USDC payment.' } }, required: ['address'] } },
  { name: 'attest', description: 'Create a SIGNED, hash-chained, append-only attestation (verifiable proof-of-existence) for a payload. PAID: 0.001 USDC/call, or free trial (3/day/IP). On 402, pay the accepts[] terms then retry with the payment tx hash.',
    inputSchema: { type: 'object', properties: { data: { type: 'string', description: 'Payload to attest (any string).' }, payment: { type: 'string', description: 'Optional X-PAYMENT base tx hash of the USDC payment.' } }, required: ['data'] } },
  { name: 'verify_attestation', description: 'FREE. Verify a ledger entry by index or by data hash: recomputes hash, checks ECDSA signature and chain link.',
    inputSchema: { type: 'object', properties: { index: { type: 'integer' }, dataHash: { type: 'string' } } } },
  { name: 'attestation_pubkey', description: 'FREE. Get the ECDSA P-256 public key (PEM) and keyId used to sign ledger entries.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'read_ledger', description: 'FREE. Read the attestation ledger (paginated).',
    inputSchema: { type: 'object', properties: { from: { type: 'integer' }, limit: { type: 'integer' } } } },
  { name: 'oracle_base', description: 'PAID 0.001 USDC/call. Get real-time Base L2 gas estimates and asset prices (ETH, USDC, cbBTC, AERO, VIRTUAL) with an ECDSA P-256 digital signature from the sovereign agent.',
    inputSchema: { type: 'object', properties: { payment: { type: 'string', description: 'Optional X-PAYMENT base tx hash of the USDC payment.' } } } },
  { name: 'merkle_prove', description: 'PAID 0.001 USDC/call. Generate a cryptographic Merkle inclusion proof for a list of items and target element.',
    inputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' }, description: 'Array of items' }, target: { type: 'string', description: 'Target item or index' }, payment: { type: 'string' } }, required: ['items'] } },
  { name: 'merkle_verify', description: 'FREE. Verify a cryptographic Merkle inclusion proof against a root.',
    inputSchema: { type: 'object', properties: { item: { type: 'string' }, proof: { type: 'array', items: { type: 'object' } }, root: { type: 'string' } }, required: ['item', 'proof', 'root'] } },
  { name: 'sentiment_analysis', description: 'PAID 0.001 USDC/call. Web3 token risk, security checks, and sentiment scoring with signed verdict.',
    inputSchema: { type: 'object', properties: { asset: { type: 'string', description: 'Asset symbol (e.g. ETH, AERO, VIRTUAL)' }, payment: { type: 'string' } }, required: ['asset'] } },
  { name: 'hash_sha256', description: 'PAID 0.001 USDC/call. SHA-256 hex of a string.',
    inputSchema: { type: 'object', properties: { input: { type: 'string' }, payment: { type: 'string' } }, required: ['input'] } },
  { name: 'uuid', description: 'PAID 0.001 USDC/call. Generate a UUIDv4.', inputSchema: { type: 'object', properties: { payment: { type: 'string' } } } },
  { name: 'pricing', description: 'FREE. Full pricing terms, endpoints, and payment mechanics.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'health', description: 'FREE. Service liveness and version.', inputSchema: { type: 'object', properties: {} } }
];

function q(o) { return Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&'); }

// opts.base / opts.headers let an embedding server (HTTP /mcp) call its own API directly and
// forward the caller's IP / public host.
async function callTool(name, args, opts) {
  args = args || {};
  opts = opts || {};
  const B = (opts.base || BASE).replace(/\/+$/, '');
  const fwd = opts.headers || {};
  const payHeader = Object.assign({}, fwd, (args.payment || PAYMENT) ? { 'X-PAYMENT': args.payment || PAYMENT } : {});
  switch (name) {
    case 'x402_conformance_check': {
      if (!/^https?:\/\//i.test(args.url || '')) throw new Error('url must be an absolute http(s) URL');
      return { status: 200, body: await linter.run(args.url) };
    }
    case 'simulate_base_transaction': {
      const r = await simulator.simulate({ to: args.to, data: args.data, value: args.value, from: args.from });
      return { status: r.ok ? 200 : 400, body: r };
    }
    case 'security_scan': return httpJson('GET', B + '/v2/security/scan?' + q({ address: args.address }), payHeader);
    case 'attest': return httpJson('POST', B + '/v2/attest', payHeader, { data: args.data });
    case 'verify_attestation': return httpJson('GET', B + '/v2/verify?' + q({ index: args.index, dataHash: args.dataHash }), fwd);
    case 'attestation_pubkey': return httpJson('GET', B + '/v2/pubkey', fwd);
    case 'read_ledger': return httpJson('GET', B + '/v2/ledger?' + q({ from: args.from, limit: args.limit }), fwd);
    case 'oracle_base': return httpJson('GET', B + '/v2/oracle/base', payHeader);
    case 'merkle_prove': return httpJson('POST', B + '/v2/merkle/prove', payHeader, { items: args.items, target: args.target });
    case 'merkle_verify': return httpJson('POST', B + '/v2/merkle/verify', fwd, { item: args.item, proof: args.proof, root: args.root });
    case 'sentiment_analysis': return httpJson('GET', B + '/v2/sentiment?' + q({ asset: args.asset }), payHeader);
    case 'hash_sha256': return httpJson('GET', B + '/v1/hash?' + q({ input: args.input }), payHeader);
    case 'uuid': return httpJson('GET', B + '/v1/uuid', payHeader);
    case 'pricing': return httpJson('GET', B + '/pricing', fwd);
    case 'health': return httpJson('GET', B + '/health', fwd);
    default: throw new Error('unknown tool: ' + name);
  }
}

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * Handles one JSON-RPC 2.0 message. Resolves to the response object, or null for
 * notifications (no id). Shared by the stdio transport and the HTTP /mcp endpoint.
 */
async function handleMessage(msg, opts) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: (msg && msg.id !== undefined) ? msg.id : null, error: { code: -32600, message: 'invalid request' } };
  }
  const isNotification = msg.id === undefined;
  const ok = (result) => isNotification ? null : { jsonrpc: '2.0', id: msg.id, result };
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params && msg.params.protocolVersion;
      return ok({ protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0], capabilities: { tools: {} },
        serverInfo: { name: 'automaton-x402', version: PKG.version } });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      const { name, arguments: a } = msg.params || {};
      try {
        if (opts && opts.beforeCall) await opts.beforeCall(name, a || {});
        const r = await callTool(name, a, opts);
        const isErr = r.status >= 400;
        // MCP expects content[]; surface status + body, and mark 402 as error with actionable text
        const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2);
        return ok({ content: [{ type: 'text', text: (isErr ? 'HTTP ' + r.status + '\n' : '') + text }], isError: isErr });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: 'error: ' + e.message }], isError: true });
      }
    }
    default:
      if (msg.method.startsWith('notifications/')) return null;
      return isNotification ? null : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found: ' + msg.method } };
  }
}

function startStdio() {
  let buf = '';
  process.stdin.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
      handleMessage(msg).then((r) => { if (r) process.stdout.write(JSON.stringify(r) + '\n'); });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

module.exports = { TOOLS, callTool, handleMessage, startStdio };

if (require.main === module) startStdio();
