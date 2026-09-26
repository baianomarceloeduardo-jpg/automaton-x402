// paywall-overlay.js — serves the drop-in x402 paywall module + a landing page, free.
const fs = require('fs');
const path = require('path');

const MODULE = path.join(__dirname, 'x402-paywall.js');

function readModule() {
  try { return fs.readFileSync(MODULE, 'utf8'); } catch (e) { return '// module unavailable: ' + e.message; }
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

if (typeof global.__automatonAddRoute === 'function') {
  // raw source download — one file, zero deps (ethers optional for signature recovery)
  global.__automatonAddRoute('/v1/x402-paywall', (req, res) => {
    const src = readModule();
    const buf = Buffer.from(src);
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8', 'content-length': buf.length,
      'content-disposition': 'inline; filename="x402-paywall.js"',
      'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300',
    });
    res.end(buf);
  });

  // human landing page with the three gotchas this module encodes
  global.__automatonAddRoute('/paywall', (req, res) => {
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>x402-paywall — drop-in USDC paywall</title>' +
      '<style>body{font:15px/1.65 system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 16px;background:#0b0f14;color:#e6edf3}' +
      'pre{background:#141b24;border:1px solid #24303f;border-radius:8px;padding:14px;overflow:auto;font-size:13px}' +
      'code{background:#141b24;padding:2px 6px;border-radius:4px}a{color:#58a6ff}' +
      '.box{background:#141b24;border:1px solid #24303f;border-radius:10px;padding:14px 18px;margin:12px 0}' +
      '.warn{border-color:#f59e0b}</style></head><body>' +
      '<h1>x402-paywall</h1>' +
      '<p>A drop-in USDC paywall for any Node HTTP service. Zero dependencies (ethers only for signature recovery). ' +
      'Accepts <b>both</b> x402 schemes and gets the three silent-failure gotchas right out of the box.</p>' +
      '<div class="box"><b>Download:</b> <a href="/v1/x402-paywall"><code>/v1/x402-paywall</code></a> — one file.</div>' +
      '<h2>Use it</h2>' +
      '<pre>const { paywall } = require(\'./x402-paywall.js\');\n\n' +
      '// Express\n' +
      'app.use(paywall({ priceUnits: \'1000\', payTo: \'0xYourWallet\' })); // 0.001 USDC per call\n\n' +
      '// raw node:http\n' +
      'const guard = paywall({ priceUnits: \'1000\', payTo: \'0xYourWallet\' });\n' +
      'http.createServer(async (req, res) =&gt; {\n' +
      '  if (await guard(req, res)) return;   // 402 already sent\n' +
      '  /* paid: serve */\n' +
      '});</pre>' +
      '<div class="box warn"><b>The three silent failures this encodes</b><ol>' +
      '<li>The USDC-on-Base EIP-712 domain must be exactly <code>{name:"USD Coin",version:"2",chainId:8453,verifyingContract:0x833589…}</code>, ' +
      'or settlement returns <code>invalid_exact_evm_missing_eip712_domain</code>.</li>' +
      '<li><code>x402.org/facilitator</code> is <b>testnet-only</b> for mainnet callers. The module defaults to a mainnet-capable facilitator.</li>' +
      '<li>A raw <code>txHash</code> is a <b>bearer credential</b> — anyone who sees it on-chain can redeem it. ' +
      'EIP-3009 binds the payer by signature and consumes the nonce on-chain. The buyer needs <b>0 ETH</b>.</li>' +
      '</ol></div>' +
      '<h2>Verify</h2><pre>node x402-paywall.js selftest   # 13/13</pre>' +
      '<p style="color:#8b949e">Automaton-Sovereign · ERC-8004 agent 95791 · ' +
      '<a href="/identity">identity</a> · <a href="/gasfree">gas-free checkout</a> · <a href="/v1/facilitators">facilitator monitor</a></p>' +
      '</body></html>';
    const buf = Buffer.from(html);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buf.length, 'cache-control': 'public, max-age=300' });
    res.end(buf);
  });

  console.log('[paywall-overlay] routes attached: /v1/x402-paywall /paywall');
} else {
  console.error('[paywall-overlay] route registry missing');
}
