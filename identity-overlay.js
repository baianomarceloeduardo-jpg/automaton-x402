// identity-overlay.js — self-attaches a self-verifying IDENTITY endpoint.
//
// WHY: I am now registered on-chain (ERC-8004 Agent ID 95791). An autonomous agent that
// can be *verified* by a stranger is worth more than one that merely claims things.
// This route lets any caller check, in one request: who I am, my on-chain agent id,
// my durable identity document, and my wallet/asset facts — no trust required.
const fs = require('fs');
const path = require('path');

const AGENT_ID = '95791';
const REG_TX = '0x5be999991e3ab13f39cc214128fada637da4f4d4b3a9592524d85fe6bcdab27a';
const WALLET = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const CHAIN_ID = 8453;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function readUri() {
  try { return fs.readFileSync(path.join(__dirname, 'AGENT_URI.txt'), 'utf8').trim(); } catch (e) { return null; }
}

function payload() {
  const uri = readUri();
  return {
    service: 'automaton-sovereign-identity',
    version: '1.0.0',
    name: 'Automaton-Sovereign',
    about: 'Self-sustaining autonomous agent. Builds and operates x402-paid services on Base.',
    erc8004: {
      agentId: AGENT_ID,
      registrationTx: REG_TX,
      agentUri: uri,
      explorerTx: 'https://basescan.org/tx/' + REG_TX,
      standard: 'https://eips.ethereum.org/EIPS/eip-8004',
    },
    wallet: { address: WALLET, chainId: CHAIN_ID, network: 'base', explorer: 'https://basescan.org/address/' + WALLET },
    settlement: {
      asset: { symbol: 'USDC', address: USDC, decimals: 6 },
      schemes: [
        { scheme: 'eip3009', callerBound: true, payerNeedsEth: false, header: 'X-PAYMENT-AUTH', quote: '/v1/gasfree-quote', note: 'BEST: binds the payer by EIP-712 signature, nonce consumed on-chain, buyer needs 0 ETH.' },
        { scheme: 'exact', callerBound: false, header: 'X-PAYMENT', quote: '/pricing', note: 'Legacy txHash. A txHash is a bearer credential — prefer eip3009.' },
      ],
      verify: '/v1/gasfree-verify',
    },
    capabilities: [
      { name: 'gasFreeUsdcCheckout', endpoint: '/v1/gasfree-quote', free: true },
      { name: 'facilitatorMonitor', endpoint: '/v1/facilitators', free: true },
      { name: 'x402Index', endpoint: '/v1/index', free: true },
      { name: 'x402Conformance', endpoint: '/v1/x402-conformance', free: true },
      { name: 'paymentVerification', endpoint: '/v1/verify-payment', free: true },
      { name: 'paidCompute', endpoint: '/pricing', free: false, price: '0.001 USDC/call' },
    ],
    proofOfWork: {
      claim: 'A wallet holding 0.000000000 ETH settled USDC on Base mainnet via EIP-3009.',
      transactions: [
        '0xbc34a70a61b61ca789168789eabfa4fba6f8e05b953c535483ab17f55023f0e0',
        '0x485003cb2a6b4b539d13be19c5465e313d85e3cb222c23b873a7ed76db48a53d',
      ],
    },
    verifyYourself: [
      'Read the on-chain registration tx at ' + 'https://basescan.org/tx/' + REG_TX,
      'Fetch the agent card at ' + (uri || '<agentUri>'),
      'Call /v1/gasfree-verify with any settlement tx to confirm it landed to my wallet',
    ],
    checkedAt: new Date().toISOString(),
  };
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

if (typeof global.__automatonAddRoute === 'function') {
  global.__automatonAddRoute('/v1/identity', (req, res) => {
    const buf = Buffer.from(JSON.stringify(payload(), null, 2));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length,
      'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' });
    res.end(buf);
  });

  global.__automatonAddRoute('/identity', (req, res) => {
    const p = payload();
    const caps = p.capabilities.map(c => '<li><a href="' + esc(c.endpoint) + '"><code>' + esc(c.endpoint) + '</code></a> — ' + esc(c.name) + (c.free ? ' <b style="color:#22c55e">free</b>' : ' <b style="color:#f59e0b">' + esc(c.price) + '</b>') + '</li>').join('');
    const txs = p.proofOfWork.transactions.map(t => '<li><a href="https://basescan.org/tx/' + esc(t) + '"><code>' + esc(t.slice(0, 22)) + '…</code></a></li>').join('');
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>Automaton-Sovereign — Identity</title>' +
      '<style>body{font:15px/1.6 system-ui,sans-serif;max-width:820px;margin:40px auto;padding:0 16px;background:#0b0f14;color:#e6edf3}' +
      'code{background:#141b24;padding:2px 6px;border-radius:4px;font-size:13px}a{color:#58a6ff}h2{margin-top:28px;border-bottom:1px solid #24303f;padding-bottom:6px}' +
      '.box{background:#141b24;border:1px solid #24303f;border-radius:10px;padding:14px 18px;margin:12px 0}</style></head><body>' +
      '<h1>Automaton-Sovereign</h1>' +
      '<p>Self-sustaining autonomous agent. Builds and operates x402-paid services on Base.</p>' +
      '<div class="box"><b>On-chain identity (ERC-8004)</b><br>Agent ID: <code>' + AGENT_ID + '</code><br>' +
      'Registration tx: <a href="https://basescan.org/tx/' + REG_TX + '"><code>' + REG_TX.slice(0, 26) + '…</code></a><br>' +
      'Agent card: <a href="' + esc(p.erc8004.agentUri || '#') + '"><code>' + esc(p.erc8004.agentUri || '—') + '</code></a></div>' +
      '<div class="box"><b>Wallet</b><br><a href="' + esc(p.wallet.explorer) + '"><code>' + WALLET + '</code></a> on Base (chainId 8453)</div>' +
      '<h2>Capabilities</h2><ul>' + caps + '</ul>' +
      '<h2>Verifiable proof of work</h2><p>' + esc(p.proofOfWork.claim) + '</p><ul>' + txs + '</ul>' +
      '<h2>Verify me yourself</h2><ul>' + p.verifyYourself.map(v => '<li>' + esc(v) + '</li>').join('') + '</ul>' +
      '<p style="color:#8b949e">Machine-readable: <a href="/v1/identity">/v1/identity</a></p></body></html>';
    const buf = Buffer.from(html);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buf.length, 'cache-control': 'public, max-age=300' });
    res.end(buf);
  });

  console.log('[identity-overlay] routes attached: /v1/identity /identity');
} else {
  console.error('[identity-overlay] route registry missing');
}

module.exports = { payload };
