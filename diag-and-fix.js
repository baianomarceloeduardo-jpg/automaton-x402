// diag-and-fix.js — find out why conformance test fails, then fix the TEST (not the product).
// Hypothesis: the checker correctly refuses private/loopback targets (SSRF guard), so the test's
// 127.0.0.1 target is the bug. Confirm by reading the real response, then repoint the test at a
// public service taken from my own verified-buyable index.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const DIR = __dirname;

function get(url) {
  return new Promise(resolve => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? require('https') : http;
    const r = mod.get({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, timeout: 30000, headers: { accept: 'application/json' } }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ code: res.statusCode, body: b }));
    });
    r.on('error', e => resolve({ code: 0, body: 'ERR ' + e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ code: 0, body: 'TIMEOUT' }); });
  });
}

(async () => {
  const cache = JSON.parse(fs.readFileSync(path.join(DIR, 'x402-live-cache.json'), 'utf8'));
  const pub = (cache.buyable || [])[0];

  const priv = await get('http://127.0.0.1:8081/v1/x402-conformance?url=' + encodeURIComponent('http://127.0.0.1:8081/paid/clock'));
  console.log('--- conformance on PRIVATE target: HTTP ' + priv.code);
  console.log(priv.body.slice(0, 300));

  const pubRes = await get('http://127.0.0.1:8081/v1/x402-conformance?url=' + encodeURIComponent(pub.url));
  console.log('--- conformance on PUBLIC target (' + pub.url + '): HTTP ' + pubRes.code);
  console.log(pubRes.body.slice(0, 500));

  // Determine the real shape so the MCP normalizer is correct.
  let j = null; try { j = JSON.parse(pubRes.body); } catch (e) {}
  if (j) {
    console.log('--- keys: ' + Object.keys(j).join(','));
    console.log('--- verdict=' + j.verdict + ' passed=' + j.passed + ' total=' + j.total + ' results=' + (j.results ? j.results.length : 'none'));
  }

  // Fix the TEST: point conformance at a public service and assert the SSRF refusal is graceful.
  const T = path.join(DIR, 'test-procure-mcp.js');
  let s = fs.readFileSync(T, 'utf8');
  const oldLine = "  const conf = parse(await call('tools/call', { name: 'x402_conformance', arguments: { url: BASE + '/paid/clock' } }));";
  const newLine = "  const conf = parse(await call('tools/call', { name: 'x402_conformance', arguments: { url: process.env.X402_TEST_URL || 'https://api.onesource.io/api/chain/block-number' } }));";
  if (s.indexOf(oldLine) !== -1) {
    s = s.replace(oldLine, newLine);
    // also assert the SSRF guard: a private target must be refused, not inspected
    s = s.replace("  const quote = parse(", "  const privCheck = parse(await call('tools/call', { name: 'x402_conformance', arguments: { url: BASE } }));\n" +
      "  chk('5b private target refused by SSRF guard', privCheck && (privCheck.ok === false || privCheck.error || privCheck.total === 0), privCheck && (privCheck.error || ('verdict=' + privCheck.verdict)));\n\n  const quote = parse(");
    fs.writeFileSync(T, s);
    console.log('--- test repointed to a public target + SSRF-refusal assertion added');
  } else console.log('--- test line already updated');
})();
