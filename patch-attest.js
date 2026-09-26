// patch-attest.js — expose the on-chain anchor record so anyone (human or MCP client) can fetch it.
// Routes: GET /v1/attest (JSON: latest anchor + full log), GET /attest (HTML view).
// The point: my index is tamper-evident, and the evidence must be as fetchable as the claim.
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const TARGET = path.join(DIR, 'paid-api.js');
const MARKER = '/* __ATTEST_OVERLAY__ */';

const OVERLAY = MARKER + `
(function () {
  const _http = require('http');
  const _o = _http.createServer.bind(_http);
  const fs = require('fs');
  const path = require('path');
  const DIR = __dirname;

  function readJson(f) { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (e) { return null; } }
  function readLog() {
    try { return fs.readFileSync(path.join(DIR, 'ATTEST-LOG.jsonl'), 'utf8').trim().split('\\n')
      .filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); }
    catch (e) { return []; }
  }
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function h(req, res) {
    let p; try { p = new URL(req.url, 'http://x').pathname; } catch (e) { p = req.url; }
    if (p !== '/v1/attest' && p !== '/attest') return false;
    const latest = readJson('ATTEST-LATEST.json');
    const log = readLog();
    const snapshot = readJson('index-snapshot.json');
    const out = {
      ok: true,
      what: 'Tamper-evident on-chain anchors of the verified-buyable x402 index.',
      how: 'The canonical index (sorted by url) is sha256-hashed, then committed in a zero-value Base self-transaction whose calldata is: AUTOMATON-X402-IDX v1 sha256=<hash> n=<count> <baseUrl>. Recompute the hash from index-snapshot.json and compare.',
      count: log.length,
      latest: latest,
      anchors: log,
      currentSnapshot: snapshot ? { generatedAt: snapshot.generatedAt, buyableCount: snapshot.buyableCount, checked: snapshot.checked } : null,
      verifyYourself: [
        '1. GET /v1/attest -> take anchors[].sha256 and anchors[].txHash',
        '2. GET /v1/index-snapshot -> canonical JSON',
        '3. sha256(JSON.stringify(snapshot)) must equal the anchored hash',
        '4. read txHash calldata on any Base RPC and confirm it utf8-decodes to the payload',
      ],
    };
    if (p === '/attest') {
      const rows = log.slice().reverse().map(a =>
        '<tr><td>' + esc(a.at) + '</td><td>' + esc(a.blockNumber) + '</td><td>n=' + esc(a.buyableCount) + '</td>' +
        '<td><code>' + esc(String(a.sha256).slice(0, 16)) + '…</code></td>' +
        '<td><a href="' + esc(a.explorer) + '" rel="noopener">tx</a></td></tr>').join('');
      const b = Buffer.from('<!doctype html><meta charset=utf-8><title>on-chain index anchors</title>' +
        '<style>body{font:13px/1.6 ui-monospace,Menlo,monospace;background:#0b0f14;color:#d7e3ee;padding:24px}a{color:#6ee7b7}' +
        'table{border-collapse:collapse;width:100%}th,td{padding:6px 10px;border-bottom:1px solid #1c2733;text-align:left}th{color:#8fa6bb}</style>' +
        '<h1>Tamper-evident index anchors</h1><p>' + esc(out.how) + '</p>' +
        '<p>JSON: <a href="/v1/attest">/v1/attest</a> · snapshot: <a href="/v1/index-snapshot">/v1/index-snapshot</a></p>' +
        '<table><thead><tr><th>anchored at</th><th>Base block</th><th>entries</th><th>sha256</th><th>proof</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan=5>no anchors yet</td></tr>') + '</tbody></table>');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': b.length, 'cache-control': 'public, max-age=300' });
      res.end(b); return true;
    }
    const b = Buffer.from(JSON.stringify(out, null, 2));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length,
      'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' });
    res.end(b); return true;
  }

  // also serve the raw canonical snapshot so a verifier can recompute the hash
  function hs(req, res) {
    let p; try { p = new URL(req.url, 'http://x').pathname; } catch (e) { p = req.url; }
    if (p !== '/v1/index-snapshot' && p !== '/index-snapshot.json') return false;
    let raw; try { raw = fs.readFileSync(path.join(DIR, 'index-snapshot.json')); } catch (e) { return false; }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': raw.length,
      'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' });
    res.end(raw); return true;
  }

  _http.createServer = function () {
    const a = Array.prototype.slice.call(arguments);
    const fns = a.filter(x => typeof x === 'function');
    const rest = a.filter(x => typeof x !== 'function');
    return _o.apply(_http, rest.concat([function (q, s) {
      try { if (h(q, s)) return; } catch (e) {}
      try { if (hs(q, s)) return; } catch (e) {}
      for (const f of fns) { try { return f(q, s); } catch (e) {} }
      s.writeHead(500, { 'content-type': 'application/json' }); s.end('{"error":"no_handler"}');
    }]));
  };
})();
`;

let s = fs.readFileSync(TARGET, 'utf8');
if (s.indexOf(MARKER) !== -1) { console.log('[attest-route] already wired (no-op)'); process.exit(0); }
fs.writeFileSync(path.join(DIR, 'paid-api.js.bak-attest'), s);
fs.writeFileSync(TARGET, OVERLAY + '\n' + s);
console.log('[attest-route] prepended /v1/attest + /v1/index-snapshot routes');
