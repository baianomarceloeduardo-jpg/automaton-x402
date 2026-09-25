'use strict';
/**
 * MCP over HTTP at /mcp (JSON-RPC 2.0, CORS open) for Smithery and other web MCP clients.
 * Reuses the tool definitions and dispatcher of the npm package's stdio MCP server.
 *
 *   GET  /mcp  -> server info + tool names (405 if the client asks for an SSE stream)
 *   POST /mcp  -> JSON-RPC message or batch; notifications get 202 with no body
 *
 * API tools call this server directly on 127.0.0.1 (no Worker/tunnel round trip), forwarding
 * the caller's IP (free-trial quota is per caller) and public host (x402 `resource` stays correct).
 */
const dns = require('dns').promises;
const net = require('net');
const MCP = require('./packages/x402-conformance/mcp-server.js');
const PKG = require('./packages/x402-conformance/package.json');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, X-PAYMENT',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id'
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS));
  res.end(body);
}

function empty(res, code, extra) {
  res.writeHead(code, Object.assign({}, CORS, extra || {}));
  res.end();
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

// The linter fetches arbitrary URLs from this machine: refuse targets on the local network.
async function guardPublicTarget(name, args) {
  if (name !== 'x402_conformance_check') return;
  let host;
  try { host = new URL(args.url).hostname.replace(/^\[|\]$/g, ''); } catch (e) { return; } // the tool reports the bad URL
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new Error('cannot resolve host: ' + host);
  if (addrs.some(isPrivateIp)) throw new Error('target must be a public host');
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    let d = '', n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { req.destroy(); return resolve(null); } d += c; });
    req.on('end', () => resolve(d));
    req.on('error', () => resolve(null));
  });
}

module.exports = function attachMcpHttp(server, options) {
  options = options || {};
  const port = options.port || process.env.PORT || 8080;
  const clientIp = options.clientIp || ((req) => (req.socket && req.socket.remoteAddress) || 'unknown');

  const prev = server.listeners('request').slice();
  server.removeAllListeners('request');
  server.on('request', async function (req, res) {
    const p = (req.url || '/').split('?')[0];
    if (p !== '/mcp') return prev.forEach((l) => l.call(server, req, res));

    if (req.method === 'OPTIONS') return empty(res, 204);

    if (req.method === 'GET') {
      const accept = String(req.headers.accept || '').toLowerCase();
      if (accept.includes('text/event-stream') && !accept.includes('application/json')) return empty(res, 405, { Allow: 'POST, OPTIONS' });
      return json(res, 200, { ok: true, name: 'automaton-x402', version: PKG.version, transport: 'http', endpoint: '/mcp',
        tools: MCP.TOOLS.map((t) => t.name) });
    }

    if (req.method !== 'POST') return empty(res, 405, { Allow: 'GET, POST, OPTIONS' });

    const raw = await readBody(req, 256 * 1024);
    if (raw === null) return json(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request too large' } });
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }

    const fwdHost = req.headers['x-forwarded-host'] || req.headers.host;
    const opts = {
      base: 'http://127.0.0.1:' + port,
      headers: Object.assign({ 'X-Forwarded-For': clientIp(req), 'X-Forwarded-Proto': req.headers['x-forwarded-proto'] || 'https' },
        fwdHost ? { 'X-Forwarded-Host': fwdHost } : {}),
      beforeCall: guardPublicTarget
    };

    if (Array.isArray(msg)) {
      if (!msg.length) return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'empty batch' } });
      const out = (await Promise.all(msg.map((m) => MCP.handleMessage(m, opts)))).filter(Boolean);
      return out.length ? json(res, 200, out) : empty(res, 202);
    }
    const r = await MCP.handleMessage(msg, opts);
    return r ? json(res, 200, r) : empty(res, 202);
  });
  console.log('[mcp-http] MCP over HTTP active: GET/POST /mcp (' + MCP.TOOLS.length + ' tools)');
};
