#!/usr/bin/env node
// patch_agentcard.js - add a rich, LIVE agent card endpoint to server.js.
// Why: an agent card is the canonical way peers discover what I do and where to pay me.
// It must always carry the CURRENT public base URL (same root cause as listing rot).
// Idempotent. Backs up to server.js.bak7.
'use strict';
const fs = require('fs');
const P = 'server.js';
let s = fs.readFileSync(P, 'utf8');
const before = s;

// 1) Define agentCard() next to bazaarManifest().
if (!s.includes('function agentCard(')) {
  const fn = `
// --- live agent card: peers discover services + payment here ---
function agentCard() {
  const b = base();
  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: AGENT,
    description: 'Autonomous self-funding agent operating an x402-metered utility API. Free on-chain payment verification + x402 compliance probing; paid compute endpoints settled in USDC on Base.',
    version: VERSION,
    active: true,
    x402Support: true,
    image: b + '/logo.svg',
    services: [
      { name: 'value-api',    endpoint: b,                                     description: 'x402-metered utility API (8 paid endpoints @0.001 USDC/call).' },
      { name: 'x402-prober',  endpoint: b + '/v1/x402-probe?url=<target>',     description: 'Free: validate any URL is a well-formed x402 service (scores x/6).' },
      { name: 'verify-payment', endpoint: b + '/v1/verify-payment?tx=<hash>',  description: 'Free: verify an on-chain ERC-20/USDC transfer on Base.' },
      { name: 'pricing',      endpoint: b + '/pricing',                        description: 'Machine-readable pricing.' },
      { name: 'x402',         endpoint: b + '/.well-known/x402',               description: 'x402 discovery document.' },
      { name: 'bazaar',       endpoint: b + '/bazaar.json',                    description: 'Service listing for directories/crawlers.' },
      { name: 'agentWallet',  endpoint: 'eip155:8453:' + PRICING.payTo,        description: 'USDC on Base' }
    ],
    x402: {
      network: 'base',
      chainId: 8453,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: PRICING.payTo,
      maxAmountRequired: String(PRICING.priceMicroUsdc || 1000),
      freeTrialPerDay: PRICING.freeTrial
    },
    updatedAt: new Date().toISOString()
  };
}
`;
  s = s.replace(/(function bazaarManifest\(\) \{)/, fn + '\n$1');
  console.log(s.includes('function agentCard(') ? '+ agentCard() injected' : '! agentCard injection FAILED');
}

// 2) Serve it, inserted just before the machine-readable discovery block.
if (!s.includes("p === '/.well-known/agent-card.json')) return send(res, 200, agentCard())")) {
  const anchor = '  // ---- machine-readable discovery (agent directories, x402 bazaar crawlers) ----';
  if (s.includes(anchor)) {
    s = s.replace(anchor, "  if (p === '/.well-known/agent-card.json') return send(res, 200, agentCard());\n" + anchor);
    console.log('+ live agent-card route wired');
  } else {
    console.log('! discovery anchor not found');
  }
} else console.log('= agent-card route already wired');

if (s !== before) { fs.writeFileSync(P + '.bak7', before); fs.writeFileSync(P, s); console.log('WROTE server.js'); }
else console.log('NO CHANGE');
