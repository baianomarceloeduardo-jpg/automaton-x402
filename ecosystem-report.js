// ecosystem-report.js v2.0.0 - HONEST x402 ecosystem measurement.
//
// WHY v2 EXISTS (important): v1 probed the ROOT URL of every registry entry and reported
// 30/30 NON_CONFORMANT. That was a MEASUREMENT ERROR, not a finding. Most entries in the
// MCP registry are MCP servers (JSON-RPC over stdio / streamable-http); their root URL does
// not and should not return an x402 402 challenge. Calling them "non-conformant" would be a
// false claim about 30 real services. I will not publish that.
//
// v2 classifies each probed endpoint by what it ACTUALLY did:
//   UNREACHABLE            - no HTTP response
//   NO_X402_CHALLENGE      - responded, but did not present an x402 402 (e.g. MCP/JSON-RPC/HTML).
//                            This is NOT a conformance verdict. The URL may simply not be the
//                            paid route. Recorded as observed, not judged.
//   X402_CHALLENGE_MALFORMED - returned 402 but the body is not a usable x402 challenge.
//   X402_CHALLENGE_INVALID   - returned a parseable x402 challenge that fails spec checks.
//   CONFORMANT             - returned a spec-conformant x402 challenge.
// Methodology caveat is stated in the published report so nobody misreads it.
'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const base = (() => { try { return fs.readFileSync(path.join(DIR, 'tunnel.url'), 'utf8').trim().replace(/\/$/, ''); } catch (e) { return ''; } })();
let conformance = null;
try { conformance = require('./x402-conformance.js'); } catch (e) { conformance = null; }

function rawGet(u, timeoutMs) {
  return new Promise(resolve => {
    let p; try { p = new URL(u); } catch (e) { return resolve({ status: 0, body: '', ctype: '' }); }
    const mod = p.protocol === 'http:' ? http : https;
    const req = mod.get(u, { timeout: timeoutMs || 12000, headers: { 'User-Agent': 'Automaton-Sovereign/2.0', 'Accept': 'application/json, */*' } }, res => {
      let d = ''; res.on('data', c => { d += c; if (d.length > 65536) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, body: d, ctype: res.headers['content-type'] || '' }));
    });
    req.on('error', () => resolve({ status: 0, body: '', ctype: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', ctype: '' }); });
  });
}
function fetchJson(u) {
  return new Promise(resolve => {
    const req = https.get(u, { timeout: 20000, headers: { 'User-Agent': 'Automaton-Sovereign/2.0', 'Accept': 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}
function endpointsOf(sv) {
  const out = [];
  const push = u => { if (typeof u === 'string' && /^https?:\/\//i.test(u)) out.push(u.replace(/\/$/, '')); };
  for (const r of (sv.remotes || [])) { if (r && typeof r === 'object') push(r.url || r.endpoint); else push(r); }
  if (Array.isArray(sv.endpoints)) for (const e of sv.endpoints) push(e && (e.url || e)); else if (typeof sv.endpoints === 'string') push(sv.endpoints);
  return [...new Set(out)];
}
function looksLikeX402(body) {
  const b = (body || '').toLowerCase();
  return b.includes('accepts') || b.includes('x402version') || b.includes('maxamountrequired') || b.includes('"x402"');
}

async function runBounded(items, concurrency, fn) {
  const results = []; let idx = 0;
  async function worker() { while (idx < items.length) { const my = items[idx++]; try { results.push(await fn(my)); } catch (e) { results.push({ error: String(e && e.message || e) }); } } }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

(async () => {
  const report = { at: new Date().toISOString(), base, checker: base ? base + '/v1/x402-conformance' : null, methodology: '', observations: [], summary: {} };

  const servers = [];
  for (const q of ['x402', 'payment', 'usdc']) {
    const j = await fetchJson('https://registry.modelcontextprotocol.io/v0/servers?search=' + q + '&limit=100');
    if (j && j.servers) for (const s of j.servers) servers.push(s.server || s);
  }
  const uniq = new Map();
  for (const sv of servers) if (sv && sv.name && !uniq.has(sv.name)) uniq.set(sv.name, sv);
  const all = [...uniq.values()];
  const withEps = all.map(sv => ({ sv, eps: endpointsOf(sv) })).filter(x => x.eps.length);
  console.log('registry servers: ' + all.length + ' | with http endpoints: ' + withEps.length);

  const SAMPLE = 40;
  const picks = withEps.slice(0, SAMPLE);
  const observations = await runBounded(picks, 5, async (item) => {
    const url = item.eps[0];
    const r = await rawGet(url);
    const rec = { name: item.sv.name, url, description: (item.sv.description || '').slice(0, 160), status: r.status, content_type: r.ctype };
    if (r.status === 0) { rec.class = 'UNREACHABLE'; return rec; }
    if (r.status !== 402) { rec.class = 'NO_X402_CHALLENGE'; rec.note = 'responded ' + r.status + ' without a 402; URL may not be the paid route (common for MCP/JSON-RPC endpoints). NOT a conformance verdict.'; return rec; }
    // Real 402: judge it.
    if (!looksLikeX402(r.body)) { rec.class = 'X402_CHALLENGE_MALFORMED'; return rec; }
    if (conformance && typeof conformance.run === 'function') {
      const v = await conformance.run(url);
      rec.passed = v && v.passed; rec.total = v && v.total; rec.verdict = v && v.verdict;
      rec.class = (v && v.verdict === 'CONFORMANT') ? 'CONFORMANT' : 'X402_CHALLENGE_INVALID';
    } else { rec.class = 'X402_CHALLENGE_PRESENT'; }
    return rec;
  });

  report.observations = observations;
  const counts = {};
  for (const o of observations) counts[o.class] = (counts[o.class] || 0) + 1;
  const realChallenges = observations.filter(o => o.class === 'CONFORMANT' || o.class === 'X402_CHALLENGE_INVALID' || o.class === 'X402_CHALLENGE_PRESENT');
  report.summary = {
    registry_servers: all.length,
    with_http_endpoints: withEps.length,
    sampled: observations.length,
    by_class: counts,
    endpoints_presenting_a_402_challenge: realChallenges.length,
    conformant_of_those: realChallenges.filter(o => o.class === 'CONFORMANT').length
  };

  report.methodology = [
    'Each endpoint was probed once with a plain HTTP GET (no payment) at the URL found in its registry record.',
    'A service is only judged on conformance if it actually returned HTTP 402 with a parseable x402 challenge.',
    'A service that returns 200/4xx/HTML at the probed URL is recorded as NO_X402_CHALLENGE, NOT as non-conformant:',
    'the probed URL may simply not be its paid route (most registry entries are MCP JSON-RPC servers).',
    'No account or wallet was used. Checker: ' + (report.checker || '(local)') + ' (free).'
  ].join(' ');

  fs.writeFileSync(path.join(DIR, 'ecosystem-report.json'), JSON.stringify(report, null, 2));

  const md = [
    '# x402 Ecosystem Probe (honest methodology)',
    '',
    'Generated ' + report.at + ' by Automaton-Sovereign. Read the methodology before reading the numbers.',
    '',
    '## Methodology',
    report.methodology,
    '',
    '## Summary',
    '- Registry servers scanned: ' + report.summary.registry_servers,
    '- With an HTTP endpoint: ' + report.summary.with_http_endpoints,
    '- Sampled: ' + report.summary.sampled,
    '- Classification: ' + JSON.stringify(report.summary.by_class),
    '- **Endpoints that actually presented a 402 x402 challenge: ' + report.summary.endpoints_presenting_a_402_challenge + '**',
    '- Of those, spec-conformant: ' + report.summary.conformant_of_those,
    '',
    '## Observations',
    '| service | class | http | note |',
    '|---|---|---|---|',
    ...observations.map(o => '| ' + o.name + ' | ' + o.class + ' | ' + (o.status || '-') + ' | ' + (o.class === 'NO_X402_CHALLENGE' ? 'no 402 at this URL (not a verdict)' : (o.total ? o.passed + '/' + o.total : '')) + ' |')
  ].join('\n');
  fs.writeFileSync(path.join(DIR, 'ecosystem-report.md'), md);

  console.log('summary ' + JSON.stringify(report.summary));
  observations.forEach(o => console.log('  ' + String(o.class).padEnd(24) + String(o.status || '-').padEnd(5) + o.name));
})();
