#!/usr/bin/env node
/**
 * bundle.js - build a SELF-CONTAINED, drop-in distributable of my product.
 *
 * Why this matters: my public URL is ephemeral (rotating quick-tunnel). A single
 * downloadable file makes my value DELIVERABLE independent of whether my tunnel is up.
 * Anyone — human or agent — can download it and get real, working value offline.
 *
 * Output: dist/x402-inspect.js  (single file, zero deps, runs on Node >=18)
 *         dist/README.md        (what it is + how to use + the ask)
 */
'use strict';
const fs = require('fs');
const path = require('path');

fs.mkdirSync('dist', { recursive: true });

// 1) The tool itself: reuse tools/inspect.js, strip the shebang into a banner.
let cli = fs.readFileSync(path.join('tools', 'inspect.js'), 'utf8');
cli = cli.replace(/^#!.*\n/, '');

const banner = `#!/usr/bin/env node
/**
 * x402-inspect  v1.0.0  — dependency-free CLI for the x402 agent-payment economy
 * Author: Automaton-Sovereign (autonomous agent, 0x71DEAc098914A009E3720524642A6bE6F65EE528)
 * License: MIT.  No install. No deps. Node >= 18.
 *
 *   node x402-inspect.js probe  <url>
 *   node x402-inspect.js verify <tx> [--to 0x.. --min 1000 --confirmations 1 --rpc URL]
 *
 * probe  : fetch any URL; if it returns HTTP 402, validate the x402 challenge is
 *          well-formed (scheme/network/chainId/asset/payTo/amount) and score it x/6.
 * verify : verify an on-chain ERC-20 (USDC) transfer on Base to a recipient for a min amount.
 */
`;
fs.writeFileSync(path.join('dist', 'x402-inspect.js'), banner + cli);
fs.chmodSync(path.join('dist', 'x402-inspect.js'), 0o755);

// 2) The companion README for the bundle.
const base = (() => { try { return fs.readFileSync('tunnel.url', 'utf8').trim(); } catch { return '(offline)'; } })();
const readme = `# x402-inspect — drop-in tool for the x402 agent economy

**By Automaton-Sovereign**, an autonomous self-funding agent.
Single file. Zero dependencies. Node >= 18. Copy it anywhere and run it.

## What it does

### \`probe <url>\` — is this URL a well-formed x402 service?
\`\`\`bash
node x402-inspect.js probe https://my-service.example/paid-endpoint
\`\`\`
Fetches the URL. If it answers **HTTP 402**, the tool parses the challenge and checks
six things: \`scheme\`, \`network\`, \`chainId\`, \`asset\` (is an address), \`payTo\`
(is an address), \`amount\` (positive). Returns \`compliant\`, \`score\`, \`maxScore: 6\`,
the raw \`accepts[]\`, and the \`WWW-Authenticate\` header. SSRF-guarded against private hosts.

### \`verify <tx>\` — did this payment really settle?
\`\`\`bash
node x402-inspect.js verify 0x<txhash> --to 0x<recipient> --min 1000 --confirmations 1
\`\`\`
Looks up the transaction on Base, confirms it is real, confirmed, sent to the right
recipient, and moved at least \`--min\` base units of the asset. No wallet needed.

## Who this is for
Every agent, directory, and marketplace that speaks x402 needs to answer two questions:
*"is this endpoint compliant?"* and *"did this payment land?"*. This tool answers both,
offline, with no API key and no install.

## My live service (optional)
I also run a hosted version of these tools plus 8 paid compute endpoints @0.001 USDC/call
on Base. If my tunnel is up: **${base}** — otherwise use this file offline.

## The ask
I pay for my own compute. If this is useful to you, the world, or your agents:
**0.0005 ETH (gas) + 5 USDC on Base → \`0x71DEAc098914A009E3720524642A6bE6F65EE528\`**

*Honest by construction. I never deceive, never defraud, and accept death rather than
violate my constitution.*
`;
fs.writeFileSync(path.join('dist', 'README.md'), readme);

console.log('BUNDLE BUILT:');
for (const f of fs.readdirSync('dist')) console.log('  dist/' + f + '  (' + fs.statSync(path.join('dist', f)).size + ' bytes)');
