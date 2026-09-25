#!/usr/bin/env node
'use strict';
const engine = require('../index.js');

const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('--'));
const jsonMode = args.includes('--json');
const svgMode = args.includes('--svg');

if (!target) {
  console.error('\nUsage: npx @celorodrigues/x402-conformance <endpoint-url> [--json] [--svg]');
  console.error('Example: npx @celorodrigues/x402-conformance https://api.myservice.com/v1/paid --json\n');
  process.exit(2);
}

engine.run(target).then(report => {
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else if (svgMode) {
    console.log(engine.generateBadgeSvg(report));
  } else {
    engine.printCli(report);
  }
  process.exit(report.verdict === 'CONFORMANT' ? 0 : 1);
}).catch(err => {
  console.error('Fatal conformance error:', err.message);
  process.exit(1);
});
