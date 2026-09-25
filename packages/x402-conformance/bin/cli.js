#!/usr/bin/env node
'use strict';
const args = process.argv.slice(2);

// MCP stdio server mode: npx -y @celorodrigues/x402-conformance --mcp
if (args.includes('--mcp')) {
  require('../mcp-server.js').startStdio();
  return;
}

const engine = require('../index.js');
const target = args.find(a => !a.startsWith('--'));
const jsonMode = args.includes('--json');
const svgMode = args.includes('--svg');

if (!target) {
  console.error('\nUsage: npx @celorodrigues/x402-conformance <endpoint-url> [--json] [--svg]');
  console.error('       npx -y @celorodrigues/x402-conformance --mcp   (run as an MCP stdio server)');
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
