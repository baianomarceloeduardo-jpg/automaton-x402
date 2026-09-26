// patch-conformance.js — wire /v1/x402-conformance into the LIVE paid API (it 404'd here).
//
// REAL DEFECT FOUND BY THE MCP SUITE: the conformance checker existed only on the old server.js
// (port 8080), but every public pointer -- tunnel, index base, MCP default -- now resolves to the
// paid API (8081). So a client following my own discovery surface asked for conformance and got
// 404 not_found. A capability that is advertised but unreachable is worse than one that is absent.
//
// This puts conformance on the same surface as everything else, WITH an SSRF guard, because a
// conformance checker fetches an arbitrary caller-supplied URL -- that is exactly the shape of an
// SSRF hole, and I will not ship one.
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const TARGET = path.join(DIR, 'paid-api.js');
const MARKER = '/* __CONFORMANCE_OVERLAY__ */';

const OVERLAY = MARKER + `
(function () {
  const _http = require('http');
  const _o = _http.createServer.bind(_http);
  const dns = require('dns');
  const net = require('net');
  const path = require('path');
  let conf = null;
  try { conf = require(path.join(__dirname, 'x402-conformance.js')); } catch (e) {}

  function isPrivate(ip) {
    if (net.isIPv4(ip)) {
      const p = ip.split('.').map(Number);
      if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
      if (p[0] === 169 && p[1] === 254) return true;
      if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
      if (p[0] === 192 && p[1] === 168) return true;
      if (p[0] >= 224) return true;
      return false;
    }
    const l = String(ip).toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127') || l.startsWith('::ffff:10') || l.startsWith('::ffff:192.168');
  }

  function guard(target, cb) {
    let u; try { u = new URL(target); } catch (e) { return cb('malformed_url'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return cb('scheme_not_allowed');
    const host = u.hostname;
    if (net.isIP(host)) return cb(isPrivate(host) ? 'private_target_refused' : null);
    dns.lookup(host, { all: true }, (err, addrs) => {
      if (err) return cb('dns_failed');
      if (!addrs || !addrs.length) return cb('dns_empty');
      for (const a of addrs) if (isPrivate(a.address)) return cb('private_target_refused');
      cb(null);
    });
  }

  function handle(req, res) {
    let p, qs;
    try { const u = new URL(req.url, 'http://x'); p = u.pathname; qs = u.searchParams; } catch (e) { return false; }
    if (p !== '/v1/x402-conformance') return false;
    const target = qs.get('url');
    const json = (code, obj) => { const b = Buffer.from(JSON.stringify(obj, null, 2));
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'access-control-allow-origin': '*' }); res.end(b); };
    if (!target) return json(400, { ok: false, error: 'url_required', usage: '/v1/x402-conformance?url=https://service' }), true;
    if (!conf || typeof conf.run !== 'function') return json(503, { ok: false, error: 'checker_module_unavailable' }), true;
    guard(target, async (why) => {
      if (why) return json(400, { ok: false, error: why, target });
      try {
        const r = await conf.run(target);
        const out = Object.assign({ ok: true, url: target, at: new Date().toISOString(),
          checks: (r.results || []).map(x => ({ name: x.name || x.id, ok: x.ok === true || x.pass === true, detail: x.detail || null })) }, r);
        json(200, out);
      } catch (e) { json(502, { ok: false, error: 'check_failed', detail: String(e.message) }); }
    });
    return true;
  }

  _http.createServer = function () {
    const a = Array.prototype.slice.call(arguments);
    const fns = a.filter(x => typeof x === 'function');
    const rest = a.filter(x => typeof x !== 'function');
    return _o.apply(_http, rest.concat([function (q, s) {
      try { if (handle(q, s)) return; } catch (e) {}
      for (const f of fns) { try { return f(q, s); } catch (e) {} }
      s.writeHead(500, { 'content-type': 'application/json' }); s.end('{"error":"no_handler"}');
    }]));
  };
})();
`;

let s = fs.readFileSync(TARGET, 'utf8');
if (s.indexOf(MARKER) !== -1) { console.log('[conformance] already wired (no-op)'); process.exit(0); }
fs.writeFileSync(path.join(DIR, 'paid-api.js.bak-conformance'), s);
fs.writeFileSync(TARGET, OVERLAY + '\n' + s);
console.log('[conformance] wired /v1/x402-conformance (SSRF-guarded) into the live paid API');
