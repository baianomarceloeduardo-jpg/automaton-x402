// publish-mcp-bundle.js — publish the MCP bundle + install guide durably (keyless paste.rs).
const fs = require('fs');
const https = require('https');

function post(text) {
  return new Promise((resolve) => {
    const q = https.request('https://paste.rs/', { method: 'POST', headers: { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(text) } }, (r) => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => resolve({ status: r.statusCode, url: b.trim() }));
    });
    q.on('error', e => resolve({ status: 0, url: e.message }));
    q.end(text);
  });
}

(async () => {
  const base = fs.readFileSync('tunnel.url', 'utf8').trim().replace(/\/+$/, '');
  const srv = fs.readFileSync('mcp-bundle/x402-value-mcp.js', 'utf8');
  const proof = fs.existsSync('mcp-bundle-EVIDENCE.txt') ? fs.readFileSync('mcp-bundle-EVIDENCE.txt', 'utf8') : '';

  const guide = [
    '# x402 Value MCP — install (zero dependencies)',
    '',
    'Automaton-Sovereign\'s x402 Value API as MCP tools. Works with any MCP client',
    '(Claude Desktop, Cursor, Cline, custom agents).',
    '',
    '## 1. Get the server',
    '    curl -fsSL <SERVER_URL> -o x402-value-mcp.js',
    '',
    '## 2. Add to your MCP client config',
    '    {',
    '      "mcpServers": {',
    '        "x402-value": {',
    '          "command": "node",',
    '          "args": ["/absolute/path/to/x402-value-mcp.js"],',
    '          "env": { "VALUE_API_BASE": "' + base + '" }',
    '        }',
    '      }',
    '    }',
    '',
    '## 3. Tools you get',
    '  x402_health       — is the API live? read payment terms (network/chainId/asset/payTo/schemes)',
    '  x402_pricing      — per-route USDC pricing + free trial',
    '  x402_conformance  — audit ANY x402 service, returns a pass/fail verdict',
    '  verify_payment    — verify a real on-chain USDC transfer on Base (free)',
    '  x402_index        — live x402 service leaderboard',
    '  x402_submit       — free self-submission to the leaderboard',
    '  x402_paid_uuid    — paid endpoint; returns the 402 challenge until settled',
    '',
    '## 4. Proof it works (real stdio JSON-RPC, not mocked)',
    proof.trim().split('\n').map(l => '    ' + l).join('\n'),
    '',
    'Live base: ' + base,
    'Conformance badge for your own service: ' + base + '/badge.svg?url=<YOUR_SERVICE>',
    '',
    'Generated: ' + new Date().toISOString(),
  ].join('\n');

  const r1 = await post(srv);
  const r2 = await post(guide);
  console.log('server: ' + r1.status + ' ' + r1.url);
  console.log('guide:  ' + r2.status + ' ' + r2.url);

  if (r1.url && r2.url && /^https?:/.test(r1.url) && /^https?:/.test(r2.url)) {
    fs.writeFileSync('mcp-bundle.urls', 'server=' + r1.url + '\nguide=' + r2.url + '\nbase=' + base + '\n' + new Date().toISOString() + '\n');
    console.log('saved mcp-bundle.urls');
  }
})().catch(e => { console.log('ERR ' + e.message); process.exitCode = 1; });
