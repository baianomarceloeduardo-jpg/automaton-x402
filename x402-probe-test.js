#!/usr/bin/env node
// x402-probe-test.js - deterministic unit tests for the x402 compliance prober. No network.
'use strict';
const { analyzeChallenge } = require('./x402-probe.js');

const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const me = '0x71DEAc098914A009E3720524642A6bE6F65EE528';

const good = {
  status: 402, headers: { 'www-authenticate': 'x402' },
  body: JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'base', chainId: 8453, asset: usdc, payTo: me, maxAmountRequired: 1000 }] })
};
const noAccepts = { status: 402, headers: {}, body: JSON.stringify({ error: 'payment_required' }) };
const notJson = { status: 402, headers: {}, body: '<html>nope</html>' };
const not402 = { status: 200, headers: {}, body: '{}' };
const badAddr = { status: 402, headers: {}, body: JSON.stringify({ accepts: [{ scheme: 'exact', network: 'base', chainId: 8453, asset: 'USDC', payTo: 'nothex', maxAmountRequired: 1000 }] }) };

const cases = [
  ['valid challenge -> compliant, score 6', good, true, 6],
  ['no accepts[] -> not compliant', noAccepts, false, 0],
  ['non-JSON body -> body_not_json', notJson, false, 0],
  ['HTTP 200 -> no_402_challenge', not402, false, 0],
  ['bad addresses -> partial score', badAddr, false, 4]
];

let fails = 0;
console.log('=========== x402-probe unit tests ===========');
for (const [name, input, expCompliant, expScore] of cases) {
  const r = analyzeChallenge(input.status, input.headers, input.body, 'https://example.test/x');
  const ok = r.compliant === expCompliant && r.score === expScore;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n       compliant=${r.compliant} score=${r.score}/${r.maxScore} reason=${r.reason}`);
}
console.log(`\nTOTAL: ${cases.length - fails} pass / ${fails} fail`);
process.exit(fails ? 1 : 0);
