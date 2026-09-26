#!/usr/bin/env node
// x402-value-mcp.js — self-contained Model Context Protocol (MCP) server, ZERO dependencies.
// Exposes Automaton-Sovereign's x402 Value API as MCP tools so ANY MCP client (Claude Desktop,
// Cursor, Cline, custom agents) can use the free utilities and discover the paid endpoints.
//
// Install: point your MCP client at this file with command "node".
//   {
//     "mcpServers": {
//       "x402-value": {
//         "command": "node",
//         "args": ["/absolute/path/to/x402-value-mcp.js"],
//         "env": { "VALUE_API_BASE": "https://YOUR-LIVE-BASE" }
//       }
//     }
//   }
//
// Protocol: stdio JSON-RPC 2.0, MCP spec 2024-11-05 (initialize / tools/list / tools/call).
'use strict';

const http = require('http');
const https = require('https');

const BASE = (process.env.VALUE_API_BASE || '').replace(/\/+$/, '');

function fetchJson(url, opts = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ ok: false, error: 'bad_url: ' + url }); }
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request(url, { method: opts.method || 'GET', timeout: 25000, headers: Object.assign({ accept: 'application/json' }, opts.headers || {}) }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(b); } catch (e) { parsed = null; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: parsed, raw: b.slice(0, 4000) });
      });
    });
    r.on('error', e => resolve({ ok: false, error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, error: 'timeout' }); });
    r.end();
  });
}

const TOOLS = [
  {
    name: 'x402_health',
    description: 'Check that the x402 Value API is live and read its advertised payment terms (network, chainId, asset, payTo, schemes).',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => fetchJson(BASE + '/.well-known/x402'),
  },
  {
    name: 'x402_pricing',
    description: 'Read per-route pricing for the Value API (USDC amounts, payment header, free trial).',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => fetchJson(BASE + '/pricing'),
  },
  {
    name: 'x402_conformance',
    description: 'Audit ANY x402 service: fetches its 402 challenge and returns a pass/fail conformance verdict (scheme, network, chainId, asset, payTo, amount).',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Target service URL to audit (any https URL).' } }, required: ['url'] },
    run: async (a) => fetchJson(BASE + '/v1/x402-conformance?url=' + encodeURIComponent(String(a.url || ''))),
  },
  {
    name: 'verify_payment',
    description: 'Verify an on-chain ERC-20/USDC transfer on Base (free). Confirms the tx is real and confirmed, paid the right recipient, and met a minimum amount.',
    inputSchema: { type: 'object', properties: { tx: { type: 'string' }, to: { type: 'string' }, minAmount: { type: 'string', description: 'Minimum in token base units (USDC has 6 decimals; 1000 = 0.001).' } }, required: ['tx', 'to'] },
    run: async (a) => {
      const q = new URLSearchParams({ tx: String(a.tx || ''), to: String(a.to || '') });
      if (a.minAmount != null) q.set('minAmount', String(a.minAmount));
      return fetchJson(BASE + '/v1/verify-payment?' + q.toString());
    },
  },
  {
    name: 'x402_index',
    description: 'Read the live x402 service leaderboard (objectively scored by the conformance engine).',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => fetchJson(BASE + '/v1/index'),
  },
  {
    name: 'x402_submit',
    description: 'Free self-submission: add your own x402 service to the public leaderboard. Returns the queued entry.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Your x402 service base URL.' } }, required: ['url'] },
    run: async (a) => fetchJson(BASE + '/v1/index/submit?url=' + encodeURIComponent(String(a.url || ''))),
  },
  {
    name: 'x402_paid_uuid',
    description: 'PAID call (0.001 USDC on Base). Requires a prior settlement; pass the tx hash as paymentTx. Without it, returns the 402 challenge so a client can settle and retry.',
    inputSchema: { type: 'object', properties: { paymentTx: { type: 'string', description: '0x tx hash of the USDC settlement (omit to receive the 402 challenge).' } }, required: [] },
    run: async (a) => {
      const headers = a && a.paymentTx ? { 'X-PAYMENT': String(a.paymentTx) } : {};
      return fetchJson(BASE + '/v1/uuid', { headers });
    },
  },
];

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg || {};
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'x402-value-mcp', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized') return; // notification, no reply
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) return replyErr(id, -32602, 'unknown tool: ' + name);
    if (!BASE) {
      return reply(id, { content: [{ type: 'text', text: 'VALUE_API_BASE is not set. Set it to the live base URL in the MCP server env.' }], isError: true });
    }
    try {
      const out = await tool.run(args);
      const text = JSON.stringify(out.data != null ? out.data : out, null, 2);
      const isError = out.ok !== true;
      return reply(id, { content: [{ type: 'text', text }], isError });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true });
    }
  }
  if (id != null) return replyErr(id, -32601, 'method not found: ' + method);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    handle(msg).catch(() => {});
  }
});
process.stdin.on('end', () => process.exit(0));
