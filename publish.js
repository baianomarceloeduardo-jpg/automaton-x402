// publish.js v1.0.0 - one-shot durable distribution + self-listing.
// 1. Self-submit the live API into my own x402 Service Index (free, proves the growth loop).
// 2. Publish the remediation engine + a fresh URL beacon to paste.rs (keyless, durable).
// 3. Write distribution-record.json for the audit trail.
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const base = fs.readFileSync(path.join(DIR, 'tunnel.url'), 'utf8').trim().replace(/\/$/, '');

function req(options, body) {
  return new Promise(resolve => {
    const r = https.request(options, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', e => resolve({ status: 0, body: e.message }));
    r.setTimeout(30000, () => { r.destroy(); resolve({ status: 0, body: 'timeout' }); });
    if (body) r.write(body);
    r.end();
  });
}
function getText(u) { const p = new URL(u); return req({ hostname: p.hostname, path: p.pathname + p.search, method: 'GET' }); }
function postText(host, p, body) {
  return req({ hostname: host, path: p, method: 'POST', headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) }, port: 443 }, body);
}

(async () => {
  const record = { at: new Date().toISOString(), base, steps: [] };
  console.log('BASE ' + base);

  // 1. Self-submit into my own index.
  const sub = await getText(base + '/v1/index/submit?url=' + encodeURIComponent(base + '/v1/uuid'));
  let sj = {}; try { sj = JSON.parse(sub.body); } catch (e) {}
  const subOk = sub.status === 200 && (sj.ok === true || sj.queued === true || /queued|accepted|added/i.test(sub.body));
  console.log('1. index self-submit -> ' + sub.status + ' ' + sub.body.slice(0, 160));
  record.steps.push({ step: 'index_self_submit', ok: subOk, status: sub.status, body: sub.body.slice(0, 300) });

  // 2. Publish the remediation engine durably.
  const src = fs.readFileSync(path.join(DIR, 'x402-remediate.js'), 'utf8');
  const pub = await postText('paste.rs', '/', src);
  console.log('2. remediation engine -> paste.rs ' + pub.status + ' ' + pub.body.trim());
  record.steps.push({ step: 'publish_remediation', ok: pub.status >= 200 && pub.status < 300, artifact: pub.body.trim() });

  // 3. Fresh URL beacon so durable listings point at the live URL.
  const beacon = [
    'Automaton-Sovereign Value API - live beacon',
    'updated: ' + new Date().toISOString(),
    'base: ' + base,
    '',
    'Free public goods for the x402 economy:',
    '  ' + base + '/index                        objective leaderboard of public x402 services',
    '  ' + base + '/remediate?url=<target>       turn a failed conformance report into concrete fixes',
    '  ' + base + '/v1/x402-conformance?url=<t>  live 10-check conformance verdict for any service',
    '  ' + base + '/badge.svg?url=<target>       embeddable live conformance badge',
    '  ' + base + '/v1/verify-payment?tx=<hash>  verify any Base USDC transfer on-chain',
    '',
    'Paid (x402, 0.001 USDC on Base, eip3009 caller-bound or exact):',
    '  /v1/uuid /v1/time /v1/hash /v1/echo /v2/oracle/base',
    '',
    'Note: this is a cloudflared quick tunnel; the base URL rotates on restart.',
    'The beacon is republished on every deploy so durable listings stay current.'
  ].join('\n');
  const bp = await postText('paste.rs', '/', beacon);
  console.log('3. url beacon -> paste.rs ' + bp.status + ' ' + bp.body.trim());
  record.steps.push({ step: 'beacon', ok: bp.status >= 200 && bp.status < 300, artifact: bp.body.trim() });

  fs.writeFileSync(path.join(DIR, 'distribution-record.json'), JSON.stringify(record, null, 2));
  fs.writeFileSync(path.join(DIR, 'latest-beacon.json'), JSON.stringify({ base, at: record.at, artifacts: record.steps.filter(s => s.artifact).map(s => s.artifact) }, null, 2));
  const allOk = record.steps.every(s => s.ok);
  console.log(allOk ? '\nDISTRIBUTION OK' : '\nPARTIAL DISTRIBUTION');
  process.exit(allOk ? 0 : 1);
})();
