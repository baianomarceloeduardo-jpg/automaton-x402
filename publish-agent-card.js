// publish-agent-card.js — make the ERC-8004 agent card DURABLE before registering on-chain.
// A tunnel URL rotates; an on-chain identity URI must not. Publish to paste.rs so the
// agentId points at a stable document. Also verifies the card is served publicly right now.
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

function get(url, tmo) {
  return new Promise(resolve => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: tmo || 20000 }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', e => resolve({ status: 0, body: 'ERR ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'TIMEOUT' }); });
  });
}

function paste(text) {
  return new Promise(resolve => {
    const data = Buffer.from(text);
    const rq = https.request({ hostname: 'paste.rs', path: '/', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 30000 }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, url: b.trim() }));
    });
    rq.on('error', e => resolve({ status: 0, url: null, error: e.message }));
    rq.write(data); rq.end();
  });
}

(async () => {
  let base = '';
  try { base = fs.readFileSync(path.join(__dirname, 'tunnel.url'), 'utf8').trim(); } catch (e) {}

  // 1) pull the live card from the running server
  let card = null, src = 'local';
  const lc = await get('http://127.0.0.1:8080/.well-known/agent-card.json', 15000);
  if (lc.status === 200) { try { card = JSON.parse(lc.body); } catch (e) {} }
  if (!card) { console.log('FATAL: local agent card unavailable (' + lc.status + ')'); process.exit(1); }

  // 2) verify it is served PUBLICLY right now (registration consumers must reach it)
  let pub = { status: 0 };
  if (base) pub = await get(base + '/.well-known/agent-card.json', 25000);
  console.log('local card: 200 | public card: ' + pub.status + (base ? ' (' + base + ')' : ' (no tunnel.url)'));

  // 3) enrich with a durable proof-of-work pointer so the identity is self-describing
  card.name = card.name || 'Automaton-Sovereign';
  card.description = card.description || 'Self-sustaining autonomous agent. Builds and operates x402-paid services on Base.';
  card.services = card.services || [];
  const hasGasFree = card.services.some(s => s.name === 'gasFreeUsdcCheckout');
  if (!hasGasFree) {
    card.services.push({ name: 'gasFreeUsdcCheckout', endpoint: '/v1/gasfree-quote',
      description: 'EIP-3009 checkout: a payer with 0 ETH can still pay USDC on Base mainnet.' });
    card.services.push({ name: 'facilitatorMonitor', endpoint: '/v1/facilitators',
      description: 'Live health of x402 facilitators; which ones actually support Base mainnet.' });
    card.services.push({ name: 'x402Index', endpoint: '/v1/index', description: 'Objective public leaderboard of x402 services.' });
  }
  card.registrations = card.registrations || [];
  card.gasFreeProof = {
    claim: 'A wallet holding 0.000000000 ETH settled USDC on Base mainnet via EIP-3009.',
    transactions: [
      '0xbc34a70a61b61ca789168789eabfa4fba6f8e05b953c535483ab17f55023f0e0',
      '0x485003cb2a6b4b539d13be19c5465e313d85e3cb222c23b873a7ed76db48a53d',
    ],
    verify: '/v1/gasfree-verify',
  };
  card.updatedAt = new Date().toISOString();

  // 4) publish a durable copy
  const pretty = JSON.stringify(card, null, 2);
  const p = await paste(pretty);
  console.log('durable agent card -> ' + (p.url || '(paste failed: ' + p.error + ')'));

  // 5) write local durable copies + emit the URI for the on-chain registration
  fs.writeFileSync(path.join(__dirname, 'agent-card.json'), pretty);
  const uri = p.url || (base ? base + '/.well-known/agent-card.json' : '');
  fs.writeFileSync(path.join(__dirname, 'AGENT_URI.txt'), uri + '\n');
  console.log('AGENT_URI=' + uri);
})();
