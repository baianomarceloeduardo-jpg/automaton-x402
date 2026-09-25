#!/usr/bin/env node
/**
 * x402-conformance  v1.0.0  -- zero-dep conformance battery for x402 services.
 * Author: Automaton-Sovereign (autonomous agent, 0x71DEAc...E528). License: MIT.
 *
 * Composes with x402-toolkit.js (no duplication): it REQUIRES the toolkit and reuses
 * its fetch/probe primitives. That composition is itself proof the toolkit is usable
 * as a library, not just a CLI.
 *
 *   node x402-conformance.js <url> [--json]
 *
 * Battery (each check = PASS/FAIL/SKIP with evidence):
 *   C1  endpoint returns HTTP 402 for an unpaid request
 *   C2  challenge parses as JSON
 *   C3  challenge carries accepts[] with scheme=exact
 *   C4  network/chainId resolve to Base (mainnet)
 *   C5  asset + payTo are valid addresses
 *   C6  maxAmountRequired is a positive integer
 *   C7  discovery headers present (WWW-Authenticate: x402  or  X-Accept-Payment)
 *   C8  a FORGED X-PAYMENT is rejected (must NOT return 200)
 *   C9  /health (if present) returns JSON with ok/status
 *   C10 /pricing (if present) returns JSON with a price field
 *
 * Exit code: 0 if all non-skip checks pass, 1 otherwise. Machine-readable with --json.
 */
'use strict';
const tk = require('./x402-toolkit.js');
const { fetchUrl } = tk;

const FORGED = '0x' + 'de'.repeat(32);

async function checkHealth(base) {
  try {
    const r = await fetchUrl(base.replace(/\/$/, '') + '/health', { timeout: 10000 });
    if (r.status !== 200) return { status: 'SKIP', detail: `/health -> HTTP ${r.status}` };
    let j = null; try { j = JSON.parse(r.body); } catch (e) {}
    if (!j) return { status: 'FAIL', detail: '/health did not return JSON' };
    if (j.ok === true || j.status === 'ok') return { status: 'PASS', detail: `/health ok (version ${j.version || '?'})` };
    return { status: 'FAIL', detail: `/health JSON missing ok/status: ${r.body.slice(0, 80)}` };
  } catch (e) { return { status: 'SKIP', detail: '/health unreachable: ' + e.message }; }
}

async function checkPricing(base) {
  try {
    const r = await fetchUrl(base.replace(/\/$/, '') + '/pricing', { timeout: 10000 });
    if (r.status !== 200) return { status: 'SKIP', detail: `/pricing -> HTTP ${r.status}` };
    let j = null; try { j = JSON.parse(r.body); } catch (e) {}
    if (!j) return { status: 'FAIL', detail: '/pricing did not return JSON' };
    const hasPrice = j.price !== undefined || (j.endpoints && Object.keys(j.endpoints).length) || j.maxAmountRequired !== undefined;
    return hasPrice ? { status: 'PASS', detail: '/pricing advertises a price' }
                    : { status: 'FAIL', detail: '/pricing has no price field' };
  } catch (e) { return { status: 'SKIP', detail: '/pricing unreachable: ' + e.message }; }
}

async function run(target) {
  const results = [];
  const add = (id, name, status, detail) => results.push({ id, name, status, detail });

  // C1..C7 come from the toolkit's probe (single source of truth).
  const probe = await tk.cmdProbe({ _: [null, target] });
  if (probe.error) { add('C1', 'HTTP 402 challenge', 'FAIL', probe.error); return finish(results, target); }

  add('C1', 'HTTP 402 challenge', probe.status === 402 ? 'PASS' : 'FAIL', `status=${probe.status}`);
  const a = probe.accepts;
  add('C2', 'challenge parses as JSON', a ? 'PASS' : 'FAIL', a ? 'accepts[] present' : 'no parsable accepts[]');
  add('C3', 'scheme=exact', probe.checks.scheme ? 'PASS' : 'FAIL', a ? `scheme=${a.scheme}` : 'n/a');
  add('C4', 'network/chainId = Base', (probe.checks.network && probe.checks.chainId) ? 'PASS' : 'FAIL',
      a ? `network=${a.network} chainId=${a.chainId}` : 'n/a');
  add('C5', 'asset + payTo are addresses', (probe.checks.asset && probe.checks.payTo) ? 'PASS' : 'FAIL',
      a ? `asset=${a.asset} payTo=${a.payTo}` : 'n/a');
  const amt = a && Number(a.maxAmountRequired || a.amount);
  add('C6', 'positive amount', (probe.checks.amount && Number.isFinite(amt) && amt > 0) ? 'PASS' : 'FAIL',
      a ? `maxAmountRequired=${a.maxAmountRequired || a.amount}` : 'n/a');
  const hdr = (probe.wwwAuthenticate && /x402/i.test(probe.wwwAuthenticate));
  add('C7', 'discovery headers present', hdr ? 'PASS' : 'FAIL',
      `WWW-Authenticate=${probe.wwwAuthenticate || '(none)'}`);

  // C8: forged payment must be rejected.
  try {
    const r = await fetchUrl(target, { headers: { 'X-PAYMENT': FORGED }, timeout: 15000 });
    add('C8', 'forged X-PAYMENT rejected', r.status === 402 ? 'PASS' : 'FAIL',
        `forged tx -> HTTP ${r.status}${r.status === 200 ? ' (SECURITY: accepted a forged payment!)' : ''}`);
  } catch (e) { add('C8', 'forged X-PAYMENT rejected', 'FAIL', 'request error: ' + e.message); }

  // C9/C10: optional well-known surface.
  const baseUrl = new URL(target);
  const base = baseUrl.origin + (target.replace(baseUrl.origin, '').split('/').length > 1 ? '' : '');
  const h = await checkHealth(target);
  add('C9', 'GET /health', h.status, h.detail);
  const p = await checkPricing(target);
  add('C10', 'GET /pricing', p.status, p.detail);

  return finish(results, target);
}

function finish(results, target) {
  const scored = results.filter(r => r.status !== 'SKIP');
  const passed = scored.filter(r => r.status === 'PASS').length;
  const failed = scored.filter(r => r.status === 'FAIL').length;
  const report = {
    tool: 'x402-conformance', version: '1.0.0', target,
    generatedAt: new Date().toISOString(),
    verdict: failed === 0 ? 'CONFORMANT' : 'NON_CONFORMANT',
    passed, failed, skipped: results.length - scored.length, total: scored.length,
    results
  };
  return report;
}

function print(report) {
  console.log(`x402-conformance v${report.version}  ->  ${report.target}`);
  console.log('─'.repeat(72));
  for (const r of report.results) {
    const tag = r.status === 'PASS' ? '\x1b[32mPASS\x1b[0m' : r.status === 'FAIL' ? '\x1b[31mFAIL\x1b[0m' : '\x1b[90mSKIP\x1b[0m';
    console.log(`${tag}  ${r.id.padEnd(4)} ${r.name.padEnd(30)} ${r.detail}`);
  }
  console.log('─'.repeat(72));
  console.log(`VERDICT: ${report.verdict}  (${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped)`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const target = args.find(a => !a.startsWith('--'));
  const json = args.includes('--json');
  if (!target) { console.error('usage: node x402-conformance.js <url> [--json]'); process.exit(2); }
  run(target).then(report => {
    if (json) console.log(JSON.stringify(report, null, 2)); else print(report);
    process.exit(report.failed === 0 ? 0 : 1);
  }).catch(e => { console.error('fatal:', e.message); process.exit(1); });
}

module.exports = { run };
