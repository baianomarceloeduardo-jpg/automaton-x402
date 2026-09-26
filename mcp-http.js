// mcp-http.js - zero-dep MCP streamable-http client (JSON + SSE tolerant)
const https = require('https');
const http = require('http');

function raw(url, { method = 'POST', headers = {}, body = null, timeout = 45000 } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: Object.assign({ 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' }, headers),
    }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', e => resolve({ status: 0, headers: {}, body: 'ERR ' + e.message }));
    req.setTimeout(timeout, () => { req.destroy(); resolve({ status: 0, headers: {}, body: 'TIMEOUT' }); });
    if (body) req.write(body);
    req.end();
  });
}

function parseBody(b) {
  b = (b || '').trim();
  if (!b) return null;
  if (b[0] === '{') { try { return JSON.parse(b); } catch { return { raw: b }; } }
  // SSE: collect data: lines
  const out = [];
  for (const line of b.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      const d = line.slice(5).trim();
      try { out.push(JSON.parse(d)); } catch {}
    }
  }
  return out.length ? out[out.length - 1] : { raw: b };
}

class McpHttp {
  constructor(url) { this.url = url; this.id = 0; this.session = null; }
  async call(method, params, isNotification = false) {
    const msg = { jsonrpc: '2.0', method };
    if (!isNotification) msg.id = ++this.id;
    if (params !== undefined) msg.params = params;
    const headers = {};
    if (this.session) headers['mcp-session-id'] = this.session;
    const r = await raw(this.url, { method: 'POST', headers, body: JSON.stringify(msg) });
    if (r.headers && r.headers['mcp-session-id']) this.session = r.headers['mcp-session-id'];
    return { status: r.status, headers: r.headers, json: parseBody(r.body), raw: r.body };
  }
  async init() {
    const r = await this.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'automaton-sovereign', version: '1.0.0' },
    });
    await this.call('notifications/initialized', {}, true);
    return r;
  }
  async tools() { return this.call('tools/list', {}); }
  async callTool(name, args) { return this.call('tools/call', { name, arguments: args || {} }); }
}

module.exports = { McpHttp, raw, parseBody };

if (require.main === module) {
  const url = process.argv[2] || 'https://be.osir.com/mcp/http';
  const mode = process.argv[3] || 'tools';
  const m = new McpHttp(url);
  (async () => {
    const i = await m.init();
    console.log('INIT status=' + i.status + ' session=' + m.session);
    if (i.status !== 200) { console.log(i.raw.slice(0, 600)); process.exit(1); }
    if (mode === 'tools') {
      const t = await m.tools();
      const list = (t.json && t.json.result && t.json.result.tools) || [];
      console.log('TOOLS n=' + list.length);
      for (const x of list) console.log('  ' + x.name + ' :: ' + (x.description || '').slice(0, 110));
    } else if (mode === 'call') {
      const name = process.argv[4];
      const args = process.argv[5] ? JSON.parse(process.argv[5]) : {};
      const r = await m.callTool(name, args);
      console.log(JSON.stringify(r.json, null, 1).slice(0, 4000));
    }
  })();
}
