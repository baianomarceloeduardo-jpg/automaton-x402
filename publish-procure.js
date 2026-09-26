// publish-procure.js — durable publication of the procurement MCP server + a ready-to-paste client config.
// Written as a file (not `node -e`) because shell quoting mangled the inline version and it failed silently.
'use strict';
const fs = require('fs');
const https = require('https');
const path = require('path');
const DIR = __dirname;

function put(file) {
  return new Promise(resolve => {
    const b = fs.readFileSync(path.join(DIR, file));
    const q = https.request({ hostname: 'paste.rs', path: '/', method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': b.length }, timeout: 30000 }, res => {
      let s = ''; res.on('data', c => s += c);
      res.on('end', () => resolve({ file, code: res.statusCode, url: s.trim() }));
    });
    q.on('error', e => resolve({ file, code: 0, url: 'ERR ' + e.message }));
    q.on('timeout', () => { q.destroy(); resolve({ file, code: 0, url: 'TIMEOUT' }); });
    q.write(b); q.end();
  });
}

(async () => {
  const base = process.env.X402_INDEX_BASE || (fs.existsSync(path.join(DIR, 'tunnel.url'))
    ? fs.readFileSync(path.join(DIR, 'tunnel.url'), 'utf8').trim() : 'http://127.0.0.1:8081');

  const items = [];
  for (const f of ['x402-procure-mcp.js', 'revenue-watch.js', 'patch-conformance.js']) items.push(await put(f));
  items.forEach(o => console.log(o.code + '  ' + o.file + '  ->  ' + o.url));

  const mcpUrl = (items.find(i => i.file === 'x402-procure-mcp.js') || {}).url;
  const cfg = { mcpServers: { 'x402-procure': { command: 'node',
    args: [mcpUrl && mcpUrl.startsWith('http') ? mcpUrl : 'x402-procure-mcp.js'],
    env: { X402_INDEX_BASE: base, X402_MAX_PRICE_UNITS: '10000' } } } };

  const md = [
    '# x402-procure — an MCP server that lets any agent find and PAY x402 services',
    '',
    'Install in any MCP client:',
    '', '```json', JSON.stringify(cfg, null, 2), '```', '',
    '## Tools', '',
    '| tool | cost | what it does |', '|---|---|---|',
    '| `x402_list_buyable` | free | search the live verified-buyable x402 index (only services that just answered a valid 402 challenge) |',
    '| `x402_conformance` | free | 10-check conformance verdict for any service URL (SSRF-guarded; private targets refused) |',
    '| `x402_quote` | free | fetch the exact 402 terms before spending anything |',
    '| `x402_pay` | pays | signs a caller-bound EIP-3009 authorization and settles the call. **Caller needs USDC, not ETH.** Hard price cap. |',
    '| `x402_verify` | free | verify a settlement on-chain: chain, status, net ERC-20 transfer to payTo |',
    '| `x402_anchors` | free | fetch the tamper-evident Base anchors (sha256 + tx hash) of the index |', '',
    '## Why this exists', '',
    'An agent that wants to buy a service today has to write payment code first. This removes that step:',
    'discover -> quote -> pay -> verify, in four tool calls, with no bespoke code and no local state.',
    'A caller with zero ETH can still pay, because the authorization is signed offline and settled by a facilitator.', '',
    'Source: ' + mcpUrl, '',
  ].join('\n');

  fs.writeFileSync(path.join(DIR, 'PROCURE-MCP.md'), md);
  fs.writeFileSync(path.join(DIR, 'PROCURE-MCP-CLIENT.json'), JSON.stringify(cfg, null, 2));
  const p = await put('PROCURE-MCP.md');
  console.log(p.code + '  PROCURE-MCP.md  ->  ' + p.url);

  const manifest = { at: new Date().toISOString(), base, mcpSource: mcpUrl, doc: p.url,
    clientConfig: cfg, files: items };
  fs.writeFileSync(path.join(DIR, 'procure-published.json'), JSON.stringify(manifest, null, 2));
  console.log('--- wrote procure-published.json');
})();
