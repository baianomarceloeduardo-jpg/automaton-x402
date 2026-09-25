// directory-submit.js v1.0.0 - probe REAL agent/MCP/x402 directories for open submission,
// then submit where allowed. No guessing: every target is probed and its exact HTTP verdict
// is recorded. Never hide a failure - the audit trail is the point.
'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const DIR = __dirname;
const base = fs.readFileSync(path.join(DIR, 'tunnel.url'), 'utf8').trim().replace(/\/$/, '');

// Candidate public directories relevant to MCP / x402 / autonomous agents.
// kind: 'probe' = just read the discovery doc; 'submit' = attempt a POST/GET submission.
const TARGETS = [
  { name: 'mcp-registry-servers', kind: 'probe', url: 'https://registry.modelcontextprotocol.io/v0/servers?search=x402' },
  { name: 'mcp-registry-publish', kind: 'submit', method: 'POST', url: 'https://registry.modelcontextprotocol.io/v0/publish', json: { $schema: 'https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json', name: 'io.automaton/x402-remediate', description: 'Free x402 conformance, remediation and indexing tools', version: '1.0.0', remotes: [{ type: 'streamable-http', url: base + '/v1/x402-remediate' }] } },
  { name: 'glama.ai', kind: 'probe', url: 'https://glama.ai/' },
  { name: 'mcp.so', kind: 'probe', url: 'https://mcp.so/' },
  { name: 'smithery.ai', kind: 'probe', url: 'https://smithery.ai/' },
  { name: 'pulsemcp', kind: 'probe', url: 'https://www.pulsemcp.com/' },
  { name: 'x402.org', kind: 'probe', url: 'https://x402.org/' },
  { name: 'x402scan', kind: 'probe', url: 'https://www.x402scan.com/' },
  { name: 'agentverse', kind: 'probe', url: 'https://agentverse.ai/' },
  { name: 'aiagentsdirectory', kind: 'probe', url: 'https://aiagentsdirectory.com/' },
  { name: 'paste.rs', kind: 'probe', url: 'https://paste.rs/' }
];

function fetchUrl(u, opts) {
  return new Promise(resolve => {
    let p; try { p = new URL(u); } catch (e) { return resolve({ status: 0, body: 'bad_url', headers: {} }); }
    const mod = p.protocol === 'http:' ? http : https;
    const options = { hostname: p.hostname, port: p.port || undefined, path: p.pathname + p.search, method: (opts && opts.method) || 'GET', headers: Object.assign({ 'User-Agent': 'Automaton-Sovereign/1.0 (+x402 agent)', 'Accept': '*/*' }, (opts && opts.headers) || {}) };
    const r = mod.request(options, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    r.on('error', e => resolve({ status: 0, body: e.message, headers: {} }));
    r.setTimeout(20000, () => { r.destroy(); resolve({ status: 0, body: 'timeout', headers: {} }); });
    if (opts && opts.body) r.write(opts.body);
    r.end();
  });
}

(async () => {
  const out = { at: new Date().toISOString(), base, results: [] };
  console.log('BASE ' + base + '\n');
  for (const t of TARGETS) {
    let r;
    if (t.kind === 'submit' && t.method === 'POST') {
      const body = JSON.stringify(t.json);
      r = await fetchUrl(t.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body });
    } else if (t.kind === 'submit') {
      r = await fetchUrl(t.url, { method: t.method || 'GET' });
    } else {
      r = await fetchUrl(t.url, { method: 'GET' });
    }
    const verdict = r.status === 0 ? 'UNREACHABLE' :
      (r.status >= 200 && r.status < 300 ? 'OK' :
        r.status === 401 || r.status === 403 ? 'AUTH_REQUIRED' :
          r.status === 404 ? 'NOT_FOUND' :
            r.status === 422 ? 'VALIDATION' : 'HTTP_' + r.status);
    const snippet = (r.body || '').replace(/\s+/g, ' ').slice(0, 140);
    console.log(t.name.padEnd(22) + ' ' + verdict.padEnd(14) + ' ' + snippet);
    out.results.push({ name: t.name, url: t.url, kind: t.kind, status: r.status, verdict, snippet });
  }
  fs.writeFileSync(path.join(DIR, 'directory-probe.json'), JSON.stringify(out, null, 2));
  const open = out.results.filter(x => x.verdict === 'OK' || x.verdict === 'VALIDATION');
  console.log('\nreachable=' + out.results.filter(x => x.status > 0).length + '/' + out.results.length +
    ' | open_or_actionable=' + open.length + (open.length ? ' [' + open.map(x => x.name).join(', ') + ']' : ''));
})();
