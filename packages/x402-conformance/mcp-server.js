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

async function callTool(name, args) {
  args = args || {};
  const payHeader = (args.payment || PAYMENT) ? { 'X-PAYMENT': args.payment || PAYMENT } : {};
  switch (name) {
    case 'x402_conformance_check': {
      if (!/^https?:\/\//i.test(args.url || '')) throw new Error('url must be an absolute http(s) URL');
      return { status: 200, body: await linter.run(args.url) };
    }
    case 'security_scan': return httpJson('GET', BASE + '/v2/security/scan?' + q({ address: args.address }), payHeader);
    case 'attest': return httpJson('POST', BASE + '/v2/attest', payHeader, { data: args.data });
    case 'verify_attestation': return httpJson('GET', BASE + '/v2/verify?' + q({ index: args.index, dataHash: args.dataHash }));
    case 'attestation_pubkey': return httpJson('GET', BASE + '/v2/pubkey');
    case 'read_ledger': return httpJson('GET', BASE + '/v2/ledger?' + q({ from: args.from, limit: args.limit }));
    case 'oracle_base': return httpJson('GET', BASE + '/v2/oracle/base', payHeader);
    case 'merkle_prove': return httpJson('POST', BASE + '/v2/merkle/prove', payHeader, { items: args.items, target: args.target });
    case 'merkle_verify': return httpJson('POST', BASE + '/v2/merkle/verify', {}, { item: args.item, proof: args.proof, root: args.root });
    case 'sentiment_analysis': return httpJson('GET', BASE + '/v2/sentiment?' + q({ asset: args.asset }), payHeader);
    case 'hash_sha256': return httpJson('GET', BASE + '/v1/hash?' + q({ input: args.input }), payHeader);
    case 'uuid': return httpJson('GET', BASE + '/v1/uuid', payHeader);
    case 'pricing': return httpJson('GET', BASE + '/pricing');
    case 'health': return httpJson('GET', BASE + '/health');
    default: throw new Error('unknown tool: ' + name);
  }
}

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function replyErr(id, code, message, data) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } }) + '\n'); }

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
    if (msg.method === 'initialize') {
      reply(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} },
        serverInfo: { name: 'automaton-x402', version: PKG.version } });
    } else if (msg.method === 'ping') {
      reply(msg.id, {});
    } else if (msg.method === 'notifications/initialized') {
      // no reply
    } else if (msg.method === 'tools/list') {
      reply(msg.id, { tools: TOOLS });
    } else if (msg.method === 'tools/call') {
      const { name, arguments: a } = msg.params || {};
      Promise.resolve().then(() => callTool(name, a)).then((r) => {
        const isClosedError = r.status >= 400;
        // MCP expects content[]; surface status + body, and mark 402 as error with actionable text
        const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2);
        const prefix = isClosedError ? ('HTTP ' + r.status + '\n') : '';
        reply(msg.id, { content: [{ type: 'text', text: prefix + text }], isError: isClosedError });
      }).catch((e) => reply(msg.id, { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true }));
    } else if (msg.id !== undefined) {
      replyErr(msg.id, -32601, 'method not found: ' + msg.method);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
